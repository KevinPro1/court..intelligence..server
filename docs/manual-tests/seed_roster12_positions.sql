-- Seed for docs/manual-tests/roster12-positions-json.md
-- Run from workers/nba-data-worker:
--   wrangler d1 execute beyondmarket_nba --local --file=../docs/manual-tests/seed_roster12_positions.sql
--   wrangler d1 execute beyondmarket_nba --remote --file=../docs/manual-tests/seed_roster12_positions.sql

-- Case 1: positions_json = legacy array (index-aligned with player_ids_json)
INSERT OR REPLACE INTO team_roster_12_current (
  team_id, season, player_ids_json, positions_json, method, constraints_json, quality_json, updated_at
) VALUES (
  'test_pos_legacy',
  2024,
  '["p1","p2","p3"]',
  '["G","F","C"]',
  'manual_test',
  '{"minG":3,"minF":3,"minC":1,"maxC":3}',
  '{"ok":true,"reasons":[],"counts":{"G":1,"F":1,"C":1,"UNK":0},"filledByUNK":false}',
  strftime('%s','now')
);

-- Case 2: positions_json = new map (Record<playerId, position>)
INSERT OR REPLACE INTO team_roster_12_current (
  team_id, season, player_ids_json, positions_json, method, constraints_json, quality_json, updated_at
) VALUES (
  'test_pos_map',
  2024,
  '["p1","p2","p3"]',
  '{"p1":"G","p2":"F","p3":"C"}',
  'manual_test',
  '{"minG":3,"minF":3,"minC":1,"maxC":3}',
  '{"ok":true,"reasons":[],"counts":{"G":1,"F":1,"C":1,"UNK":0},"filledByUNK":false}',
  strftime('%s','now')
);

-- Minimal players so roster12 returns profile for p1, p2, p3 (same ids used by both teams)
INSERT OR REPLACE INTO players (player_id, full_name, team_id, updated_at) VALUES
  ('p1', 'Test Player 1', 'test_pos_legacy', strftime('%s','now')),
  ('p2', 'Test Player 2', 'test_pos_legacy', strftime('%s','now')),
  ('p3', 'Test Player 3', 'test_pos_legacy', strftime('%s','now'));
