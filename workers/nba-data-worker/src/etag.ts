/**
 * ETag helper: stable JSON stringify + simple hash.
 * Worker-safe (no Node crypto); for stronger ETag use crypto.subtle.digest if needed.
 */

/**
 * Stable stringify for deterministic ETag (key order).
 */
export function stableStringify(obj: unknown): string {
  if (obj === null) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + stableStringify((obj as Record<string, unknown>)[k]));
  return "{" + pairs.join(",") + "}";
}

/**
 * Simple hash of string for ETag (djb2-style).
 * For production: consider crypto.subtle.digest('SHA-256', ...) and base64.
 */
function simpleHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

/**
 * Generate ETag from response body (string) or object (will be stable-stringified).
 */
export function etagFromBody(body: string | unknown): string {
  const str = typeof body === "string" ? body : stableStringify(body);
  return '"' + simpleHash(str) + '"';
}

/**
 * Check If-None-Match; return true if client has same version (304).
 */
export function checkNotModified(request: Request, etag: string): boolean {
  const noneMatch = request.headers.get("If-None-Match");
  if (!noneMatch) return false;
  return noneMatch.split(/,\s*/).some((v) => v.trim() === etag);
}
