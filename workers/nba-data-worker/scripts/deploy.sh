#!/usr/bin/env bash
# Deploy NBA data worker to Cloudflare: apply remote D1 migrations, then deploy.
# First-time: create D1 with `wrangler d1 create beyondmarket_nba` and set database_id in wrangler.toml.

set -e
cd "$(dirname "$0")/.."
WRANGLER_TOML="wrangler.toml"

if grep -q "YOUR_D1_DATABASE_ID" "$WRANGLER_TOML" 2>/dev/null; then
  echo "Error: Set a real D1 database_id in $WRANGLER_TOML first."
  echo ""
  echo "This worker uses its own D1 database (beyondmarket_nba), not the root project's DB."
  echo "From this directory ($(pwd)):"
  echo "  1. npx wrangler d1 create beyondmarket_nba"
  echo "  2. Copy the returned database_id into $WRANGLER_TOML:"
  echo "     [[d1_databases]]"
  echo "     binding = \"DB\""
  echo "     database_name = \"beyondmarket_nba\""
  echo "     database_id = \"<paste-id-here>\""
  exit 1
fi

echo "Applying migrations to remote D1..."
npm run db:migrate

echo "Deploying worker..."
npm run deploy

echo "Done. Cron will run on schedule."
