-- Active 12 rotation: recent usage aggregation + position-constrained roster 12 per team.
-- player_recent_usage: aggregated minutes/starts from boxscore snapshots (14-day window).
CREATE TABLE IF NOT EXISTS player_recent_usage (
  player_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  games_appeared INTEGER NOT NULL,
  minutes_total REAL NOT NULL,
  starts INTEGER NOT NULL,
  last_seen_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, season, window_days)
);

CREATE INDEX IF NOT EXISTS idx_player_recent_usage_team_season_window ON player_recent_usage(team_id, season, window_days);

-- team_roster_12_current: derived active 12 per team/season with position constraints and quality.
CREATE TABLE IF NOT EXISTS team_roster_12_current (
  team_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  player_ids_json TEXT NOT NULL,
  positions_json TEXT NOT NULL,
  method TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, season)
);
