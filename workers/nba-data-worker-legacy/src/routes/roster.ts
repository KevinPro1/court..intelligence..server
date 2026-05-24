/**
 * GET /v1/nba/teams/:teamId/roster?season=YYYY
 * Defaults to current season. Returns roster from KV or D1; optional ESPN fetch.
 */

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

function currentSeason(): number {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  return month >= 9 ? year + 1 : year;
}

export async function rosterGet(
  request: Request,
  env: Env,
  teamId: string
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
  if (await isRateLimited(env.KV, ip, "roster")) {
    return Response.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const url = new URL(request.url);
  const season = parseInt(url.searchParams.get("season") ?? String(currentSeason()), 10);
  if (isNaN(season)) {
    return Response.json({ error: "Invalid season" }, { status: 400 });
  }

  const cacheKey = CACHE_KEYS.roster(teamId, season);
  const cached = await kvGet<{ teamId: string; season: number; players: unknown[] }>(env.KV, cacheKey);
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
        "Cache-Control": cacheControlHeader(TTL.roster),
        ETag: etag,
      },
    });
  }

  const rosterRows = await db.getRoster(env.DB, teamId, season);
  const players = rosterRows.map((r) => {
    try {
      return r.raw_json ? JSON.parse(r.raw_json) : { playerId: r.player_id };
    } catch {
      return { playerId: r.player_id };
    }
  });
  const payload = { teamId, season, players };
  await kvSet(env.KV, cacheKey, payload, TTL.roster);
  const body = JSON.stringify(payload);
  const etag = etagFromBody(body);
  if (checkNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControlHeader(TTL.roster),
      ETag: etag,
    },
  });
}
