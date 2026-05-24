# NBA Live Data Platform — ML Engineer Guide

Cloudflare Worker that ingests **NBA live data from ESPN**, stores it in **D1 (SQLite)**, and exposes **REST APIs** for games, lineups, live stats, and ML context. This README is written for **ML engineers** who consume the data; it documents schema, APIs, and recommended usage.

---

## Quickstart for ML

Replace `WORKER_URL` with your deployed worker URL (e.g. `https://nba-data-worker.<subdomain>.workers.dev`).

```bash
# 1. Health check
curl -s "WORKER_URL/v1/health" | jq

# 2. List today's games (pick a gameId for live inference)
curl -s "WORKER_URL/v1/games/today" | jq '.data[] | {gameId, status, completed}'

# 3. List currently live games (best for real-time context)
curl -s "WORKER_URL/v1/games/live" | jq '.data[] | .gameId'

# 4. Get ML context for a game (10 on-court players + live stats + optional season stats). Use a gameId from step 2 or 3.
curl -s "WORKER_URL/v1/ml/games/GAME_ID/context?includeSeason=1" | jq

# 5. Check quality object in the response: quality.ok, quality.reasons, quality.lineupAgeSec, quality.statsAgeSec, quality.missingStats
```

Use the **quality** object in the ML context response to decide if the snapshot is fresh enough for inference; see [How to use for ML](#how-to-use-for-ml) below.

---

## What This Worker Does

1. **Ingestion**: Fetches ESPN scoreboard (games for a date) and game summary (play-by-play + boxscore) per game.
2. **Storage**: Writes to D1: current games, snapshots, teams, players, rosters, player season stats, per-game lineup, play-by-play cursor, live boxscore stats, and boxscore snapshots.
3. **APIs**: Public endpoints for games, lineup, boxscore, player stats; one **ML-focused** endpoint that returns game + lineup (10 on-court) + live stats + optional season stats with a **quality** object.
4. **Cron**: Four schedules keep data fresh — 1m (live games only), 2m (scoreboard + live sync), 6h (rosters), 24h (season stats + snapshot cleanup).

Data flow: **ESPN → Worker (fetch + parse) → D1 → your API calls**.

---

## D1 Schema

All timestamps in the schema are **Unix seconds (integer)** unless noted. Schema is defined in `migrations/*.sql`; TypeScript row shapes live in `src/types.ts` (some columns added by migrations, e.g. `lock_until`, `lock_token`, may not be in types — treat schema as canonical).

---

### games_current

| Aspect | Description |
|--------|-------------|
| **Purpose** | One row per game; upserted by `game_id` for fast reads. Source of truth for current score, status, period, clock. |
| **Primary key** | `game_id` (TEXT) |
| **Update sources** | `fetchScoreboardAndUpsert` (1m cron when live count > 0, 2m cron always); admin `POST /v1/admin/refresh` |
| **Freshness** | Scoreboard: every 1m if there are live games, else every 2m. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| game_id | TEXT | NOT NULL | ESPN event id | "401810596" |
| date_ymd | TEXT | NOT NULL | Game date YYYYMMDD | "20260207" |
| start_time_utc | TEXT | nullable | ISO start time | "2026-02-07T00:30:00.000Z" |
| status | TEXT | NOT NULL | Display status (e.g. "Q3 5:00", "Halftime", "Final") | "Q3 5:00" |
| period | INTEGER | NOT NULL | Period number (0 = not started) | 3 |
| clock | TEXT | NOT NULL | Game clock | "5:00" |
| completed | INTEGER | NOT NULL | 1 = final, 0 = not final | 0 |
| home_team_id | TEXT | NOT NULL | Home team id (ESPN) | "1" |
| home_team_name | TEXT | nullable | Home team name | "Atlanta Hawks" |
| home_team_abbr | TEXT | nullable | Abbreviation | "ATL" |
| home_score | INTEGER | NOT NULL | Home score | 98 |
| away_team_id | TEXT | NOT NULL | Away team id | "2" |
| away_team_name | TEXT | nullable | Away team name | "Boston Celtics" |
| away_team_abbr | TEXT | nullable | "BOS" |
| away_score | INTEGER | NOT NULL | Away score | 102 |
| raw_json | TEXT | nullable | UNKNOWN (stored as null in code) | null |
| updated_at | INTEGER | NOT NULL | Unix seconds of last update | 1770368458 |

**ML query example:** Get live games and their last update time.

```sql
SELECT game_id, status, period, clock, home_score, away_score, updated_at
FROM games_current
WHERE completed = 0 AND status NOT IN ('scheduled', '') AND status != ''
ORDER BY updated_at DESC;
```

---

### games_snapshot

| Aspect | Description |
|--------|-------------|
| **Purpose** | Append-only snapshots of scoreboard rows for replay/debugging. Retention: 7 days (24h cron cleanup). |
| **Primary key** | (game_id, fetched_at) |
| **Update sources** | `insertGamesSnapshot` inside `fetchScoreboardAndUpsert` (1m/2m cron, admin refresh) |
| **Freshness** | Every 1m or 2m when scoreboard is fetched. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| game_id | TEXT | NOT NULL | ESPN event id | "401810596" |
| fetched_at | INTEGER | NOT NULL | Unix seconds when snapshot was taken | 1770368396 |
| date_ymd | TEXT | NOT NULL | YYYYMMDD | "20260207" |
| start_time_utc | TEXT | nullable | ISO start | "2026-02-07T00:30:00.000Z" |
| status | TEXT | NOT NULL | Status at fetch time | "Q2 8:00" |
| period | INTEGER | NOT NULL | Period at fetch | 2 |
| clock | TEXT | NOT NULL | Clock at fetch | "8:00" |
| completed | INTEGER | NOT NULL | 0 or 1 | 0 |
| home_team_id, home_team_name, home_team_abbr | TEXT | mixed | Home team fields | |
| home_score | INTEGER | NOT NULL | Home score at fetch | 45 |
| away_team_id, away_team_name, away_team_abbr | TEXT | mixed | Away team fields | |
| away_score | INTEGER | NOT NULL | Away score at fetch | 48 |
| raw_json | TEXT | nullable | UNKNOWN (null in code) | null |

**ML query example:** Latest snapshot per game in last 24h.

```sql
SELECT game_id, fetched_at, status, period, clock, home_score, away_score
FROM games_snapshot
WHERE fetched_at >= (unixepoch() - 86400)
ORDER BY game_id, fetched_at DESC;
```

---

### teams

| Aspect | Description |
|--------|-------------|
| **Purpose** | One row per NBA team; used for roster refresh and display. |
| **Primary key** | `team_id` (TEXT) |
| **Update sources** | Scoreboard upsert in `fetchScoreboardAndUpsert`; `refreshTeamRosters` (6h) upserts from ESPN `/teams` when fewer than 30 teams exist. |
| **Freshness** | Every 1m/2m from scoreboard; 6h cron ensures 30 teams from ESPN /teams if needed. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| team_id | TEXT | NOT NULL | Team id (ESPN; used as primary key) | "1" |
| name | TEXT | NOT NULL | Full name | "Atlanta Hawks" |
| abbr | TEXT | NOT NULL | Abbreviation | "ATL" |
| espn_team_id | TEXT | nullable | Same as team_id in practice | "1" |
| updated_at | INTEGER | NOT NULL | Unix seconds | 1770368516 |

**ML query example:** All teams for mapping team_id to name.

```sql
SELECT team_id, name, abbr FROM teams ORDER BY team_id;
```

---

### refresh_state

| Aspect | Description |
|--------|-------------|
| **Purpose** | Singleton row (key='singleton') for Smart Refresh: last fetch times, live count, cron lock, last error. |
| **Primary key** | `key` (TEXT) |
| **Update sources** | All cron branches and sync paths; cron lock (lock_until) set at cron start, cleared at end. |
| **Freshness** | Updated on every scoreboard fetch, live sync, roster/stats cron, and on errors. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| key | TEXT | NOT NULL | Always "singleton" | "singleton" |
| last_scoreboard_fetch_at | INTEGER | nullable | Unix seconds of last scoreboard fetch | 1770368396 |
| live_games_count | INTEGER | NOT NULL | Count of live games at last scoreboard fetch | 6 |
| last_live_detect_at | INTEGER | nullable | When live count was last detected | 1770368396 |
| last_live_check_at | INTEGER | nullable | Last 1m cron check time | 1770368396 |
| last_2m_refresh_at | INTEGER | nullable | Last 2m cron refresh | 1770368329 |
| last_error | TEXT | nullable | Last error message (bounded in code to 500 chars) | "PBP_PLAYS_NOT_FOUND:401810600" |
| updated_at | INTEGER | NOT NULL | Last update time | 1770368398 |
| lock_until | INTEGER | nullable | Cron lock expiry (Unix seconds); NULL when not locked | null or 1770368506 |
| lock_token | TEXT | nullable | Migration 0003; usage UNKNOWN in code | null |

**ML query example:** Check if ingestion is healthy (no recent error).

```sql
SELECT last_scoreboard_fetch_at, live_games_count, last_error, lock_until
FROM refresh_state WHERE key = 'singleton';
```

---

### players

| Aspect | Description |
|--------|-------------|
| **Purpose** | One row per player; profiles for lineup and ML context. Filled from boxscore (live sync) and from roster (6h). |
| **Primary key** | `player_id` (TEXT) |
| **Update sources** | `syncLiveGameSummary` / `syncOneGameNow` (boxscore players); `refreshTeamRosters` (6h, from roster). |
| **Freshness** | Live games: every 1m/2m for players in boxscore; all 30 rosters: every 6h. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| player_id | TEXT | NOT NULL | ESPN athlete id | "3136197" |
| full_name | TEXT | NOT NULL | Display name | "Trae Young" |
| team_id | TEXT | nullable | Current team id | "1" |
| position | TEXT | nullable | Position abbreviation | "PG" |
| jersey | TEXT | nullable | Jersey number | "11" |
| headshot | TEXT | nullable | Headshot URL | "https://..." |
| updated_at | INTEGER | NOT NULL | Last upsert time | 1770368452 |

**ML query example:** Players on court for a game (join with lineup JSON).

```sql
SELECT p.player_id, p.full_name, p.team_id, p.position, p.jersey
FROM players p
WHERE p.player_id IN (SELECT value FROM json_each('["id1","id2",...]'));
```

---

### rosters

| Aspect | Description |
|--------|-------------|
| **Purpose** | Per-team, per-season roster; raw ESPN JSON for fallback profile (name, position, jersey) when players table is missing data. |
| **Primary key** | (team_id, season, player_id) |
| **Update sources** | `refreshTeamRosters` (6h cron). |
| **Freshness** | Every 6 hours. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| team_id | TEXT | NOT NULL | Team id | "1" |
| season | INTEGER | NOT NULL | Season start year (e.g. 2024 for 2024-25) | 2024 |
| player_id | TEXT | NOT NULL | ESPN athlete id | "3136197" |
| raw_json | TEXT | nullable | ESPN roster entry JSON | "{\"athlete\":{...}}" |
| updated_at | INTEGER | NOT NULL | Last upsert | 1770368000 |

**ML query example:** Roster for a season (for fallback profiles).

```sql
SELECT team_id, player_id, raw_json
FROM rosters
WHERE season = 2024
ORDER BY team_id, player_id;
```

---

### player_season_stats

| Aspect | Description |
|--------|-------------|
| **Purpose** | Per-player, per-season stats (perGame, totals, advanced, or raw). Used by ML context when `includeSeason=1`. |
| **Primary key** | (player_id, season, stat_type) |
| **Update sources** | `refreshPlayerSeasonStats` (24h cron). |
| **Freshness** | Every 24 hours. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| player_id | TEXT | NOT NULL | ESPN athlete id | "3136197" |
| season | INTEGER | NOT NULL | Season start year | 2024 |
| stat_type | TEXT | NOT NULL | e.g. "perGame", "totals", "advanced", "raw" | "perGame" |
| json | TEXT | NOT NULL | JSON object of stats | "{\"points\":28.4,...}" |
| updated_at | INTEGER | NOT NULL | Last upsert | 1770300000 |

**ML query example:** Season stats for a set of player IDs.

```sql
SELECT player_id, season, stat_type, json
FROM player_season_stats
WHERE season = 2024 AND player_id IN ('3136197','...');
```

---

### game_lineup_current

| Aspect | Description |
|--------|-------------|
| **Purpose** | Current on-court players per game: two JSON arrays (home, away) of player_id; derived from boxscore starters + play-by-play substitutions. |
| **Primary key** | `game_id` (TEXT) |
| **Update sources** | `syncLiveGameSummary`, `syncOneGameNow` (after deriving lineup). |
| **Freshness** | Every 1m/2m for live games; updated when boxscore or PBP substitutions change. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| game_id | TEXT | NOT NULL | ESPN event id | "401810596" |
| home_on_court_json | TEXT | NOT NULL | JSON array of player_id strings | "[\"3136197\",\"...\"]" |
| away_on_court_json | TEXT | NOT NULL | JSON array of player_id strings | "[\"...\"]" |
| derived_from | TEXT | NOT NULL | "boxscore" or "playbyplay" | "playbyplay" |
| confidence | REAL | NOT NULL | 0–1 confidence of derivation | 0.85 |
| updated_at | INTEGER | NOT NULL | Last lineup update (Unix seconds) | 1770368452 |

**ML query example:** Lineup and age for live games.

```sql
SELECT game_id, home_on_court_json, away_on_court_json, derived_from, confidence, updated_at,
       (unixepoch() - updated_at) AS lineup_age_sec
FROM game_lineup_current
WHERE game_id IN (SELECT game_id FROM games_current WHERE completed = 0);
```

---

### game_playbyplay_cursor

| Aspect | Description |
|--------|-------------|
| **Purpose** | Tracks last processed play-by-play event for incremental substitution parsing. |
| **Primary key** | `game_id` (TEXT) |
| **Update sources** | `syncLiveGameSummary`, `syncOneGameNow`. |
| **Freshness** | Same as lineup. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| game_id | TEXT | NOT NULL | ESPN event id | "401810596" |
| last_event_seq | INTEGER | NOT NULL | Last processed sequence number | 42 |
| last_fetched_at | INTEGER | NOT NULL | Unix seconds of last fetch | 1770368460 |
| updated_at | INTEGER | NOT NULL | Last update | 1770368460 |

**ML query example:** Cursor for a game (debugging / replay).

```sql
SELECT game_id, last_event_seq, last_fetched_at FROM game_playbyplay_cursor WHERE game_id = ?;
```

---

### player_game_stats_current

| Aspect | Description |
|--------|-------------|
| **Purpose** | Per-game, per-player stats from current boxscore (live stats). One row per (game_id, player_id). |
| **Primary key** | (game_id, player_id) |
| **Update sources** | `syncLiveGameSummary`, `syncOneGameNow` (from ESPN summary boxscore). |
| **Freshness** | Every 1m/2m for live games. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| game_id | TEXT | NOT NULL | ESPN event id | "401810596" |
| player_id | TEXT | NOT NULL | ESPN athlete id | "3136197" |
| team_id | TEXT | nullable | Team id for this game | "1" |
| json | TEXT | NOT NULL | Stats: ESPN summary uses array `[MIN,PTS,FG,3PT,FT,REB,AST,TO,STL,BLK,OREB,DREB,PF,+/-]` | `["38","26","10-16",...]` |
| updated_at | INTEGER | NOT NULL | Last upsert | 1770368452 |

**ML query example:** Live stats for a game and max update time.

```sql
SELECT player_id, team_id, json, updated_at
FROM player_game_stats_current
WHERE game_id = ?
ORDER BY updated_at DESC;

SELECT MAX(updated_at) AS max_at FROM player_game_stats_current WHERE game_id = ?;
```

**Interpretation:** The `json` array order matches the reference table `player_game_stats_keys`: index 0 = MIN, 1 = PTS, 2 = FG, 3 = 3PT, 4 = FT, 5 = REB, 6 = AST, 7 = TO, 8 = STL, 9 = BLK, 10 = OREB, 11 = DREB, 12 = PF, 13 = +/-. Use `GET /v1/nba/stats-keys` or query `player_game_stats_keys` for labels and descriptions.

---

### player_game_stats_keys

| Aspect | Description |
|--------|-------------|
| **Purpose** | Reference table: explains `player_game_stats_current.json` array order (ESPN summary boxscore stats). |
| **Primary key** | ordinal (0–13) |
| **Update** | Static; populated by migration. |

| Column | Type | Meaning |
|--------|------|---------|
| ordinal | INTEGER | Array index (0 = MIN, 1 = PTS, …) |
| key_name | TEXT | Internal key (e.g. minutes, points) |
| label | TEXT | Short label (MIN, PTS, FG, …) |
| description | TEXT | Human-readable description |

**API:** `GET /v1/nba/stats-keys` returns the same keys for clients to interpret `player_game_stats_current.json`.

---

### game_boxscore_snapshot

| Aspect | Description |
|--------|-------------|
| **Purpose** | Append-only raw boxscore JSON snapshots per game for debugging. Retention: 24 hours (24h cron). |
| **Primary key** | (game_id, fetched_at) |
| **Update sources** | `syncLiveGameSummary` (when 2m cron inserts boxscore), `syncOneGameNow` with `?boxscore=1`. |
| **Freshness** | Every 2m for live games (alternating minute); or on-demand admin sync with boxscore=1. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| game_id | TEXT | NOT NULL | ESPN event id | "401810596" |
| fetched_at | INTEGER | NOT NULL | Unix seconds when snapshot was taken | 1770368396 |
| json | TEXT | NOT NULL | Full ESPN summary/boxscore JSON | "{...}" |

**ML query example:** Latest snapshot time per game.

```sql
SELECT game_id, fetched_at
FROM game_boxscore_snapshot
WHERE game_id = ?
ORDER BY fetched_at DESC LIMIT 1;
```

---

### cron_runs

| Aspect | Description |
|--------|-------------|
| **Purpose** | Observability: log of each cron run (start, finish, ok/error, counts). |
| **Primary key** | `run_id` (INTEGER AUTOINCREMENT) |
| **Update sources** | `runScheduledCron`: insert at start, finish at end with metrics. |
| **Freshness** | One row per cron trigger (1m, 2m, 6h, 24h). |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| run_id | INTEGER | NOT NULL | Auto-increment id | 1 |
| cron | TEXT | NOT NULL | Schedule string | "*/1 * * * *" |
| started_at | INTEGER | NOT NULL | Unix seconds | 1770368340 |
| finished_at | INTEGER | nullable | Unix seconds when finished | 1770368342 |
| ok | INTEGER | NOT NULL | 1 = success, 0 = failure | 1 |
| error | TEXT | nullable | Error message on failure | null |
| live_games_count | INTEGER | nullable | Live games at run time | 6 |
| synced_games_count | INTEGER | nullable | Games synced | 6 |
| boxscore_snapshots_inserted | INTEGER | nullable | Boxscore snapshots inserted | 3 |
| players_upserted | INTEGER | nullable | Players upserted | 120 |
| stats_upserted | INTEGER | nullable | Stats rows upserted | 120 |

**ML query example:** Recent cron health.

```sql
SELECT run_id, cron, started_at, finished_at, ok, error
FROM cron_runs
ORDER BY started_at DESC LIMIT 20;
```

---

### game_sync_diagnostics

| Aspect | Description |
|--------|-------------|
| **Purpose** | Per-game sync sanity checks: lineup size, cursor, counts, reasons (e.g. LINEUP_BAD_SIZE, STATS_TOO_FEW). Used to detect ESPN schema drift. |
| **Primary key** | `id` (INTEGER AUTOINCREMENT) |
| **Update sources** | `syncLiveGameSummary`, `syncOneGameNow` (insert one row per sync). |
| **Freshness** | Every 1m/2m per live game; or on admin sync. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| id | INTEGER | NOT NULL | Auto-increment | 1 |
| game_id | TEXT | NOT NULL | ESPN event id | "401810596" |
| cron | TEXT | NOT NULL | "*/1", "*/2", or "admin" | "*/1" |
| created_at | INTEGER | NOT NULL | Unix seconds | 1770368452 |
| ok | INTEGER | NOT NULL | 1 = pass, 0 = fail | 1 |
| reasons | TEXT | nullable | JSON array of reason codes | "[\"LINEUP_BAD_SIZE\"]" |
| home_on_court_count | INTEGER | NOT NULL | Count of home on-court | 5 |
| away_on_court_count | INTEGER | NOT NULL | Count of away on-court | 5 |
| unique_on_court_count | INTEGER | NOT NULL | Unique player count (10 when valid) | 10 |
| missing_profiles | INTEGER | NOT NULL | -1 = skipped, else count | -1 |
| missing_stats | INTEGER | NOT NULL | On-court players without stats row | 0 |
| cursor_before | INTEGER | NOT NULL | PBP cursor before sync | 40 |
| cursor_after | INTEGER | NOT NULL | PBP cursor after sync | 42 |
| inserted_boxscore | INTEGER | NOT NULL | 1 if boxscore snapshot inserted | 0 |
| players_upserted | INTEGER | NOT NULL | Players upserted this sync | 10 |
| stats_upserted | INTEGER | NOT NULL | Stats rows upserted | 10 |
| notes | TEXT | nullable | Short hint (truncated to 300 chars in code) | "PBP_PLAYS_NOT_FOUND" |

**ML query example:** Recent diagnostics for a game.

```sql
SELECT id, created_at, ok, reasons, home_on_court_count, away_on_court_count, missing_stats
FROM game_sync_diagnostics
WHERE game_id = ?
ORDER BY created_at DESC LIMIT 20;
```

---

### error_log

| Aspect | Description |
|--------|-------------|
| **Purpose** | Rolling error history (scope, key, message) for debugging. Message truncated to 300 chars in code. |
| **Primary key** | `id` (INTEGER AUTOINCREMENT) |
| **Update sources** | Insert on errors in sync/cron (e.g. syncLiveGameSummary, cron catch blocks). |
| **Freshness** | On failure only. |

| Column | Type | Nullable | Meaning / units | Example |
|--------|------|----------|-----------------|---------|
| id | INTEGER | NOT NULL | Auto-increment | 1 |
| ts | INTEGER | NOT NULL | Unix seconds | 1770368270 |
| scope | TEXT | NOT NULL | e.g. "cron", "syncLiveGameSummary", "admin" | "syncLiveGameSummary" |
| key | TEXT | nullable | gameId or cron spec or null | "401810596" |
| message | TEXT | NOT NULL | Truncated to 300 chars | "PBP_PLAYS_NOT_FOUND:401810596" |

**ML query example:** Recent errors by scope.

```sql
SELECT id, ts, scope, key, message
FROM error_log
ORDER BY ts DESC LIMIT 50;
```

---

## Public APIs

All successful JSON responses use an envelope: `{ "ok": true, "data": ..., "meta": { "serverTimeUtc": "...", "source": "espn", "cacheHit": ... } }`. Errors use `{ "ok": false, "error": { "code": "...", "message": "..." }, "meta": ... }`. Unless noted, routes support **ETag** and **If-None-Match** for 304 when unchanged.

| Method | Path | Auth | Params | Response shape (data) | Cache-Control | ETag |
|--------|------|------|--------|------------------------|---------------|------|
| GET | `/v1/health` | None | — | `{ status, service }` | no-store | No |
| GET | `/v1/games/live` | None | — | Array of `NormalizedGame` | public, max-age=15 | Yes |
| GET | `/v1/games/today` | None | optional `date` (YYYYMMDD) | Array of `NormalizedGame` | public, max-age=30 | Yes |
| GET | `/v1/games/:gameId` | None | — | `{ current: NormalizedGame, latestSnapshot: {...} \| null }` | public, max-age=15 | Yes |
| GET | `/v1/state` | None | — | `RefreshStateRow`-like object | public, max-age=10 | Yes |
| GET | `/v1/nba/games/:gameId/lineup` | None | — | `{ gameId, homeOnCourt, awayOnCourt, confidence, derivedFrom, updatedAt }` (profiles + metadata) | public, max-age=15 | Yes |
| GET | `/v1/nba/games/:gameId/boxscore` | None | — | `{ gameId, fetchedAt, boxscore }` (boxscore = raw JSON) | public, max-age=30 | Yes |
| GET | `/v1/nba/games/:gameId/players/stats` | None | — | `{ gameId, players: [{ playerId, teamId, stats }] }` | public, max-age=15 | Yes |
| GET | `/v1/ml/games/:gameId/context` | None | optional `includeSeason=1` | See [ML context response](#ml-context-response) | public, max-age=15 | Yes |
| GET | `/` | None | — | `{ service, health, games }` | no-store | No |

**NormalizedGame** (from `src/types.ts`): `gameId`, `dateYmd`, `startTimeUtc`, `status`, `period`, `clock`, `completed`, `homeTeam: { id, name, abbr, score }`, `awayTeam: { id, name, abbr, score }`.

**ML context response** (`/v1/ml/games/:gameId/context`):

- `quality`: `{ ok, reasons[], lineupAgeSec, statsAgeSec, missingProfiles, missingStats, profileFromRoster }`
- `game`: NormalizedGame
- `lineup`: `{ homeOnCourt, awayOnCourt, confidence, derivedFrom, updatedAt }` (each on-court is `NormalizedPlayerProfile`)
- `liveStats`: `{ players: [{ playerId, teamId, stats }] }`
- `seasonStats` (if `includeSeason=1`): `{ season, players: { [playerId]: { perGame?, totals?, advanced?, raw? } } }`

**Example curl (public):**

```bash
curl -s "WORKER_URL/v1/games/live" | jq
curl -s "WORKER_URL/v1/games/today?date=20260207" | jq
curl -s "WORKER_URL/v1/ml/games/401810596/context?includeSeason=1" | jq
# With ETag (second request may get 304):
curl -sI "WORKER_URL/v1/games/live"
curl -s -H 'If-None-Match: "<etag>"' "WORKER_URL/v1/games/live"
```

---

## Admin and Debug APIs

All admin/debug routes require header **`X-ADMIN-KEY`** (value must match worker secret `ADMIN_KEY`). Responses use **Cache-Control: no-store**.

| Method | Path | Params | Response shape (data or body) |
|--------|------|--------|--------------------------------|
| POST | `/v1/admin/refresh` | — | `{ message, gamesCount, liveCount, liveSynced }` or error |
| POST | `/v1/admin/refresh-rosters` | — | `{ message, refreshedTeamsCount, playersUpserted, rosterRowsUpserted }` |
| POST | `/v1/admin/refresh-player-stats` | — | `{ message, refreshedPlayersCount, statRowsUpserted }` |
| POST | `/v1/admin/games/:gameId/sync` | optional `boxscore=1` | `{ message, gameId, playersUpserted, statsUpserted, lineupUpdated, elapsedMs }` |
| GET | `/v1/admin/smoke` | — | `{ ok, tablesOk, refreshStateOk, gamesCount, liveSampleOk, lineupOk, statsOk, boxscoreOk, error?, sampleGameId? }` |
| GET | `/v1/admin/diagnostics/state` | — | Body `{ ok: true, data }` or `{ ok: false, error }`; data: refresh_state, serverTimeUtc, isLocked, lockRemainingSec, liveGamesCountFromState, liveGamesCountActual |
| GET | `/v1/admin/diagnostics/games` | `limit` (default 10, max 50) | Body `{ ok: true, data: { games: [...] } }`; each game: gameId, status, completed, updated_at, date_ymd, start_time_utc, ageSec, lineupExists?, lineupUpdatedAt?, confidence?, statsMaxUpdatedAt? |
| GET | `/v1/admin/diagnostics/game/:gameId` | — | Body `{ ok: true, data }` or `{ ok: false, error }`; data: game, lineup meta, playbyplayCursor, liveStats meta, boxscoreSnapshotAgeSec, quality flags |
| GET | `/v1/debug/games/:gameId/sync-diagnostics` | `limit` (default 20, max 100) | `{ gameId, diagnostics: GameSyncDiagnosticResultRow[] }` |
| GET | `/v1/debug/games/:gameId/quick` | — | `{ game, lineup, boxscoreFetchedAt, diagnosticsSummary }` |
| GET | `/v1/debug/cron-runs` | `limit` (default 20, max 100) | `{ cronRuns: [...] }` |

**Example curl (admin):**

```bash
curl -s -X POST -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "WORKER_URL/v1/admin/refresh" | jq
curl -s -X POST -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "WORKER_URL/v1/admin/games/401810596/sync?boxscore=1" | jq
curl -s -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "WORKER_URL/v1/admin/smoke" | jq
curl -s -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "WORKER_URL/v1/admin/diagnostics/state" | jq
```

---

## How to Use for ML

### Recommended data pull workflow (live inference)

1. **Pick a gameId**
   - Call `GET /v1/games/live`; use any `gameId` from the list for in-progress games.
   - Or call `GET /v1/games/today` and choose a game (scheduled games may have no lineup/stats until tip-off).

2. **Fetch ML context**
   - `GET /v1/ml/games/:gameId/context?includeSeason=1` (omit `includeSeason=1` if you do not need season stats).

3. **Interpret the quality object**
   - `quality.ok`: `true` if the snapshot passed internal checks (lineup age ≤30s, stats age ≤30s, missingStats ≤2, missingProfiles 0).
   - `quality.reasons`: e.g. `["LINEUP_STALE","STATS_STALE","MISSING_STATS","MISSING_PROFILES"]` — use to gate or weight inference.
   - `quality.lineupAgeSec`: Seconds since lineup was last updated; lower is fresher.
   - `quality.statsAgeSec`: Seconds since last update to live stats; `null` if no stats yet.
   - `quality.missingProfiles`: Count of on-court players with no full name in `players` (or roster fallback).
   - `quality.missingStats`: Count of on-court players with no row in `player_game_stats_current`.
   - `quality.profileFromRoster`: Count of on-court players whose profile came from roster fallback (roster is 6h-refresh; may be slightly stale).

4. **When to fallback**
   - If `quality.ok` is false, consider skipping inference or using a different game/snapshot.
   - If `quality.statsAgeSec` is null or large (e.g. > 60), live stats may be missing or stale.
   - If `quality.missingStats > 0`, some on-court players have no boxscore stats (common right after substitutions or for scheduled games).
   - If `quality.missingProfiles > 0`, some players are missing names (you can still use player_id; roster fallback may fill names).

### Feature ideas

- **Lineup-based:** Use `lineup.homeOnCourt` / `lineup.awayOnCourt` (player_id, position, jersey, teamId) for lineup composition, height/position balance, or matchup features. Risk: `derivedFrom` "boxscore" vs "playbyplay" — playbyplay is more accurate after substitutions.
- **Live boxscore stats:** Use `liveStats.players[].stats` (points, rebounds, assists, etc.) for in-game performance. Risk: stats are from current boxscore only; missing for players just subbed in until next sync (1m/2m).
- **Season stats:** With `includeSeason=1`, use `seasonStats.players[playerId]` (perGame, totals, advanced) for prior performance. Risk: updated every 24h; not game-specific.
- **Leakage / mismatch:** Avoid using future information: use only `updated_at` / quality ages to ensure you are not leaking post-event data. Team ids and player ids are stable; names/rosters can lag (6h) vs boxscore (1m/2m).

---

## Troubleshooting

| Symptom | Meaning | What to do |
|--------|--------|------------|
| **No plays array / PBP_PLAYS_NOT_FOUND** | ESPN game summary returned empty play-by-play (common for **scheduled** games before tip-off). | Expected for scheduled games. Lineup may still come from boxscore; live stats may be empty until game starts. |
| **Lineup empty or missing** | No row in `game_lineup_current` for that game, or lineup derivation returned empty. | Ensure game is live or near tip-off. Call admin sync for that game: `POST /v1/admin/games/:gameId/sync`. Check `game_sync_diagnostics` for that game (reasons like LINEUP_BAD_SIZE). |
| **last_error in refresh_state** | Last error message from any sync/cron (e.g. timeout, parse error, PBP_PLAYS_NOT_FOUND). | Check `GET /v1/state` or admin diagnostics. For PBP_PLAYS_NOT_FOUND, no action needed for scheduled games. For other errors, check `error_log` and retry admin refresh or game sync. |
| **quality.reasons include LINEUP_STALE / STATS_STALE** | Lineup or live stats are older than 30 seconds. | Normal if you poll infrequently. Use a shorter polling interval for live inference or accept lower freshness. |
| **quality.missingStats > 0** | Some on-court players have no row in `player_game_stats_current`. | Common right after a substitution (stats appear on next 1m/2m sync). Or boxscore not yet populated (scheduled game). |
| **players / rosters empty** | No roster refresh yet or no boxscore data yet. | Trigger `POST /v1/admin/refresh-rosters` to fill teams + rosters (6h cron also does this). For boxscore-derived players, need a live game and 1m/2m sync. |

---

## Cron schedule summary

| Cron | Schedule | What runs | Tables updated |
|------|----------|-----------|----------------|
| 1m | `*/1 * * * *` | If live_games_count > 0: scoreboard + sync all live games (no boxscore snapshot) | games_current, games_snapshot, teams, refresh_state; per game: players, player_game_stats_current, game_lineup_current, game_playbyplay_cursor, game_sync_diagnostics |
| 2m | `*/2 * * * *` | Scoreboard + sync all live games (with boxscore snapshot every other minute) | Same as 1m + game_boxscore_snapshot |
| 6h | `0 */6 * * *` | refreshTeamRosters (and fetch ESPN /teams if &lt;30 teams) | teams, players, rosters, refresh_state |
| 24h | `0 0 * * *` | refreshPlayerSeasonStats + cleanupSnapshots(7) + cleanupBoxscoreSnapshots(24) | player_season_stats, refresh_state; deletes old games_snapshot, game_boxscore_snapshot |

---

## References

- **Worker name:** `nba-data-worker` (wrangler.toml)
- **D1 database:** `beyondmarket_nba`
- **Source:** ESPN public API; base URL in env `ESPN_BASE_URL` (default: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba`)
- **Code:** `src/index.ts` (routes), `src/db.ts` (queries), `src/types.ts` (shapes), `src/cron/sync.ts` (ingestion), `src/espn.ts` (fetch/parse), `src/lineup/derive.ts` (lineup derivation)
