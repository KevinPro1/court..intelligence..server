#!/usr/bin/env bash
# Sanity test: game_boxscore_snapshot row count should not grow unbounded.
# After 24h cron (0 0 * * *), cleanupBoxscoreSnapshots(24) deletes rows older than 24h.
# Run this script before and after 24h cron to confirm count drops or stays bounded.

set -e
# Use same D1 database name as wrangler.toml
DB_NAME="${DB_NAME:-beyondmarket_nba}"
# --remote for production D1; use --local for wrangler dev local D1
MODE="${MODE:-remote}"

echo "=== game_boxscore_snapshot retention check ==="
echo "DB_NAME=$DB_NAME  MODE=$MODE"
echo ""

if [ "$MODE" = "remote" ]; then
  wrangler d1 execute "$DB_NAME" --remote --command "SELECT COUNT(*) AS snapshot_count FROM game_boxscore_snapshot;"
else
  wrangler d1 execute "$DB_NAME" --local --command "SELECT COUNT(*) AS snapshot_count FROM game_boxscore_snapshot;"
fi

echo ""
echo "After 24h cron runs (0 0 * * *), run again: count should decrease or stay bounded (retention = 24h)."
echo "  Example: MODE=remote ./scripts/check-boxscore-retention.sh"
