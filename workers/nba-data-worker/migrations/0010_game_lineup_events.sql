-- Substitution history per game: who came in, who went out, when (for real-time lineup tracking).
CREATE TABLE IF NOT EXISTS game_lineup_events (
  game_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  team_id TEXT,
  player_out_id TEXT,
  player_in_id TEXT,
  period INTEGER NOT NULL DEFAULT 0,
  clock TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, event_seq)
);

CREATE INDEX IF NOT EXISTS idx_game_lineup_events_game ON game_lineup_events(game_id);
