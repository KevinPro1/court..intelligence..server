/**
 * NBA Live Data Platform (D1) Worker.
 * Router + cron entry. Smart Refresh Engine in src/cron/sync.ts.
 * CHANGED: Cron moved to cron/sync.ts; new routes lineup, boxscore, player stats.
 * CHANGED: GET /v1/ml/games/:gameId/context for ML (game + lineup + liveStats + roster fallback + optional seasonStats); quality object; POST /v1/admin/games/:gameId/sync.
 */

import { Router } from "itty-router";
import * as db from "./db";
import { etagFromBody, checkNotModified } from "./etag";
import { handleScheduled, fetchScoreboardAndUpsert, syncAllLiveGames, refreshTeamRosters, refreshPlayerSeasonStats, buildRecentUsage, syncOneGameNow } from "./cron/sync";
import type { Roster12Constraints, Roster12Quality } from "./types";
// NEW: Debug active12 — derive without writing.
import { deriveTeamActive12, buildActive12ContextFromBoxscore } from "./active12/deriveActive12";
import { jsonOk, jsonOkWithEtag, jsonErr } from "./routes/_helpers";
import { parseRosterRawToProfile } from "./espn";
import type { Env, ApiMeta, NormalizedPlayerProfile } from "./types";

// CHANGED: Export Durable Object for real-time ESPN polling (wrangler binding).
export { GameRealtimeDO } from "./realtime/GameRealtimeDO";

const router = Router<Request, [Env]>();

// --- Response envelope (existing FE compatibility) ---
function jsonEnvelope<T>(data: T, meta: ApiMeta, init?: ResponseInit): Response {
  const body = JSON.stringify({ ok: true as const, data, meta });
  return new Response(body, {
    ...init,
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
      ...init?.headers,
    },
  });
}

function metaBase(cacheHit?: boolean): ApiMeta {
  return {
    serverTimeUtc: new Date().toISOString(),
    source: "espn",
    ...(cacheHit !== undefined && { cacheHit }),
  };
}

import { todayYmdEastern, tomorrowYmdEastern, currentSeasonStartYearUtc } from "./utils/date";

// --- Routes ---

router.get("/v1/health", (request: Request, env: Env) => {
  const data = { status: "ok", service: "beyondmarket-nba-data-worker" };
  const meta = metaBase();
  return jsonEnvelope(data, meta, {
    headers: { "Cache-Control": "no-store" },
  });
});

router.get("/v1/games/live", async (request: Request, env: Env) => {
  const rows = await db.getLiveGames(env.DB);
  const data = rows.map(db.gameCurrentRowToNormalized);
  const body = { ok: true as const, data, meta: metaBase(false) };
  const bodyStr = JSON.stringify(body);
  const etag = etagFromBody(bodyStr);
  if (checkNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(bodyStr, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=15",
      ETag: etag,
    },
  });
});

router.get("/v1/games/today", async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const dateParam = url.searchParams.get("date");
  const rows = dateParam
    ? await db.getTodayGames(env.DB, dateParam)
    : await db.getGamesForToday(env.DB, todayYmdEastern(), tomorrowYmdEastern());
  const data = rows.map(db.gameCurrentRowToNormalized);
  const body = { ok: true as const, data, meta: metaBase(false) };
  const bodyStr = JSON.stringify(body);
  const etag = etagFromBody(bodyStr);
  if (checkNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(bodyStr, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
      ETag: etag,
    },
  });
});

router.get("/v1/games/:gameId", async (request: Request, env: Env) => {
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  const current = await db.getGameById(env.DB, gameId);
  if (!current) {
    return jsonEnvelope(
      { error: "Game not found", gameId },
      metaBase(),
      { status: 404 }
    );
  }
  const snapshot = await db.getLatestSnapshotForGame(env.DB, gameId);
  const data = {
    current: db.gameCurrentRowToNormalized(current),
    latestSnapshot: snapshot
      ? {
        gameId: snapshot.game_id,
        fetchedAt: snapshot.fetched_at,
        status: snapshot.status,
        period: snapshot.period,
        clock: snapshot.clock,
        homeScore: snapshot.home_score,
        awayScore: snapshot.away_score,
      }
      : null,
  };
  const body = { ok: true as const, data, meta: metaBase(false) };
  const bodyStr = JSON.stringify(body);
  const etag = etagFromBody(bodyStr);
  if (checkNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(bodyStr, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=15",
      ETag: etag,
    },
  });
});

router.get("/v1/state", async (request: Request, env: Env) => {
  const state = await db.getRefreshState(env.DB);
  const data = state ?? {
    key: "singleton",
    last_scoreboard_fetch_at: null,
    live_games_count: 0,
    last_live_detect_at: null,
    last_live_check_at: null,
    last_2m_refresh_at: null,
    last_error: null,
    updated_at: 0,
  };
  const body = { ok: true as const, data, meta: metaBase(false) };
  const bodyStr = JSON.stringify(body);
  const etag = etagFromBody(bodyStr);
  if (checkNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(bodyStr, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=10",
      ETag: etag,
    },
  });
});

// CHANGED: All admin routes use Cache-Control: no-store.
const ADMIN_HEADERS = { "Cache-Control": "no-store" as const };

router.post("/v1/admin/refresh", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  try {
    const result = await fetchScoreboardAndUpsert(env);
    const liveSynced = result.liveCount > 0 ? (await syncAllLiveGames(env, false)).syncedCount : 0;
    return jsonEnvelope(
      { message: "Refresh completed", ...result, liveSynced },
      metaBase(),
      { headers: ADMIN_HEADERS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonEnvelope(
      { error: "Refresh failed", message: msg },
      metaBase(),
      { status: 502, headers: ADMIN_HEADERS }
    );
  }
});

router.post("/v1/admin/refresh-rosters", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  try {
    const result = await refreshTeamRosters(env);
    return jsonEnvelope(
      {
        message: "Roster refresh completed",
        refreshedTeamsCount: result.refreshedTeamsCount,
        playersUpserted: result.playersUpserted,
        rosterRowsUpserted: result.rosterRowsUpserted,
      },
      metaBase(),
      { headers: ADMIN_HEADERS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonEnvelope(
      { error: "Roster refresh failed", message: msg },
      metaBase(),
      { status: 502, headers: ADMIN_HEADERS }
    );
  }
});

router.post("/v1/admin/refresh-player-stats", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  try {
    const result = await refreshPlayerSeasonStats(env);
    return jsonEnvelope(
      {
        message: "Player stats refresh completed",
        refreshedPlayersCount: result.refreshedPlayersCount,
        statRowsUpserted: result.statRowsUpserted,
        ...(result.skippedDueToLimit != null && result.skippedDueToLimit > 0 && { skippedDueToLimit: result.skippedDueToLimit }),
        ...(result.errors != null && result.errors > 0 && { errors: result.errors }),
      },
      metaBase(),
      { headers: ADMIN_HEADERS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonEnvelope(
      { error: "Player stats refresh failed", message: msg },
      metaBase(),
      { status: 502, headers: ADMIN_HEADERS }
    );
  }
});

router.post("/v1/admin/refresh-recent-usage", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  try {
    const result = await buildRecentUsage(env);
    return jsonEnvelope(
      {
        message: "Recent usage refresh completed",
        teamsProcessed: result.teamsProcessed,
        rowsUpserted: result.rowsUpserted,
      },
      metaBase(),
      { headers: ADMIN_HEADERS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonEnvelope(
      { error: "Recent usage refresh failed", message: msg },
      metaBase(),
      { status: 502, headers: ADMIN_HEADERS }
    );
  }
});

// CHANGED: Admin force sync a single game; query param boxscore=1 to insertBoxscoreSnapshot.
router.post("/v1/admin/games/:gameId/sync", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  const url = new URL(request.url);
  const insertBoxscore = url.searchParams.get("boxscore") === "1";

  const result = await syncOneGameNow(env, gameId, insertBoxscore);
  if (result.errorMessage) {
    return jsonErr(request, "SYNC_FAILED", result.errorMessage, 502, undefined, { headers: ADMIN_HEADERS });
  }
  return jsonEnvelope(
    {
      message: "Game sync completed",
      gameId,
      playersUpserted: result.playersUpserted,
      statsUpserted: result.statsUpserted,
      lineupUpdated: result.lineupUpdated,
      elapsedMs: result.elapsedMs,
    },
    metaBase(),
    { headers: ADMIN_HEADERS }
  );
});

// Admin: record pregame snapshot (ai_prob, market_prob, picked_team) for a game. No-op if game_id already exists.
router.post("/v1/admin/pregame/snapshot", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  let body: {
    gameId: string;
    pickedTeamId: string;
    aiProb: number;
    marketProb: number;
    season: number;
    homeTeamId: string;
    awayTeamId: string;
    startTimeUtc?: string;
    modelVersion?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonEnvelope({ error: "Invalid JSON body" }, metaBase(), { status: 400, headers: ADMIN_HEADERS });
  }
  const { gameId, pickedTeamId, aiProb, marketProb, season, homeTeamId, awayTeamId, startTimeUtc, modelVersion } = body;
  if (!gameId || pickedTeamId == null || aiProb == null || marketProb == null || season == null || !homeTeamId || !awayTeamId) {
    return jsonEnvelope(
      { error: "Missing required fields: gameId, pickedTeamId, aiProb, marketProb, season, homeTeamId, awayTeamId" },
      metaBase(),
      { status: 400, headers: ADMIN_HEADERS }
    );
  }
  // Only record pregame for games that have not started; skip if already live/finished or start time passed.
  const game = await db.getGameById(env.DB, gameId);
  if (game) {
    if (game.completed === 1) {
      return jsonEnvelope({ message: "Game already finished, skipped", gameId }, metaBase(), { headers: ADMIN_HEADERS });
    }
    if (game.status === "live" || game.status === "finished") {
      return jsonEnvelope({ message: "Game already started, skipped", gameId }, metaBase(), { headers: ADMIN_HEADERS });
    }
    if (game.start_time_utc) {
      const startMs = new Date(game.start_time_utc).getTime();
      if (!Number.isNaN(startMs) && startMs < Date.now()) {
        return jsonEnvelope({ message: "Game start time already passed, skipped", gameId }, metaBase(), { headers: ADMIN_HEADERS });
      }
    }
  }
  const aiProbClamped = Math.max(0, Math.min(1, aiProb));
  const marketProbClamped = Math.max(0, Math.min(1, marketProb));
  try {
    await db.insertPregameCallIfMissing(env.DB, {
      game_id: gameId,
      season,
      created_at: Math.floor(Date.now() / 1000),
      game_start_time_utc: startTimeUtc ?? null,
      home_team_id: homeTeamId,
      away_team_id: awayTeamId,
      picked_team_id: pickedTeamId,
      ai_prob: aiProbClamped,
      market_prob: marketProbClamped,
      model_version: modelVersion ?? null,
      source: "pregame",
    });
    // 只写一次：不再对已存在的行做 update，pregame/market 赛前不变，Beyond-Market 端用 pregame_calls_sent 控制不重复推
    return jsonEnvelope({ message: "Pregame snapshot recorded (or already exists)", gameId }, metaBase(), { headers: ADMIN_HEADERS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonEnvelope({ error: "Failed to record pregame snapshot", message: msg }, metaBase(), { status: 502, headers: ADMIN_HEADERS });
  }
});

// Admin: settle pregame_calls by game result (gameId/slug = nba-away-home-YYYY-MM-DD, winnerTeamId = 3-letter abbr). Called by Beyond-Market /api/nba/pregame/settle.
router.post("/v1/admin/pregame/settle", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  let body: { results?: Array<{ gameId?: string; slug?: string; winnerTeamId: string }> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonEnvelope({ error: "Invalid JSON body" }, metaBase(), { status: 400, headers: ADMIN_HEADERS });
  }
  const results = Array.isArray(body.results) ? body.results : [];
  if (results.length === 0) {
    return jsonEnvelope({ settled: 0, message: "No results to settle" }, metaBase(), { headers: ADMIN_HEADERS });
  }
  const ts = Math.floor(Date.now() / 1000);
  let settled = 0;
  const skipped: string[] = [];
  for (const r of results) {
    const gameId = (r.gameId ?? r.slug ?? "").trim().toLowerCase();
    const winnerTeamId = (r.winnerTeamId || "").trim().toLowerCase().slice(0, 3);
    if (!gameId || !winnerTeamId) {
      if (gameId) skipped.push(`${gameId}:missing winner`);
      continue;
    }
    try {
      const updated = await db.updatePregameCallOutcomeAndScore(env.DB, gameId, winnerTeamId, ts);
      if (updated > 0) settled += 1;
      else skipped.push(gameId);
    } catch (e) {
      skipped.push(`${gameId}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return jsonEnvelope(
    { settled, updated: settled, resultsCount: results.length, skipped: skipped.length ? skipped.slice(0, 50) : undefined },
    metaBase(),
    { headers: ADMIN_HEADERS }
  );
});

// Admin: update ai_prob, market_prob, picked_team_id for an existing pregame call (completed=0). Use when refreshing market data.
router.post("/v1/admin/pregame/update", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  let body: { gameId: string; aiProb: number; marketProb: number; pickedTeamId: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonEnvelope({ error: "Invalid JSON body" }, metaBase(), { status: 400, headers: ADMIN_HEADERS });
  }
  const { gameId, aiProb, marketProb, pickedTeamId } = body;
  if (!gameId || aiProb == null || marketProb == null || !pickedTeamId) {
    return jsonEnvelope(
      { error: "Missing required fields: gameId, aiProb, marketProb, pickedTeamId" },
      metaBase(),
      { status: 400, headers: ADMIN_HEADERS }
    );
  }
  const aiProbClamped = Math.max(0, Math.min(1, aiProb));
  const marketProbClamped = Math.max(0, Math.min(1, marketProb));
  try {
    await db.updatePregameCallPregameData(env.DB, gameId.trim().toLowerCase(), {
      ai_prob: aiProbClamped,
      market_prob: marketProbClamped,
      picked_team_id: pickedTeamId.trim().toLowerCase().slice(0, 3),
    });
    return jsonEnvelope({ message: "Pregame data updated", gameId }, metaBase(), { headers: ADMIN_HEADERS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonEnvelope({ error: "Failed to update pregame data", message: msg }, metaBase(), { status: 502, headers: ADMIN_HEADERS });
  }
});

// Admin: sync today's games and update pregame_calls table with game data (without predictions).
// This ensures today's scheduled games are in pregame_calls, ready for prediction updates.
router.post("/v1/admin/pregame/sync-today", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  try {
    // First, sync today's games from scoreboard
    await fetchScoreboardAndUpsert(env);
    
    // Get today's games (scheduled or not started)
    const todayYmd = todayYmdEastern();
    const games = await db.getTodayGames(env.DB, todayYmd);
    const season = currentSeasonStartYearUtc();
    
    // Filter for scheduled games that haven't started
    const now = Date.now();
    const scheduledGames = games.filter((g) => {
      if (g.completed === 1) return false;
      if (g.status === "live" || g.status === "finished" || g.status === "in progress") return false;
      
      // Check if start time has passed
      if (g.start_time_utc) {
        const startMs = new Date(g.start_time_utc).getTime();
        if (!Number.isNaN(startMs) && startMs < now) return false;
      }
      
      return g.status === "scheduled" || g.status === "" || !g.status || g.status.toLowerCase().includes("scheduled");
    });
    
    const results: Array<{
      gameId: string;
      slug: string;
      homeTeam: string;
      awayTeam: string;
      startTime: string | null;
      hasPregameCall: boolean;
      action: string;
    }> = [];
    
    for (const game of scheduledGames) {
      const slug = db.gameRowToSlug(game);
      const existing = await env.DB.prepare("SELECT id FROM pregame_calls WHERE game_id = ?")
        .bind(slug)
        .first<{ id: number }>();
      
      const hasPregameCall = !!existing;
      let action = "skipped";
      
      // If game hasn't started and no pregame call exists, we could create a placeholder
      // But since we need ai_prob, market_prob, picked_team_id, we'll just report it
      if (!hasPregameCall) {
        action = "needs_prediction_data";
      } else {
        action = "already_exists";
      }
      
      results.push({
        gameId: game.game_id,
        slug,
        homeTeam: game.home_team_abbr ?? game.home_team_id,
        awayTeam: game.away_team_abbr ?? game.away_team_id,
        startTime: game.start_time_utc,
        hasPregameCall,
        action,
      });
    }
    
    return jsonEnvelope(
      {
        message: "Today's games synced",
        dateYmd: todayYmd,
        totalGames: scheduledGames.length,
        games: results,
        note: "Games without pregame_calls need prediction data (aiProb, marketProb, pickedTeamId) via /v1/admin/pregame/snapshot or /v1/admin/pregame/update",
      },
      metaBase(),
      { headers: ADMIN_HEADERS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonEnvelope({ error: "Failed to sync today's games", message: msg }, metaBase(), { status: 502, headers: ADMIN_HEADERS });
  }
});

// Admin: batch create/update pregame calls for today's games.
// Accepts an array of predictions or uses default values if not provided.
router.post("/v1/admin/pregame/batch-today", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  
  let body: {
    predictions?: Array<{
      gameId?: string;
      slug?: string;
      aiProb: number;
      marketProb: number;
      pickedTeamId: string;
      modelVersion?: string;
    }>;
    defaultAiProb?: number;
    defaultMarketProb?: number;
  };
  
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonEnvelope({ error: "Invalid JSON body" }, metaBase(), { status: 400, headers: ADMIN_HEADERS });
  }
  
  try {
    // Sync today's games first
    await fetchScoreboardAndUpsert(env);
    
    const todayYmd = todayYmdEastern();
    const games = await db.getTodayGames(env.DB, todayYmd);
    const season = currentSeasonStartYearUtc();
    const now = Date.now();
    
    // Filter for scheduled games that haven't started
    const scheduledGames = games.filter((g) => {
      if (g.completed === 1) return false;
      if (g.status === "live" || g.status === "finished" || g.status === "in progress") return false;
      if (g.start_time_utc) {
        const startMs = new Date(g.start_time_utc).getTime();
        if (!Number.isNaN(startMs) && startMs < now) return false;
      }
      return g.status === "scheduled" || g.status === "" || !g.status || g.status.toLowerCase().includes("scheduled");
    });
    
    // Build prediction map from body.predictions
    const predictionMap = new Map<string, { aiProb: number; marketProb: number; pickedTeamId: string; modelVersion?: string }>();
    if (Array.isArray(body.predictions)) {
      for (const pred of body.predictions) {
        const key = (pred.slug ?? pred.gameId ?? "").toLowerCase();
        if (key) {
          predictionMap.set(key, {
            aiProb: Math.max(0, Math.min(1, pred.aiProb)),
            marketProb: Math.max(0, Math.min(1, pred.marketProb)),
            pickedTeamId: pred.pickedTeamId.trim().toLowerCase().slice(0, 3),
            modelVersion: pred.modelVersion ?? null,
          });
        }
      }
    }
    
    const defaultAiProb = body.defaultAiProb != null ? Math.max(0, Math.min(1, body.defaultAiProb)) : 0.5;
    const defaultMarketProb = body.defaultMarketProb != null ? Math.max(0, Math.min(1, body.defaultMarketProb)) : 0.5;
    
    const results: Array<{
      gameId: string;
      slug: string;
      homeTeam: string;
      awayTeam: string;
      action: string;
      error?: string;
    }> = [];
    
    let created = 0;
    let updated = 0;
    let skipped = 0;
    
    for (const game of scheduledGames) {
      const slug = db.gameRowToSlug(game);
      const homeTeamId = (game.home_team_abbr ?? game.home_team_id).toLowerCase().slice(0, 3);
      const awayTeamId = (game.away_team_abbr ?? game.away_team_id).toLowerCase().slice(0, 3);
      
      // Get prediction data (from map or defaults)
      const pred = predictionMap.get(slug);
      const aiProb = pred?.aiProb ?? defaultAiProb;
      const marketProb = pred?.marketProb ?? defaultMarketProb;
      const pickedTeamId = pred?.pickedTeamId ?? (aiProb > 0.5 ? homeTeamId : awayTeamId);
      const modelVersion = pred?.modelVersion ?? null;
      
      try {
        // Check if pregame call exists
        const existing = await env.DB.prepare("SELECT id, completed FROM pregame_calls WHERE game_id = ?")
          .bind(slug)
          .first<{ id: number; completed: number }>();
        
        if (existing) {
          if (existing.completed === 1) {
            results.push({
              gameId: game.game_id,
              slug,
              homeTeam: game.home_team_abbr ?? game.home_team_id,
              awayTeam: game.away_team_abbr ?? game.away_team_id,
              action: "skipped_already_settled",
            });
            skipped++;
            continue;
          }
          
          // Update existing
          await db.updatePregameCallPregameData(env.DB, slug, {
            ai_prob: aiProb,
            market_prob: marketProb,
            picked_team_id: pickedTeamId,
          });
          results.push({
            gameId: game.game_id,
            slug,
            homeTeam: game.home_team_abbr ?? game.home_team_id,
            awayTeam: game.away_team_abbr ?? game.away_team_id,
            action: "updated",
          });
          updated++;
        } else {
          // Create new
          await db.insertPregameCallIfMissing(env.DB, {
            game_id: slug,
            season,
            created_at: Math.floor(Date.now() / 1000),
            game_start_time_utc: game.start_time_utc ?? null,
            home_team_id: homeTeamId,
            away_team_id: awayTeamId,
            picked_team_id: pickedTeamId,
            ai_prob: aiProb,
            market_prob: marketProb,
            model_version: modelVersion,
            source: "pregame",
          });
          results.push({
            gameId: game.game_id,
            slug,
            homeTeam: game.home_team_abbr ?? game.home_team_id,
            awayTeam: game.away_team_abbr ?? game.away_team_id,
            action: "created",
          });
          created++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          gameId: game.game_id,
          slug,
          homeTeam: game.home_team_abbr ?? game.home_team_id,
          awayTeam: game.away_team_abbr ?? game.away_team_id,
          action: "error",
          error: msg.slice(0, 200),
        });
      }
    }
    
    return jsonEnvelope(
      {
        message: "Batch pregame update completed",
        dateYmd: todayYmd,
        summary: {
          totalGames: scheduledGames.length,
          created,
          updated,
          skipped,
        },
        games: results,
      },
      metaBase(),
      { headers: ADMIN_HEADERS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonEnvelope({ error: "Failed to batch update pregame calls", message: msg }, metaBase(), { status: 502, headers: ADMIN_HEADERS });
  }
});

// CHANGED: Admin-only smoke test — validates DB tables + basic queries; never throws; Cache-Control: no-store.
const SMOKE_EXPECTED_TABLES = [
  "games_current",
  "games_snapshot",
  "refresh_state",
  "teams",
  "players",
  "rosters",
  "player_season_stats",
  "game_lineup_current",
  "game_playbyplay_cursor",
  "player_game_stats_current",
  "player_game_stats_keys",
  "game_boxscore_snapshot",
  "player_recent_usage",
  "team_roster_12_current",
  "cron_runs",
  "game_sync_diagnostics",
  "error_log",
  "pregame_calls",
];

router.get("/v1/admin/smoke", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }

  const report: {
    ok: boolean;
    tablesOk: boolean;
    refreshStateOk: boolean;
    gamesCount: number;
    liveSampleOk: boolean | null;
    lineupOk: boolean | null;
    statsOk: boolean | null;
    boxscoreOk: boolean | null;
    error?: string;
    sampleGameId?: string;
  } = {
    ok: false,
    tablesOk: false,
    refreshStateOk: false,
    gamesCount: 0,
    liveSampleOk: null,
    lineupOk: null,
    statsOk: null,
    boxscoreOk: null,
  };

  try {
    const tableNames = await db.listTables(env.DB);
    const tableSet = new Set(tableNames);
    report.tablesOk = SMOKE_EXPECTED_TABLES.every((t) => tableSet.has(t));
    if (!report.tablesOk) {
      const missing = SMOKE_EXPECTED_TABLES.filter((t) => !tableSet.has(t));
      report.error = `Missing tables: ${missing.join(", ")}`;
      return jsonEnvelope(report, metaBase(), { status: 200, headers: { "Cache-Control": "no-store" } });
    }

    const state = await db.getRefreshState(env.DB);
    report.refreshStateOk = state != null;

    const latestGames = await db.getGamesCurrentLatest(env.DB, 3);
    report.gamesCount = latestGames.length;

    const liveGame = latestGames.find(
      (g) => g.completed === 0 && g.status !== "scheduled" && g.status !== ""
    );
    if (liveGame) {
      report.sampleGameId = liveGame.game_id;
      try {
        const [lineup, statsRows, boxscore] = await Promise.all([
          db.getGameLineupCurrent(env.DB, liveGame.game_id),
          db.getPlayerGameStatsForGame(env.DB, liveGame.game_id),
          db.getLatestBoxscoreSnapshot(env.DB, liveGame.game_id),
        ]);
        report.liveSampleOk = true;
        report.lineupOk = lineup != null;
        report.statsOk = Array.isArray(statsRows);
        report.boxscoreOk = boxscore != null;
      } catch (e) {
        report.liveSampleOk = false;
        report.error = e instanceof Error ? e.message : String(e);
      }
    }

    report.ok = report.tablesOk && report.refreshStateOk;
    return jsonEnvelope(report, metaBase(), { status: 200, headers: ADMIN_HEADERS });
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    return jsonEnvelope(report, metaBase(), { status: 200, headers: ADMIN_HEADERS });
  }
});

// CHANGED: Admin diagnostics — lock/state; never throw; HTTP 200 body { ok, data } or { ok, error }.
function diagnosticsResponse(ok: true, data: unknown): Response;
function diagnosticsResponse(ok: false, error: string): Response;
function diagnosticsResponse(ok: boolean, dataOrError: unknown): Response {
  const body = ok ? JSON.stringify({ ok: true, data: dataOrError }) : JSON.stringify({ ok: false, error: dataOrError });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", ...ADMIN_HEADERS },
  });
}

router.get("/v1/admin/diagnostics/state", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const [state, liveGames] = await Promise.all([db.getRefreshState(env.DB), db.getLiveGames(env.DB)]);
    const isLocked = state?.lock_until != null && state.lock_until > nowSec;
    const lockRemainingSec = state?.lock_until != null && state.lock_until > nowSec ? state.lock_until - nowSec : 0;
    const data = {
      refresh_state: state,
      serverTimeUtc: new Date().toISOString(),
      isLocked,
      lockRemainingSec,
      liveGamesCountFromState: state?.live_games_count ?? 0,
      liveGamesCountActual: liveGames.length,
    };
    return diagnosticsResponse(true, data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return diagnosticsResponse(false, msg);
  }
});

// CHANGED: Admin diagnostics — latest N games with age and live-game lineup/stats; never throw.
router.get("/v1/admin/diagnostics/games", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  try {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "10", 10) || 10), 50);
    const nowSec = Math.floor(Date.now() / 1000);
    const games = await db.getRecentGames(env.DB, limit);
    const items: Array<{
      gameId: string;
      status: string;
      completed: number;
      updated_at: number;
      date_ymd: string;
      start_time_utc: string | null;
      ageSec: number;
      lineupExists?: boolean;
      lineupUpdatedAt?: number;
      confidence?: number;
      statsMaxUpdatedAt?: number | null;
    }> = [];
    for (const g of games) {
      const ageSec = nowSec - g.updated_at;
      const isLive = g.completed === 0 && g.status !== "scheduled" && g.status !== "";
      const item: (typeof items)[0] = {
        gameId: g.game_id,
        status: g.status,
        completed: g.completed,
        updated_at: g.updated_at,
        date_ymd: g.date_ymd,
        start_time_utc: g.start_time_utc,
        ageSec,
      };
      if (isLive) {
        try {
          const [lineup, statsMax] = await Promise.all([
            db.getGameLineupCurrent(env.DB, g.game_id),
            db.getPlayerGameStatsUpdatedAtMax(env.DB, g.game_id),
          ]);
          item.lineupExists = lineup != null;
          item.lineupUpdatedAt = lineup?.updated_at;
          item.confidence = lineup?.confidence;
          item.statsMaxUpdatedAt = statsMax ?? undefined;
        } catch {
          item.lineupExists = false;
        }
      }
      items.push(item);
    }
    return diagnosticsResponse(true, { games: items });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return diagnosticsResponse(false, msg);
  }
});

// CHANGED: Admin diagnostics — per-game bundle (game, lineup, cursor, stats, boxscore age, quality flags); never throw.
router.get("/v1/admin/diagnostics/game/:gameId", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const [gameRow, lineup, cursor, statsRows, statsMax, boxscoreMeta] = await Promise.all([
      db.getGameById(env.DB, gameId),
      db.getGameLineupCurrent(env.DB, gameId),
      db.getPlayByPlayCursor(env.DB, gameId),
      db.getPlayerGameStatsForGame(env.DB, gameId),
      db.getPlayerGameStatsUpdatedAtMax(env.DB, gameId),
      db.getBoxscoreSnapshotMeta(env.DB, gameId),
    ]);
    if (!gameRow) {
      return diagnosticsResponse(false, "Game not found");
    }
    const statsCount = statsRows.length;
    const statsMaxUpdatedAt = statsMax ?? null;
    const statsAgeSec = statsMaxUpdatedAt != null ? nowSec - statsMaxUpdatedAt : null;
    let lineupIdsCount = 0;
    let lineupUpdatedAt: number | null = null;
    let lineupAgeSec: number | null = null;
    if (lineup) {
      try {
        const homeIds = JSON.parse(lineup.home_on_court_json) as string[];
        const awayIds = JSON.parse(lineup.away_on_court_json) as string[];
        lineupIdsCount = homeIds.length + awayIds.length;
      } catch {
        // ignore
      }
      lineupUpdatedAt = lineup.updated_at;
      lineupAgeSec = nowSec - lineup.updated_at;
    }
    const statsPlayerIds = new Set(statsRows.map((r) => r.player_id));
    let lineupPlayerIds: string[] = [];
    try {
      if (lineup) {
        const homeIds = JSON.parse(lineup.home_on_court_json) as string[];
        const awayIds = JSON.parse(lineup.away_on_court_json) as string[];
        lineupPlayerIds = [...homeIds, ...awayIds];
      }
    } catch {
      // ignore
    }
    const missingStatsCount = lineupPlayerIds.filter((id) => !statsPlayerIds.has(id)).length;
    const STALE_THRESHOLD_SEC = 120;
    const has10Players = lineupIdsCount === 10;
    const statsStale = statsAgeSec != null && statsAgeSec > STALE_THRESHOLD_SEC;
    const lineupStale = lineupAgeSec != null && lineupAgeSec > STALE_THRESHOLD_SEC;
    const boxscoreAgeSec = boxscoreMeta?.fetched_at != null ? nowSec - boxscoreMeta.fetched_at : null;
    const data = {
      game: db.gameCurrentRowToNormalized(gameRow),
      lineup: lineup
        ? {
          idsCount: lineupIdsCount,
          confidence: lineup.confidence,
          derivedFrom: lineup.derived_from,
          updatedAt: lineup.updated_at,
          ageSec: lineupAgeSec,
        }
        : null,
      playbyplayCursor: cursor,
      liveStats: { count: statsCount, maxUpdatedAt: statsMaxUpdatedAt, ageSec: statsAgeSec },
      boxscoreSnapshotAgeSec: boxscoreAgeSec,
      quality: {
        has10Players,
        missingStatsCount,
        statsStale,
        lineupStale,
      },
    };
    return diagnosticsResponse(true, data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return diagnosticsResponse(false, msg);
  }
});

// --- New NBA lineup / boxscore / player stats (use shared helpers) ---

function playerRowToProfile(row: db.PlayerRow | null): NormalizedPlayerProfile {
  if (!row) return { playerId: "", fullName: "" };
  return {
    playerId: row.player_id,
    fullName: row.full_name,
    teamId: row.team_id ?? undefined,
    position: row.position ?? undefined,
    jersey: row.jersey ?? undefined,
    headshot: row.headshot ?? undefined,
  };
}

// CHANGED: ML context - parse roster raw_json for fallback (defensive; no throw).
function profileFromRosterRaw(playerId: string, rawJson: string | null): Partial<NormalizedPlayerProfile> {
  const out: Partial<NormalizedPlayerProfile> = { playerId };
  if (!rawJson || typeof rawJson !== "string") return out;
  try {
    const o = JSON.parse(rawJson) as Record<string, unknown>;
    const name = o?.displayName ?? o?.fullName ?? (o as { name?: string }).name;
    if (name != null) out.fullName = String(name);
    const pos = (o?.position as { abbreviation?: string })?.abbreviation ?? (o as { position?: string }).position;
    if (pos != null) out.position = String(pos);
    const jersey = o?.jersey ?? (o as { jerseyNumber?: string }).jerseyNumber;
    if (jersey != null) out.jersey = String(jersey);
    const headshotObj = o?.headshot ?? (o as { headShot?: unknown }).headShot;
    const href = headshotObj != null && typeof headshotObj === "object" && "href" in headshotObj ? (headshotObj as { href?: string }).href : null;
    if (href != null) out.headshot = String(href);
  } catch {
    // defensive
  }
  return out;
}

router.get("/v1/nba/games/:gameId/lineup", async (request: Request, env: Env) => {
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  const lineup = await db.getGameLineupCurrent(env.DB, gameId);
  if (!lineup) {
    return jsonErr(request, "NOT_FOUND", "Lineup not found for game", 404);
  }
  let homeIds: string[] = [];
  let awayIds: string[] = [];
  try {
    homeIds = JSON.parse(lineup.home_on_court_json) as string[];
    awayIds = JSON.parse(lineup.away_on_court_json) as string[];
  } catch {
    // keep empty
  }
  // CHANGED: single query getPlayersByIds (no N+1); preserve order matching homeIds/awayIds
  const allIds = [...homeIds, ...awayIds];
  const playersMap = allIds.length > 0 ? await db.getPlayersByIds(env.DB, allIds) : new Map<string, db.PlayerRow>();
  const homeProfiles: NormalizedPlayerProfile[] = homeIds.map((id) => {
    const row = playersMap.get(id);
    return row ? playerRowToProfile(row) : { playerId: id, fullName: "" };
  });
  const awayProfiles: NormalizedPlayerProfile[] = awayIds.map((id) => {
    const row = playersMap.get(id);
    return row ? playerRowToProfile(row) : { playerId: id, fullName: "" };
  });
  const data = {
    gameId,
    homeOnCourt: homeProfiles,
    awayOnCourt: awayProfiles,
    confidence: lineup.confidence,
    derivedFrom: lineup.derived_from,
    updatedAt: lineup.updated_at,
  };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=15" });
});

router.get("/v1/nba/games/:gameId/lineup-history", async (request: Request, env: Env) => {
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  const events = await db.getGameLineupEvents(env.DB, gameId);
  const data = {
    gameId,
    events: events.map((e) => ({
      eventSeq: e.event_seq,
      teamId: e.team_id,
      playerOutId: e.player_out_id,
      playerInId: e.player_in_id,
      period: e.period,
      clock: e.clock,
      createdAt: e.created_at,
    })),
  };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=15" });
});

router.get("/v1/nba/games/:gameId/boxscore", async (request: Request, env: Env) => {
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  const snapshot = await db.getLatestBoxscoreSnapshot(env.DB, gameId);
  if (!snapshot) {
    return jsonErr(request, "NOT_FOUND", "Boxscore snapshot not found for game", 404);
  }
  let json: unknown = {};
  try {
    json = JSON.parse(snapshot.json) as unknown;
  } catch {
    json = { raw: snapshot.json };
  }
  const data = { gameId, fetchedAt: snapshot.fetched_at, boxscore: json };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=30" });
});

router.get("/v1/nba/games/:gameId/players/stats", async (request: Request, env: Env) => {
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  const rows = await db.getPlayerGameStatsForGame(env.DB, gameId);
  const data = rows.map((r) => ({
    playerId: r.player_id,
    teamId: r.team_id,
    stats: (() => {
      try {
        return JSON.parse(r.json) as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
  }));
  return jsonOkWithEtag(request, { gameId, players: data }, { cacheHit: false }, { cacheControl: "public, max-age=15" });
});

/** Reference: keys for player_game_stats_current.json array (ordinal -> key_name, label, description). */
router.get("/v1/nba/stats-keys", async (request: Request, env: Env) => {
  const keys = await db.getPlayerGameStatsKeys(env.DB);
  const data = {
    description: "player_game_stats_current.json is an array; index i maps to keys[i].",
    keys: keys.map((k) => ({ ordinal: k.ordinal, key: k.key_name, label: k.label, description: k.description })),
  };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=86400" });
});

/** Pregame track record: list pregame calls with summary. Query: limit (default 50), rangeDays (default 30). */
function pregameCallLabel(row: db.PregameCallRow): string {
  if (row.completed !== 1) return "PENDING";
  const beatMarket = row.beat_market === 1;
  const pickCorrect = row.pick_correct === 1;
  if (beatMarket && pickCorrect) return "BEAT_MARKET ✅";
  if (beatMarket && !pickCorrect) return "BEAT_MARKET (calibration win)";
  if (!beatMarket && pickCorrect) return "MATCH_WIN_BUT_NO_EDGE";
  return "MISS";
}

router.get("/v1/nba/track-record/pregame", async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50), 100);
  const rangeDays = Math.min(Math.max(1, parseInt(url.searchParams.get("rangeDays") ?? "30", 10) || 30), 365);
  const sinceSec = rangeDays * 86400;

  const [calls, teamsList] = await Promise.all([
    db.listPregameCalls(env.DB, limit, { sinceSec }),
    db.getTeams(env.DB),
  ]);
  const teamMap = new Map(teamsList.map((t) => [t.team_id, { id: t.team_id, abbr: t.abbr, name: t.name }]));

  const completed = calls.filter((c) => c.completed === 1);
  const pickWins = completed.filter((c) => c.pick_correct === 1).length;
  const pickLosses = completed.length - pickWins;
  const pickWinRate = completed.length > 0 ? pickWins / completed.length : 0;
  const beatMarketWins = completed.filter((c) => c.beat_market === 1).length;
  const beatMarketRate = completed.length > 0 ? beatMarketWins / completed.length : 0;
  const avgAiError =
    completed.length > 0 && completed.some((c) => c.ai_error != null)
      ? completed.reduce((s, c) => s + (c.ai_error ?? 0), 0) / completed.length
      : null;
  const avgMarketError =
    completed.length > 0 && completed.some((c) => c.market_error != null)
      ? completed.reduce((s, c) => s + (c.market_error ?? 0), 0) / completed.length
      : null;

  const summary = {
    rangeDays,
    sampleSize: calls.length,
    pickWins,
    pickLosses,
    pickWinRate,
    beatMarketWins,
    beatMarketRate,
    avgAiError,
    avgMarketError,
  };

  // Confidence buckets (high >= 0.62, medium >= 0.55, low < 0.55) from completed calls
  const CONF_HIGH = 0.62;
  const CONF_MEDIUM = 0.55;
  const highConf = completed.filter((c) => c.ai_prob >= CONF_HIGH);
  const mediumConf = completed.filter((c) => c.ai_prob >= CONF_MEDIUM && c.ai_prob < CONF_HIGH);
  const lowConf = completed.filter((c) => c.ai_prob < CONF_MEDIUM);
  const bucketWinRate = (arr: typeof completed) =>
    arr.length === 0 ? 0 : arr.filter((c) => c.pick_correct === 1).length / arr.length;
  const marketCorrect = (c: db.PregameCallRow) =>
    (c.market_prob >= 0.5 && c.pick_correct === 1) || (c.market_prob < 0.5 && c.pick_correct !== 1);
  const bucketVsMarket = (arr: typeof completed): number | null => {
    if (arr.length === 0) return null;
    const aiWins = arr.filter((c) => c.pick_correct === 1).length;
    const mktWins = arr.filter(marketCorrect).length;
    return aiWins / arr.length - mktWins / arr.length;
  };
  const confidenceBuckets = [
    { bucket: "high" as const, label: "High (≥62%)", win_rate: bucketWinRate(highConf), vs_market: bucketVsMarket(highConf), count: highConf.length },
    { bucket: "medium" as const, label: "Medium (55-62%)", win_rate: bucketWinRate(mediumConf), vs_market: bucketVsMarket(mediumConf), count: mediumConf.length },
    { bucket: "low" as const, label: "Low (<55%)", win_rate: bucketWinRate(lowConf), vs_market: bucketVsMarket(lowConf), count: lowConf.length },
  ];

  // Calibration buckets (ai_prob ranges) from completed calls
  const calibrationRanges: { range: string; min: number; max: number }[] = [
    { range: "45-50%", min: 0.45, max: 0.5 },
    { range: "50-55%", min: 0.5, max: 0.55 },
    { range: "55-60%", min: 0.55, max: 0.6 },
    { range: "60-65%", min: 0.6, max: 0.65 },
    { range: "65-70%", min: 0.65, max: 0.7 },
    { range: "70-80%", min: 0.7, max: 0.8 },
    { range: "80-90%", min: 0.8, max: 0.9 },
  ];
  const calibrationBuckets = calibrationRanges
    .map(({ range, min, max }) => {
      const bucket = completed.filter((c) => c.ai_prob >= min && c.ai_prob < max);
      const count = bucket.length;
      const predicted_avg = count > 0 ? bucket.reduce((s, c) => s + c.ai_prob, 0) / count : (min + max) / 2;
      const realized_rate = count > 0 ? bucket.filter((c) => c.pick_correct === 1).length / count : 0;
      return { range, min_prob: min, max_prob: max, predicted_avg, realized_rate, count, ideal: (min + max) / 2 };
    })
    .filter((b) => b.count > 0);

  const gameIds = [...new Set(calls.map((c) => c.game_id))];
  const gameRows = await Promise.all(gameIds.map((id) => db.getGameById(env.DB, id)));
  const gameByGameId = new Map<string, { game_id: string; home_score: number; away_score: number; completed: number }>();
  gameRows.forEach((g) => {
    if (g) gameByGameId.set(g.game_id, g);
  });

  const callsPayload = calls.map((c) => {
    const home = teamMap.get(c.home_team_id) ?? { id: c.home_team_id, abbr: c.home_team_id, name: c.home_team_id };
    const away = teamMap.get(c.away_team_id) ?? { id: c.away_team_id, abbr: c.away_team_id, name: c.away_team_id };
    const game = gameByGameId.get(c.game_id);
    return {
      gameId: c.game_id,
      createdAt: c.created_at,
      homeTeam: home,
      awayTeam: away,
      pickedTeamId: c.picked_team_id,
      aiProb: c.ai_prob,
      marketProb: c.market_prob,
      completed: c.completed === 1,
      winnerTeamId: c.winner_team_id ?? undefined,
      pickCorrect: c.pick_correct === 1,
      beatMarket: c.beat_market === 1,
      aiError: c.ai_error ?? undefined,
      marketError: c.market_error ?? undefined,
      label: pregameCallLabel(c),
      finalScore:
        game && game.completed === 1
          ? { home: game.home_score, away: game.away_score }
          : undefined,
      gameTimeUtc: c.game_start_time_utc ?? undefined,
    };
  });

  const data = { summary, calls: callsPayload, confidenceBuckets, calibrationBuckets };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=60" });
});

// Normalized player profile from players table + roster raw_json (ESPN athlete object).
router.get("/v1/nba/players/:playerId", async (request: Request, env: Env) => {
  const playerId = (request as Request & { params?: { playerId?: string } }).params?.playerId ?? "";
  const url = new URL(request.url);
  const includeRaw = url.searchParams.get("raw") === "1";
  const includeSeasonStats = url.searchParams.get("seasonStats") !== "0";

  const [playerRow, rosterRow] = await Promise.all([
    db.getPlayerById(env.DB, playerId),
    db.getRosterByPlayerId(env.DB, playerId),
  ]);

  const seasonYear = currentSeasonStartYearUtc();
  let profileFromRoster = parseRosterRawToProfile(rosterRow?.raw_json ?? null);
  const profile = (() => {
    const base = playerRow
      ? {
        id: playerRow.player_id,
        displayName: playerRow.full_name,
        position: playerRow.position ?? undefined,
        jersey: playerRow.jersey ?? undefined,
        headshot: playerRow.headshot ?? undefined,
      }
      : profileFromRoster
        ? {
          id: profileFromRoster.id,
          displayName: profileFromRoster.displayName,
          position: profileFromRoster.position,
          jersey: profileFromRoster.jersey,
          headshot: profileFromRoster.headshot,
        }
        : { id: playerId, displayName: "" };
    if (profileFromRoster) {
      return {
        ...base,
        weight: profileFromRoster.weight,
        height: profileFromRoster.height,
        college: profileFromRoster.college,
        birthPlace: profileFromRoster.birthPlace,
        contract: profileFromRoster.contract,
        status: profileFromRoster.status,
        statusDetail: profileFromRoster.statusDetail,
        injuries: profileFromRoster.injuries,
        experience: profileFromRoster.experience,
      };
    }
    return base;
  })();

  const data: Record<string, unknown> = {
    playerId,
    profile,
    teamId: rosterRow?.team_id ?? playerRow?.team_id ?? undefined,
    season: rosterRow?.season ?? undefined,
  };
  if (includeSeasonStats && (playerRow || rosterRow)) {
    const statsMap = await db.getPlayerSeasonStatsByIds(env.DB, seasonYear, [playerId]);
    const seasonStats = statsMap.get(playerId);
    if (seasonStats) data.seasonStats = { season: seasonYear, ...seasonStats };
  }
  if (includeRaw && rosterRow?.raw_json) {
    try {
      data.raw = JSON.parse(rosterRow.raw_json) as unknown;
    } catch {
      data.raw = rosterRow.raw_json;
    }
  }
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=60" });
});

router.get("/v1/nba/players/:playerId/season-stats", async (request: Request, env: Env) => {
  const playerId = (request as Request & { params?: { playerId?: string } }).params?.playerId ?? "";
  const url = new URL(request.url);
  const seasonParam = url.searchParams.get("season");
  const seasonYear = seasonParam ? parseInt(seasonParam, 10) : currentSeasonStartYearUtc();

  if (seasonParam != null && isNaN(seasonYear)) {
    return jsonErr(request, "BAD_REQUEST", "Invalid season", 400);
  }

  if (seasonParam != null) {
    const map = await db.getPlayerSeasonStatsByIds(env.DB, seasonYear, [playerId]);
    const stats = map.get(playerId);
    const data = { playerId, season: seasonYear, stats: stats ?? null };
    return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=60" });
  }

  const rows = await db.getPlayerSeasonStatsByPlayerId(env.DB, playerId);
  const bySeason = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    let obj = bySeason.get(r.season);
    if (!obj) {
      obj = {};
      bySeason.set(r.season, obj);
    }
    try {
      const parsed = JSON.parse(r.json) as unknown;
      if (r.stat_type === "perGame") (obj as Record<string, unknown>).perGame = parsed;
      else if (r.stat_type === "totals") (obj as Record<string, unknown>).totals = parsed;
      else if (r.stat_type === "advanced") (obj as Record<string, unknown>).advanced = parsed;
      else (obj as Record<string, unknown>).raw = parsed;
    } catch {
      (obj as Record<string, unknown>).raw = r.json;
    }
  }
  const data = {
    playerId,
    seasons: Array.from(bySeason.entries()).map(([season, stats]) => ({ season, stats })),
  };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=60" });
});

// CHANGED: Parse positions_json supporting legacy array or new map format; returns both for getPosGroupFromParsed.
function parsePositionsJson(rowPositionsJson: string): { positionsArr: string[]; positionsMap: Record<string, string> } {
  const positionsArr: string[] = [];
  const positionsMap: Record<string, string> = {};
  try {
    const raw = JSON.parse(rowPositionsJson) as unknown;
    if (Array.isArray(raw)) {
      raw.forEach((v) => positionsArr.push(typeof v === "string" ? v : String(v)));
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string") positionsMap[k] = v;
      }
    }
  } catch {
    // keep empty
  }
  return { positionsArr, positionsMap };
}

// CHANGED: Resolve posGroup from map (prefer) or array by index; sanitize to G|F|C|UNK.
function getPosGroupFromParsed(
  positionsArr: string[],
  positionsMap: Record<string, string>,
  playerId: string,
  idx: number
): "G" | "F" | "C" | "UNK" {
  const raw = positionsMap[playerId] ?? positionsArr[idx];
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (s === "G" || s === "F" || s === "C" || s === "UNK") return s;
  return "UNK";
}

// CHANGED: Active 12 roster per team (recent usage + position constraints).
router.get("/v1/nba/teams/:teamId/roster12", async (request: Request, env: Env) => {
  const teamId = (request as Request & { params?: { teamId?: string } }).params?.teamId ?? "";
  const url = new URL(request.url);
  const seasonParam = url.searchParams.get("season");
  const seasonYear = seasonParam ? parseInt(seasonParam, 10) : currentSeasonStartYearUtc();
  if (isNaN(seasonYear)) {
    return jsonErr(request, "BAD_REQUEST", "Invalid season", 400);
  }

  const row = await db.getTeamRoster12(env.DB, teamId, seasonYear);
  if (!row) {
    return jsonErr(request, "NOT_FOUND", "Roster12 not found for team", 404);
  }

  let playerIds: string[] = [];
  try {
    playerIds = JSON.parse(row.player_ids_json) as string[];
  } catch {
    // keep empty
  }
  // CHANGED: support positions_json as array (legacy) or map (new).
  const { positionsArr, positionsMap } = parsePositionsJson(row.positions_json);
  const constraints = (() => {
    try {
      return JSON.parse(row.constraints_json) as Roster12Constraints;
    } catch {
      return { minG: 3, minF: 3, minC: 1, maxC: 3 };
    }
  })();
  const quality = (() => {
    try {
      return JSON.parse(row.quality_json) as Roster12Quality;
    } catch {
      return { ok: false, reasons: [], counts: { G: 0, F: 0, C: 0, UNK: 0 }, filledByUNK: false };
    }
  })();

  const includePastSeasons = url.searchParams.get("includePastSeasons") === "1";
  const seasons = includePastSeasons
    ? [seasonYear, seasonYear - 1, seasonYear - 2, seasonYear - 3]
    : [seasonYear];

  const roster12Promises: [
    Promise<Map<string, db.PlayerRow>>,
    Promise<Map<string, db.RecentUsageRow>>,
    ...Promise<Map<string, db.SeasonStatsByPlayer>>[]
  ] = [
      playerIds.length > 0 ? db.getPlayersByIds(env.DB, playerIds) : Promise.resolve(new Map<string, db.PlayerRow>()),
      db.getRecentUsageByTeamIds(env.DB, [teamId], seasonYear, 14),
      ...seasons.map((s) => db.getPlayerSeasonStatsByIds(env.DB, s, playerIds)),
    ];
  const [playersMap, recentUsageMap, ...seasonStatsMaps] = await Promise.all(roster12Promises);

  const seasonStatsBySeasonMaps: Map<number, Map<string, db.SeasonStatsByPlayer>> = new Map();
  seasons.forEach((s, i) => {
    const m = seasonStatsMaps[i];
    if (m) seasonStatsBySeasonMaps.set(s, m);
  });

  const players = playerIds.map((id, idx) => {
    const profile = playerRowToProfile(playersMap.get(id) ?? null);
    // CHANGED: use compatible posGroup from map or array.
    const posGroup = getPosGroupFromParsed(positionsArr, positionsMap, id, idx);
    const recentUsage = (() => {
      const r = recentUsageMap.get(`${teamId}:${id}`);
      if (!r) return undefined;
      return {
        games_appeared: r.games_appeared,
        minutes_total: r.minutes_total,
        starts: r.starts,
        last_seen_at: r.last_seen_at,
      };
    })();
    const seasonStatsBySeasonRes: Record<number, unknown> | undefined = includePastSeasons
      ? {}
      : undefined;
    if (includePastSeasons && seasonStatsBySeasonRes) {
      for (const s of seasons) {
        const map = seasonStatsBySeasonMaps.get(s);
        if (map) {
          const stats = map.get(id);
          if (stats) seasonStatsBySeasonRes[s] = stats;
        }
      }
    }
    return {
      profile: { ...profile, playerId: id },
      posGroup,
      ...(recentUsage && { recentUsage }),
      ...(seasonStatsBySeasonRes && Object.keys(seasonStatsBySeasonRes).length > 0 && { seasonStatsBySeason: seasonStatsBySeasonRes }),
    };
  });

  const data = {
    teamId,
    season: seasonYear,
    players,
    quality,
    constraints,
  };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=60" });
});

// CHANGED: ML-only API - model input friendly: game + lineup (10 on-court) + liveStats + roster fallback + optional seasonStats (no N+1).
// includeRoster12=1 adds both teams roster12; includePastSeasons=1 adds last 3 seasons stats for roster12 players.
router.get("/v1/ml/games/:gameId/context", async (request: Request, env: Env) => {
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  const url = new URL(request.url);
  const includeSeason = url.searchParams.get("includeSeason") === "1";
  const includeRoster12 = url.searchParams.get("includeRoster12") === "1";
  const includePastSeasons = url.searchParams.get("includePastSeasons") === "1";

  const gameRow = await db.getGameById(env.DB, gameId);
  if (!gameRow) {
    return jsonErr(request, "NOT_FOUND", "Game not found", 404);
  }
  const lineupRow = await db.getGameLineupCurrent(env.DB, gameId);
  if (!lineupRow) {
    return jsonErr(request, "NOT_FOUND", "Lineup not found for game", 404);
  }

  let homeOnCourtIds: string[] = [];
  let awayOnCourtIds: string[] = [];
  try {
    homeOnCourtIds = JSON.parse(lineupRow.home_on_court_json) as string[];
    awayOnCourtIds = JSON.parse(lineupRow.away_on_court_json) as string[];
  } catch {
    // keep empty
  }
  const allPlayerIds = [...new Set([...homeOnCourtIds, ...awayOnCourtIds])];

  const seasonYear = currentSeasonStartYearUtc();
  let roster12RowsMap = new Map<string, db.TeamRoster12Row>();
  if (includeRoster12) {
    roster12RowsMap = await db.getTeamRoster12ByTeamIds(
      env.DB,
      [gameRow.home_team_id, gameRow.away_team_id],
      seasonYear
    );
  }

  const [playersMap, liveStatsRows, rosterMap, seasonStatsMap, statsMaxUpdatedAt] = await Promise.all([
    allPlayerIds.length > 0 ? db.getPlayersByIds(env.DB, allPlayerIds) : Promise.resolve(new Map<string, db.PlayerRow>()),
    db.getPlayerGameStatsForGame(env.DB, gameId),
    allPlayerIds.length > 0 ? db.getRosterRowsByPlayerIds(env.DB, seasonYear, allPlayerIds) : Promise.resolve(new Map<string, db.RosterRowByPlayer>()),
    includeSeason && allPlayerIds.length > 0 ? db.getPlayerSeasonStatsByIds(env.DB, seasonYear, allPlayerIds) : Promise.resolve(new Map<string, db.SeasonStatsByPlayer>()),
    db.getPlayerGameStatsUpdatedAtMax(env.DB, gameId),
  ]);

  // CHANGED: toProfile returns { profile, fromRoster } for quality counts; avoid N+1.
  function toProfileResult(id: string): { profile: NormalizedPlayerProfile; fromRoster: boolean } {
    const row = playersMap.get(id);
    let profile: NormalizedPlayerProfile = row ? playerRowToProfile(row) : { playerId: id, fullName: "" };
    const roster = rosterMap.get(id);
    let fromRoster = false;
    if (roster && (!profile.fullName || !profile.position)) {
      fromRoster = true;
      const fallback = profileFromRosterRaw(id, roster.raw_json);
      profile = {
        playerId: id,
        fullName: profile.fullName || fallback.fullName || "",
        teamId: profile.teamId ?? fallback.teamId,
        position: profile.position ?? fallback.position,
        jersey: profile.jersey ?? fallback.jersey,
        headshot: profile.headshot ?? fallback.headshot,
      };
    }
    return { profile, fromRoster };
  }

  const homeResults = homeOnCourtIds.map(toProfileResult);
  const awayResults = awayOnCourtIds.map(toProfileResult);
  const homeOnCourt: NormalizedPlayerProfile[] = homeResults.map((r) => r.profile);
  const awayOnCourt: NormalizedPlayerProfile[] = awayResults.map((r) => r.profile);

  const liveStats = {
    players: liveStatsRows.map((r) => ({
      playerId: r.player_id,
      teamId: r.team_id,
      stats: (() => {
        try {
          return JSON.parse(r.json) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
    })),
  };

  let seasonStats: { season: number; players: Record<string, { perGame?: unknown; totals?: unknown; advanced?: unknown; raw?: unknown }> } | undefined;
  if (includeSeason && seasonStatsMap.size > 0) {
    const players: Record<string, { perGame?: unknown; totals?: unknown; advanced?: unknown; raw?: unknown }> = {};
    for (const [pid, obj] of seasonStatsMap) {
      players[pid] = obj;
    }
    seasonStats = { season: seasonYear, players };
  }

  // CHANGED: Add quality object for ML safety (lineupAgeSec, statsAgeSec, missingProfiles, missingStats, profileFromRoster).
  const nowSec = Math.floor(Date.now() / 1000);
  const lineupAgeSec = nowSec - lineupRow.updated_at;
  const statsAgeSec = statsMaxUpdatedAt != null ? nowSec - statsMaxUpdatedAt : null;
  const missingProfiles =
    homeResults.filter((r) => !r.profile.fullName).length + awayResults.filter((r) => !r.profile.fullName).length;
  const profileFromRoster = homeResults.filter((r) => r.fromRoster).length + awayResults.filter((r) => r.fromRoster).length;
  const liveStatsPlayerIds = new Set(liveStatsRows.map((r) => r.player_id));
  const missingStats = allPlayerIds.filter((id) => !liveStatsPlayerIds.has(id)).length;

  // CHANGED: ML quality gate — ok and reasons; thresholds: lineupAgeSec<=30, statsAgeSec!=null&&<=30, missingStats<=2, missingProfiles==0.
  const LINEUP_AGE_THRESHOLD_SEC = 30;
  const STATS_AGE_THRESHOLD_SEC = 30;
  const MISSING_STATS_THRESHOLD = 2;
  const reasons: string[] = [];
  if (lineupAgeSec > LINEUP_AGE_THRESHOLD_SEC) reasons.push("LINEUP_STALE");
  if (statsAgeSec == null || statsAgeSec > STATS_AGE_THRESHOLD_SEC) reasons.push("STATS_STALE");
  if (missingStats > MISSING_STATS_THRESHOLD) reasons.push("MISSING_STATS");
  if (missingProfiles > 0) reasons.push("MISSING_PROFILES");
  const qualityOk = reasons.length === 0;

  let roster12Home: unknown = undefined;
  let roster12Away: unknown = undefined;
  if (includeRoster12 && roster12RowsMap.size > 0) {
    const roster12PlayerIds = new Set<string>();
    for (const row of roster12RowsMap.values()) {
      try {
        const ids = JSON.parse(row.player_ids_json) as string[];
        ids.forEach((id: string) => roster12PlayerIds.add(id));
      } catch {
        //
      }
    }
    const roster12Ids = Array.from(roster12PlayerIds);
    const seasonsPast = includePastSeasons ? [seasonYear, seasonYear - 1, seasonYear - 2, seasonYear - 3] : [seasonYear];
    const [roster12PlayersMap, recentUsageR12, ...pastSeasonMaps] = await Promise.all([
      roster12Ids.length > 0 ? db.getPlayersByIds(env.DB, roster12Ids) : Promise.resolve(new Map<string, db.PlayerRow>()),
      db.getRecentUsageByTeamIds(env.DB, [gameRow.home_team_id, gameRow.away_team_id], seasonYear, 14),
      ...seasonsPast.map((s) => db.getPlayerSeasonStatsByIds(env.DB, s, roster12Ids)),
    ]);
    const buildRoster12Bundle = (teamId: string) => {
      const row = roster12RowsMap.get(teamId);
      if (!row) return undefined;
      let playerIds: string[] = [];
      try {
        playerIds = JSON.parse(row.player_ids_json) as string[];
      } catch {
        return undefined;
      }
      // CHANGED: support positions_json as array (legacy) or map (new); do not return undefined for map.
      const { positionsArr, positionsMap } = parsePositionsJson(row.positions_json);
      const quality = (() => {
        try {
          return JSON.parse(row.quality_json) as Roster12Quality;
        } catch {
          return { ok: false, reasons: [], counts: { G: 0, F: 0, C: 0, UNK: 0 }, filledByUNK: false };
        }
      })();
      const constraints = (() => {
        try {
          return JSON.parse(row.constraints_json) as Roster12Constraints;
        } catch {
          return { minG: 3, minF: 3, minC: 1, maxC: 3 };
        }
      })();
      const players = playerIds.map((id, idx) => {
        const profile = playerRowToProfile(roster12PlayersMap.get(id) ?? null);
        // CHANGED: use compatible posGroup from map or array.
        const posGroup = getPosGroupFromParsed(positionsArr, positionsMap, id, idx);
        const recentUsage = (() => {
          const r = recentUsageR12.get(`${teamId}:${id}`);
          if (!r) return undefined;
          return { games_appeared: r.games_appeared, minutes_total: r.minutes_total, starts: r.starts, last_seen_at: r.last_seen_at };
        })();
        const seasonStatsBySeason: Record<number, unknown> = {};
        seasonsPast.forEach((s, i) => {
          const m = pastSeasonMaps[i] as Map<string, db.SeasonStatsByPlayer> | undefined;
          if (m) {
            const stats = m.get(id);
            if (stats) seasonStatsBySeason[s] = stats;
          }
        });
        return {
          profile: { ...profile, playerId: id },
          posGroup,
          ...(recentUsage && { recentUsage }),
          ...(Object.keys(seasonStatsBySeason).length > 0 && { seasonStatsBySeason: seasonStatsBySeason }),
        };
      });
      return { teamId, season: seasonYear, players, quality, constraints };
    };
    roster12Home = buildRoster12Bundle(gameRow.home_team_id);
    roster12Away = buildRoster12Bundle(gameRow.away_team_id);
  }

  const data = {
    quality: {
      ok: qualityOk,
      reasons,
      lineupAgeSec,
      statsAgeSec,
      missingProfiles,
      missingStats,
      profileFromRoster,
    },
    game: db.gameCurrentRowToNormalized(gameRow),
    lineup: {
      homeOnCourt,
      awayOnCourt,
      confidence: lineupRow.confidence,
      derivedFrom: lineupRow.derived_from,
      updatedAt: lineupRow.updated_at,
    },
    liveStats,
    ...(seasonStats !== undefined && { seasonStats }),
    ...(includeRoster12 && (roster12Home != null || roster12Away != null) ? { roster12: { home: roster12Home, away: roster12Away } } : {}),
  };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "public, max-age=15" });
});

// CHANGED: Admin-protected debug — latest sync diagnostics for a game; Cache-Control: no-store; jsonOkWithEtag.
router.get("/v1/debug/games/:gameId/sync-diagnostics", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20), 100);
  const rows = await db.getGameSyncDiagnostics(env.DB, gameId, limit);
  return jsonOkWithEtag(request, { gameId, diagnostics: rows }, { cacheHit: false }, { cacheControl: "no-store" });
});

// CHANGED: Admin-protected quick debug — game row, lineup row, latest boxscore fetched_at, last 5 diagnostics summary.
router.get("/v1/debug/games/:gameId/quick", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  const [game, lineup, boxscoreSnapshot, diagnostics] = await Promise.all([
    db.getGameById(env.DB, gameId),
    db.getGameLineupCurrent(env.DB, gameId),
    db.getLatestBoxscoreSnapshot(env.DB, gameId),
    db.getGameSyncDiagnostics(env.DB, gameId, 5),
  ]);
  const data = {
    game,
    lineup,
    boxscoreFetchedAt: boxscoreSnapshot?.fetched_at ?? null,
    diagnosticsSummary: diagnostics.map((d) => {
      let reasons: string[] = [];
      if (d.reasons != null) {
        try {
          reasons = JSON.parse(d.reasons) as string[];
        } catch {
          reasons = [];
        }
      }
      return { id: d.id, created_at: d.created_at, ok: d.ok, reasons };
    }),
  };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "no-store" });
});

// NEW: Admin-only debug — team active12 current row, derived result (no write), recentUsage top 20, roster count.
router.get("/v1/debug/teams/:teamId/active12", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  const teamId = (request as Request & { params?: { teamId?: string } }).params?.teamId ?? "";
  const url = new URL(request.url);
  const seasonParam = url.searchParams.get("season");
  const seasonYear = seasonParam ? parseInt(seasonParam, 10) : currentSeasonStartYearUtc();
  const windowDays = Math.min(Math.max(1, parseInt(url.searchParams.get("windowDays") ?? "14", 10) || 14), 30);
  if (isNaN(seasonYear)) {
    return jsonErr(request, "BAD_REQUEST", "Invalid season", 400);
  }

  const [current, derived, recentUsageTop, rosterOrder] = await Promise.all([
    db.getTeamRoster12(env.DB, teamId, seasonYear),
    deriveTeamActive12(env.DB, teamId, seasonYear, windowDays, buildActive12ContextFromBoxscore([])),
    db.getRecentUsageByTeamSeasonWindow(env.DB, teamId, seasonYear, windowDays).then((rows) => rows.slice(0, 20)),
    db.getRosterForTeam(env.DB, teamId, seasonYear),
  ]);

  const data = {
    teamId,
    season: seasonYear,
    windowDays,
    current: current ?? null,
    derived,
    recentUsageTop,
    rosterCount: rosterOrder.length,
  };
  return jsonOkWithEtag(request, data, { cacheHit: false }, { cacheControl: "no-store" });
});

// CHANGED: Admin-only debug endpoint — latest cron_runs rows; X-ADMIN-KEY required; Cache-Control: no-store.
router.get("/v1/debug/cron-runs", async (request: Request, env: Env) => {
  const adminKey = request.headers.get("X-ADMIN-KEY");
  if (adminKey !== env.ADMIN_KEY) {
    return jsonEnvelope({ error: "Unauthorized" }, metaBase(), { status: 401, headers: ADMIN_HEADERS });
  }
  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20), 100);
  const rows = await db.getCronRuns(env.DB, limit);
  return jsonOkWithEtag(request, { cronRuns: rows }, { cacheHit: false }, { cacheControl: "no-store" });
});

router.get("/", () => {
  const data = {
    service: "beyondmarket-nba-data-worker",
    health: "/v1/health",
    games: "/v1/games/live",
    today: "/v1/games/today",
  };
  return jsonEnvelope(data, metaBase(), { headers: { "Cache-Control": "no-store" } });
});

// CHANGED: Real-time endpoints — forward to Durable Object (no D1 writes on fast path).
router.get("/v1/rt/nba/games/:gameId/context", async (request: Request, env: Env) => {
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  if (!gameId) return jsonErr(request, "BAD_REQUEST", "Missing gameId", 400);
  if (!env.RT) return jsonErr(request, "UNAVAILABLE", "Realtime not configured", 503);
  const doUrl = new URL(request.url);
  doUrl.pathname = "/context";
  const doRequest = new Request(doUrl.toString(), { method: "GET", headers: new Headers(request.headers) });
  doRequest.headers.set("X-Game-Id", gameId);
  const stub = env.RT.get(env.RT.idFromName("game:" + gameId));
  try {
    return await stub.fetch(doRequest);
  } catch (err) {
    console.error("RT context DO error:", err);
    return jsonErr(request, "BAD_GATEWAY", "Realtime unavailable", 502);
  }
});

router.get("/v1/rt/nba/games/:gameId/stream", async (request: Request, env: Env) => {
  const gameId = (request as Request & { params?: { gameId?: string } }).params?.gameId ?? "";
  if (!gameId) return jsonErr(request, "BAD_REQUEST", "Missing gameId", 400);
  if (!env.RT) return jsonErr(request, "UNAVAILABLE", "Realtime not configured", 503);
  const doUrl = new URL(request.url);
  doUrl.pathname = "/stream";
  const doRequest = new Request(doUrl.toString(), { method: "GET", headers: new Headers(request.headers) });
  doRequest.headers.set("X-Game-Id", gameId);
  const stub = env.RT.get(env.RT.idFromName("game:" + gameId));
  try {
    return await stub.fetch(doRequest);
  } catch (err) {
    console.error("RT stream DO error:", err);
    return jsonErr(request, "BAD_GATEWAY", "Realtime unavailable", 502);
  }
});

router.all("*", () =>
  jsonEnvelope({ error: "Not Found" }, metaBase(), { status: 404 })
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await router.handle(request, env);
    } catch (err) {
      console.error(err);
      return jsonEnvelope(
        { error: "Internal Server Error" },
        metaBase(),
        { status: 500 }
      );
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await handleScheduled(env, event);
  },
};
