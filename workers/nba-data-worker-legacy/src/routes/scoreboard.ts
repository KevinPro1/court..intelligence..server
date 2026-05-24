/**
 * GET /v1/nba/scoreboard?date=YYYYMMDD
 * Defaults to today; returns normalized scoreboard from ESPN or D1/KV fallback.
 */

import { fetchScoreboard } from "../services/espn";
import { normalizeScoreboard } from "../services/normalize";
import * as db from "../db/queries";
import {
  CACHE_KEYS,
  TTL,
  kvGet,
  kvSet,
  cacheControlHeader,
  etagFromBody,
  checkNotModified,
  isRateLimited,
} from "../cache/cache";
import type { Env } from "../types";

function todayYmd(): string {
  const d = new Date();
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("");
}

export async function scoreboardGet(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
  if (await isRateLimited(env.KV, ip, "scoreboard")) {
    return Response.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const url = new URL(request.url);
  const dateYmd = url.searchParams.get("date") ?? todayYmd();

  const cacheKey = CACHE_KEYS.scoreboard(dateYmd);
  const cached = await kvGet<{ date: string; games: unknown[] }>(env.KV, cacheKey);
  if (cached) {
    const body = JSON.stringify(cached);
    const etag = etagFromBody(body);
    if (checkNotModified(request, etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(TTL.scoreboard),
        ETag: etag,
      },
    });
  }

  try {
    const data = await fetchScoreboard(dateYmd);
    const normalized = normalizeScoreboard(data, dateYmd);
    await kvSet(env.KV, cacheKey, normalized, TTL.scoreboard);
    const body = JSON.stringify(normalized);
    const etag = etagFromBody(body);
    if (checkNotModified(request, etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(TTL.scoreboard),
        ETag: etag,
      },
    });
  } catch {
    const fallback = await db.getGamesByDate(env.DB, dateYmd);
    const teamRows = await db.getAllTeams(env.DB);
    const teamMap = new Map(teamRows.map((t) => [t.team_id, { id: t.team_id, displayName: t.name, abbreviation: t.abbr }]));
    const games = fallback.map((row) => db.gameRowToNormalized(row, teamMap));
    const payload = { date: dateYmd, games };
    const body = JSON.stringify(payload);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(60),
        "X-Fallback": "d1",
      },
    });
  }
}
