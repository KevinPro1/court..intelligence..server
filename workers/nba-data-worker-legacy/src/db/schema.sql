-- Court Intelligence D1 schema
-- Run: wrangler d1 execute court-intel-db --remote --file=./src/db/schema.sql

-- Teams: our team_id is stable (e.g. ESPN id or slug); espn_team_id for API mapping
CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  abbr TEXT NOT NULL,
  espn_team_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_teams_espn ON teams(espn_team_id);

-- Players: bio and current team reference
CREATE TABLE IF NOT EXISTS players (
  player_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  team_id TEXT,
  position TEXT,
  jersey TEXT,
  headshot TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);

-- Rosters: team + season + player; raw_json for ESPN payload
CREATE TABLE IF NOT EXISTS rosters (
  team_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  raw_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, season, player_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (player_id) REFERENCES players(player_id)
);

CREATE INDEX IF NOT EXISTS idx_rosters_season ON rosters(season);

-- Player stats: per season, stat_type (e.g. 'regular', 'playoffs'); json holds stats blob
CREATE TABLE IF NOT EXISTS player_stats (
  player_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  stat_type TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, season, stat_type),
  FOREIGN KEY (player_id) REFERENCES players(player_id)
);

CREATE INDEX IF NOT EXISTS idx_player_stats_season ON player_stats(season);

-- Games: scoreboard + live state; raw_json for full ESPN event
CREATE TABLE IF NOT EXISTS games (
  game_id TEXT PRIMARY KEY,
  date_ymd TEXT NOT NULL,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  status TEXT NOT NULL,
  period INTEGER NOT NULL DEFAULT 0,
  clock TEXT NOT NULL DEFAULT '',
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (home_team_id) REFERENCES teams(team_id),
  FOREIGN KEY (away_team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_games_date ON games(date_ymd);
CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at);
