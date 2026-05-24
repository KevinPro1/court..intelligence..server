-- Reference table: explains player_game_stats_current.json array order (ESPN summary boxscore stats).
-- json is stored as [MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, +/-].
CREATE TABLE IF NOT EXISTS player_game_stats_keys (
  ordinal INTEGER NOT NULL PRIMARY KEY,
  key_name TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT
);

INSERT OR IGNORE INTO player_game_stats_keys (ordinal, key_name, label, description) VALUES
  (0,  'minutes',     'MIN',  'Minutes played'),
  (1,  'points',      'PTS',  'Points'),
  (2,  'fieldGoals',  'FG',   'Field goals made-attempted (e.g. 10-16)'),
  (3,  'threePoint',  '3PT',  'Three-pointers made-attempted'),
  (4,  'freeThrows',  'FT',   'Free throws made-attempted'),
  (5,  'rebounds',    'REB',  'Total rebounds'),
  (6,  'assists',     'AST',  'Assists'),
  (7,  'turnovers',   'TO',   'Turnovers'),
  (8,  'steals',      'STL',  'Steals'),
  (9,  'blocks',      'BLK',  'Blocks'),
  (10, 'offensiveRebounds', 'OREB', 'Offensive rebounds'),
  (11, 'defensiveRebounds', 'DREB', 'Defensive rebounds'),
  (12, 'fouls',       'PF',   'Personal fouls'),
  (13, 'plusMinus',   '+/-',  'Plus/minus');
