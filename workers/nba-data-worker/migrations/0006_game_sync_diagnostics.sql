-- CHANGED: Per-game sync diagnostics for sanity checks and ESPN schema drift detection.
CREATE TABLE IF NOT EXISTS game_sync_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  reasons TEXT NULL,
  home_on_court_count INTEGER NOT NULL DEFAULT 0,
  away_on_court_count INTEGER NOT NULL DEFAULT 0,
  unique_on_court_count INTEGER NOT NULL DEFAULT 0,
  missing_profiles INTEGER NOT NULL DEFAULT 0,
  missing_stats INTEGER NOT NULL DEFAULT 0,
  cursor_before INTEGER NOT NULL DEFAULT 0,
  cursor_after INTEGER NOT NULL DEFAULT 0,
  inserted_boxscore INTEGER NOT NULL DEFAULT 0,
  players_upserted INTEGER NOT NULL DEFAULT 0,
  stats_upserted INTEGER NOT NULL DEFAULT 0,
  notes TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_sync_diag_game_time ON game_sync_diagnostics(game_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_sync_diag_time ON game_sync_diagnostics(created_at DESC);
