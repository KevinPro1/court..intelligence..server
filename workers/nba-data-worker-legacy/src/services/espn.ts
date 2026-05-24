/**
 * ESPN public API HTTP client.
 * - Generic fetchJson with AbortController timeout.
 * - Retry (max 2 retries) with exponential backoff for 429/5xx.
 * - Primary endpoint: NBA scoreboard.
 */

import type { ESPNScoreboardResponse } from "../types";

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 500;

export class ESPNClientError extends Error {
  constructor(
    message: string,
    public status?: number,
    public url?: string
  ) {
    super(message);
    this.name = "ESPNClientError";
  }
}

/**
 * Fetch JSON from URL with timeout and retries.
 * Uses AbortController for timeout; retries on 429 and 5xx (max 2 retries, exponential backoff).
 */
export async function fetchJson<T = unknown>(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  let lastError: Error | null = null;
  let backoff = INITIAL_BACKOFF_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeoutId);

      const shouldRetry =
        res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!res.ok && !shouldRetry) {
        throw new ESPNClientError(
          `ESPN API error: ${res.status} ${res.statusText}`,
          res.status,
          url
        );
      }

      if (!res.ok && attempt < MAX_RETRIES) {
        await sleep(backoff);
        backoff *= 2;
        continue;
      }

      if (!res.ok) {
        throw new ESPNClientError(
          `ESPN API error after retries: ${res.status}`,
          res.status,
          url
        );
      }

      const data = (await res.json()) as T;
      return data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new ESPNClientError(`Request timeout after ${timeoutMs}ms`, undefined, url);
      }
      if (attempt < MAX_RETRIES) {
        await sleep(backoff);
        backoff *= 2;
      } else {
        break;
      }
    }
  }

  throw lastError ?? new ESPNClientError("Unknown fetch error", undefined, url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- ESPN endpoints ---

const ESPN_NBA_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

/**
 * NBA scoreboard for a given date.
 * @param dateYmd - YYYYMMDD (e.g. 20250205). Omit for today.
 */
export function getScoreboardUrl(dateYmd?: string): string {
  const url = new URL(`${ESPN_NBA_BASE}/scoreboard`);
  if (dateYmd) url.searchParams.set("dates", dateYmd);
  return url.toString();
}

export async function fetchScoreboard(dateYmd?: string): Promise<ESPNScoreboardResponse> {
  const url = getScoreboardUrl(dateYmd);
  return fetchJson<ESPNScoreboardResponse>(url, DEFAULT_TIMEOUT_MS);
}

/**
 * ESPN teams list endpoint.
 * TODO: Verify exact URL from ESPN; common pattern is /teams or from scoreboard/standings.
 * Fallback: derive teams from scoreboard events until a dedicated teams endpoint is confirmed.
 */
export function getTeamsUrl(): string {
  // ESPN has a teams endpoint; structure may vary.
  // https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams
  return `${ESPN_NBA_BASE}/teams`;
}

export async function fetchTeams(): Promise<unknown> {
  const url = getTeamsUrl();
  return fetchJson<unknown>(url, DEFAULT_TIMEOUT_MS);
}

/**
 * Roster endpoint. ESPN roster may be under team or scoreboard links.
 * TODO: Discover from scoreboard payload (links) or use known pattern.
 * Pattern often: .../teams/{id} or .../teams/{id}/roster
 */
export function getRosterUrl(espnTeamId: string, season?: number): string {
  // Common pattern; if 404, implement discovery from scoreboard links.
  const base = `${ESPN_NBA_BASE}/teams/${espnTeamId}`;
  const url = new URL(base);
  if (season) url.searchParams.set("season", String(season));
  return url.toString();
}

export async function fetchRoster(espnTeamId: string, season?: number): Promise<unknown> {
  const url = getRosterUrl(espnTeamId, season);
  return fetchJson<unknown>(url, DEFAULT_TIMEOUT_MS);
}

/**
 * Player profile/stats. ESPN player endpoint.
 * TODO: Exact URL from ESPN; often .../people/{id} or from roster payload.
 */
export function getPlayerUrl(espnPlayerId: string): string {
  // Common pattern for person/player
  return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/athletes/${espnPlayerId}`;
}

export async function fetchPlayer(espnPlayerId: string): Promise<unknown> {
  const url = getPlayerUrl(espnPlayerId);
  return fetchJson<unknown>(url, DEFAULT_TIMEOUT_MS);
}
