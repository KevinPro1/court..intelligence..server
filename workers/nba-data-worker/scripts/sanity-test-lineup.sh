#!/usr/bin/env bash
# Sanity test: lineup stability for a live game.
# 1. Find a live gameId (from /v1/games/live, else first from /v1/games/today).
# 2. Request /v1/nba/games/:gameId/lineup 5–10 times; expect stable response (changes only on substitution).

set -e
BASE_URL="${BASE_URL:-http://localhost:8787}"
REQUESTS="${REQUESTS:-8}"
TMPDIR="${TMPDIR:-/tmp}"

echo "=== Lineup stability sanity test ==="
echo "BASE_URL=$BASE_URL  REQUESTS=$REQUESTS"
echo ""

# Resolve gameId: prefer first live game
GAME_ID=""
LIVE_JSON=$(curl -sS --connect-timeout 5 "$BASE_URL/v1/games/live" || true)
if [ -n "$LIVE_JSON" ]; then
  GAME_ID=$(echo "$LIVE_JSON" | jq -r '.data[0].gameId // empty')
fi
if [ -z "$GAME_ID" ]; then
  TODAY_JSON=$(curl -sS --connect-timeout 5 "$BASE_URL/v1/games/today" || true)
  GAME_ID=$(echo "$TODAY_JSON" | jq -r '.data[0].gameId // empty')
fi
if [ -z "$GAME_ID" ]; then
  echo "No gameId found (no live/today games). Start worker and ensure D1 has scoreboard data."
  echo "  Example: wrangler dev  # then re-run this script"
  exit 1
fi

echo "Using gameId: $GAME_ID"
LINEUP_URL="$BASE_URL/v1/nba/games/$GAME_ID/lineup"
OUT_DIR="$TMPDIR/lineup-sanity-$$"
mkdir -p "$OUT_DIR"

# Request lineup N times (save body only; ETag may vary by response time)
for i in $(seq 1 "$REQUESTS"); do
  curl -sS "$LINEUP_URL" > "$OUT_DIR/body_$i.json"
  echo "  request $i -> body_$i.json"
done

# Compare only stable lineup data (ignore meta.serverTimeUtc and data.updatedAt which change every request)
for i in $(seq 1 "$REQUESTS"); do
  jq -cS '.data | {homeOnCourtIds, awayOnCourtIds, derivedFrom, confidence}' "$OUT_DIR/body_$i.json" > "$OUT_DIR/norm_$i.json" 2>/dev/null || echo '{"homeOnCourtIds":[],"awayOnCourtIds":[],"derivedFrom":null,"confidence":null}' > "$OUT_DIR/norm_$i.json"
done
SAME=1
for i in $(seq 2 "$REQUESTS"); do
  if ! cmp -s "$OUT_DIR/norm_1.json" "$OUT_DIR/norm_$i.json"; then
    SAME=0
    echo "  DIFF: request 1 vs $i"
  fi
done

echo ""
if [ "$SAME" -eq 1 ]; then
  echo "PASS: Lineup response identical across $REQUESTS requests (stable; no change between polls)."
else
  echo "INFO: Lineup response differed in at least one request."
  echo "  Expected if cron ran a substitution update between requests. Check data.homeOnCourtIds / awayOnCourtIds."
fi

# Show one sample (home/away counts)
echo ""
echo "Sample lineup (request 1):"
jq -r '.data | "  home: \((.homeOnCourtIds // []) | length) players, away: \((.awayOnCourtIds // []) | length) players, derivedFrom: \(.derivedFrom), confidence: \(.confidence)"' "$OUT_DIR/body_1.json" 2>/dev/null || true
rm -rf "$OUT_DIR"
echo "Done."
