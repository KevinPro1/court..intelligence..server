-- CHANGED: Indexes for ML context and cron batch queries (rosters, player_season_stats by season + player_id).
CREATE INDEX IF NOT EXISTS idx_rosters_season_player ON rosters(season, player_id);
CREATE INDEX IF NOT EXISTS idx_player_season_stats_season_player ON player_season_stats(season, player_id);
