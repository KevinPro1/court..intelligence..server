/**
 * Shared types for court-intelligence API.
 * Schema-stable, deterministic responses for ML/features.
 */

// --- ESPN raw response shapes (minimal, for typing fetch results) ---

export interface ESPNTeamRef {
  id?: string;
  uid?: string;
  displayName?: string;
  abbreviation?: string;
  name?: string;
  links?: Array<{ href: string }>;
}

export interface ESPNCompetitor {
  id: string;
  uid?: string;
  team?: ESPNTeamRef;
  homeAway?: "home" | "away";
  score?: string;
}

export interface ESPNStatus {
  type?: { completed?: boolean; state?: string; detail?: string };
  displayClock?: string;
  period?: number;
}

export interface ESPNEvent {
  id: string;
  date?: string;
  name?: string;
  competitors?: ESPNCompetitor[];
  status?: ESPNStatus;
  links?: Array<{ href: string }>;
}

export interface ESPNScoreboardResponse {
  leagues?: unknown[];
  events?: ESPNEvent[];
  day?: { date: string };
}

// --- Normalized / API response types ---

export interface NormalizedTeam {
  id: string;
  displayName: string;
  abbreviation: string;
  espnTeamId?: string;
}

export interface NormalizedGame {
  id: string;
  dateYmd: string;
  homeTeamId: string;
  awayTeamId: string;
  homeTeamAbbr?: string;
  awayTeamAbbr?: string;
  homeScore: number;
  awayScore: number;
  period: number;
  displayClock: string;
  status: string;
  completed: boolean;
}

export interface NormalizedScoreboard {
  date: string;
  games: NormalizedGame[];
}

export interface NormalizedPlayerProfile {
  playerId: string;
  fullName: string;
  teamId?: string;
  position?: string;
  jersey?: string;
  headshot?: string;
}

export interface NormalizedPlayerStats {
  playerId: string;
  season: number;
  statType: string;
  json: Record<string, unknown>;
}

// --- D1 row types (match schema) ---

export interface TeamRow {
  team_id: string;
  name: string;
  abbr: string;
  espn_team_id: string | null;
  updated_at: number;
}

export interface PlayerRow {
  player_id: string;
  full_name: string;
  team_id: string | null;
  position: string | null;
  jersey: string | null;
  headshot: string | null;
  updated_at: number;
}

export interface RosterRow {
  team_id: string;
  season: number;
  player_id: string;
  raw_json: string;
  updated_at: number;
}

export interface PlayerStatsRow {
  player_id: string;
  season: number;
  stat_type: string;
  json: string;
  updated_at: number;
}

export interface GameRow {
  game_id: string;
  date_ymd: string;
  home_team_id: string;
  away_team_id: string;
  status: string;
  period: number;
  clock: string;
  home_score: number;
  away_score: number;
  raw_json: string;
  updated_at: number;
}

// --- Env bindings ---

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  TZ?: string;
}
