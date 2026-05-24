/**
 * KV + Cache API helpers for fast reads and rate-limit protection.
 * TTLs: scoreboard/games 10–60s, teams 24h, roster 6h, player stats 24h.
 * ETag / Cache-Control on responses; simple per-IP rate limiter via KV.
 */

export const CACHE_KEYS = {
  scoreboard: (date: string) => `sb:${date}`,
  gamesToday: () => "games:today",
  teams: () => "teams:all",
  roster: (teamId: string, season: number) => `roster:${teamId}:${season}`,
  playerProfile: (playerId: string) => `player:${playerId}`,
  playerStats: (playerId: string, seasons: string) => `stats:${playerId}:${seasons}`,
  rateLimit: (ip: string, route: string) => `rl:${ip}:${route}`,
} as const;

/** TTL seconds */
export const TTL = {
  scoreboard: 30,
  gamesToday: 30,
  teams: 24 * 3600,
  roster: 6 * 3600,
  playerProfile: 24 * 3600,
  playerStats: 24 * 3600,
  rateLimitWindow: 60,
} as const;

/** Max requests per IP per route in rateLimitWindow (best-effort). */
export const RATE_LIMIT_MAX = 100;

/**
 * Get from KV with optional JSON parse.
 */
export async function kvGet<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

/**
 * Set in KV with TTL (seconds). Value is JSON-stringified if object.
 */
export async function kvSet(
  kv: KVNamespace,
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  await kv.put(key, str, { expirationTtl: ttlSeconds });
}

/**
 * Check rate limit: increment counter for ip+route; if over RATE_LIMIT_MAX return true (should 429).
 */
export async function isRateLimited(kv: KVNamespace, ip: string, route: string): Promise<boolean> {
  const key = CACHE_KEYS.rateLimit(ip, route);
  const raw = await kv.get(key);
  const count = raw === null ? 0 : parseInt(raw, 10) || 0;
  if (count >= RATE_LIMIT_MAX) return true;
  await kv.put(key, String(count + 1), { expirationTtl: TTL.rateLimitWindow });
  return false;
}

/**
 * Build Cache-Control header value.
 */
export function cacheControlHeader(ttlSeconds: number, options?: { immutable?: boolean }): string {
  const maxAge = `max-age=${ttlSeconds}`;
  if (options?.immutable) return `${maxAge}, immutable`;
  return maxAge;
}

/**
 * Simple ETag from string body (hash of content).
 * Worker-safe: use small hash; for production consider crypto.subtle.digest.
 */
export function etagFromBody(body: string): string {
  let h = 0;
  for (let i = 0; i < body.length; i++) {
    h = (Math.imul(31, h) + body.charCodeAt(i)) | 0;
  }
  return `"${Math.abs(h).toString(16)}"`;
}

/**
 * Check If-None-Match and return 304 if match.
 */
export function checkNotModified(request: Request, etag: string): boolean {
  const noneMatch = request.headers.get("If-None-Match");
  if (!noneMatch) return false;
  return noneMatch.split(/,\s*/).some((v) => v.trim() === etag);
}
