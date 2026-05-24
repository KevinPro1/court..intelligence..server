-- One-time seed so GET /v1/nba/teams/1/roster12 returns 200 locally.
-- Run from workers/nba-data-worker (docs is at repo root):
--   wrangler d1 execute beyondmarket_nba --local --file=../../docs/manual-tests/seed_roster12_team1_local.sql
-- Season 2025 = 2025-26 NBA season (adjust if your currentSeasonStartYearUtc differs).

-- team_roster_12_current: 3 players, positions as map (new format)
INSERT OR REPLACE INTO team_roster_12_current (
  team_id, season, player_ids_json, positions_json, method, constraints_json, quality_json, updated_at
) VALUES (
  '1',
  2025,
  '["roster12_p1","roster12_p2","roster12_p3"]',
  '{"roster12_p1":"G","roster12_p2":"F","roster12_p3":"C"}',
  'manual_seed',
  '{"minG":2,"minF":2,"minC":1,"maxC":5}',
  '{"ok":true,"reasons":[],"counts":{"G":1,"F":1,"C":1,"UNK":0},"filledByUNK":false}',
  strftime('%s','now')
);

-- Minimal players so roster12 returns profile
INSERT OR REPLACE INTO players (player_id, full_name, team_id, updated_at) VALUES
  ('roster12_p1', 'Roster12 Test 1', '1', strftime('%s','now')),
  ('roster12_p2', 'Roster12 Test 2', '1', strftime('%s','now')),
  ('roster12_p3', 'Roster12 Test 3', '1', strftime('%s','now'));
