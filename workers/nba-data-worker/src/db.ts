/**
 * D1 query helpers for NBA Live Data Platform.
 * All timestamps in Unix seconds (integer).
 * CHANGED: Batch upserts for games_current/games_snapshot; lineup/boxscore helpers; cron lock.
 * CHANGED: getAllTeams alias; getRosterRowsByPlayerIds, getPlayerSeasonStatsByIds for ML context (no N+1).
 * CHANGED: cron_runs observability — insertCronRunStart, finishCronRun, getCronRuns.
 */

import type {
  GameCurrentRow,
  GameSnapshotRow,
  RefreshStateRow,
  NormalizedGame,
} from "./types";

const now = () => Math.floor(Date.now() / 1000);

// CHANGED: 110s to reduce expiry during heavy live-game sync
const CRON_LOCK_TTL_SEC = 110;

/** D1 per-query bound vars limit is 100; chunk IN clauses to avoid "too many SQL variables". */
const MAX_IN_CLAUSE = 99;

function chunkIds<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- refresh_state (singleton) ---

const SINGLETON_KEY = "singleton";

export async function getRefreshState(db: D1Database): Promise<RefreshStateRow | null> {
  const row = await db
    .prepare("SELECT * FROM refresh_state WHERE key = ?")
    .bind(SINGLETON_KEY)
    .first<RefreshStateRow>();
  return row ?? null;
}

export async function updateRefreshState(
  db: D1Database,
  updates: {
    last_scoreboard_fetch_at?: number | null;
    live_games_count?: number;
    last_live_detect_at?: number | null;
    last_live_check_at?: number | null;
    last_2m_refresh_at?: number | null;
    last_error?: string | null;
    lock_until?: number | null;
  }
): Promise<void> {
  const state = await getRefreshState(db);
  const ts = now();
  const last_scoreboard_fetch_at = updates.last_scoreboard_fetch_at ?? state?.last_scoreboard_fetch_at ?? null;
  const live_games_count = updates.live_games_count ?? state?.live_games_count ?? 0;
  const last_live_detect_at = updates.last_live_detect_at ?? state?.last_live_detect_at ?? null;
  const last_live_check_at = updates.last_live_check_at ?? state?.last_live_check_at ?? null;
  const last_2m_refresh_at = updates.last_2m_refresh_at ?? state?.last_2m_refresh_at ?? null;
  const last_error = updates.last_error !== undefined ? updates.last_error : state?.last_error ?? null;
  const lock_until = updates.lock_until !== undefined ? updates.lock_until : state?.lock_until ?? null;

  await db
    .prepare(
      `INSERT INTO refresh_state (key, last_scoreboard_fetch_at, live_games_count, last_live_detect_at, last_live_check_at, last_2m_refresh_at, last_error, lock_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         last_scoreboard_fetch_at = excluded.last_scoreboard_fetch_at,
         live_games_count = excluded.live_games_count,
         last_live_detect_at = excluded.last_live_detect_at,
         last_live_check_at = excluded.last_live_check_at,
         last_2m_refresh_at = excluded.last_2m_refresh_at,
         last_error = excluded.last_error,
         lock_until = excluded.lock_until,
         updated_at = excluded.updated_at`
    )
    .bind(SINGLETON_KEY, last_scoreboard_fetch_at, live_games_count, last_live_detect_at, last_live_check_at, last_2m_refresh_at, last_error, lock_until, ts)
    .run();
}

/** Cron mutex: set lock_until to prevent re-entry. Returns { acquired }. */
export async function acquireCronLock(
  db: D1Database,
  ttlSeconds: number = CRON_LOCK_TTL_SEC
): Promise<{ acquired: boolean }> {
  const ts = now();
  const lockUntil = ts + ttlSeconds;
  const r = await db
    .prepare(
      `UPDATE refresh_state SET lock_until = ?, updated_at = ? WHERE key = ? AND (lock_until IS NULL OR lock_until <= ?)`
    )
    .bind(lockUntil, ts, SINGLETON_KEY, ts)
    .run();
  const acquired = (r.meta.changes ?? 0) === 1;
  return { acquired };
}

/** Release cron lock (clear lock_until for singleton). */
export async function releaseCronLock(db: D1Database): Promise<void> {
  await db
    .prepare(`UPDATE refresh_state SET lock_until = NULL, updated_at = ? WHERE key = ?`)
    .bind(now(), SINGLETON_KEY)
    .run();
}

// CHANGED: Smoke test helper — list all table names from sqlite_master.
export async function listTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  return (results ?? []).map((r) => r.name);
}

// --- games_current (CHANGED: use db.batch) ---

type GameCurrentInput = {
  game_id: string;
  date_ymd: string;
  start_time_utc?: string | null;
  status: string;
  period: number;
  clock: string;
  completed: number;
  home_team_id: string;
  home_team_name?: string | null;
  home_team_abbr?: string | null;
  home_score: number;
  away_team_id: string;
  away_team_name?: string | null;
  away_team_abbr?: string | null;
  away_score: number;
  raw_json?: string | null;
};

const upsertGameCurrentSql = `INSERT INTO games_current (
  game_id, date_ymd, start_time_utc, status, period, clock, completed,
  home_team_id, home_team_name, home_team_abbr, home_score,
  away_team_id, away_team_name, away_team_abbr, away_score,
  raw_json, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(game_id) DO UPDATE SET
  date_ymd = excluded.date_ymd,
  start_time_utc = excluded.start_time_utc,
  status = excluded.status,
  period = excluded.period,
  clock = excluded.clock,
  completed = excluded.completed,
  home_team_id = excluded.home_team_id,
  home_team_name = excluded.home_team_name,
  home_team_abbr = excluded.home_team_abbr,
  home_score = excluded.home_score,
  away_team_id = excluded.away_team_id,
  away_team_name = excluded.away_team_name,
  away_team_abbr = excluded.away_team_abbr,
  away_score = excluded.away_score,
  raw_json = excluded.raw_json,
  updated_at = excluded.updated_at`;

export async function upsertGamesCurrent(db: D1Database, games: GameCurrentInput[]): Promise<void> {
  const ts = now();
  if (games.length === 0) return;
  const stmt = db.prepare(upsertGameCurrentSql);
  const batch = games.map((g) =>
    stmt.bind(
      g.game_id,
      g.date_ymd,
      g.start_time_utc ?? null,
      g.status,
      g.period ?? 0,
      g.clock ?? "",
      g.completed ?? 0,
      g.home_team_id,
      g.home_team_name ?? null,
      g.home_team_abbr ?? null,
      g.home_score ?? 0,
      g.away_team_id,
      g.away_team_name ?? null,
      g.away_team_abbr ?? null,
      g.away_score ?? 0,
      g.raw_json ?? null,
      ts
    )
  );
  await db.batch(batch);
}

// CHANGED: use db.batch for insertGamesSnapshot
export async function insertGamesSnapshot(db: D1Database, games: GameCurrentInput[]): Promise<void> {
  const fetchedAt = now();
  if (games.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO games_snapshot (
      game_id, fetched_at, date_ymd, start_time_utc, status, period, clock, completed,
      home_team_id, home_team_name, home_team_abbr, home_score,
      away_team_id, away_team_name, away_team_abbr, away_score,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const batch = games.map((g) =>
    stmt.bind(
      g.game_id,
      fetchedAt,
      g.date_ymd,
      g.start_time_utc ?? null,
      g.status,
      g.period ?? 0,
      g.clock ?? "",
      g.completed ?? 0,
      g.home_team_id,
      g.home_team_name ?? null,
      g.home_team_abbr ?? null,
      g.home_score ?? 0,
      g.away_team_id,
      g.away_team_name ?? null,
      g.away_team_abbr ?? null,
      g.away_score ?? 0,
      g.raw_json ?? null
    )
  );
  await db.batch(batch);
}

export async function getLiveGames(db: D1Database): Promise<GameCurrentRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM games_current WHERE completed = 0 AND status != 'scheduled' AND status != '' ORDER BY updated_at DESC"
    )
    .all<GameCurrentRow>();
  return results ?? [];
}

export async function getTodayGames(db: D1Database, dateYmd: string): Promise<GameCurrentRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM games_current WHERE date_ymd = ? ORDER BY start_time_utc ASC, updated_at DESC")
    .bind(dateYmd)
    .all<GameCurrentRow>();
  return results ?? [];
}

/** Games where date_ymd is in [dateYmd1, dateYmd2] (for /v1/games/today: Eastern today + tomorrow). */
export async function getGamesForToday(
  db: D1Database,
  dateYmd1: string,
  dateYmd2: string
): Promise<GameCurrentRow[]> {
  if (dateYmd1 === dateYmd2) {
    return getTodayGames(db, dateYmd1);
  }
  const { results } = await db
    .prepare(
      "SELECT * FROM games_current WHERE date_ymd = ? OR date_ymd = ? ORDER BY start_time_utc ASC, updated_at DESC"
    )
    .bind(dateYmd1, dateYmd2)
    .all<GameCurrentRow>();
  const seen = new Set<string>();
  const deduped: GameCurrentRow[] = [];
  for (const row of results ?? []) {
    if (seen.has(row.game_id)) continue;
    seen.add(row.game_id);
    deduped.push(row);
  }
  deduped.sort((a, b) => (a.start_time_utc ?? "").localeCompare(b.start_time_utc ?? ""));
  return deduped;
}

export async function getGameById(db: D1Database, gameId: string): Promise<GameCurrentRow | null> {
  const row = await db
    .prepare("SELECT * FROM games_current WHERE game_id = ?")
    .bind(gameId)
    .first<GameCurrentRow>();
  return row ?? null;
}

// CHANGED: Smoke test — latest N games by updated_at DESC.
export async function getGamesCurrentLatest(
  db: D1Database,
  limit: number
): Promise<GameCurrentRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM games_current ORDER BY updated_at DESC LIMIT ?")
    .bind(limit)
    .all<GameCurrentRow>();
  return results ?? [];
}

// CHANGED: Diagnostics — alias for latest N games (basic fields, updated_at desc).
export async function getRecentGames(db: D1Database, limit: number): Promise<GameCurrentRow[]> {
  return getGamesCurrentLatest(db, limit);
}

export async function getLatestSnapshotForGame(
  db: D1Database,
  gameId: string
): Promise<GameSnapshotRow | null> {
  const row = await db
    .prepare("SELECT * FROM games_snapshot WHERE game_id = ? ORDER BY fetched_at DESC LIMIT 1")
    .bind(gameId)
    .first<GameSnapshotRow>();
  return row ?? null;
}

// --- teams upsert (from scoreboard) ---
export async function upsertTeam(
  db: D1Database,
  teamId: string,
  name: string,
  abbr: string,
  espnTeamId?: string | null
): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `INSERT INTO teams (team_id, name, abbr, espn_team_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, abbr = excluded.abbr, espn_team_id = excluded.espn_team_id, updated_at = excluded.updated_at`
    )
    .bind(teamId, name, abbr, espnTeamId ?? teamId, ts)
    .run();
}

// NEW: batch upsert teams (dedupe by team_id)
const upsertTeamSql = `INSERT INTO teams (team_id, name, abbr, espn_team_id, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, abbr = excluded.abbr, espn_team_id = excluded.espn_team_id, updated_at = excluded.updated_at`;

export async function upsertTeamsBatch(
  db: D1Database,
  teams: Array<{ teamId: string; name: string; abbr: string; espnTeamId?: string | null }>
): Promise<void> {
  if (teams.length === 0) return;
  const ts = now();
  const stmt = db.prepare(upsertTeamSql);
  const batch = teams.map((t) =>
    stmt.bind(t.teamId, t.name, t.abbr, t.espnTeamId ?? t.teamId, ts)
  );
  await db.batch(batch);
}

/** Get all teams (team_id, name, abbr) for roster refresh. */
export async function getTeams(db: D1Database): Promise<Array<{ team_id: string; name: string; abbr: string }>> {
  const { results } = await db
    .prepare("SELECT team_id, name, abbr FROM teams ORDER BY team_id")
    .all<{ team_id: string; name: string; abbr: string }>();
  return results ?? [];
}

// CHANGED: alias for ML/cron; same as getTeams.
export async function getAllTeams(db: D1Database): Promise<Array<{ team_id: string; name: string; abbr: string }>> {
  return getTeams(db);
}

/** Get all team ids (for 6h roster refresh). */
export async function getAllTeamIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT team_id FROM teams ORDER BY team_id")
    .all<{ team_id: string }>();
  return (results ?? []).map((r) => r.team_id);
}

// --- rosters (batch upsert) ---
const upsertRosterSql = `INSERT INTO rosters (
  team_id, season, player_id, raw_json, status, injuries_json,
  display_name, first_name, last_name, full_name, short_name,
  position_abbr, position_name, jersey, headshot_href,
  weight, height, age, date_of_birth, debut_year,
  college_name, birth_place_city, birth_place_state, birth_place_country,
  experience_years, contract_salary, contract_years_remaining, slug,
  updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(team_id, season, player_id) DO UPDATE SET
  raw_json = excluded.raw_json, status = excluded.status, injuries_json = excluded.injuries_json,
  display_name = excluded.display_name, first_name = excluded.first_name, last_name = excluded.last_name,
  full_name = excluded.full_name, short_name = excluded.short_name,
  position_abbr = excluded.position_abbr, position_name = excluded.position_name,
  jersey = excluded.jersey, headshot_href = excluded.headshot_href,
  weight = excluded.weight, height = excluded.height, age = excluded.age,
  date_of_birth = excluded.date_of_birth, debut_year = excluded.debut_year,
  college_name = excluded.college_name, birth_place_city = excluded.birth_place_city,
  birth_place_state = excluded.birth_place_state, birth_place_country = excluded.birth_place_country,
  experience_years = excluded.experience_years, contract_salary = excluded.contract_salary,
  contract_years_remaining = excluded.contract_years_remaining, slug = excluded.slug,
  updated_at = excluded.updated_at`;

export interface RosterRowInput {
  team_id: string;
  season: number;
  player_id: string;
  raw_json: string | null;
  status?: string | null;
  injuries_json?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  short_name?: string | null;
  position_abbr?: string | null;
  position_name?: string | null;
  jersey?: string | null;
  headshot_href?: string | null;
  weight?: number | null;
  height?: number | null;
  age?: number | null;
  date_of_birth?: string | null;
  debut_year?: number | null;
  college_name?: string | null;
  birth_place_city?: string | null;
  birth_place_state?: string | null;
  birth_place_country?: string | null;
  experience_years?: number | null;
  contract_salary?: number | null;
  contract_years_remaining?: number | null;
  slug?: string | null;
}

export async function upsertRostersBatch(db: D1Database, rows: RosterRowInput[]): Promise<void> {
  if (rows.length === 0) return;
  const ts = now();
  const stmt = db.prepare(upsertRosterSql);
  const batch = rows.map((r) =>
    stmt.bind(
      r.team_id,
      r.season,
      r.player_id,
      r.raw_json ?? null,
      r.status ?? null,
      r.injuries_json ?? null,
      r.display_name ?? null,
      r.first_name ?? null,
      r.last_name ?? null,
      r.full_name ?? null,
      r.short_name ?? null,
      r.position_abbr ?? null,
      r.position_name ?? null,
      r.jersey ?? null,
      r.headshot_href ?? null,
      r.weight ?? null,
      r.height ?? null,
      r.age ?? null,
      r.date_of_birth ?? null,
      r.debut_year ?? null,
      r.college_name ?? null,
      r.birth_place_city ?? null,
      r.birth_place_state ?? null,
      r.birth_place_country ?? null,
      r.experience_years ?? null,
      r.contract_salary ?? null,
      r.contract_years_remaining ?? null,
      r.slug ?? null,
      ts
    )
  );
  await db.batch(batch);
}

/** Rows that have raw_json but missing parsed columns (for one-time backfill). */
export async function getRosterRowsForColumnBackfill(
  db: D1Database,
  limit: number
): Promise<Array<{ team_id: string; season: number; player_id: string; raw_json: string | null }>> {
  const { results } = await db
    .prepare(
      "SELECT team_id, season, player_id, raw_json FROM rosters WHERE raw_json IS NOT NULL AND display_name IS NULL LIMIT ?"
    )
    .bind(limit)
    .all<{ team_id: string; season: number; player_id: string; raw_json: string | null }>();
  return results ?? [];
}

// --- player_season_stats (batch upsert) ---
const upsertPlayerSeasonStatSql = `INSERT INTO player_season_stats (player_id, season, stat_type, json, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(player_id, season, stat_type) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`;

export async function upsertPlayerSeasonStatsBatch(
  db: D1Database,
  rows: Array<{ player_id: string; season: number; stat_type: string; json: string }>
): Promise<void> {
  if (rows.length === 0) return;
  const ts = now();
  const stmt = db.prepare(upsertPlayerSeasonStatSql);
  const batch = rows.map((r) => stmt.bind(r.player_id, r.season, r.stat_type, r.json, ts));
  await db.batch(batch);
}

/** Distinct player_ids from player_game_stats_current with updated_at >= (now - lookbackSec), ordered by most recent, limit. */
export async function getRecentlySeenPlayers(
  db: D1Database,
  lookbackSec: number,
  limit: number
): Promise<string[]> {
  const cutoff = now() - lookbackSec;
  const { results } = await db
    .prepare(
      `SELECT player_id FROM (
        SELECT player_id, MAX(updated_at) AS mt FROM player_game_stats_current WHERE updated_at >= ?
        GROUP BY player_id ORDER BY mt DESC LIMIT ?
      )`
    )
    .bind(cutoff, limit)
    .all<{ player_id: string }>();
  return (results ?? []).map((r) => r.player_id);
}

/** Fallback: get up to limit player_ids from players table (for stats refresh when no recent game stats). */
export async function getPlayerIdsLimit(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT player_id FROM players ORDER BY updated_at DESC LIMIT ?")
    .bind(limit)
    .all<{ player_id: string }>();
  return (results ?? []).map((r) => r.player_id);
}

/** Get all player ids (for 24h season stats refresh - full list). */
export async function getAllPlayerIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT player_id FROM players ORDER BY updated_at DESC")
    .all<{ player_id: string }>();
  return (results ?? []).map((r) => r.player_id);
}

/** Get recent player ids by updated_at (for 24h stats refresh - limit load). */
export async function getRecentPlayerIds(db: D1Database, limit: number): Promise<string[]> {
  return getPlayerIdsLimit(db, limit);
}

// CHANGED: ML context - batch query roster rows by player ids and season for roster fallback.
export interface RosterRowByPlayer {
  player_id: string;
  team_id: string;
  raw_json: string | null;
  status?: string | null;
  injuries_json?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  short_name?: string | null;
  position_abbr?: string | null;
  position_name?: string | null;
  jersey?: string | null;
  headshot_href?: string | null;
  weight?: number | null;
  height?: number | null;
  age?: number | null;
  date_of_birth?: string | null;
  debut_year?: number | null;
  college_name?: string | null;
  birth_place_city?: string | null;
  birth_place_state?: string | null;
  birth_place_country?: string | null;
  experience_years?: number | null;
  contract_salary?: number | null;
  contract_years_remaining?: number | null;
  slug?: string | null;
}

/** Get roster rows for given season and player ids (one or more rows per player if on multiple teams). Returns map by player_id (latest row per player). Chunks to avoid D1 var limit. */
export async function getRosterRowsByPlayerIds(
  db: D1Database,
  season: number,
  playerIds: string[]
): Promise<Map<string, RosterRowByPlayer>> {
  const map = new Map<string, RosterRowByPlayer>();
  if (playerIds.length === 0) return map;
  const seen = new Set<string>();
  const ids = playerIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (ids.length === 0) return map;
  for (const chunk of chunkIds(ids, MAX_IN_CLAUSE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT player_id, team_id, raw_json, status, injuries_json,
  display_name, first_name, last_name, full_name, short_name,
  position_abbr, position_name, jersey, headshot_href,
  weight, height, age, date_of_birth, debut_year,
  college_name, birth_place_city, birth_place_state, birth_place_country,
  experience_years, contract_salary, contract_years_remaining, slug
  FROM rosters WHERE season = ? AND player_id IN (${placeholders}) ORDER BY updated_at DESC`
      )
      .bind(season, ...chunk)
      .all<RosterRowByPlayer>();
    for (const row of results ?? []) {
      if (!map.has(row.player_id)) map.set(row.player_id, row);
    }
  }
  return map;
}

// CHANGED: ML context - batch query player_season_stats by season and player ids; returns map playerId -> { perGame?, totals?, advanced?, raw? }.
export type SeasonStatsByPlayer = {
  perGame?: unknown;
  totals?: unknown;
  advanced?: unknown;
  raw?: unknown;
};

export async function getPlayerSeasonStatsByIds(
  db: D1Database,
  season: number,
  playerIds: string[]
): Promise<Map<string, SeasonStatsByPlayer>> {
  const map = new Map<string, SeasonStatsByPlayer>();
  if (playerIds.length === 0) return map;
  const seen = new Set<string>();
  const ids = playerIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (ids.length === 0) return map;
  for (const chunk of chunkIds(ids, MAX_IN_CLAUSE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT player_id, stat_type, json FROM player_season_stats WHERE season = ? AND player_id IN (${placeholders})`
      )
      .bind(season, ...chunk)
      .all<{ player_id: string; stat_type: string; json: string }>();
    for (const row of results ?? []) {
      let obj = map.get(row.player_id);
      if (!obj) {
        obj = {};
        map.set(row.player_id, obj);
      }
      try {
        const parsed = JSON.parse(row.json) as unknown;
        if (row.stat_type === "perGame") obj.perGame = parsed;
        else if (row.stat_type === "totals") obj.totals = parsed;
        else if (row.stat_type === "advanced") obj.advanced = parsed;
        else obj.raw = parsed;
      } catch {
        (obj as Record<string, unknown>).raw = row.json;
      }
    }
  }
  return map;
}

/** All season stats for one player (for API GET /v1/nba/players/:id/season-stats without season param). */
export async function getPlayerSeasonStatsByPlayerId(
  db: D1Database,
  playerId: string
): Promise<Array<{ season: number; stat_type: string; json: string }>> {
  const { results } = await db
    .prepare("SELECT season, stat_type, json FROM player_season_stats WHERE player_id = ? ORDER BY season DESC, stat_type ASC")
    .bind(playerId)
    .all<{ season: number; stat_type: string; json: string }>();
  return results ?? [];
}

// --- games_snapshot retention: keep last 7 days or last N rows per game (e.g. 5000 total cap)
// CHANGED: retention policy can be tuned (e.g. 7 days vs 3 days)
export async function cleanupSnapshots(db: D1Database, retainDays: number = 7): Promise<number> {
  const cutoff = now() - retainDays * 86400;
  const r = await db.prepare("DELETE FROM games_snapshot WHERE fetched_at < ?").bind(cutoff).run();
  return r.meta.changes ?? 0;
}

// NEW: Boxscore snapshot retention to avoid D1 growth (append-only table).
export async function cleanupBoxscoreSnapshots(db: D1Database, retainHours: number = 24): Promise<number> {
  const cutoff = now() - retainHours * 3600;
  const r = await db.prepare("DELETE FROM game_boxscore_snapshot WHERE fetched_at < ?").bind(cutoff).run();
  return r.meta.changes ?? 0;
}

// --- players (for lineup enrichment) ---
export interface PlayerRow {
  player_id: string;
  full_name: string;
  team_id: string | null;
  position: string | null;
  jersey: string | null;
  headshot: string | null;
  updated_at: number;
}

export async function getPlayerById(db: D1Database, playerId: string): Promise<PlayerRow | null> {
  const row = await db
    .prepare("SELECT * FROM players WHERE player_id = ?")
    .bind(playerId)
    .first<PlayerRow>();
  return row ?? null;
}

// NEW: get players by ids; chunks to avoid D1 "too many SQL variables" (limit 100).
export async function getPlayersByIds(db: D1Database, ids: string[]): Promise<Map<string, PlayerRow>> {
  const map = new Map<string, PlayerRow>();
  if (ids.length === 0) return map;
  const seen = new Set<string>();
  const uniqueIds = ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (uniqueIds.length === 0) return map;
  for (const chunk of chunkIds(uniqueIds, MAX_IN_CLAUSE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT * FROM players WHERE player_id IN (${placeholders})`)
      .bind(...chunk)
      .all<PlayerRow>();
    for (const row of results ?? []) {
      map.set(row.player_id, row);
    }
  }
  return map;
}

export async function upsertPlayer(
  db: D1Database,
  playerId: string,
  fullName: string,
  teamId?: string | null,
  position?: string | null,
  jersey?: string | null,
  headshot?: string | null
): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `INSERT INTO players (player_id, full_name, team_id, position, jersey, headshot, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET full_name = excluded.full_name, team_id = excluded.team_id,
         position = excluded.position, jersey = excluded.jersey, headshot = excluded.headshot, updated_at = excluded.updated_at`
    )
    .bind(playerId, fullName, teamId ?? null, position ?? null, jersey ?? null, headshot ?? null, ts)
    .run();
}

// NEW: batch upsert players (no N+1)
type PlayerInput = {
  player_id: string;
  full_name: string;
  team_id: string | null;
  position: string | null;
  jersey: string | null;
  headshot: string | null;
};

const upsertPlayerSql = `INSERT INTO players (player_id, full_name, team_id, position, jersey, headshot, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(player_id) DO UPDATE SET full_name = excluded.full_name, team_id = excluded.team_id,
    position = excluded.position, jersey = excluded.jersey, headshot = excluded.headshot, updated_at = excluded.updated_at`;

export async function upsertPlayersBatch(db: D1Database, players: PlayerInput[]): Promise<void> {
  if (players.length === 0) return;
  const ts = now();
  const stmt = db.prepare(upsertPlayerSql);
  const batch = players.map((p) =>
    stmt.bind(p.player_id, p.full_name, p.team_id, p.position, p.jersey, p.headshot, ts)
  );
  await db.batch(batch);
}

// --- game_lineup_current (CHANGED: lineup helpers) ---
export async function upsertGameLineupCurrent(
  db: D1Database,
  gameId: string,
  homeOnCourtJson: string,
  awayOnCourtJson: string,
  derivedFrom: string,
  confidence: number
): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `INSERT INTO game_lineup_current (game_id, home_on_court_json, away_on_court_json, derived_from, confidence, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET home_on_court_json = excluded.home_on_court_json,
         away_on_court_json = excluded.away_on_court_json, derived_from = excluded.derived_from,
         confidence = excluded.confidence, updated_at = excluded.updated_at`
    )
    .bind(gameId, homeOnCourtJson, awayOnCourtJson, derivedFrom, confidence, ts)
    .run();
}

export async function getGameLineupCurrent(
  db: D1Database,
  gameId: string
): Promise<{ home_on_court_json: string; away_on_court_json: string; derived_from: string; confidence: number; updated_at: number } | null> {
  const row = await db
    .prepare("SELECT home_on_court_json, away_on_court_json, derived_from, confidence, updated_at FROM game_lineup_current WHERE game_id = ?")
    .bind(gameId)
    .first<{ home_on_court_json: string; away_on_court_json: string; derived_from: string; confidence: number; updated_at: number }>();
  return row ?? null;
}

// CHANGED: Diagnostics — alias for getGameLineupCurrent.
export function getLineupByGameId(
  db: D1Database,
  gameId: string
): Promise<{ home_on_court_json: string; away_on_court_json: string; derived_from: string; confidence: number; updated_at: number } | null> {
  return getGameLineupCurrent(db, gameId);
}

// --- game_playbyplay_cursor ---
export async function getPlayByPlayCursor(
  db: D1Database,
  gameId: string
): Promise<{ last_event_seq: number; last_fetched_at: number } | null> {
  const row = await db
    .prepare("SELECT last_event_seq, last_fetched_at FROM game_playbyplay_cursor WHERE game_id = ?")
    .bind(gameId)
    .first<{ last_event_seq: number; last_fetched_at: number }>();
  return row ?? null;
}

export async function upsertPlayByPlayCursor(
  db: D1Database,
  gameId: string,
  lastEventSeq: number,
  lastFetchedAt: number
): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `INSERT INTO game_playbyplay_cursor (game_id, last_event_seq, last_fetched_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET last_event_seq = excluded.last_event_seq,
         last_fetched_at = excluded.last_fetched_at, updated_at = excluded.updated_at`
    )
    .bind(gameId, lastEventSeq, lastFetchedAt, ts)
    .run();
}

// --- game_lineup_events (substitution history) ---
export type LineupEventRow = {
  game_id: string;
  event_seq: number;
  team_id: string | null;
  player_out_id: string | null;
  player_in_id: string | null;
  period: number;
  clock: string | null;
  created_at: number;
};

export async function insertGameLineupEventsBatch(
  db: D1Database,
  gameId: string,
  events: Array<{ seq: number; teamId?: string; playerOutId?: string; playerInId?: string; period: number; clock: string }>
): Promise<void> {
  if (events.length === 0) return;
  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO game_lineup_events (game_id, event_seq, team_id, player_out_id, player_in_id, period, clock, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(game_id, event_seq) DO UPDATE SET team_id = excluded.team_id, player_out_id = excluded.player_out_id,
       player_in_id = excluded.player_in_id, period = excluded.period, clock = excluded.clock, created_at = excluded.created_at`
  );
  const batch = events.map((e) =>
    stmt.bind(
      gameId,
      e.seq,
      e.teamId ?? null,
      e.playerOutId ?? null,
      e.playerInId ?? null,
      e.period,
      e.clock ?? null,
      ts
    )
  );
  await db.batch(batch);
}

export async function getGameLineupEvents(
  db: D1Database,
  gameId: string
): Promise<LineupEventRow[]> {
  const { results } = await db
    .prepare(
      "SELECT game_id, event_seq, team_id, player_out_id, player_in_id, period, clock, created_at FROM game_lineup_events WHERE game_id = ? ORDER BY event_seq ASC"
    )
    .bind(gameId)
    .all<LineupEventRow>();
  return results ?? [];
}

// --- player_game_stats_current (batch) ---
export async function upsertPlayerGameStatsCurrent(
  db: D1Database,
  rows: Array<{ game_id: string; player_id: string; team_id?: string | null; json: string }>
): Promise<void> {
  return upsertPlayerGameStatsCurrentBatch(db, rows);
}

// CHANGED: alias for batch usage
export async function upsertPlayerGameStatsCurrentBatch(
  db: D1Database,
  rows: Array<{ game_id: string; player_id: string; team_id?: string | null; json: string }>
): Promise<void> {
  if (rows.length === 0) return;
  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO player_game_stats_current (game_id, player_id, team_id, json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(game_id, player_id) DO UPDATE SET team_id = excluded.team_id, json = excluded.json, updated_at = excluded.updated_at`
  );
  const batch = rows.map((r) => stmt.bind(r.game_id, r.player_id, r.team_id ?? null, r.json, ts));
  await db.batch(batch);
}

export async function getPlayerGameStatsForGame(
  db: D1Database,
  gameId: string
): Promise<Array<{ player_id: string; team_id: string | null; json: string }>> {
  const { results } = await db
    .prepare("SELECT player_id, team_id, json FROM player_game_stats_current WHERE game_id = ?")
    .bind(gameId)
    .all<{ player_id: string; team_id: string | null; json: string }>();
  return results ?? [];
}

/** Stats rows for multiple games (for buildRecentUsage fallback when no boxscore snapshot). */
export async function getPlayerGameStatsForGames(
  db: D1Database,
  gameIds: string[]
): Promise<Array<{ game_id: string; player_id: string; team_id: string | null; json: string }>> {
  if (gameIds.length === 0) return [];
  const placeholders = gameIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT game_id, player_id, team_id, json FROM player_game_stats_current WHERE game_id IN (${placeholders})`
    )
    .bind(...gameIds)
    .all<{ game_id: string; player_id: string; team_id: string | null; json: string }>();
  return results ?? [];
}

/** Player game stats with game date (for aggregating season stats from boxscore). sinceYmd optional e.g. "2023-10-01". */
export async function getPlayerGameStatsWithDates(
  db: D1Database,
  sinceYmd?: string
): Promise<Array<{ player_id: string; date_ymd: string; json: string }>> {
  const sql = sinceYmd
    ? `SELECT p.player_id, g.date_ymd, p.json FROM player_game_stats_current p
       INNER JOIN games_current g ON g.game_id = p.game_id WHERE g.date_ymd >= ? ORDER BY p.player_id, g.date_ymd`
    : `SELECT p.player_id, g.date_ymd, p.json FROM player_game_stats_current p
       INNER JOIN games_current g ON g.game_id = p.game_id ORDER BY p.player_id, g.date_ymd`;
  const { results } = await db
    .prepare(sql)
    .bind(...(sinceYmd ? [sinceYmd] : []))
    .all<{ player_id: string; date_ymd: string; json: string }>();
  return results ?? [];
}

// CHANGED: ML quality — max(updated_at) for player_game_stats_current for given gameId (single query; for statsAgeSec).
export async function getPlayerGameStatsUpdatedAtMax(db: D1Database, gameId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT MAX(updated_at) AS max_at FROM player_game_stats_current WHERE game_id = ?")
    .bind(gameId)
    .first<{ max_at: number | null }>();
  return row?.max_at ?? null;
}

/** Reference: player_game_stats_current.json array keys (ordinal -> key_name, label, description). */
export async function getPlayerGameStatsKeys(
  db: D1Database
): Promise<Array<{ ordinal: number; key_name: string; label: string; description: string | null }>> {
  const { results } = await db
    .prepare("SELECT ordinal, key_name, label, description FROM player_game_stats_keys ORDER BY ordinal")
    .all<{ ordinal: number; key_name: string; label: string; description: string | null }>();
  return results ?? [];
}

// --- game_boxscore_snapshot ---
export async function insertBoxscoreSnapshot(db: D1Database, gameId: string, json: string): Promise<void> {
  const fetchedAt = now();
  await db
    .prepare("INSERT INTO game_boxscore_snapshot (game_id, fetched_at, json) VALUES (?, ?, ?)")
    .bind(gameId, fetchedAt, json)
    .run();
}

export async function getLatestBoxscoreSnapshot(
  db: D1Database,
  gameId: string
): Promise<{ json: string; fetched_at: number } | null> {
  const row = await db
    .prepare("SELECT json, fetched_at FROM game_boxscore_snapshot WHERE game_id = ? ORDER BY fetched_at DESC LIMIT 1")
    .bind(gameId)
    .first<{ json: string; fetched_at: number }>();
  return row ?? null;
}

// CHANGED: Diagnostics — boxscore snapshot meta only (avoid reading big json).
export async function getBoxscoreSnapshotMeta(
  db: D1Database,
  gameId: string
): Promise<{ fetched_at: number } | null> {
  const row = await db
    .prepare("SELECT fetched_at FROM game_boxscore_snapshot WHERE game_id = ? ORDER BY fetched_at DESC LIMIT 1")
    .bind(gameId)
    .first<{ fetched_at: number }>();
  return row ?? null;
}

// CHANGED: Observability — cron_runs table helpers (all timestamps unix seconds).
/** Insert a cron run start row; returns run_id. */
export async function insertCronRunStart(
  db: D1Database,
  cron: string,
  startedAt: number
): Promise<number> {
  const r = await db
    .prepare("INSERT INTO cron_runs (cron, started_at, ok) VALUES (?, ?, 0)")
    .bind(cron, startedAt)
    .run();
  const runId = r.meta.last_row_id;
  return typeof runId === "number" ? runId : Number(runId ?? 0);
}

/** Finish a cron run with finished_at, ok, optional error and counters. */
export async function finishCronRun(
  db: D1Database,
  runId: number,
  updates: {
    finished_at: number;
    ok: number;
    error?: string | null;
    live_games_count?: number;
    synced_games_count?: number;
    boxscore_snapshots_inserted?: number;
    players_upserted?: number;
    stats_upserted?: number;
  }
): Promise<void> {
  const {
    finished_at,
    ok,
    error = null,
    live_games_count = 0,
    synced_games_count = 0,
    boxscore_snapshots_inserted = 0,
    players_upserted = 0,
    stats_upserted = 0,
  } = updates;
  await db
    .prepare(
      `UPDATE cron_runs SET finished_at = ?, ok = ?, error = ?,
       live_games_count = ?, synced_games_count = ?, boxscore_snapshots_inserted = ?,
       players_upserted = ?, stats_upserted = ?
       WHERE run_id = ?`
    )
    .bind(
      finished_at,
      ok,
      error ?? null,
      live_games_count,
      synced_games_count,
      boxscore_snapshots_inserted,
      players_upserted,
      stats_upserted,
      runId
    )
    .run();
}

/** Latest cron_runs rows for debug endpoint; ordered by started_at DESC. */
export interface CronRunRow {
  run_id: number;
  cron: string;
  started_at: number;
  finished_at: number | null;
  ok: number;
  error: string | null;
  live_games_count: number;
  synced_games_count: number;
  boxscore_snapshots_inserted: number;
  players_upserted: number;
  stats_upserted: number;
}

export async function getCronRuns(db: D1Database, limit: number = 20): Promise<CronRunRow[]> {
  const { results } = await db
    .prepare(
      `SELECT run_id, cron, started_at, finished_at, ok, error,
       live_games_count, synced_games_count, boxscore_snapshots_inserted,
       players_upserted, stats_upserted
       FROM cron_runs ORDER BY started_at DESC LIMIT ?`
    )
    .bind(limit)
    .all<CronRunRow>();
  return results ?? [];
}

// CHANGED: Per-game sync diagnostics — insert one row; get latest by game_id (reasons stored as JSON string).
export interface GameSyncDiagnosticRow {
  game_id: string;
  cron: string;
  created_at: number;
  ok: number;
  reasons: string | null;
  home_on_court_count: number;
  away_on_court_count: number;
  unique_on_court_count: number;
  missing_profiles: number;
  missing_stats: number;
  cursor_before: number;
  cursor_after: number;
  inserted_boxscore: number;
  players_upserted: number;
  stats_upserted: number;
  notes: string | null;
}

export type GameSyncDiagnosticInput = Omit<GameSyncDiagnosticRow, "created_at"> & { created_at?: number };

export async function insertGameSyncDiagnostic(
  db: D1Database,
  row: GameSyncDiagnosticInput
): Promise<void> {
  const ts = row.created_at ?? now();
  const notes = row.notes != null && row.notes.length > 300 ? row.notes.slice(0, 300) : row.notes;
  await db
    .prepare(
      `INSERT INTO game_sync_diagnostics (
       game_id, cron, created_at, ok, reasons,
       home_on_court_count, away_on_court_count, unique_on_court_count,
       missing_profiles, missing_stats, cursor_before, cursor_after,
       inserted_boxscore, players_upserted, stats_upserted, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.game_id,
      row.cron,
      ts,
      row.ok,
      row.reasons ?? null,
      row.home_on_court_count ?? 0,
      row.away_on_court_count ?? 0,
      row.unique_on_court_count ?? 0,
      row.missing_profiles ?? 0,
      row.missing_stats ?? 0,
      row.cursor_before ?? 0,
      row.cursor_after ?? 0,
      row.inserted_boxscore ?? 0,
      row.players_upserted ?? 0,
      row.stats_upserted ?? 0,
      notes ?? null
    )
    .run();
}

export interface GameSyncDiagnosticResultRow extends GameSyncDiagnosticRow {
  id: number;
}

export async function getGameSyncDiagnostics(
  db: D1Database,
  gameId: string,
  limit: number = 20
): Promise<GameSyncDiagnosticResultRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, game_id, cron, created_at, ok, reasons,
       home_on_court_count, away_on_court_count, unique_on_court_count,
       missing_profiles, missing_stats, cursor_before, cursor_after,
       inserted_boxscore, players_upserted, stats_upserted, notes
       FROM game_sync_diagnostics WHERE game_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .bind(gameId, limit)
    .all<GameSyncDiagnosticResultRow>();
  return results ?? [];
}

// CHANGED: Error history — insert one row (message truncated to 300 chars); call only on actual errors.
const ERROR_LOG_MESSAGE_MAX = 300;
export async function insertErrorLog(
  db: D1Database,
  scope: string,
  key: string | null,
  message: string
): Promise<void> {
  const ts = now();
  const msg = message.slice(0, ERROR_LOG_MESSAGE_MAX);
  await db
    .prepare("INSERT INTO error_log (ts, scope, key, message) VALUES (?, ?, ?, ?)")
    .bind(ts, scope, key ?? null, msg)
    .run();
}

// --- Games involving team (for recent usage: last N games in window) ---
/** Games where team is home or away, date_ymd >= sinceYmd, ordered by date desc, limit N. */
export async function getGamesInvolvingTeamSince(
  db: D1Database,
  teamId: string,
  sinceYmd: string,
  limit: number
): Promise<GameCurrentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM games_current WHERE (home_team_id = ? OR away_team_id = ?) AND date_ymd >= ? ORDER BY date_ymd DESC, start_time_utc DESC LIMIT ?`
    )
    .bind(teamId, teamId, sinceYmd, limit)
    .all<GameCurrentRow>();
  return results ?? [];
}

// --- Roster per team (for active-12 derivation: full roster list in order) ---
export interface RosterPlayerRow {
  player_id: string;
  raw_json: string | null;
}

/** Roster players for team/season in table order (updated_at, player_id) for stable tiebreaker. */
export async function getRosterForTeam(
  db: D1Database,
  teamId: string,
  season: number
): Promise<RosterPlayerRow[]> {
  const { results } = await db
    .prepare("SELECT player_id, raw_json FROM rosters WHERE team_id = ? AND season = ? ORDER BY updated_at ASC, player_id ASC")
    .bind(teamId, season)
    .all<RosterPlayerRow>();
  return results ?? [];
}

/** One roster row for player (any season), latest updated_at. For API profile from raw_json. */
export async function getRosterByPlayerId(
  db: D1Database,
  playerId: string
): Promise<{
  player_id: string;
  team_id: string;
  season: number;
  raw_json: string | null;
  status?: string | null;
  injuries_json?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  short_name?: string | null;
  position_abbr?: string | null;
  position_name?: string | null;
  jersey?: string | null;
  headshot_href?: string | null;
  weight?: number | null;
  height?: number | null;
  age?: number | null;
  date_of_birth?: string | null;
  debut_year?: number | null;
  college_name?: string | null;
  birth_place_city?: string | null;
  birth_place_state?: string | null;
  birth_place_country?: string | null;
  experience_years?: number | null;
  contract_salary?: number | null;
  contract_years_remaining?: number | null;
  slug?: string | null;
} | null> {
  const row = await db
    .prepare(
      `SELECT player_id, team_id, season, raw_json, status, injuries_json,
        display_name, first_name, last_name, full_name, short_name,
        position_abbr, position_name, jersey, headshot_href,
        weight, height, age, date_of_birth, debut_year,
        college_name, birth_place_city, birth_place_state, birth_place_country,
        experience_years, contract_salary, contract_years_remaining, slug
        FROM rosters WHERE player_id = ? ORDER BY updated_at DESC LIMIT 1`
    )
    .bind(playerId)
    .first<{
      player_id: string;
      team_id: string;
      season: number;
      raw_json: string | null;
      status?: string | null;
      injuries_json?: string | null;
      display_name?: string | null;
      first_name?: string | null;
      last_name?: string | null;
      full_name?: string | null;
      short_name?: string | null;
      position_abbr?: string | null;
      position_name?: string | null;
      jersey?: string | null;
      headshot_href?: string | null;
      weight?: number | null;
      height?: number | null;
      age?: number | null;
      date_of_birth?: string | null;
      debut_year?: number | null;
      college_name?: string | null;
      birth_place_city?: string | null;
      birth_place_state?: string | null;
      birth_place_country?: string | null;
      experience_years?: number | null;
      contract_salary?: number | null;
      contract_years_remaining?: number | null;
      slug?: string | null;
    }>();
  return row ?? null;
}

// --- player_recent_usage ---
export interface RecentUsageRow {
  player_id: string;
  team_id: string;
  season: number;
  window_days: number;
  games_appeared: number;
  minutes_total: number;
  starts: number;
  last_seen_at: number | null;
  updated_at: number;
}

export async function upsertRecentUsageBatch(
  db: D1Database,
  rows: Array<{
    player_id: string;
    team_id: string;
    season: number;
    window_days: number;
    games_appeared: number;
    minutes_total: number;
    starts: number;
    last_seen_at: number | null;
  }>
): Promise<void> {
  if (rows.length === 0) return;
  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO player_recent_usage (player_id, team_id, season, window_days, games_appeared, minutes_total, starts, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id, season, window_days) DO UPDATE SET
       team_id = excluded.team_id, games_appeared = excluded.games_appeared, minutes_total = excluded.minutes_total,
       starts = excluded.starts, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`
  );
  const batch = rows.map((r) =>
    stmt.bind(r.player_id, r.team_id, r.season, r.window_days, r.games_appeared, r.minutes_total, r.starts, r.last_seen_at, ts)
  );
  await db.batch(batch);
}

export async function getRecentUsageByTeamSeasonWindow(
  db: D1Database,
  teamId: string,
  season: number,
  windowDays: number
): Promise<RecentUsageRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM player_recent_usage WHERE team_id = ? AND season = ? AND window_days = ? ORDER BY games_appeared DESC, minutes_total DESC"
    )
    .bind(teamId, season, windowDays)
    .all<RecentUsageRow>();
  return results ?? [];
}

/** Batch: get recent usage for many (team_id, season, window_days); returns map key "teamId:playerId". */
export async function getRecentUsageByTeamIds(
  db: D1Database,
  teamIds: string[],
  season: number,
  windowDays: number
): Promise<Map<string, RecentUsageRow>> {
  const map = new Map<string, RecentUsageRow>();
  if (teamIds.length === 0) return map;
  const placeholders = teamIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT * FROM player_recent_usage WHERE team_id IN (${placeholders}) AND season = ? AND window_days = ?`
    )
    .bind(...teamIds, season, windowDays)
    .all<RecentUsageRow>();
  for (const row of results ?? []) {
    map.set(`${row.team_id}:${row.player_id}`, row);
  }
  return map;
}

// --- team_roster_12_current ---
export interface TeamRoster12Row {
  team_id: string;
  season: number;
  player_ids_json: string;
  positions_json: string;
  method: string;
  constraints_json: string;
  quality_json: string;
  updated_at: number;
}

export async function upsertTeamRoster12Current(
  db: D1Database,
  row: {
    team_id: string;
    season: number;
    player_ids_json: string;
    positions_json: string;
    method: string;
    constraints_json: string;
    quality_json: string;
  }
): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `INSERT INTO team_roster_12_current (team_id, season, player_ids_json, positions_json, method, constraints_json, quality_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_id, season) DO UPDATE SET
         player_ids_json = excluded.player_ids_json, positions_json = excluded.positions_json,
         method = excluded.method, constraints_json = excluded.constraints_json, quality_json = excluded.quality_json, updated_at = excluded.updated_at`
    )
    .bind(
      row.team_id,
      row.season,
      row.player_ids_json,
      row.positions_json,
      row.method,
      row.constraints_json,
      row.quality_json,
      ts
    )
    .run();
}

export async function getTeamRoster12(
  db: D1Database,
  teamId: string,
  season: number
): Promise<TeamRoster12Row | null> {
  const row = await db
    .prepare("SELECT * FROM team_roster_12_current WHERE team_id = ? AND season = ?")
    .bind(teamId, season)
    .first<TeamRoster12Row>();
  return row ?? null;
}

export async function getTeamRoster12ByTeamIds(
  db: D1Database,
  teamIds: string[],
  season: number
): Promise<Map<string, TeamRoster12Row>> {
  const map = new Map<string, TeamRoster12Row>();
  if (teamIds.length === 0) return map;
  const placeholders = teamIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM team_roster_12_current WHERE team_id IN (${placeholders}) AND season = ?`)
    .bind(...teamIds, season)
    .all<TeamRoster12Row>();
  for (const row of results ?? []) {
    map.set(row.team_id, row);
  }
  return map;
}

/** Distinct player_id from rosters for season (fallback when roster12 is empty for refreshPlayerSeasonStats). */
export async function getPlayerIdsFromRosters(db: D1Database, season: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT player_id FROM rosters WHERE season = ? ORDER BY player_id ASC")
    .bind(season)
    .all<{ player_id: string }>();
  return (results ?? []).map((r) => r.player_id);
}

/** All player IDs from team_roster_12_current (all teams) for season; deduplicated. */
export async function getAllPlayerIdsFromRoster12(db: D1Database, season: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT player_ids_json FROM team_roster_12_current WHERE season = ?")
    .bind(season)
    .all<{ player_ids_json: string }>();
  const seen = new Set<string>();
  for (const r of results ?? []) {
    try {
      const ids = JSON.parse(r.player_ids_json) as string[];
      for (const id of ids) {
        if (id && typeof id === "string") seen.add(id);
      }
    } catch {
      // skip
    }
  }
  return Array.from(seen);
}

// --- player_season_stats: max updated_at per (player_id, season) for 24h policy ---
/** Max updated_at per player for given season (any stat_type). Chunks to avoid D1 "too many SQL variables". */
export async function getPlayerSeasonStatsMaxUpdatedAt(
  db: D1Database,
  playerIds: string[],
  season: number
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (playerIds.length === 0) return map;
  const seen = new Set<string>();
  const ids = playerIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (ids.length === 0) return map;
  for (const chunk of chunkIds(ids, MAX_IN_CLAUSE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT player_id, MAX(updated_at) AS max_at FROM player_season_stats WHERE player_id IN (${placeholders}) AND season = ? GROUP BY player_id`
      )
      .bind(...chunk, season)
      .all<{ player_id: string; max_at: number }>();
    for (const row of results ?? []) {
      map.set(row.player_id, row.max_at);
    }
  }
  return map;
}

/** Set of "playerId" that have at least one row for given season. Chunks to avoid D1 "too many SQL variables". */
export async function getPlayerIdsWithSeasonStats(db: D1Database, playerIds: string[], season: number): Promise<Set<string>> {
  const set = new Set<string>();
  if (playerIds.length === 0) return set;
  const seen = new Set<string>();
  const ids = playerIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (ids.length === 0) return set;
  for (const chunk of chunkIds(ids, MAX_IN_CLAUSE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT DISTINCT player_id FROM player_season_stats WHERE player_id IN (${placeholders}) AND season = ?`)
      .bind(...chunk, season)
      .all<{ player_id: string }>();
    for (const row of results ?? []) {
      set.add(row.player_id);
    }
  }
  return set;
}

// --- pregame_calls (track record: pregame snapshot + settle after game) ---
export interface PregameCallRow {
  id: number;
  game_id: string;
  season: number;
  created_at: number;
  game_start_time_utc: string | null;
  home_team_id: string;
  away_team_id: string;
  picked_team_id: string;
  ai_prob: number;
  market_prob: number;
  model_version: string | null;
  source: string | null;
  completed: number;
  winner_team_id: string | null;
  settled_at: number | null;
  pick_correct: number | null;
  beat_market: number | null;
  ai_error: number | null;
  market_error: number | null;
  notes: string | null;
}

export type PregameCallInput = {
  game_id: string;
  season: number;
  created_at: number;
  game_start_time_utc?: string | null;
  home_team_id: string;
  away_team_id: string;
  picked_team_id: string;
  ai_prob: number;
  market_prob: number;
  model_version?: string | null;
  source?: string | null;
};

/** Insert one pregame call; no-op if game_id already exists (UNIQUE). */
export async function insertPregameCallIfMissing(db: D1Database, row: PregameCallInput): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO pregame_calls (
        game_id, season, created_at, game_start_time_utc, home_team_id, away_team_id,
        picked_team_id, ai_prob, market_prob, model_version, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.game_id,
      row.season,
      row.created_at,
      row.game_start_time_utc ?? null,
      row.home_team_id,
      row.away_team_id,
      row.picked_team_id,
      row.ai_prob,
      row.market_prob,
      row.model_version ?? null,
      row.source ?? "pregame"
    )
    .run();
}

/** Update ai_prob, market_prob, picked_team_id for an existing pregame call (completed=0). Used when sync runs again with fresh market_prob from nba_slug_market_odds. */
export async function updatePregameCallPregameData(
  db: D1Database,
  gameId: string,
  data: { ai_prob: number; market_prob: number; picked_team_id: string }
): Promise<void> {
  await db
    .prepare(
      `UPDATE pregame_calls SET ai_prob = ?, market_prob = ?, picked_team_id = ? WHERE game_id = ? AND completed = 0`
    )
    .bind(data.ai_prob, data.market_prob, data.picked_team_id, gameId)
    .run();
}

/** List pregame calls, newest first. sinceSec: only created_at >= (now - sinceSec). completedOnly: only completed=1. */
export async function listPregameCalls(
  db: D1Database,
  limit: number,
  opts?: { sinceSec?: number; completedOnly?: boolean }
): Promise<PregameCallRow[]> {
  const sinceSec = opts?.sinceSec ?? 0;
  const completedOnly = opts?.completedOnly ?? false;
  const cutoff = sinceSec > 0 ? now() - sinceSec : 0;
  let sql = "SELECT * FROM pregame_calls";
  const conditions: string[] = [];
  const bindings: (number | string)[] = [];
  if (sinceSec > 0) {
    conditions.push("created_at >= ?");
    bindings.push(cutoff);
  }
  if (completedOnly) {
    conditions.push("completed = 1");
  }
  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY created_at DESC LIMIT ?";
  bindings.push(limit);
  const { results } = await db.prepare(sql).bind(...bindings).all<PregameCallRow>();
  return results ?? [];
}

/** Update outcome and derived metrics for a pregame call by game_id. EPS = 1e-6 for beat_market. Returns number of rows updated (0 or 1). */
const PREGAME_EPS = 1e-6;

export async function updatePregameCallOutcomeAndScore(
  db: D1Database,
  gameId: string,
  winnerTeamId: string,
  settledAt: number
): Promise<number> {
  const rows = await db
    .prepare("SELECT id, picked_team_id, ai_prob, market_prob FROM pregame_calls WHERE game_id = ? AND completed = 0")
    .bind(gameId)
    .all<PregameCallRow>();
  let updated = 0;
  for (const row of rows.results ?? []) {
    const outcome = row.picked_team_id === winnerTeamId ? 1 : 0;
    const aiErr = (row.ai_prob - outcome) ** 2;
    const mktErr = (row.market_prob - outcome) ** 2;
    const beatMarket = aiErr + PREGAME_EPS < mktErr ? 1 : 0;
    await db
      .prepare(
        `UPDATE pregame_calls SET completed = 1, winner_team_id = ?, settled_at = ?,
         pick_correct = ?, ai_error = ?, market_error = ?, beat_market = ? WHERE id = ?`
      )
      .bind(winnerTeamId, settledAt, outcome, aiErr, mktErr, beatMarket, row.id)
      .run();
    updated += 1;
  }
  return updated;
}

/** Build pregame_calls slug from games_current row. pregame_calls uses slug (nba-away-home-YYYY-MM-DD), games_current uses ESPN game_id. */
export function gameRowToSlug(row: GameCurrentRow): string {
  const away = (row.away_team_abbr ?? row.away_team_id).toLowerCase().slice(0, 3);
  const home = (row.home_team_abbr ?? row.home_team_id).toLowerCase().slice(0, 3);
  const d = row.date_ymd ?? "";
  const dateStr =
    d.length === 8 && d.indexOf("-") === -1
      ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
      : d;
  return `nba-${away}-${home}-${dateStr}`;
}

/** Get completed games from games_current updated in the last 24h (by updated_at). Used to settle pregame_calls. */
export async function getCompletedGamesRecentlyUpdated(db: D1Database, sinceSec: number = 86400): Promise<GameCurrentRow[]> {
  const cutoff = now() - sinceSec;
  const { results } = await db
    .prepare("SELECT * FROM games_current WHERE completed = 1 AND updated_at >= ? ORDER BY updated_at DESC")
    .bind(cutoff)
    .all<GameCurrentRow>();
  return results ?? [];
}

/** Settle all unsettled pregame_calls for completed games (winner from home_score/away_score). Call after scoreboard upsert. pregame_calls.game_id is slug (nba-away-home-YYYY-MM-DD) and picked_team_id/winner_team_id are 3-letter abbr, so we use gameRowToSlug and winner abbr. */
export async function settlePregameCallsForCompletedGames(db: D1Database, sinceSec: number = 86400): Promise<number> {
  const games = await getCompletedGamesRecentlyUpdated(db, sinceSec);
  const ts = now();
  for (const g of games) {
    const homeWon = g.home_score > g.away_score;
    const winnerAbbr = (homeWon ? g.home_team_abbr ?? g.home_team_id : g.away_team_abbr ?? g.away_team_id)
      .toLowerCase()
      .slice(0, 3);
    const slug = gameRowToSlug(g);
    await updatePregameCallOutcomeAndScore(db, slug, winnerAbbr, ts);
  }
  return games.length;
}

// --- Row to NormalizedGame ---
export function gameCurrentRowToNormalized(row: GameCurrentRow): NormalizedGame {
  return {
    gameId: row.game_id,
    dateYmd: row.date_ymd,
    startTimeUtc: row.start_time_utc,
    status: row.status,
    period: row.period,
    clock: row.clock,
    completed: row.completed !== 0,
    homeTeam: {
      id: row.home_team_id,
      name: row.home_team_name ?? "",
      abbr: row.home_team_abbr ?? row.home_team_id,
      score: row.home_score,
    },
    awayTeam: {
      id: row.away_team_id,
      name: row.away_team_name ?? "",
      abbr: row.away_team_abbr ?? row.away_team_id,
      score: row.away_score,
    },
  };
}
