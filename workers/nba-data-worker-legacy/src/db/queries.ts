/**
 * Typed D1 query helpers for court-intelligence.
 * All timestamps stored as Unix seconds (integer).
 */

import type {
  TeamRow,
  PlayerRow,
  RosterRow,
  PlayerStatsRow,
  GameRow,
  NormalizedGame,
} from "../types";

const now = () => Math.floor(Date.now() / 1000);

// --- Teams ---

export async function getTeamById(db: D1Database, teamId: string): Promise<TeamRow | null> {
  const row = await db.prepare("SELECT * FROM teams WHERE team_id = ?").bind(teamId).first<TeamRow>();
  return row ?? null;
}

export async function getAllTeams(db: D1Database): Promise<TeamRow[]> {
  const { results } = await db.prepare("SELECT * FROM teams ORDER BY name").all<TeamRow>();
  return results ?? [];
}

export async function upsertTeam(
  db: D1Database,
  row: Omit<TeamRow, "updated_at"> & { updated_at?: number }
): Promise<void> {
  const ts = row.updated_at ?? now();
  await db
    .prepare(
      "INSERT INTO teams (team_id, name, abbr, espn_team_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, abbr = excluded.abbr, espn_team_id = excluded.espn_team_id, updated_at = excluded.updated_at"
    )
    .bind(row.team_id, row.name, row.abbr, row.espn_team_id ?? null, ts)
    .run();
}

// --- Players ---

export async function getPlayerById(db: D1Database, playerId: string): Promise<PlayerRow | null> {
  const row = await db
    .prepare("SELECT * FROM players WHERE player_id = ?")
    .bind(playerId)
    .first<PlayerRow>();
  return row ?? null;
}

export async function upsertPlayer(
  db: D1Database,
  row: Omit<PlayerRow, "updated_at"> & { updated_at?: number }
): Promise<void> {
  const ts = row.updated_at ?? now();
  await db
    .prepare(
      "INSERT INTO players (player_id, full_name, team_id, position, jersey, headshot, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET full_name = excluded.full_name, team_id = excluded.team_id, position = excluded.position, jersey = excluded.jersey, headshot = excluded.headshot, updated_at = excluded.updated_at"
    )
    .bind(
      row.player_id,
      row.full_name,
      row.team_id ?? null,
      row.position ?? null,
      row.jersey ?? null,
      row.headshot ?? null,
      ts
    )
    .run();
}

// --- Rosters ---

export async function getRoster(
  db: D1Database,
  teamId: string,
  season: number
): Promise<RosterRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM rosters WHERE team_id = ? AND season = ? ORDER BY player_id")
    .bind(teamId, season)
    .all<RosterRow>();
  return results ?? [];
}

export async function upsertRosterRow(
  db: D1Database,
  row: Omit<RosterRow, "updated_at"> & { updated_at?: number }
): Promise<void> {
  const ts = row.updated_at ?? now();
  await db
    .prepare(
      "INSERT INTO rosters (team_id, season, player_id, raw_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, season, player_id) DO UPDATE SET raw_json = excluded.raw_json, updated_at = excluded.updated_at"
    )
    .bind(row.team_id, row.season, row.player_id, row.raw_json ?? "", ts)
    .run();
}

// --- Player stats ---

export async function getPlayerStats(
  db: D1Database,
  playerId: string,
  season: number,
  statType: string
): Promise<PlayerStatsRow | null> {
  const row = await db
    .prepare("SELECT * FROM player_stats WHERE player_id = ? AND season = ? AND stat_type = ?")
    .bind(playerId, season, statType)
    .first<PlayerStatsRow>();
  return row ?? null;
}

export async function getPlayerStatsForSeasons(
  db: D1Database,
  playerId: string,
  seasons: number[],
  statType: string = "regular"
): Promise<PlayerStatsRow[]> {
  if (seasons.length === 0) return [];
  const placeholders = seasons.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT * FROM player_stats WHERE player_id = ? AND season IN (${placeholders}) AND stat_type = ? ORDER BY season DESC`
    )
    .bind(playerId, ...seasons, statType)
    .all<PlayerStatsRow>();
  return results ?? [];
}

export async function upsertPlayerStats(
  db: D1Database,
  row: Omit<PlayerStatsRow, "updated_at"> & { updated_at?: number }
): Promise<void> {
  const ts = row.updated_at ?? now();
  await db
    .prepare(
      "INSERT INTO player_stats (player_id, season, stat_type, json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(player_id, season, stat_type) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at"
    )
    .bind(row.player_id, row.season, row.stat_type, row.json, ts)
    .run();
}

// --- Games ---

export async function getGameById(db: D1Database, gameId: string): Promise<GameRow | null> {
  const row = await db
    .prepare("SELECT * FROM games WHERE game_id = ?")
    .bind(gameId)
    .first<GameRow>();
  return row ?? null;
}

export async function getGamesByDate(db: D1Database, dateYmd: string): Promise<GameRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM games WHERE date_ymd = ? ORDER BY updated_at DESC")
    .bind(dateYmd)
    .all<GameRow>();
  return results ?? [];
}

export async function upsertGame(
  db: D1Database,
  row: Omit<GameRow, "updated_at"> & { updated_at?: number }
): Promise<void> {
  const ts = row.updated_at ?? now();
  await db
    .prepare(
      `INSERT INTO games (game_id, date_ymd, home_team_id, away_team_id, status, period, clock, home_score, away_score, raw_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET
         status = excluded.status, period = excluded.period, clock = excluded.clock,
         home_score = excluded.home_score, away_score = excluded.away_score,
         raw_json = excluded.raw_json, updated_at = excluded.updated_at`
    )
    .bind(
      row.game_id,
      row.date_ymd,
      row.home_team_id,
      row.away_team_id,
      row.status,
      row.period ?? 0,
      row.clock ?? "",
      row.home_score ?? 0,
      row.away_score ?? 0,
      row.raw_json ?? "",
      ts
    )
    .run();
}

/** Convert GameRow to NormalizedGame (teamMap optional, for abbreviation lookup). */
export function gameRowToNormalized(
  row: GameRow,
  teamMap?: Map<string, { abbreviation?: string }>
): NormalizedGame {
  return {
    id: row.game_id,
    dateYmd: row.date_ymd,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    homeTeamAbbr: teamMap?.get(row.home_team_id)?.abbreviation,
    awayTeamAbbr: teamMap?.get(row.away_team_id)?.abbreviation,
    homeScore: row.home_score,
    awayScore: row.away_score,
    period: row.period,
    displayClock: row.clock,
    status: row.status,
    completed: row.status.toLowerCase().includes("final") || row.status.toLowerCase().includes("postponed"),
  };
}
