// NEW FILE: Cron sync with mutex (DB lock_until only), scoreboard + live game summary (lineup/boxscore).
// CHANGED: Concurrency-safe cron mutex using DB only; release lock at end of handler.
// CHANGED: 6h refreshTeamRosters; 24h refreshPlayerSeasonStats; syncOneGameNow for admin single-game sync (best-effort, returns counts).

import {
  fetchScoreboard,
  parseScoreboard,
  fetchSummaryWithRetry,
  parsePlayByPlaySubstitutions,
  parseBoxscorePlayers,
  extractPlays,
  fetchAllNbaTeams,
  parseAllNbaTeams,
  fetchTeamRoster,
  parseTeamRoster,
  parseRosterRawToDbColumns,
  fetchAthleteStatsWeb,
  parseAthleteSeasonStatsWeb,
} from "../espn";
import * as db from "../db";
import { deriveLineup, getStartersFromBoxscore } from "../lineup/derive";
import { deriveRoster12 } from "../roster12/derive";
import { extractMinutesFromStatsJson } from "../position";
// NEW: Dynamic adjust active 12 after boxscore sync.
import { updateTeamsActive12FromBoxscore } from "../active12/deriveActive12";
import type { Env } from "../types";
import type { BoxscorePlayer } from "../types";

const SUMMARY_TIMEOUT_MS = 6000;
const CONCURRENCY_LIVE = 4;
const CONCURRENCY_ROSTER = 4;
const CONCURRENCY_STATS = 4;
// CHANGED: 110s to reduce expiry during heavy live-game sync
const CRON_LOCK_TTL_SEC = 110;

import {
  todayYmdEastern,
  dateYmdDaysAheadEastern,
  currentSeasonStartYearUtc,
  getCurrentSeasonYear,
} from "../utils/date";

async function acquireCronLock(env: Env): Promise<{ acquired: boolean }> {
  return db.acquireCronLock(env.DB, CRON_LOCK_TTL_SEC);
}

/** Number of days ahead to fetch scoreboard (today + tomorrow + day-after = 3 days of games). */
const SCOREBOARD_DAYS_AHEAD = 2;

export async function fetchScoreboardAndUpsert(env: Env): Promise<{
  gamesCount: number;
  liveCount: number;
  elapsedMs: number;
}> {
  const start = Date.now();
  const datesToFetch: string[] = [];
  for (let d = 0; d <= SCOREBOARD_DAYS_AHEAD; d++) {
    datesToFetch.push(d === 0 ? todayYmdEastern() : dateYmdDaysAheadEastern(d));
  }
  const allGames: Array<ReturnType<typeof parseScoreboard>[number]> = [];
  const seenGameIds = new Set<string>();

  try {
    for (const dateYmd of datesToFetch) {
      const data = await fetchScoreboard(env.ESPN_BASE_URL, dateYmd);
      const games = parseScoreboard(data, dateYmd);
      for (const g of games) {
        if (!seenGameIds.has(g.gameId)) {
          seenGameIds.add(g.gameId);
          allGames.push(g);
        }
      }
    }
    const games = allGames;
    const gamesCount = games.length;
    const liveCount = games.filter(
      (g) => !g.completed && g.status !== "scheduled" && g.status !== ""
    ).length;

    const rows = games.map((g) => ({
      game_id: g.gameId,
      date_ymd: g.dateYmd,
      start_time_utc: g.startTimeUtc,
      status: g.status,
      period: g.period,
      clock: g.clock,
      completed: g.completed ? 1 : 0,
      home_team_id: g.homeTeam.id,
      home_team_name: g.homeTeam.name,
      home_team_abbr: g.homeTeam.abbr,
      home_score: g.homeTeam.score,
      away_team_id: g.awayTeam.id,
      away_team_name: g.awayTeam.name,
      away_team_abbr: g.awayTeam.abbr,
      away_score: g.awayTeam.score,
      raw_json: null as string | null,
    }));

    await db.upsertGamesCurrent(env.DB, rows);
    await db.insertGamesSnapshot(env.DB, rows);

    // CHANGED: batch upsert teams (no N+1)
    const teamsMap = new Map<string, { teamId: string; name: string; abbr: string }>();
    for (const g of games) {
      teamsMap.set(g.homeTeam.id, { teamId: g.homeTeam.id, name: g.homeTeam.name, abbr: g.homeTeam.abbr });
      teamsMap.set(g.awayTeam.id, { teamId: g.awayTeam.id, name: g.awayTeam.name, abbr: g.awayTeam.abbr });
    }
    await db.upsertTeamsBatch(env.DB, Array.from(teamsMap.values()));

    await db.updateRefreshState(env.DB, {
      last_scoreboard_fetch_at: Math.floor(Date.now() / 1000),
      live_games_count: liveCount,
      last_live_detect_at: liveCount > 0 ? Math.floor(Date.now() / 1000) : undefined,
      last_error: null,
    });

    // Settle pregame_calls for any games that just completed (winner from score).
    try {
      const settled = await db.settlePregameCallsForCompletedGames(env.DB, 86400);
      if (settled > 0) console.log(`settlePregameCallsForCompletedGames: games=${settled}`);
    } catch (e) {
      console.error("settlePregameCallsForCompletedGames failed", e instanceof Error ? e.message : String(e));
    }

    const elapsedMs = Date.now() - start;
    console.log(`fetchScoreboardAndUpsert: games=${gamesCount} live=${liveCount} elapsedMs=${elapsedMs}`);
    return { gamesCount, liveCount, elapsedMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.updateRefreshState(env.DB, { last_error: msg.slice(0, 500) });
    // CHANGED: Also write to error_log (best-effort, never throw).
    try {
      await db.insertErrorLog(env.DB, "scoreboard", null, msg);
    } catch {
      // ignore
    }
    console.error("fetchScoreboardAndUpsert failed", msg);
    throw err;
  }
}

// CHANGED: Sanity checker for per-game sync — returns ok, reasons, and metrics for diagnostics.
function evaluateSyncQuality(params: {
  gameId: string;
  homeTeamId: string;
  awayTeamId: string;
  homeOnCourtIds: string[];
  awayOnCourtIds: string[];
  confidence: number;
  derivedFrom: string;
  newCursorSeq: number;
  boxscorePlayers: BoxscorePlayer[];
  statsUpserted: number;
  playersUpserted: number;
  cursorBefore: number;
  cursorAfter: number;
  insertedBoxscore: number;
  substitutionsCount: number;
}): {
  ok: boolean;
  reasons: string[];
  homeOnCourtCount: number;
  awayOnCourtCount: number;
  uniqueOnCourtCount: number;
  missingProfiles: number;
  missingStats: number;
} {
  const {
    homeTeamId,
    awayTeamId,
    homeOnCourtIds,
    awayOnCourtIds,
    confidence,
    derivedFrom,
    boxscorePlayers,
    statsUpserted,
    cursorBefore,
    cursorAfter,
    substitutionsCount,
  } = params;
  const reasons: string[] = [];
  const homeCount = homeOnCourtIds.length;
  const awayCount = awayOnCourtIds.length;
  const uniqueSet = new Set([...homeOnCourtIds, ...awayOnCourtIds]);
  const uniqueOnCourtCount = uniqueSet.size;

  // LINEUP_BAD_SIZE: home/away not in [3..5] OR not equal 5 when derivedFrom is playbyplay and confidence >= 0.7
  const inRange = (n: number) => n >= 3 && n <= 5;
  if (!inRange(homeCount) || !inRange(awayCount)) {
    reasons.push("LINEUP_BAD_SIZE");
  } else if (derivedFrom === "playbyplay" && confidence >= 0.7 && (homeCount !== 5 || awayCount !== 5)) {
    reasons.push("LINEUP_BAD_SIZE");
  }

  // DUPLICATE_ON_COURT: duplicates within home/away or across both
  if (uniqueOnCourtCount < homeCount + awayCount) reasons.push("DUPLICATE_ON_COURT");

  // MIXED_TEAMS: from boxscorePlayers playerId -> teamId; allow up to 1 mismatch per side
  const playerToTeam = new Map<string, string>();
  for (const p of boxscorePlayers) {
    if (p.teamId) playerToTeam.set(p.playerId, p.teamId);
  }
  let homeMismatch = 0;
  let awayMismatch = 0;
  for (const id of homeOnCourtIds) {
    const team = playerToTeam.get(id);
    if (team != null && team !== homeTeamId) homeMismatch++;
  }
  for (const id of awayOnCourtIds) {
    const team = playerToTeam.get(id);
    if (team != null && team !== awayTeamId) awayMismatch++;
  }
  if (homeMismatch > 1 || awayMismatch > 1) reasons.push("MIXED_TEAMS");

  // CURSOR_WENT_BACKWARDS
  if (cursorAfter < cursorBefore) reasons.push("CURSOR_WENT_BACKWARDS");

  // EMPTY_BOX_IF_LIVE: substitutions exist but boxscorePlayers empty
  if (substitutionsCount > 0 && boxscorePlayers.length === 0) reasons.push("EMPTY_BOX_IF_LIVE");

  // STATS_TOO_FEW: defensive threshold
  if (statsUpserted < 6) reasons.push("STATS_TOO_FEW");

  const boxscorePlayerIds = new Set(boxscorePlayers.map((p) => p.playerId));
  const missingStats = [...uniqueSet].filter((id) => !boxscorePlayerIds.has(id)).length;

  return {
    ok: reasons.length === 0,
    reasons,
    homeOnCourtCount: homeCount,
    awayOnCourtCount: awayCount,
    uniqueOnCourtCount,
    missingProfiles: -1,
    missingStats,
  };
}

// CHANGED: Accept cronTag; return cursorBefore/cursorAfter/lineupHomeCount/lineupAwayCount; insert game_sync_diagnostics (best-effort, never throw).
async function syncLiveGameSummary(
  env: Env,
  gameId: string,
  homeTeamId: string,
  awayTeamId: string,
  insertBoxscoreSnapshotThisRun: boolean,
  cronTag: string
): Promise<{
  playersUpserted: number;
  statsUpserted: number;
  insertedBoxscore: number;
  cursorBefore: number;
  cursorAfter: number;
  lineupHomeCount: number;
  lineupAwayCount: number;
}> {
  const zero = {
    playersUpserted: 0,
    statsUpserted: 0,
    insertedBoxscore: 0,
    cursorBefore: 0,
    cursorAfter: 0,
    lineupHomeCount: 0,
    lineupAwayCount: 0,
  };
  try {
    const summary = await fetchSummaryWithRetry(env.ESPN_BASE_URL, gameId, SUMMARY_TIMEOUT_MS);
    const plays = extractPlays(summary);
    let notes: string | null = null;
    if (plays.length === 0) {
      notes = "PBP_PLAYS_NOT_FOUND";
      const errMsg = `PBP_PLAYS_NOT_FOUND:${gameId}`.slice(0, 200);
      await db.updateRefreshState(env.DB, { last_error: errMsg });
      try {
        await db.insertErrorLog(env.DB, "syncLiveGameSummary", gameId, errMsg);
      } catch {
        // ignore
      }
    }
    const substitutions = parsePlayByPlaySubstitutions(summary);
    const boxscorePlayers = parseBoxscorePlayers(summary);

    if (boxscorePlayers.length > 0) {
      await db.upsertPlayersBatch(
        env.DB,
        boxscorePlayers.map((p) => ({
          player_id: p.playerId,
          full_name: p.fullName,
          team_id: p.teamId ?? null,
          position: p.position ?? null,
          jersey: p.jersey ?? null,
          headshot: p.headshot ?? null,
        }))
      );
    }

    const statsRows = boxscorePlayers.map((p) => ({
      game_id: gameId,
      player_id: p.playerId,
      team_id: p.teamId ?? null,
      json: JSON.stringify(p.statsJson ?? {}),
    }));
    if (statsRows.length > 0) {
      await db.upsertPlayerGameStatsCurrentBatch(env.DB, statsRows);
    }

    // NEW: Dynamic adjust active 12 for both teams after boxscore sync (near-real-time).
    try {
      await updateTeamsActive12FromBoxscore(
        env.DB,
        gameId,
        homeTeamId,
        awayTeamId,
        currentSeasonStartYearUtc(),
        14,
        boxscorePlayers
      );
    } catch {
      // best-effort: never throw
    }

    const starters = getStartersFromBoxscore(boxscorePlayers, homeTeamId, awayTeamId);
    const cursor = await db.getPlayByPlayCursor(env.DB, gameId);
    const cursorBefore = cursor?.last_event_seq ?? 0;
    const prevLineup = await db.getGameLineupCurrent(env.DB, gameId);
    const prevHome = prevLineup ? (JSON.parse(prevLineup.home_on_court_json) as string[]) : undefined;
    const prevAway = prevLineup ? (JSON.parse(prevLineup.away_on_court_json) as string[]) : undefined;

    const result = deriveLineup({
      prevLineup: prevHome && prevAway ? { homeOnCourtIds: prevHome, awayOnCourtIds: prevAway } : undefined,
      startersFromBoxscore: starters,
      substitutions,
      cursorSeq: cursorBefore,
    });

    await db.upsertGameLineupCurrent(
      env.DB,
      gameId,
      JSON.stringify(result.homeOnCourtIds),
      JSON.stringify(result.awayOnCourtIds),
      result.derivedFrom,
      result.confidence
    );
    const newEvents = substitutions
      .filter((s) => s.seq > cursorBefore && s.seq <= result.newCursorSeq)
      .map((s) => ({
        seq: s.seq,
        teamId: s.teamId,
        playerOutId: s.playerOutId,
        playerInId: s.playerInId,
        period: s.period,
        clock: s.clock ?? "",
      }));
    if (newEvents.length > 0) {
      await db.insertGameLineupEventsBatch(env.DB, gameId, newEvents);
    }
    await db.upsertPlayByPlayCursor(
      env.DB,
      gameId,
      result.newCursorSeq,
      Math.floor(Date.now() / 1000)
    );

    let insertedBoxscore = 0;
    if (insertBoxscoreSnapshotThisRun) {
      await db.insertBoxscoreSnapshot(env.DB, gameId, JSON.stringify(summary));
      insertedBoxscore = 1;
    }

    const quality = evaluateSyncQuality({
      gameId,
      homeTeamId,
      awayTeamId,
      homeOnCourtIds: result.homeOnCourtIds,
      awayOnCourtIds: result.awayOnCourtIds,
      confidence: result.confidence,
      derivedFrom: result.derivedFrom,
      newCursorSeq: result.newCursorSeq,
      boxscorePlayers,
      statsUpserted: statsRows.length,
      playersUpserted: boxscorePlayers.length,
      cursorBefore,
      cursorAfter: result.newCursorSeq,
      insertedBoxscore,
      substitutionsCount: substitutions.length,
    });

    try {
      await db.insertGameSyncDiagnostic(env.DB, {
        game_id: gameId,
        cron: cronTag,
        created_at: Math.floor(Date.now() / 1000),
        ok: quality.ok ? 1 : 0,
        reasons: quality.reasons.length > 0 ? JSON.stringify(quality.reasons) : null,
        home_on_court_count: quality.homeOnCourtCount,
        away_on_court_count: quality.awayOnCourtCount,
        unique_on_court_count: quality.uniqueOnCourtCount,
        missing_profiles: quality.missingProfiles,
        missing_stats: quality.missingStats,
        cursor_before: cursorBefore,
        cursor_after: result.newCursorSeq,
        inserted_boxscore: insertedBoxscore,
        players_upserted: boxscorePlayers.length,
        stats_upserted: statsRows.length,
        notes,
      });
    } catch {
      // best-effort: never throw
    }

    return {
      playersUpserted: boxscorePlayers.length,
      statsUpserted: statsRows.length,
      insertedBoxscore,
      cursorBefore,
      cursorAfter: result.newCursorSeq,
      lineupHomeCount: result.homeOnCourtIds.length,
      lineupAwayCount: result.awayOnCourtIds.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errMsg = `syncLiveGameSummary ${gameId}: ${msg.slice(0, 200)}`;
    await db.updateRefreshState(env.DB, { last_error: errMsg });
    try {
      await db.insertErrorLog(env.DB, "syncLiveGameSummary", gameId, errMsg);
    } catch {
      // ignore
    }
    console.error("syncLiveGameSummary failed", gameId, msg);
    return zero;
  }
}

/** Run syncLiveGameSummary for all current live games; returns synced count and aggregated metrics. */
// CHANGED: cronTag passed through for game_sync_diagnostics (e.g. "*/1", "*/2", "admin").
export async function syncAllLiveGames(env: Env, insertBoxscore: boolean = false, cronTag: string = "admin"): Promise<{
  syncedCount: number;
  playersUpserted: number;
  statsUpserted: number;
  boxscoreSnapshotsInserted: number;
}> {
  const liveGames = await db.getLiveGames(env.DB);
  let playersUpserted = 0;
  let statsUpserted = 0;
  let boxscoreSnapshotsInserted = 0;
  for (let i = 0; i < liveGames.length; i += CONCURRENCY_LIVE) {
    const batch = liveGames.slice(i, i + CONCURRENCY_LIVE).map((g) =>
      syncLiveGameSummary(env, g.game_id, g.home_team_id, g.away_team_id, insertBoxscore, cronTag)
    );
    const results = await Promise.all(batch);
    for (const r of results) {
      playersUpserted += r.playersUpserted;
      statsUpserted += r.statsUpserted;
      boxscoreSnapshotsInserted += r.insertedBoxscore;
    }
  }
  return {
    syncedCount: liveGames.length,
    playersUpserted,
    statsUpserted,
    boxscoreSnapshotsInserted,
  };
}

// CHANGED: Admin single-game sync — reuse syncLiveGameSummary logic; return counts and optional errorMessage; must not throw (best-effort).
export async function syncOneGameNow(
  env: Env,
  gameId: string,
  insertBoxscore: boolean
): Promise<{
  playersUpserted: number;
  statsUpserted: number;
  lineupUpdated: boolean;
  elapsedMs: number;
  errorMessage?: string;
}> {
  const start = Date.now();
  const zero = { playersUpserted: 0, statsUpserted: 0, lineupUpdated: false, elapsedMs: 0 };

  const game = await db.getGameById(env.DB, gameId);
  if (!game) {
    return { ...zero, elapsedMs: Date.now() - start, errorMessage: "Game not found" };
  }

  try {
    const summary = await fetchSummaryWithRetry(env.ESPN_BASE_URL, gameId, SUMMARY_TIMEOUT_MS);
    const substitutions = parsePlayByPlaySubstitutions(summary);
    const boxscorePlayers = parseBoxscorePlayers(summary);

    if (boxscorePlayers.length > 0) {
      await db.upsertPlayersBatch(
        env.DB,
        boxscorePlayers.map((p) => ({
          player_id: p.playerId,
          full_name: p.fullName,
          team_id: p.teamId ?? null,
          position: p.position ?? null,
          jersey: p.jersey ?? null,
          headshot: p.headshot ?? null,
        }))
      );
    }

    const statsRows = boxscorePlayers.map((p) => ({
      game_id: gameId,
      player_id: p.playerId,
      team_id: p.teamId ?? null,
      json: JSON.stringify(p.statsJson ?? {}),
    }));
    if (statsRows.length > 0) {
      await db.upsertPlayerGameStatsCurrentBatch(env.DB, statsRows);
    }

    const starters = getStartersFromBoxscore(boxscorePlayers, game.home_team_id, game.away_team_id);
    const cursor = await db.getPlayByPlayCursor(env.DB, gameId);
    const cursorBefore = cursor?.last_event_seq ?? 0;
    const prevLineup = await db.getGameLineupCurrent(env.DB, gameId);
    const prevHome = prevLineup ? (JSON.parse(prevLineup.home_on_court_json) as string[]) : undefined;
    const prevAway = prevLineup ? (JSON.parse(prevLineup.away_on_court_json) as string[]) : undefined;

    const result = deriveLineup({
      prevLineup: prevHome && prevAway ? { homeOnCourtIds: prevHome, awayOnCourtIds: prevAway } : undefined,
      startersFromBoxscore: starters,
      substitutions,
      cursorSeq: cursorBefore,
    });

    await db.upsertGameLineupCurrent(
      env.DB,
      gameId,
      JSON.stringify(result.homeOnCourtIds),
      JSON.stringify(result.awayOnCourtIds),
      result.derivedFrom,
      result.confidence
    );
    const newEvents = substitutions
      .filter((s) => s.seq > cursorBefore && s.seq <= result.newCursorSeq)
      .map((s) => ({
        seq: s.seq,
        teamId: s.teamId,
        playerOutId: s.playerOutId,
        playerInId: s.playerInId,
        period: s.period,
        clock: s.clock ?? "",
      }));
    if (newEvents.length > 0) {
      await db.insertGameLineupEventsBatch(env.DB, gameId, newEvents);
    }
    await db.upsertPlayByPlayCursor(
      env.DB,
      gameId,
      result.newCursorSeq,
      Math.floor(Date.now() / 1000)
    );

    if (insertBoxscore) {
      await db.insertBoxscoreSnapshot(env.DB, gameId, JSON.stringify(summary));
    }

    // NEW: Dynamic adjust active 12 for both teams after boxscore sync.
    try {
      await updateTeamsActive12FromBoxscore(
        env.DB,
        gameId,
        game.home_team_id,
        game.away_team_id,
        currentSeasonStartYearUtc(),
        14,
        boxscorePlayers
      );
    } catch {
      // best-effort: never throw
    }

    const elapsedMs = Date.now() - start;
    return {
      playersUpserted: boxscorePlayers.length,
      statsUpserted: statsRows.length,
      lineupUpdated: true,
      elapsedMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errMsg = `syncOneGameNow ${gameId}: ${msg.slice(0, 200)}`;
    await db.updateRefreshState(env.DB, { last_error: errMsg });
    try {
      await db.insertErrorLog(env.DB, "admin", gameId, errMsg);
    } catch {
      // ignore
    }
    return {
      playersUpserted: 0,
      statsUpserted: 0,
      lineupUpdated: false,
      elapsedMs: Date.now() - start,
      errorMessage: msg.slice(0, 500),
    };
  }
}

export async function handleScheduled(env: Env, event: ScheduledEvent): Promise<void> {
  const { acquired } = await acquireCronLock(env);
  if (!acquired) {
    console.log("cron lock held, skipping");
    return;
  }
  try {
    await runScheduledCron(env, event);
  } finally {
    await db.releaseCronLock(env.DB);
  }
}

// CHANGED: Instrument each cron branch with cron_runs (insert start -> run job -> finish with ok/error + metrics). Defensive: never throw.
async function runScheduledCron(env: Env, event: ScheduledEvent): Promise<void> {
  const cron = event.cron ?? "";
  const startedAt = Math.floor(Date.now() / 1000);
  let runId: number;
  try {
    runId = await db.insertCronRunStart(env.DB, cron, startedAt);
  } catch (e) {
    console.error("insertCronRunStart failed", e);
    return;
  }

  const finish = (updates: {
    ok: number;
    error?: string | null;
    live_games_count?: number;
    synced_games_count?: number;
    boxscore_snapshots_inserted?: number;
    players_upserted?: number;
    stats_upserted?: number;
  }) => {
    const finishedAt = Math.floor(Date.now() / 1000);
    return db.finishCronRun(env.DB, runId, {
      finished_at: finishedAt,
      ok: updates.ok,
      error: updates.error ?? null,
      live_games_count: updates.live_games_count ?? 0,
      synced_games_count: updates.synced_games_count ?? 0,
      boxscore_snapshots_inserted: updates.boxscore_snapshots_inserted ?? 0,
      players_upserted: updates.players_upserted ?? 0,
      stats_upserted: updates.stats_upserted ?? 0,
    });
  };

  if (cron === "*/1 * * * *") {
    try {
      // Backfill roster parsed columns from existing raw_json (runs until no rows need backfill).
      const backfillRows = await db.getRosterRowsForColumnBackfill(env.DB, 500);
      if (backfillRows.length > 0) {
        const parsed = backfillRows.map((r) => {
          const cols = parseRosterRawToDbColumns(r.raw_json);
          return { team_id: r.team_id, season: r.season, player_id: r.player_id, raw_json: r.raw_json, ...(cols ?? {}) };
        });
        await db.upsertRostersBatch(env.DB, parsed);
        console.log(`backfillRosterParsedColumns: updated ${parsed.length} rows`);
      }
      const state = await db.getRefreshState(env.DB);
      const liveCount = state?.live_games_count ?? 0;
      await db.updateRefreshState(env.DB, { last_live_check_at: startedAt });
      if (liveCount > 0) {
        await fetchScoreboardAndUpsert(env);
        const liveGames = await db.getLiveGames(env.DB);
        let playersUpserted = 0;
        let statsUpserted = 0;
        let boxscoreInserted = 0;
        for (let i = 0; i < liveGames.length; i += CONCURRENCY_LIVE) {
          const batch = liveGames.slice(i, i + CONCURRENCY_LIVE).map((g) =>
            syncLiveGameSummary(env, g.game_id, g.home_team_id, g.away_team_id, false, "*/1")
          );
          const results = await Promise.all(batch);
          for (const r of results) {
            playersUpserted += r.playersUpserted;
            statsUpserted += r.statsUpserted;
            boxscoreInserted += r.insertedBoxscore;
          }
        }
        console.log(`syncLiveGameSummary batch: games=${liveGames.length}`);
        await finish({
          ok: 1,
          live_games_count: liveGames.length,
          synced_games_count: liveGames.length,
          boxscore_snapshots_inserted: boxscoreInserted,
          players_upserted: playersUpserted,
          stats_upserted: statsUpserted,
        });
      } else {
        await finish({ ok: 1, live_games_count: 0 });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.updateRefreshState(env.DB, { last_error: msg.slice(0, 500) });
      try {
        await db.insertErrorLog(env.DB, "cron", "*/1", msg);
      } catch {
        // ignore
      }
      await finish({ ok: 0, error: msg.slice(0, 500) });
    }
    return;
  }

  if (cron === "*/2 * * * *") {
    try {
      await fetchScoreboardAndUpsert(env);
      await db.updateRefreshState(env.DB, { last_2m_refresh_at: startedAt });
      const liveGames = await db.getLiveGames(env.DB);
      const insertBoxscore = startedAt % 120 < 60;
      let playersUpserted = 0;
      let statsUpserted = 0;
      let boxscoreInserted = 0;
      for (let i = 0; i < liveGames.length; i += CONCURRENCY_LIVE) {
        const batch = liveGames.slice(i, i + CONCURRENCY_LIVE).map((g) =>
          syncLiveGameSummary(env, g.game_id, g.home_team_id, g.away_team_id, insertBoxscore, "*/2")
        );
        const results = await Promise.all(batch);
        for (const r of results) {
          playersUpserted += r.playersUpserted;
          statsUpserted += r.statsUpserted;
          boxscoreInserted += r.insertedBoxscore;
        }
      }
      console.log(`syncLiveGameSummary batch: games=${liveGames.length}`);
      await finish({
        ok: 1,
        live_games_count: liveGames.length,
        synced_games_count: liveGames.length,
        boxscore_snapshots_inserted: boxscoreInserted,
        players_upserted: playersUpserted,
        stats_upserted: statsUpserted,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.updateRefreshState(env.DB, { last_error: msg.slice(0, 500) });
      try {
        await db.insertErrorLog(env.DB, "cron", "*/2", msg);
      } catch {
        // ignore
      }
      await finish({ ok: 0, error: msg.slice(0, 500) });
    }
    return;
  }

  if (cron === "0 */6 * * *") {
    try {
      await refreshTeamRosters(env);
      await buildRecentUsage(env);
      await buildTeamRoster12Current(env);
      await finish({ ok: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.updateRefreshState(env.DB, { last_error: msg.slice(0, 500) });
      try {
        await db.insertErrorLog(env.DB, "cron", "0 */6 * * *", msg);
      } catch {
        // ignore
      }
      await finish({ ok: 0, error: msg.slice(0, 500) });
    }
    return;
  }

  if (cron === "0 0 * * *") {
    try {
      await refreshPlayerSeasonStats(env);
      const deleted = await db.cleanupSnapshots(env.DB, 7);
      const boxDeleted = await db.cleanupBoxscoreSnapshots(env.DB, 24);
      console.log(`cleanupSnapshots: deleted=${deleted} cleanupBoxscoreSnapshots: deleted=${boxDeleted}`);
      await finish({ ok: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.updateRefreshState(env.DB, { last_error: msg.slice(0, 500) });
      try {
        await db.insertErrorLog(env.DB, "cron", "0 0 * * *", msg);
      } catch {
        // ignore
      }
      await finish({ ok: 0, error: msg.slice(0, 500) });
    }
    return;
  }

  await finish({ ok: 1 });
}

const WINDOW_DAYS_RECENT_USAGE = 14;
const MAX_GAMES_PER_TEAM_RECENT = 30;

import { dateYmdDaysAgoEastern } from "../utils/date";

export async function buildRecentUsage(env: Env): Promise<{ teamsProcessed: number; rowsUpserted: number }> {
  const seasonYear = currentSeasonStartYearUtc();
  const sinceYmd = dateYmdDaysAgoEastern(WINDOW_DAYS_RECENT_USAGE);
  const teamIds = await db.getAllTeamIds(env.DB).then((ids) => ids.filter((id) => id !== ""));
  let rowsUpserted = 0;

  for (let i = 0; i < teamIds.length; i += CONCURRENCY_ROSTER) {
    const chunk = teamIds.slice(i, i + CONCURRENCY_ROSTER);
    await Promise.all(
      chunk.map(async (teamId) => {
        try {
          const games = await db.getGamesInvolvingTeamSince(
            env.DB,
            teamId,
            sinceYmd,
            MAX_GAMES_PER_TEAM_RECENT
          );
          const agg = new Map<
            string,
            { games_appeared: number; minutes_total: number; starts: number; last_seen_at: number | null }
          >();
          const gamesWithoutSnapshot: string[] = [];

          for (const g of games) {
            const snapshot = await db.getLatestBoxscoreSnapshot(env.DB, g.game_id);
            if (snapshot) {
              let summary: unknown;
              try {
                summary = JSON.parse(snapshot.json) as unknown;
              } catch {
                gamesWithoutSnapshot.push(g.game_id);
                continue;
              }
              if (summary) {
                const boxscorePlayers = parseBoxscorePlayers(summary).filter((p) => p.teamId === teamId);
                for (const p of boxscorePlayers) {
                  const minutes = extractMinutesFromStatsJson(p.statsJson ?? undefined);
                  const cur = agg.get(p.playerId);
                  if (cur) {
                    cur.games_appeared += 1;
                    cur.minutes_total += minutes;
                    if (p.isStarter) cur.starts += 1;
                    if (snapshot.fetched_at != null && (cur.last_seen_at == null || snapshot.fetched_at > cur.last_seen_at)) {
                      cur.last_seen_at = snapshot.fetched_at;
                    }
                  } else {
                    agg.set(p.playerId, {
                      games_appeared: 1,
                      minutes_total: minutes,
                      starts: p.isStarter ? 1 : 0,
                      last_seen_at: snapshot.fetched_at,
                    });
                  }
                }
                continue;
              }
            }
            gamesWithoutSnapshot.push(g.game_id);
          }
          // Fallback: for games with no boxscore snapshot, aggregate from player_game_stats_current (minutes + games_appeared; starts = 0).
          if (gamesWithoutSnapshot.length > 0) {
            const statsRows = await db.getPlayerGameStatsForGames(env.DB, gamesWithoutSnapshot);
            for (const row of statsRows) {
              if (row.team_id !== teamId) continue;
              let minutes = 0;
              try {
                const parsed = JSON.parse(row.json) as unknown;
                minutes = extractMinutesFromStatsJson(parsed as Record<string, unknown> | unknown[]);
              } catch {
                // ignore
              }
              const cur = agg.get(row.player_id);
              if (cur) {
                cur.games_appeared += 1;
                cur.minutes_total += minutes;
              } else {
                agg.set(row.player_id, {
                  games_appeared: 1,
                  minutes_total: minutes,
                  starts: 0,
                  last_seen_at: null,
                });
              }
            }
          }

          const rows = Array.from(agg.entries()).map(([player_id, v]) => ({
            player_id,
            team_id: teamId,
            season: seasonYear,
            window_days: WINDOW_DAYS_RECENT_USAGE,
            games_appeared: v.games_appeared,
            minutes_total: v.minutes_total,
            starts: v.starts,
            last_seen_at: v.last_seen_at,
          }));
          if (rows.length > 0) {
            await db.upsertRecentUsageBatch(env.DB, rows);
            rowsUpserted += rows.length;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            await db.insertErrorLog(env.DB, "recent_usage", teamId, msg.slice(0, 300));
          } catch {
            // ignore
          }
        }
      })
    );
  }

  return { teamsProcessed: teamIds.length, rowsUpserted };
}

/** Build team_roster_12_current per team (ActiveScore + position constraints). Best-effort; never throw. */
export async function buildTeamRoster12Current(env: Env): Promise<{ teamsProcessed: number }> {
  const seasonYear = currentSeasonStartYearUtc();
  const teamIds = await db.getAllTeamIds(env.DB).then((ids) => ids.filter((id) => id !== ""));

  for (let i = 0; i < teamIds.length; i += CONCURRENCY_ROSTER) {
    const chunk = teamIds.slice(i, i + CONCURRENCY_ROSTER);
    await Promise.all(
      chunk.map(async (teamId) => {
        try {
          const [rosterOrder, recentUsageRows, seasonStatsMap] = await Promise.all([
            db.getRosterForTeam(env.DB, teamId, seasonYear),
            db.getRecentUsageByTeamSeasonWindow(env.DB, teamId, seasonYear, WINDOW_DAYS_RECENT_USAGE),
            db.getPlayerSeasonStatsByIds(
              env.DB,
              seasonYear,
              (await db.getRosterForTeam(env.DB, teamId, seasonYear)).map((r) => r.player_id)
            ),
          ]);

          if (rosterOrder.length === 0) return;

          const playerIds = rosterOrder.map((r) => r.player_id);
          const playersMap = await db.getPlayersByIds(env.DB, playerIds);
          const recentUsageMap = new Map<string, db.RecentUsageRow>();
          for (const row of recentUsageRows) {
            recentUsageMap.set(`${teamId}:${row.player_id}`, row);
          }

          const result = deriveRoster12({
            rosterOrder,
            playersMap,
            recentUsageMap,
            seasonStatsMap,
            teamId,
            season: seasonYear,
          });

          await db.upsertTeamRoster12Current(env.DB, {
            team_id: teamId,
            season: seasonYear,
            player_ids_json: JSON.stringify(result.playerIds),
            positions_json: JSON.stringify(result.positions),
            method: result.method,
            constraints_json: JSON.stringify(result.constraints),
            quality_json: JSON.stringify(result.quality),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            await db.insertErrorLog(env.DB, "roster12", teamId, msg.slice(0, 300));
          } catch {
            // ignore
          }
        }
      })
    );
  }

  return { teamsProcessed: teamIds.length };
}

/** Refresh rosters for all teams: fetch roster per team (concurrency 4), upsert players + rosters batch. Returns counts for admin. */
// CHANGED: Ensure we have 30 NBA teams from ESPN /teams so roster refresh has team_id even when scoreboard returns empty.
export async function refreshTeamRosters(env: Env): Promise<{
  refreshedTeamsCount: number;
  playersUpserted: number;
  rosterRowsUpserted: number;
}> {
  const seasonStartYear = currentSeasonStartYearUtc();
  let teamIds = await db.getAllTeamIds(env.DB).then((ids) => ids.filter((id) => id !== ""));
  if (teamIds.length < 30) {
    try {
      const raw = await fetchAllNbaTeams(env.ESPN_BASE_URL, 6000);
      const teams = parseAllNbaTeams(raw).filter((t) => t.teamId !== "");
      if (teams.length > 0) {
        await db.upsertTeamsBatch(
          env.DB,
          teams.map((t) => ({ teamId: t.teamId, name: t.name, abbr: t.abbr }))
        );
        teamIds = await db.getAllTeamIds(env.DB).then((ids) => ids.filter((id) => id !== ""));
      }
    } catch (e) {
      console.error("fetchAllNbaTeams failed", e instanceof Error ? e.message : String(e));
    }
  }
  const allPlayers: Array<{ player_id: string; full_name: string; team_id: string | null; position: string | null; jersey: string | null; headshot: string | null }> = [];
  const allRosterRows: db.RosterRowInput[] = [];
  let errors = 0;

  for (let i = 0; i < teamIds.length; i += CONCURRENCY_ROSTER) {
    const chunk = teamIds.slice(i, i + CONCURRENCY_ROSTER);
    const results = await Promise.allSettled(
      chunk.map(async (teamId) => {
        const raw = await fetchTeamRoster(env.ESPN_BASE_URL, teamId, 6000);
        return parseTeamRoster(raw, teamId);
      })
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const teamId = chunk[j]!;
      if (r.status === "rejected") {
        errors++;
        const errMsg = `roster ${teamId}: ${String(r.reason).slice(0, 200)}`;
        await db.updateRefreshState(env.DB, { last_error: errMsg });
        try {
          await db.insertErrorLog(env.DB, "roster", teamId, errMsg);
        } catch {
          // ignore
        }
        continue;
      }
      const list = r.value;
      for (const p of list) {
        allPlayers.push({
          player_id: p.player_id,
          full_name: p.full_name,
          team_id: p.team_id,
          position: p.position,
          jersey: p.jersey,
          headshot: p.headshot,
        });
        const cols = parseRosterRawToDbColumns(p.raw_json);
        allRosterRows.push({
          team_id: teamId,
          season: seasonStartYear,
          player_id: p.player_id,
          raw_json: p.raw_json,
          ...(cols ?? {}),
        });
      }
    }
  }

  if (allPlayers.length > 0) {
    await db.upsertPlayersBatch(env.DB, allPlayers);
  }
  if (allRosterRows.length > 0) {
    await db.upsertRostersBatch(env.DB, allRosterRows);
  }
  console.log(`refreshTeamRosters: teams=${teamIds.length} players=${allPlayers.length} rosterRows=${allRosterRows.length} errors=${errors}`);
  return {
    refreshedTeamsCount: teamIds.length,
    playersUpserted: allPlayers.length,
    rosterRowsUpserted: allRosterRows.length,
  };
}

const SEASON_STATS_24H_SEC = 86400;

/** Max ESPN fetches per invocation to avoid "Too many API requests by single worker invocation" (Cloudflare subrequest limit). */
const MAX_PLAYER_STATS_FETCH_PER_INVOCATION = 40;

import { dateYmdToSeason } from "../utils/date";

/** Aggregate season stats from player_game_stats_current (boxscore). ESPN athlete API returns 404, so we populate from our data. */
async function aggregatePlayerSeasonStatsFromBoxscore(env: Env): Promise<number> {
  const sinceYmd = "2023-10-01"; // last ~3 seasons
  const rows = await db.getPlayerGameStatsWithDates(env.DB, sinceYmd);
  const byKey = new Map<string, Array<{ date_ymd: string; json: string }>>();
  for (const r of rows) {
    const key = `${r.player_id}:${dateYmdToSeason(r.date_ymd)}`;
    let arr = byKey.get(key);
    if (!arr) {
      arr = [];
      byKey.set(key, arr);
    }
    arr.push({ date_ymd: r.date_ymd, json: r.json });
  }
  const out: Array<{ player_id: string; season: number; stat_type: string; json: string }> = [];
  for (const [key, games] of byKey) {
    const [player_id, seasonStr] = key.split(":");
    const season = parseInt(seasonStr, 10);
    let minutes = 0;
    let points = 0;
    let rebounds = 0;
    let assists = 0;
    let steals = 0;
    let blocks = 0;
    let turnovers = 0;
    let fouls = 0;
    let plusMinus = 0;
    let fgMade = 0;
    let fgAtt = 0;
    let threeMade = 0;
    let threeAtt = 0;
    let ftMade = 0;
    let ftAtt = 0;
    let oreb = 0;
    let dreb = 0;
    for (const g of games) {
      let arr: unknown[];
      try {
        arr = JSON.parse(g.json) as unknown[];
      } catch {
        continue;
      }
      if (!Array.isArray(arr) || arr.length < 14) continue;
      const n = (v: unknown): number => (typeof v === "number" && !Number.isNaN(v) ? v : 0);
      const toNum = (v: unknown): number => {
        if (typeof v === "number" && !Number.isNaN(v)) return v;
        if (typeof v === "string") {
          const mmss = /^(\d+):(\d+)$/.exec(v.trim());
          if (mmss) return parseInt(mmss[1], 10) + parseInt(mmss[2], 10) / 60;
          const x = parseFloat(v);
          if (!Number.isNaN(x)) return x;
        }
        return 0;
      };
      const parseMadeAtt = (v: unknown): [number, number] => {
        if (typeof v === "string") {
          const [a, b] = v.split("-").map((x) => parseInt(x, 10));
          return [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0];
        }
        return [n(v), 0];
      };
      minutes += toNum(arr[0]);
      points += toNum(arr[1]);
      const [fm, fa] = parseMadeAtt(arr[2]);
      fgMade += fm;
      fgAtt += fa;
      const [tm, ta] = parseMadeAtt(arr[3]);
      threeMade += tm;
      threeAtt += ta;
      const [ftm, fta] = parseMadeAtt(arr[4]);
      ftMade += ftm;
      ftAtt += fta;
      rebounds += toNum(arr[5]);
      assists += toNum(arr[6]);
      turnovers += toNum(arr[7]);
      steals += toNum(arr[8]);
      blocks += toNum(arr[9]);
      oreb += toNum(arr[10]);
      dreb += toNum(arr[11]);
      fouls += toNum(arr[12]);
      plusMinus += toNum(arr[13]);
    }
    const gp = games.length;
    const totals = {
      gamesPlayed: gp,
      minutes,
      points,
      fieldGoalsMade: fgMade,
      fieldGoalsAttempted: fgAtt,
      threePointMade: threeMade,
      threePointAttempted: threeAtt,
      freeThrowsMade: ftMade,
      freeThrowsAttempted: ftAtt,
      rebounds,
      assists,
      turnovers,
      steals,
      blocks,
      offensiveRebounds: oreb,
      defensiveRebounds: dreb,
      fouls,
      plusMinus,
    };
    const perGame = {
      gamesPlayed: gp,
      minutes: gp ? Math.round((minutes / gp) * 10) / 10 : 0,
      points: gp ? Math.round((points / gp) * 10) / 10 : 0,
      rebounds: gp ? Math.round((rebounds / gp) * 10) / 10 : 0,
      assists: gp ? Math.round((assists / gp) * 10) / 10 : 0,
      steals: gp ? Math.round((steals / gp) * 10) / 10 : 0,
      blocks: gp ? Math.round((blocks / gp) * 10) / 10 : 0,
      turnovers: gp ? Math.round((turnovers / gp) * 10) / 10 : 0,
      fouls: gp ? Math.round((fouls / gp) * 10) / 10 : 0,
      plusMinus: gp ? Math.round((plusMinus / gp) * 10) / 10 : 0,
    };
    out.push({ player_id, season, stat_type: "totals", json: JSON.stringify(totals) });
    out.push({ player_id, season, stat_type: "perGame", json: JSON.stringify(perGame) });
  }
  if (out.length > 0) {
    await db.upsertPlayerSeasonStatsBatch(env.DB, out);
  }
  console.log(`aggregatePlayerSeasonStatsFromBoxscore: players=${byKey.size} rows=${out.length}`);
  return out.length;
}

/** Refresh player season stats: roster12 players, current season daily; past 3 seasons once. Capped per invocation to stay under subrequest limit. */
export async function refreshPlayerSeasonStats(env: Env): Promise<{
  refreshedPlayersCount: number;
  statRowsUpserted: number;
  skippedDueToLimit?: number;
  errors?: number;
}> {
  const seasonYear = currentSeasonStartYearUtc();
  const nowSec = Math.floor(Date.now() / 1000);
  const seasons = [seasonYear, seasonYear - 1, seasonYear - 2, seasonYear - 3];

  let playerIds = await db.getAllPlayerIdsFromRoster12(env.DB, seasonYear);
  if (playerIds.length === 0) {
    playerIds = await db.getRecentPlayerIds(env.DB, 450);
  }
  if (playerIds.length === 0) {
    playerIds = await db.getPlayerIdsFromRosters(env.DB, seasonYear);
  }

  const toFetch: Array<{ player_id: string; season: number }> = [];

  for (const season of seasons) {
    if (season === seasonYear) {
      const maxUpdated = await db.getPlayerSeasonStatsMaxUpdatedAt(env.DB, playerIds, season);
      for (const pid of playerIds) {
        const at = maxUpdated.get(pid);
        if (at == null || nowSec - at > SEASON_STATS_24H_SEC) {
          toFetch.push({ player_id: pid, season });
        }
      }
    } else {
      const existing = await db.getPlayerIdsWithSeasonStats(env.DB, playerIds, season);
      for (const pid of playerIds) {
        if (!existing.has(pid)) {
          toFetch.push({ player_id: pid, season });
        }
      }
    }
  }

  const uniquePlayerIds = [...new Set(toFetch.map((x) => x.player_id))].sort((a, b) => a.localeCompare(b));
  const playersToFetch = uniquePlayerIds.slice(0, MAX_PLAYER_STATS_FETCH_PER_INVOCATION);
  const skippedDueToLimit = Math.max(0, uniquePlayerIds.length - MAX_PLAYER_STATS_FETCH_PER_INVOCATION);

  const allStats: Array<{ player_id: string; season: number; stat_type: string; json: string }> = [];
  let errors = 0;

  for (let i = 0; i < playersToFetch.length; i += CONCURRENCY_STATS) {
    const chunk = playersToFetch.slice(i, i + CONCURRENCY_STATS);
    const results = await Promise.allSettled(
      chunk.map(async (player_id) => {
        const raw = await fetchAthleteStatsWeb(player_id, 6000);
        const rows = parseAthleteSeasonStatsWeb(raw);
        return rows.map((row) => ({ player_id, season: row.season, stat_type: row.stat_type, json: row.json }));
      })
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const player_id = chunk[j];
      if (r.status === "rejected") {
        errors++;
        const errMsg = `playerStats: ${String(r.reason).slice(0, 150)}`;
        await db.updateRefreshState(env.DB, { last_error: errMsg });
        try {
          await db.insertErrorLog(env.DB, "playerStats", null, errMsg);
        } catch {
          // ignore
        }
        continue;
      }
      const rows = r.value;
      if (rows.length === 0) {
        for (const season of seasons) {
          allStats.push({ player_id, season, stat_type: "raw", json: JSON.stringify({ source: "espn_web", empty: true }) });
        }
        continue;
      }
      const seasonsWritten = new Set<number>();
      for (const row of rows) {
        allStats.push(row);
        seasonsWritten.add(row.season);
      }
      for (const season of seasons) {
        if (!seasonsWritten.has(season)) {
          allStats.push({ player_id, season, stat_type: "raw", json: JSON.stringify({ source: "espn_web", noData: true }) });
        }
      }
    }
  }

  if (allStats.length > 0) {
    await db.upsertPlayerSeasonStatsBatch(env.DB, allStats);
  }
  let statRowsUpserted = allStats.length;
  const aggregated = await aggregatePlayerSeasonStatsFromBoxscore(env);
  statRowsUpserted += aggregated;
  const uniquePlayers = playersToFetch.length;
  console.log(`refreshPlayerSeasonStats: players=${uniquePlayers} skipped=${skippedDueToLimit} statRows=${allStats.length} aggregated=${aggregated} errors=${errors}`);
  const out: { refreshedPlayersCount: number; statRowsUpserted: number; skippedDueToLimit?: number; errors?: number } = {
    refreshedPlayersCount: uniquePlayers,
    statRowsUpserted,
  };
  if (skippedDueToLimit > 0) out.skippedDueToLimit = skippedDueToLimit;
  if (errors > 0) out.errors = errors;
  return out;
}
