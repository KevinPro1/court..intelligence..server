# nba-data-worker: Local Test & Remote Validation Guide

Worker: **nba-data-worker** (D1: `beyondmarket_nba`, Durable Object: **RT** `GameRealtimeDO`).  
Admin header: **`X-ADMIN-KEY`** (value from `wrangler.toml`; local default: `change-me`).

---

## STEP 0 — Local Dev

**Run:**

```bash
cd workers/nba-data-worker
wrangler dev
```

**Confirm:**

- Worker boots without type errors.
- No missing bindings: **DB** (D1) and **RT** (Durable Object) appear in startup output.
- Default URL: **http://localhost:8787** (or the URL wrangler prints).

Keep this terminal open for the following steps.

---

## STEP 1 — Smoke Test Tables

**Request:**

```bash
curl -s -H "X-ADMIN-KEY: change-me" http://localhost:8787/v1/admin/smoke | jq .
```

**Expected result:**

- Response shape: `{ ok: true, data: { ... }, meta: { ... } }`.
- **`data.ok`** = `true`
- **`data.tablesOk`** = `true`
- **`data.refreshStateOk`** = `true`
- Optional: `data.gamesCount`, `data.liveSampleOk`, `data.lineupOk`, `data.statsOk`, `data.boxscoreOk` (when there is a live game).

**If `data.tablesOk` is false:**

- Run:  
  `wrangler d1 migrations apply beyondmarket_nba --local`  
  (from `workers/nba-data-worker`).
- Then call `/v1/admin/smoke` again.

---

## STEP 2 — Seed Scoreboard + Teams

**Request:**

```bash
curl -s -X POST -H "X-ADMIN-KEY: change-me" http://localhost:8787/v1/admin/refresh | jq .
```

**Expected:**

- `data.message` = `"Refresh completed"`.
- `data` includes scoreboard/live sync info (e.g. `liveSynced`).

**Verify:**

```bash
curl -s http://localhost:8787/v1/games/today | jq .
```

**Explain:**

- `games_current` should now have rows (today’s games).
- `teams` table is populated by the refresh flow.  
- Response: `{ ok: true, data: [ ... games ... ], meta }`; `data` is an array of game objects.

---

## STEP 3 — Force Roster Refresh

**Request:**

```bash
curl -s -X POST -H "X-ADMIN-KEY: change-me" http://localhost:8787/v1/admin/refresh-rosters | jq .
```

**Expected:**

- `data.message` = `"Roster refresh completed"`.
- `data.refreshedTeamsCount` ≥ 0 (e.g. 30 teams).

**Verify one team** (replace `<TEAM_ID>` with a real team ID from your data, e.g. from `/v1/games/today` → `home_team_id` or `away_team_id`):

```bash
curl -s "http://localhost:8787/v1/nba/teams/<TEAM_ID>/roster12" | jq .
```

**Explain:**

- `team_roster_12_current` must exist for that team/season (created by roster refresh or by cron).
- Response includes: `teamId`, `season`, `players` (array with `profile`, `posGroup`, etc.), `quality`, `constraints`.

---

## STEP 4 — Season Stats Backfill (Current + Past 3)

**Request:**

```bash
curl -s -X POST -H "X-ADMIN-KEY: change-me" http://localhost:8787/v1/admin/refresh-player-stats | jq .
```

**Expected:**

- `data.message` = `"Player stats refresh completed"`.
- `data.refreshedPlayersCount` ≥ 0.

**Verify:**

```bash
curl -s "http://localhost:8787/v1/nba/teams/<TEAM_ID>/roster12?includePastSeasons=1" | jq .
```

**Expected:**

- Each item in `data.players` can have **`seasonStatsBySeason`** (object keyed by season year).
- Keys should include: **current season** (e.g. `2024`), **seasonYear-1**, **seasonYear-2**, **seasonYear-3** (where applicable).
- Current season is updated every 24h by cron; past seasons do not re-fetch once present.

---

## STEP 5 — Test Active12 Dynamic Adjust

Pick a **live** `gameId` (from `/v1/games/today` or `/v1/games/live`).

**Request:**

```bash
curl -s -X POST -H "X-ADMIN-KEY: change-me" "http://localhost:8787/v1/admin/games/<GAME_ID>/sync?boxscore=1" | jq .
```

**Expected:**

- `data.message` = `"Game sync completed"`.
- `data.playersUpserted`, `data.statsUpserted`, `data.lineupUpdated`, `data.elapsedMs` present.

**Verify** (use one of the game’s team IDs):

```bash
curl -s -H "X-ADMIN-KEY: change-me" "http://localhost:8787/v1/debug/teams/<TEAM_ID>/active12" | jq .
```

**Expected:**

- **`data.derived.quality.updated_reason`** = `"boxscore_dynamic_adjust"` (when boxscore context was used).
- **`data.derived.quality.boxscore_hit_count`** > 0 (players from boxscore in active 12).
- **`data.derived.quality.usage_coverage_ratio`** > 0.
- **`data.current`** should reflect the updated roster (same team/season).

---

## STEP 6 — ML Context API

**Request:**

```bash
curl -s "http://localhost:8787/v1/ml/games/<GAME_ID>/context?includeSeason=1&includeRoster12=1&includePastSeasons=1" | jq .
```

**Verify:**

- **`data.quality.ok`** (boolean).
- **`data.lineup.homeOnCourt`** — array of 5 (on-court players).
- **`data.lineup.awayOnCourt`** — array of 5.
- **`data.liveStats.players`** (or equivalent live stats structure).
- **`data.roster12.home.players`** — up to 12; each has `profile`, `posGroup`, optionally `recentUsage`, `seasonStatsBySeason`.
- **`data.roster12.away.players`** — same.
- **`data.game`** — normalized game.
- With `includePastSeasons=1`, roster12 players can include **`seasonStatsBySeason`** for current and past 3 seasons.

---

## STEP 7 — Realtime Durable Object

**Context (snapshot):**

```bash
curl -s "http://localhost:8787/v1/rt/nba/games/<GAME_ID>/context" | jq .
```

**SSE stream:**

```bash
curl -N "http://localhost:8787/v1/rt/nba/games/<GAME_ID>/stream"
```

**Expected:**

- Context returns current game/lineup/state from the DO.
- Stream: continuous JSON events (e.g. score/lineup updates).
- Polling interval ~ **RT_POLL_MS** (5000 ms in wrangler.toml).

---

## STEP 8 — Diagnostics

**State (lock / refresh):**

```bash
curl -s -H "X-ADMIN-KEY: change-me" http://localhost:8787/v1/admin/diagnostics/state | jq .
```

**Games (latest N with age / lineup):**

```bash
curl -s -H "X-ADMIN-KEY: change-me" http://localhost:8787/v1/admin/diagnostics/games | jq .
```

**Cron runs:**

```bash
curl -s -H "X-ADMIN-KEY: change-me" http://localhost:8787/v1/debug/cron-runs | jq .
```

**Optional — per-game diagnostics:**

```bash
curl -s -H "X-ADMIN-KEY: change-me" "http://localhost:8787/v1/admin/diagnostics/game/<GAME_ID>" | jq .
```

---

## STEP 9 — Remote Deploy Verification

After **`wrangler deploy`** (or `./scripts/deploy.sh`), repeat the same curl tests using the **production URL** (e.g. `https://nba-data-worker.<YOUR_SUBDOMAIN>.workers.dev`):

- Replace `http://localhost:8787` with your deployed worker URL.
- Use the **same** `X-ADMIN-KEY` value as configured in the deployed worker (production should use a real secret, not `change-me`).

---

## What To Report Back

Please paste:

1. **`/v1/admin/smoke`** response (full JSON or at least `data`).
2. **`/v1/admin/refresh-player-stats`** response (full or `data`).
3. **One** `roster12?includePastSeasons=1` response (full or `data.players[0]` and `data.players[0].seasonStatsBySeason`).
4. **One** `ml/games/:gameId/context` response **quality section** (e.g. `data.quality` and, if present, `data.roster12.home.quality` / `data.roster12.away.quality`).

Then we can evaluate:

- **Is 3-season backfill working?** — `seasonStatsBySeason` has current + past 3 season keys where expected.
- **Is 24h update logic correct?** — Cron runs and refresh_player_stats behavior; no duplicate full backfills.
- **Is dynamic Active12 updating properly?** — After boxscore sync, `debug/teams/:teamId/active12` shows `updated_reason: "boxscore_dynamic_adjust"`, `boxscore_hit_count` > 0.
- **Is ML context safe for production?** — No missing required fields; roster12 present when `includeRoster12=1`; quality flags and lineup/liveStats consistent.

Be strict: validate every step and report any 4xx/5xx or unexpected shapes.
