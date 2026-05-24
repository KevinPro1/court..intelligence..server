-- NBA Live Data Platform (D1) - initial schema
-- games_current: upsert by gameId for fast API reads
CREATE TABLE IF NOT EXISTS games_current (
  game_id TEXT PRIMARY KEY,
  date_ymd TEXT NOT NULL,
  start_time_utc TEXT,
  status TEXT NOT NULL,
  period INTEGER NOT NULL DEFAULT 0,
  clock TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0,
  home_team_id TEXT NOT NULL,
  home_team_name TEXT,
  home_team_abbr TEXT,
  home_score INTEGER NOT NULL DEFAULT 0,
  away_team_id TEXT NOT NULL,
  away_team_name TEXT,
  away_team_abbr TEXT,
  away_score INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_current_date ON games_current(date_ymd);
CREATE INDEX IF NOT EXISTS idx_games_current_completed ON games_current(completed);

-- games_snapshot: append-only for replay/debugging; retention via cleanupSnapshots()
CREATE TABLE IF NOT EXISTS games_snapshot (
  game_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  date_ymd TEXT NOT NULL,
  start_time_utc TEXT,
  status TEXT NOT NULL,
  period INTEGER NOT NULL DEFAULT 0,
  clock TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0,
  home_team_id TEXT NOT NULL,
  home_team_name TEXT,
  home_team_abbr TEXT,
  home_score INTEGER NOT NULL DEFAULT 0,
  away_team_id TEXT NOT NULL,
  away_team_name TEXT,
  away_team_abbr TEXT,
  away_score INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  PRIMARY KEY (game_id, fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_games_snapshot_fetched ON games_snapshot(fetched_at);
CREATE INDEX IF NOT EXISTS idx_games_snapshot_date ON games_snapshot(date_ymd);

-- teams: upsert for roster/stats future extension
CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  abbr TEXT NOT NULL,
  espn_team_id TEXT,
  updated_at INTEGER NOT NULL
);

-- refresh_state: singleton row for Smart Refresh Engine
CREATE TABLE IF NOT EXISTS refresh_state (
  key TEXT PRIMARY KEY,
  last_scoreboard_fetch_at INTEGER,
  live_games_count INTEGER NOT NULL DEFAULT 0,
  last_live_detect_at INTEGER,
  last_live_check_at INTEGER,
  last_2m_refresh_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO refresh_state (key, live_games_count, updated_at) VALUES ('singleton', 0, 0);

-- Optional: players, rosters, player_season_stats (data population TODO)
CREATE TABLE IF NOT EXISTS players (
  player_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  team_id TEXT,
  position TEXT,
  jersey TEXT,
  headshot TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rosters (
  team_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  raw_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, season, player_id)
);

CREATE TABLE IF NOT EXISTS player_season_stats (
  player_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  stat_type TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, season, stat_type)
);
