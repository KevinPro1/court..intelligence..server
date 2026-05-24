-- CHANGED: Observability — cron execution logs for production monitoring.
CREATE TABLE IF NOT EXISTS cron_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cron TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT NULL,
  live_games_count INTEGER DEFAULT 0,
  synced_games_count INTEGER DEFAULT 0,
  boxscore_snapshots_inserted INTEGER DEFAULT 0,
  players_upserted INTEGER DEFAULT 0,
  stats_upserted INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_cron_started ON cron_runs(cron, started_at DESC);
