# Manual Test Guide: roster12 `positions_json` (array vs map)

This guide verifies that the API correctly reads `team_roster_12_current.positions_json` in both formats:

- **Legacy:** `string[]` (index-aligned with `player_ids_json`)
- **New:** `Record<string, string>` (playerId → `"G"|"F"|"C"|"UNK"`)

No production logic is changed; this doc only adds test data and curl checks.

---

## Prerequisites

- Run from repo root or from `workers/nba-data-worker` for wrangler commands.
- D1 binding name in app: **`DB`**. For CLI use **database_name** from `workers/nba-data-worker/wrangler.toml`: **`beyondmarket_nba`**.
- Local DB: `--local`; remote/preview: `--remote`.

---

## A) Insert test data into `team_roster_12_current`

Use two different `team_id`s for clarity: **`test_pos_legacy`** (array) and **`test_pos_map`** (map). Same `season` (e.g. `2024`). `updated_at` is Unix seconds.

A ready-made seed file **`docs/manual-tests/seed_roster12_positions.sql`** in the repo inserts both roster12 rows and the minimal `players` rows (see B). Run it from **`workers/nba-data-worker`**.

### Wrangler execute (DB binding: use database name `beyondmarket_nba`)

From **`workers/nba-data-worker`**:

```bash
# Local
wrangler d1 execute beyondmarket_nba --local --file=../docs/manual-tests/seed_roster12_positions.sql

# Remote (preview/production)
wrangler d1 execute beyondmarket_nba --remote --file=../docs/manual-tests/seed_roster12_positions.sql
```

Optional: run a single statement at a time with `--command="..."` (escape double quotes in JSON for your shell). The seed file above is the recommended way.

---

## B) Minimal `players` rows (so roster12 returns profiles)

`GET /v1/nba/teams/:teamId/roster12` and the ML context roster12 bundle read from `players` for profile (e.g. `full_name`). The seed file **`docs/manual-tests/seed_roster12_positions.sql`** already inserts minimal rows for `p1`, `p2`, `p3` with `team_id = test_pos_legacy`.

**Note:** Missing `player_recent_usage` or `player_season_stats` does **not** affect `posGroup` verification; they only add `recentUsage` and `seasonStatsBySeason`. You can omit them for this test.

---

## C) Curl verification

Start the worker locally (from `workers/nba-data-worker`):

```bash
wrangler dev
```

Assume the app is at **`http://localhost:8787`** (or the URL wrangler prints).

### 1) GET `/v1/nba/teams/:teamId/roster12?season=YYYY`

```bash
# Legacy (array) team
curl -s "http://localhost:8787/v1/nba/teams/test_pos_legacy/roster12?season=2024" | jq .

# Map team
curl -s "http://localhost:8787/v1/nba/teams/test_pos_map/roster12?season=2024" | jq .
```

**How to check `posGroup`:**

- In the response, `data.players` (or the top-level `players` if your envelope is different) is an array of `{ profile, posGroup, ... }`.
- For **test_pos_legacy**: `positions_json` is `["G","F","C"]`, so:
  - `players[0].profile.playerId === "p1"` → `players[0].posGroup` should be **`"G"`**
  - `players[1].profile.playerId === "p2"` → **`"F"`**
  - `players[2].profile.playerId === "p3"` → **`"C"`**
- For **test_pos_map**: `positions_json` is `{"p1":"G","p2":"F","p3":"C"}`, so the same mapping by `profile.playerId` must hold.

### 2) GET `/v1/ml/games/:gameId/context?includeRoster12=1`

This endpoint returns roster12 only when the game’s home/away teams have rows in `team_roster_12_current`. You need a game row whose `home_team_id` / `away_team_id` are `test_pos_legacy` and/or `test_pos_map`.

**Option A – use an existing game:** If you have a game in `games_current` (or the table your app uses) with `home_team_id = test_pos_legacy` or `away_team_id = test_pos_map`, call:

```bash
curl -s "http://localhost:8787/v1/ml/games/<GAME_ID>/context?includeRoster12=1" | jq .
```

Then check `data.roster12.home.players` and/or `data.roster12.away.players`: each element should have `profile.playerId` and `posGroup` matching that team’s `positions_json` (array or map).

**Option B – insert a minimal game for the test teams:** Insert one game where `home_team_id = test_pos_legacy` and `away_team_id = test_pos_map`, then use that `game_id` in the curl above. The exact table and columns depend on your schema (`games_current` / `game_id`, etc.); add one row and use its `game_id` in the URL.

**Check:** For each team in `roster12.home` / `roster12.away`, the list `players` must have the same `profile.playerId` → `posGroup` mapping as in section 1. Missing or wrong `posGroup` (or missing roster bundle) when `positions_json` is a map would indicate a bug.

---

## D) Expected result (example)

After running the seeds and curls, you should see something like the following.

**Legacy team `test_pos_legacy`** (`positions_json` = `["G","F","C"]`):

```json
{
  "teamId": "test_pos_legacy",
  "season": 2024,
  "players": [
    { "profile": { "playerId": "p1", "fullName": "Test Player 1", ... }, "posGroup": "G" },
    { "profile": { "playerId": "p2", "fullName": "Test Player 2", ... }, "posGroup": "F" },
    { "profile": { "playerId": "p3", "fullName": "Test Player 3", ... }, "posGroup": "C" }
  ],
  "quality": { ... },
  "constraints": { ... }
}
```

**Map team `test_pos_map`** (`positions_json` = `{"p1":"G","p2":"F","p3":"C"}`):

```json
{
  "teamId": "test_pos_map",
  "season": 2024,
  "players": [
    { "profile": { "playerId": "p1", "fullName": "Test Player 1", ... }, "posGroup": "G" },
    { "profile": { "playerId": "p2", "fullName": "Test Player 2", ... }, "posGroup": "F" },
    { "profile": { "playerId": "p3", "fullName": "Test Player 3", ... }, "posGroup": "C" }
  ],
  "quality": { ... },
  "constraints": { ... }
}
```

So in both cases:

| `profile.playerId` | `posGroup` |
|--------------------|------------|
| `p1`               | `G`        |
| `p2`               | `F`        |
| `p3`               | `C`        |

Confirming that array and map formats both produce correct `posGroup` values for each player.
