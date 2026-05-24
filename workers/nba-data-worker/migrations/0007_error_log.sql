-- CHANGED: Rolling error history for observability (bounded; insert on actual errors only).
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NULL,
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_scope_ts ON error_log(scope, ts DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_key_ts ON error_log(key, ts DESC);
