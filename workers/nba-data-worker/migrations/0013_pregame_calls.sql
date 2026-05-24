-- Pregame calls: one row per game (recommended side). Snapshot ai_prob + market_prob pregame; settle after game completes.
CREATE TABLE IF NOT EXISTS pregame_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  game_start_time_utc TEXT,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  picked_team_id TEXT NOT NULL,
  ai_prob REAL NOT NULL,
  market_prob REAL NOT NULL,
  model_version TEXT,
  source TEXT DEFAULT 'pregame',
  completed INTEGER DEFAULT 0,
  winner_team_id TEXT,
  settled_at INTEGER,
  pick_correct INTEGER,
  beat_market INTEGER,
  ai_error REAL,
  market_error REAL,
  notes TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_pregame_game ON pregame_calls(game_id);
CREATE INDEX IF NOT EXISTS idx_pregame_calls_created_at ON pregame_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_pregame_calls_completed ON pregame_calls(completed);
