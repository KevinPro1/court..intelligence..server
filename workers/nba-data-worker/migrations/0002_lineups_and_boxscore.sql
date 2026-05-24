-- CHANGED: Lineup + boxscore + play-by-play cursor and player game stats.
-- game_lineup_current: current on-court players per game
CREATE TABLE IF NOT EXISTS game_lineup_current (
  game_id TEXT PRIMARY KEY,
  home_on_court_json TEXT NOT NULL,
  away_on_court_json TEXT NOT NULL,
  derived_from TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  updated_at INTEGER NOT NULL
);

-- game_playbyplay_cursor: last processed event for incremental substitutions
CREATE TABLE IF NOT EXISTS game_playbyplay_cursor (
  game_id TEXT PRIMARY KEY,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_fetched_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- player_game_stats_current: per-game per-player stats from boxscore
CREATE TABLE IF NOT EXISTS player_game_stats_current (
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  team_id TEXT,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_player_game_stats_game ON player_game_stats_current(game_id);

-- game_boxscore_snapshot: append-only boxscore snapshots for debugging
CREATE TABLE IF NOT EXISTS game_boxscore_snapshot (
  game_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (game_id, fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_game_boxscore_snapshot_fetched ON game_boxscore_snapshot(fetched_at);

-- Cron mutex: lock_until (epoch seconds) for re-entry protection
ALTER TABLE refresh_state ADD COLUMN lock_until INTEGER;
