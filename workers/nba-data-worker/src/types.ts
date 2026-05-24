/**
 * Shared types for NBA Live Data Platform Worker.
 * All comments in English.
 * CHANGED: Env includes optional KV for cron lock; added NormalizedPlayerProfile and lineup/boxscore types.
 */

// CHANGED: Env extended with Durable Object realtime binding and optional RT env vars.
export interface Env {
  DB: D1Database;
  KV?: KVNamespace;
  ADMIN_KEY: string;
  ESPN_BASE_URL: string;
  RT?: DurableObjectNamespace;
  RT_POLL_MS?: string;
  RT_STREAM_TOKEN?: string;
}

// --- ESPN raw (defensive parsing) ---
export interface ESPNTeamRef {
  id?: string;
  uid?: string;
  displayName?: string;
  name?: string;
  abbreviation?: string;
}

export interface ESPNCompetitor {
  id?: string;
  team?: ESPNTeamRef;
  homeAway?: string;
  score?: string;
}

export interface ESPNStatus {
  type?: { completed?: boolean; state?: string; detail?: string };
  displayClock?: string;
  period?: number;
}

export interface ESPNEvent {
  id?: string;
  date?: string;
  name?: string;
  /** Top-level competitors (legacy); prefer competitions[0].competitors. */
  competitors?: ESPNCompetitor[];
  /** First element holds competitors + status for this event (current ESPN scoreboard shape). */
  competitions?: Array<{ competitors?: ESPNCompetitor[]; status?: ESPNStatus }>;
  status?: ESPNStatus;
}

export interface ESPNScoreboardResponse {
  events?: ESPNEvent[];
  /** Some ESPN responses wrap events under day or scoreboard. */
  day?: { date?: string; events?: ESPNEvent[] };
  scoreboard?: { events?: ESPNEvent[] };
}

// --- Normalized game (internal + API) — single canonical shape ---
export interface NormalizedGame {
  gameId: string;
  dateYmd: string;
  startTimeUtc: string | null;
  status: string;
  period: number;
  clock: string;
  completed: boolean;
  homeTeam: { id: string; name: string; abbr: string; score: number };
  awayTeam: { id: string; name: string; abbr: string; score: number };
}

// --- Player profile (lineup / boxscore) ---
export interface NormalizedPlayerProfile {
  playerId: string;
  fullName: string;
  teamId?: string;
  position?: string;
  jersey?: string;
  headshot?: string;
}

/**
 * ESPN roster API: each item in root.athletes (or root.roster) is this shape.
 * Stored as rosters.raw_json per (team_id, season, player_id).
 */
export interface ESPNRosterAthlete {
  id?: string;
  uid?: string;
  guid?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  displayName?: string;
  shortName?: string;
  weight?: number;
  displayWeight?: string;
  height?: number;
  displayHeight?: string;
  age?: number;
  dateOfBirth?: string;
  debutYear?: number;
  links?: Array<{ rel?: string[]; href?: string; text?: string }>;
  birthPlace?: { city?: string; state?: string; country?: string };
  college?: { id?: string; name?: string; shortName?: string; abbrev?: string; mascot?: string };
  slug?: string;
  headshot?: { href?: string; alt?: string };
  jersey?: string;
  position?: { id?: string; name?: string; displayName?: string; abbreviation?: string; leaf?: boolean };
  /** Injury list; non-empty when player has injury/status. */
  injuries?: Array<{ id?: string; type?: string; status?: string; details?: { type?: string; detail?: string }; date?: string }>;
  teams?: Array<{ $ref?: string }>;
  contracts?: Array<{ salary?: number; season?: { year?: number; startDate?: string; endDate?: string } }>;
  experience?: { years?: number };
  contract?: {
    salary?: number;
    yearsRemaining?: number;
    season?: { year?: number; startDate?: string; endDate?: string };
    active?: boolean;
  };
  /** Availability/health: Active, Out, Day-to-Day, etc. */
  status?: { id?: string; name?: string; type?: string; abbreviation?: string };
}

/** Normalized profile parsed from roster raw_json (ESPN athlete object). For API / D1 backfill. */
export interface NormalizedRosterProfile {
  id: string;
  displayName: string;
  position?: string;
  jersey?: string;
  headshot?: string;
  weight?: number;
  height?: number;
  college?: string;
  birthPlace?: { city?: string; state?: string; country?: string };
  contract?: { salary?: number; yearsRemaining?: number; seasonYear?: number };
  /** Human-readable status (e.g. "Active", "Out"). From status.name. */
  status?: string;
  /** Full status object from ESPN (id, name, type, abbreviation). */
  statusDetail?: { id?: string; name?: string; type?: string; abbreviation?: string };
  /** Parsed injuries[] from ESPN (when present). */
  injuries?: Array<{ type?: string; status?: string; detail?: string; date?: string }>;
  experience?: number;
}

/** Parsed ESPN athlete fields for rosters table columns (snake_case). All optional. */
export interface RosterDbColumns {
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
  status?: string | null;
  injuries_json?: string | null;
}

// --- Lineup / play-by-play (defensive) ---
export interface SubstitutionEvent {
  seq: number;
  period: number;
  clock: string;
  teamId?: string;
  playerInId?: string;
  playerOutId?: string;
  raw?: unknown;
}

export interface BoxscorePlayer {
  playerId: string;
  fullName: string;
  teamId?: string;
  position?: string;
  jersey?: string;
  headshot?: string;
  isStarter?: boolean;
  statsJson?: Record<string, unknown>;
}

// --- D1 row shapes ---
export interface GameCurrentRow {
  game_id: string;
  date_ymd: string;
  start_time_utc: string | null;
  status: string;
  period: number;
  clock: string;
  completed: number;
  home_team_id: string;
  home_team_name: string | null;
  home_team_abbr: string | null;
  home_score: number;
  away_team_id: string;
  away_team_name: string | null;
  away_team_abbr: string | null;
  away_score: number;
  raw_json: string | null;
  updated_at: number;
}

export interface GameSnapshotRow {
  game_id: string;
  fetched_at: number;
  date_ymd: string;
  start_time_utc: string | null;
  status: string;
  period: number;
  clock: string;
  completed: number;
  home_team_id: string;
  home_team_name: string | null;
  home_team_abbr: string | null;
  home_score: number;
  away_team_id: string;
  away_team_name: string | null;
  away_team_abbr: string | null;
  away_score: number;
  raw_json: string | null;
}

export interface RefreshStateRow {
  key: string;
  last_scoreboard_fetch_at: number | null;
  live_games_count: number;
  last_live_detect_at: number | null;
  last_live_check_at: number | null;
  last_2m_refresh_at: number | null;
  last_error: string | null;
  updated_at: number;
  lock_until?: number | null;
}

// --- Active 12 / recent usage ---
export type PositionGroup = "G" | "F" | "C" | "UNK";

export interface Roster12Constraints {
  minG: number;
  minF: number;
  minC: number;
  maxC: number;
}

export interface Roster12Quality {
  ok: boolean;
  reasons: string[];
  counts: { G: number; F: number; C: number; UNK: number };
  filledByUNK: boolean;
  missing?: { G?: number; F?: number; C?: number };
}

// NEW: Quality for dynamic active 12 (boxscore_dynamic_adjust).
export interface Active12Quality {
  ok: boolean;
  reasons: string[];
  counts: { G: number; F: number; C: number; UNK: number };
  filledByUNK: boolean;
  missing?: { G?: number; F?: number; C?: number };
  candidate_count: number;
  picked_count: number;
  usage_coverage_ratio: number;
  boxscore_hit_count: number;
  updated_reason: string;
}

// --- API response envelope ---
export interface ApiMeta {
  serverTimeUtc: string;
  source: string;
  cacheHit?: boolean;
}

export interface ApiEnvelope<T> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
  meta: ApiMeta;
}
