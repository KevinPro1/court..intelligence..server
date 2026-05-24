/**
 * GET /v1/nba/games/today - today's games normalized
 * GET /v1/nba/games/:gameId/live - best-effort live info; fallback scoreboard + status
 */

import { fetchScoreboard } from "../services/espn";
import { normalizeScoreboard, normalizeGame } from "../services/normalize";
import type { ESPNScoreboardResponse, ESPNEvent } from "../types";
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

export async function gamesTodayGet(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
  if (await isRateLimited(env.KV, ip, "games-today")) {
    return Response.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const dateYmd = todayYmd();
  const cacheKey = CACHE_KEYS.gamesToday();

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
        "Cache-Control": cacheControlHeader(TTL.gamesToday),
        ETag: etag,
      },
    });
  }

  try {
    const data = await fetchScoreboard(dateYmd);
    const normalized = normalizeScoreboard(data as ESPNScoreboardResponse, dateYmd);
    await kvSet(env.KV, cacheKey, normalized, TTL.gamesToday);
    const body = JSON.stringify(normalized);
    const etag = etagFromBody(body);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(TTL.gamesToday),
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

export async function gameLiveGet(
  request: Request,
  env: Env,
  gameId: string
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
  if (await isRateLimited(env.KV, ip, "game-live")) {
    return Response.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const row = await db.getGameById(env.DB, gameId);
  if (row) {
    const teamRows = await db.getAllTeams(env.DB);
    const teamMap = new Map(teamRows.map((t) => [t.team_id, { id: t.team_id, displayName: t.name, abbreviation: t.abbr }]));
    const game = db.gameRowToNormalized(row, teamMap);
    const payload = {
      gameId: row.game_id,
      live: !game.completed,
      scoreboard: game,
      status: row.status,
      period: row.period,
      clock: row.clock,
      homeScore: row.home_score,
      awayScore: row.away_score,
    };
    const body = JSON.stringify(payload);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(30),
      },
    });
  }

  try {
    const data = await fetchScoreboard();
    const events = (data as ESPNScoreboardResponse).events ?? [];
    const event = events.find((e: ESPNEvent) => e.id === gameId);
    if (event) {
      const game = normalizeGame(event);
      const payload = {
        gameId: game.id,
        live: !game.completed,
        scoreboard: game,
        status: game.status,
        period: game.period,
        clock: game.displayClock,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
      };
      const body = JSON.stringify(payload);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": cacheControlHeader(15),
        },
      });
    }
  } catch {
    // fall through to 404
  }

  return Response.json(
    { error: "Game not found", gameId },
    { status: 404 }
  );
}
