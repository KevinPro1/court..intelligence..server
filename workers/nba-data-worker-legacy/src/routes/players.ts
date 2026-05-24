/**
 * GET /v1/nba/players/:playerId/profile - bio/basic info
 * GET /v1/nba/players/:playerId/stats?seasons=2026,2025,2024,2023 - default current + prev 3
 */

import { fetchPlayer } from "../services/espn";
import { normalizePlayerProfile } from "../services/normalize";
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
import type { NormalizedPlayerProfile, NormalizedPlayerStats } from "../types";

function currentSeason(): number {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  return month >= 9 ? year + 1 : year;
}

export async function playerProfileGet(
  request: Request,
  env: Env,
  playerId: string
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
  if (await isRateLimited(env.KV, ip, "player-profile")) {
    return Response.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const cacheKey = CACHE_KEYS.playerProfile(playerId);
  const cached = await kvGet<NormalizedPlayerProfile>(env.KV, cacheKey);
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
        "Cache-Control": cacheControlHeader(TTL.playerProfile),
        ETag: etag,
      },
    });
  }

  const row = await db.getPlayerById(env.DB, playerId);
  if (row) {
    const profile: NormalizedPlayerProfile = {
      playerId: row.player_id,
      fullName: row.full_name,
      teamId: row.team_id ?? undefined,
      position: row.position ?? undefined,
      jersey: row.jersey ?? undefined,
      headshot: row.headshot ?? undefined,
    };
    await kvSet(env.KV, cacheKey, profile, TTL.playerProfile);
    const body = JSON.stringify(profile);
    const etag = etagFromBody(body);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(TTL.playerProfile),
        ETag: etag,
      },
    });
  }

  try {
    const data = await fetchPlayer(playerId);
    const profile = normalizePlayerProfile(data, playerId);
    if (profile.fullName) {
      await db.upsertPlayer(env.DB, {
        player_id: profile.playerId,
        full_name: profile.fullName,
        team_id: profile.teamId ?? null,
        position: profile.position ?? null,
        jersey: profile.jersey ?? null,
        headshot: profile.headshot ?? null,
        updated_at: Math.floor(Date.now() / 1000),
      });
      await kvSet(env.KV, cacheKey, profile, TTL.playerProfile);
    }
    const body = JSON.stringify(profile);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(TTL.playerProfile),
        ETag: etagFromBody(body),
      },
    });
  } catch {
    return Response.json(
      { error: "Player not found", playerId, todo: "ESPN athlete endpoint may differ; implement discovery if needed" },
      { status: 404 }
    );
  }
}

export async function playerStatsGet(
  request: Request,
  env: Env,
  playerId: string
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
  if (await isRateLimited(env.KV, ip, "player-stats")) {
    return Response.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const url = new URL(request.url);
  const seasonsParam = url.searchParams.get("seasons");
  const current = currentSeason();
  const seasons: number[] = seasonsParam
    ? seasonsParam.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
    : [current, current - 1, current - 2, current - 3];

  const cacheKey = CACHE_KEYS.playerStats(playerId, seasons.sort((a, b) => b - a).join(","));
  const cached = await kvGet<{ playerId: string; seasons: NormalizedPlayerStats[] }>(env.KV, cacheKey);
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
        "Cache-Control": cacheControlHeader(TTL.playerStats),
        ETag: etag,
      },
    });
  }

  const rows = await db.getPlayerStatsForSeasons(env.DB, playerId, seasons, "regular");
  const stats: NormalizedPlayerStats[] = rows.map((r) => ({
    playerId: r.player_id,
    season: r.season,
    statType: r.stat_type,
    json: (() => {
      try {
        return JSON.parse(r.json) as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
  }));

  if (stats.length > 0) {
    await kvSet(
      env.KV,
      cacheKey,
      { playerId, seasons: stats },
      TTL.playerStats
    );
  }

  const payload = { playerId, seasons: stats };
  const body = JSON.stringify(payload);
  const etag = etagFromBody(body);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControlHeader(TTL.playerStats),
      ETag: etag,
    },
  });
}
