# Court Intelligence Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A monorepo of **Cloudflare Workers** providing **live-game sports data** (NBA & Soccer) for ML training and realtime consumers. Uses **D1** as the durable slow-path (minute-level cron sync) and an optional **Durable Object** as a best-effort fast-path (5s polling cache + optional SSE). No paid APIs; all data comes from ESPN public APIs.

## Workers in this monorepo

| Worker | Status | Description |
|--------|--------|-------------|
| [`workers/nba-data-worker`](./workers/nba-data-worker) | ✅ **Production** | Main NBA worker — D1 + Durable Objects + cron sync + ESPN parsing + ML context API |
| [`workers/soccer-data-worker`](./workers/soccer-data-worker) | ✅ Active | ESPN soccer data — scoreboard, match summary, shots, team features, ML context, pregame tracking |
| [`workers/nba-data-worker-legacy`](./workers/nba-data-worker-legacy) | 🗄️ Legacy | Earlier NBA worker — **do not deploy**, kept for reference only |

## Table of Contents

- [Quickstart](#quickstart)
- [Repo layout](#repo-layout)
- [How to run locally](#how-to-run-locally-production-worker)
- [How to run cron manually](#how-to-run-cron-manually-admin)
- [System overview](#system-overview)
- [Architecture](#architecture)
- [Low latency: keeping lineup in sync](#low-latency-keeping-lineup-in-sync-with-live-games)
- [D1 tables](#d1-tables)
- [API usage](#api-usage-curl)
- [ML ingestion workflow](#ml-ingestion-workflow)
- [Example SQL](#example-sql-dsml)
- [Deployment & env vars](#deployment--env-vars)
- [License](#license)

> **Note:** The detailed documentation below focuses on **`nba-data-worker`** (the primary production target). For soccer-specific details, see [`workers/soccer-data-worker/README.md`](./workers/soccer-data-worker/README.md).

---

## Repo layout

| Path | Role |
|------|------|
| **`/workers/nba-data-worker`** | **PRODUCTION** worker — this is the only deploy target. D1, Durable Objects, active12, cron, ESPN parsing. |
| **`/workers/soccer-data-worker`** | **ACTIVE** soccer worker — D1, cron sync, ML context, pregame tracking. |
| **`/workers/nba-data-worker-legacy`** | **LEGACY** worker — do **not** deploy. Kept for reference/history only. See that directory's README. |
| **`/docs`** | Shared documentation. |

**Default deploy:** run from repo root `npm run deploy:worker` (deploys `workers/nba-data-worker` only). There is no wrangler at repo root; deploying the legacy worker requires explicitly `cd workers/nba-data-worker-legacy` and setting `ALLOW_LEGACY_DEPLOY=1`.

**Do not run `npx wrangler dev` (or `wrangler dev --local`) from the repo root** — there is no `wrangler.toml` at the root, so you'll get "Missing entry-point to Worker script". Use `npm run dev:worker` from the root, or `cd workers/nba-data-worker` then `npx wrangler dev` / `npx wrangler dev --local`.

---

## Quickstart

```bash
cd workers/nba-data-worker
npm install
cp .dev.vars.example .dev.vars   # set ADMIN_KEY, optionally RT_STREAM_TOKEN
npx wrangler dev
```

- **Today’s games:** `GET http://localhost:8787/v1/games/today`
- **ML context (D1):** `GET http://localhost:8787/v1/ml/games/:gameId/context?includeSeason=1`
- **Realtime snapshot (DO):** `GET http://localhost:8787/v1/rt/nba/games/:gameId/context`

Admin endpoints require header `X-ADMIN-KEY: <ADMIN_KEY>`.

---

## How to run locally (production worker)

From repo root:

```bash
npm run dev:worker              # remote D1/KV
npm run dev:worker:local        # local D1/KV (--local)
```

Or from the worker directory:

```bash
cd workers/nba-data-worker
npm install
cp .dev.vars.example .dev.vars   # set ADMIN_KEY; optionally RT_STREAM_TOKEN
npx wrangler dev                # or: npx wrangler dev --local
```

Set **`.dev.vars`** in `workers/nba-data-worker/` (copy from `.dev.vars.example`). Required: **ADMIN_KEY**. Optional: **RT_STREAM_TOKEN** for SSE.

---

## How to run cron manually (admin)

Cron is triggered by Cloudflare; to trigger a full refresh or single-game sync manually, call the admin endpoints with **X-ADMIN-KEY**:

```bash
# Full refresh (scoreboard + live games sync)
curl -s -X POST -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "http://localhost:8787/v1/admin/refresh"

# Single-game sync (optional boxscore=1)
curl -s -X POST -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "http://localhost:8787/v1/admin/games/GAME_ID/sync?boxscore=1"
```

Use your deployed worker URL in place of `http://localhost:8787` for production.

---

## System overview

| Layer | Role | Update cadence | Durability |
|-------|-----|----------------|------------|
| **D1** | Durable source of truth; analytics, training, fallback | Cron: 1m (live) / 2m (fallback) / 6h (rosters) / 24h (stats) | Writes on every cron/sync |
| **Durable Object (DO)** | Best-effort realtime cache per game | Polls ESPN every **RT_POLL_MS** (default **5s**) | Writes lineup to D1 on each poll when DO is active |

- **Cron minimum is 1 minute** (Cloudflare limit). High-frequency freshness comes from the DO.
- **DO** keeps latest derived lineup + liveStats in memory; it reads D1 for game row and initial cursor/lineup. On each poll it also **writes** the derived lineup to **game_lineup_current** so D1 stays in sync (low latency for both DO and D1 readers). If the game is missing in D1, the DO stops polling and sets an error.

---

## Architecture

- **D1 (slow-path):** Scoreboard → `games_current`; per-game sync → lineup (from play-by-play + boxscore), `player_game_stats_current`, boxscore snapshots, play-by-play cursor. Roster and player season stats filled by 6h/24h cron.
- **DO (fast-path):** One DO per `gameId`; on alarm it fetches ESPN summary, derives lineup, builds a snapshot (game + lineup + liveStats), stores it in memory, and optionally pushes to SSE clients. Single-flight polling (at most one ESPN fetch at a time per game).

**Recommendation for ML:** Prefer **D1-backed** `/v1/ml/games/:gameId/context` for training and batch jobs (consistent, durable). Use **DO** `/v1/rt/nba/games/:gameId/context` for low-latency inference when you need fresher data and can tolerate best-effort.

---

## Low latency: keeping lineup in sync with live games

To keep **game_lineup_current** and lineup APIs aligned with the live on-court 5v5 with low delay:

1. **Use the realtime (DO) endpoint for “current” lineup**  
   - **GET** `/v1/rt/nba/games/:gameId/context` — lineup is refreshed every **RT_POLL_MS** (default **5s**).  
   - Client: poll every 5–10s, or use **If-None-Match** with the last **ETag** to only process when the snapshot changed.

2. **Optional: SSE stream (push updates)**  
   - **GET** `/v1/rt/nba/games/:gameId/stream` (header **X-RT-TOKEN** or query **token=**).  
   - You receive **update** events every RT_POLL_MS when the DO polls; no client polling needed.

3. **Optional: shorten poll interval**  
   - In **wrangler.toml** or secrets, set **RT_POLL_MS** = `3000` (3s) for fresher data. Higher ESPN request rate per game; use only if needed.

4. **DO now writes lineup to D1 on each poll**  
   - When at least one client has hit the DO for a game (e.g. requested context or stream), the DO polls ESPN every RT_POLL_MS and **writes the derived lineup to game_lineup_current**. So **D1** (and APIs that read from D1, e.g. `/v1/nba/games/:gameId/lineup`, `/v1/ml/games/:gameId/context`) also update every 5s for that game while the DO is active. Cron (1–2 min) still updates D1 for all live games; the DO keeps D1 fresh for games that are being watched in realtime.

---

## D1 tables

All timestamps are **Unix seconds (integer)** unless noted. Schema: `workers/nba-data-worker/migrations/*.sql`.

| Table | Purpose | Key(s) | Updated by | Retention / TTL |
|-------|---------|--------|------------|------------------|
| **games_current** | Current game state (score, period, clock, teams) | `game_id` (PK) | Cron (scoreboard + per-game sync) | Overwritten on each sync |
| **games_snapshot** | Append-only game state history for replay/debug | `(game_id, fetched_at)` | Cron (per-game sync) | `cleanupSnapshots(retainDays)` default 7 days |
| **refresh_state** | Singleton: cron lock + last fetch times + live count | `key` (e.g. `singleton`) | Cron | Single row |
| **teams** | Team id, name, abbr, espn_team_id | `team_id` (PK) | Cron (scoreboard, rosters) | Long-lived |
| **players** | Player profile (name, team, position, jersey, headshot) | `player_id` (PK) | Cron (boxscore/roster upserts) | Long-lived |
| **rosters** | Team roster per season (raw JSON) | `(team_id, season, player_id)` | Cron 6h | Long-lived |
| **player_season_stats** | Season-level stats per player/type | `(player_id, season, stat_type)` | Cron 24h | Long-lived |
| **game_lineup_current** | Current 5-on-5 (home/away player IDs JSON + derived_from, confidence) | `game_id` (PK) | Cron (per-game sync) | Overwritten per game |
| **game_playbyplay_cursor** | Last processed play-by-play event seq for substitutions | `game_id` (PK) | Cron (per-game sync) | Overwritten per game |
| **player_game_stats_current** | Per-game per-player boxscore stats (JSON) | `(game_id, player_id)` | Cron (per-game sync) | Overwritten per game |
| **game_boxscore_snapshot** | Append-only boxscore JSON for debug | `(game_id, fetched_at)` | Cron (per-game sync) | `cleanupBoxscoreSnapshots(retainHours)` default 24h |
| **cron_runs** | Cron execution log (started_at, ok, error, counts) | `run_id` (auto) | Cron | Append-only; query by time |
| **game_sync_diagnostics** | Per-game sync sanity (lineup counts, missing profiles/stats, cursor) | `id` (auto); index `(game_id, created_at)` | Cron (per-game sync) | Append-only |
| **error_log** | Rolling error history (scope, key, message) | `id` (auto); index `(scope, ts)` | Any path on error | Append-only |

### Field highlights

- **games_current:** `game_id`, `date_ymd`, `start_time_utc`, `status`, `period`, `clock`, `completed` (0/1), `home_team_id`, `home_team_name`, `home_team_abbr`, `home_score`, `away_*`, `updated_at`.
- **refresh_state:** `last_scoreboard_fetch_at`, `live_games_count`, `last_live_detect_at`, `last_live_check_at`, `last_2m_refresh_at`, `last_error`, `lock_until` (cron mutex), `lock_token`, `updated_at`.
- **game_lineup_current:** `home_on_court_json`, `away_on_court_json` (arrays of player_id), `derived_from` (e.g. `playbyplay` / `boxscore`), `confidence`, `updated_at`.
- **game_playbyplay_cursor:** `last_event_seq`, `last_fetched_at`, `updated_at`.
- **player_game_stats_current:** `game_id`, `player_id`, `team_id`, `json` (stats blob), `updated_at`.
- **game_sync_diagnostics:** `game_id`, `cron`, `created_at`, `ok`, `reasons` (JSON), `home_on_court_count`, `away_on_court_count`, `missing_profiles`, `missing_stats`, `cursor_before`/`cursor_after`, `notes`, etc.

---

## API usage (curl)

Base URL: your worker (e.g. `https://nba-data-worker.<account>.workers.dev` or `http://localhost:8787`).

### Public / ML

```bash
# Today's games (D1)
curl -s "https://YOUR_WORKER/v1/games/today"

# Live games only (D1)
curl -s "https://YOUR_WORKER/v1/games/live"

# Single game (D1)
curl -s "https://YOUR_WORKER/v1/games/401584893"

# Lineup only (D1)
curl -s "https://YOUR_WORKER/v1/nba/games/401584893/lineup"

# Player stats for game (D1)
curl -s "https://YOUR_WORKER/v1/nba/games/401584893/players/stats"

# ML context: game + lineup + liveStats + quality; optional season stats (D1)
curl -s "https://YOUR_WORKER/v1/ml/games/401584893/context?includeSeason=1"
```

### Realtime (DO)

```bash
# Realtime context (DO snapshot; supports If-None-Match for 304)
curl -s -D - "https://YOUR_WORKER/v1/rt/nba/games/401584893/context"

# With ETag caching (second request returns 304 if unchanged)
ETAG=$(curl -sI "https://YOUR_WORKER/v1/rt/nba/games/401584893/context" | grep -i etag | tr -d '\r' | cut -d' ' -f2)
curl -s -D - -H "If-None-Match: $ETAG" "https://YOUR_WORKER/v1/rt/nba/games/401584893/context"

# SSE stream (protected by RT_STREAM_TOKEN or ADMIN_KEY; use -N for streaming)
curl -s -N -H "X-RT-TOKEN: YOUR_RT_STREAM_TOKEN" "https://YOUR_WORKER/v1/rt/nba/games/401584893/stream"
# or: ?token=YOUR_RT_STREAM_TOKEN
# Events: snapshot (initial), update (on each DO poll), ping (heartbeat every 15s)
```

### Admin

```bash
# Full refresh (scoreboard + live games sync)
curl -s -X POST -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "https://YOUR_WORKER/v1/admin/refresh"

# Single-game sync (optional boxscore=1)
curl -s -X POST -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "https://YOUR_WORKER/v1/admin/games/401584893/sync?boxscore=1"

# Smoke test (tables, refresh_state, sample live game lineup/stats/boxscore)
curl -s -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "https://YOUR_WORKER/v1/admin/smoke"

# Diagnostics
curl -s -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "https://YOUR_WORKER/v1/admin/diagnostics/state"
curl -s -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "https://YOUR_WORKER/v1/admin/diagnostics/games"
curl -s -H "X-ADMIN-KEY: YOUR_ADMIN_KEY" "https://YOUR_WORKER/v1/admin/diagnostics/game/401584893"
```

---

## ML ingestion workflow

### Recommended polling

- **Training / batch:** Use **D1** via `/v1/ml/games/:gameId/context`. Poll at most every 1–2 minutes; cron updates at 1m for live games.
- **Realtime inference:** Use **DO** `/v1/rt/nba/games/:gameId/context` every 5–15s. Use `If-None-Match` with the last `ETag` to avoid re-processing when nothing changed.

### Freshness and quality (ML endpoint)

The **ML context** response includes a **`quality`** object:

- **`quality.ok`** — `true` only when all gates pass; **check this before using data**.
- **`quality.reasons`** — list of codes when not ok:
  - **LINEUP_STALE** — lineup older than ~30s
  - **STATS_STALE** — boxscore stats older than ~30s or missing
  - **MISSING_STATS** — more than 2 on-court players without stats
  - **MISSING_PROFILES** — one or more on-court players missing profile (name, etc.)
- **`quality.lineupAgeSec`**, **`quality.statsAgeSec`**, **`quality.missingProfiles`**, **`quality.missingStats`**, **`quality.profileFromRoster`** — raw metrics.

**Quality gates:** If `quality.ok` is false, either fall back to D1-only (e.g. retry later or use last known good snapshot) or wait and retry until ok. Do not train or serve on context with `quality.ok === false` when freshness matters.

### Realtime (DO) response shape

- **`/v1/rt/nba/games/:gameId/context`** returns JSON: `quality` (fetchedAtUtc, substitutionsCount, boxscorePlayersCount, derivedFrom, confidence, lastUpdatedMs, lastError), `game`, `lineup` (homeOnCourtIds, awayOnCourtIds, derivedFrom, confidence), `liveStats` (players: [{ playerId, teamId, stats }]). On cold start it may return **202** with `{ ok: false, error: { code: "WARMING_UP" } }`; retry after a short delay. Use **Cache-Control: public, max-age=1** and **ETag**; support **304** via **If-None-Match**.

- **`/v1/rt/nba/games/:gameId/stream`** (SSE): **Content-Type: text/event-stream**. Auth: header **X-RT-TOKEN** or query **token=**; value must equal **RT_STREAM_TOKEN** or **ADMIN_KEY**. Events: **snapshot** (initial full JSON), **update** (new snapshot after each DO poll, ~RT_POLL_MS), **ping** (heartbeat every 15s, empty or `{}`). Client should use `curl -N` or an SSE client to consume the stream.

---

## Example SQL (DS/ML)

```sql
-- Live games right now (D1)
SELECT * FROM games_current
WHERE completed = 0 AND status NOT IN ('scheduled', '') AND status != ''
ORDER BY updated_at DESC;

-- Latest lineup and stats for a game
SELECT g.game_id, g.period, g.clock, l.home_on_court_json, l.away_on_court_json, l.derived_from, l.confidence, l.updated_at AS lineup_updated_at
FROM games_current g
JOIN game_lineup_current l ON l.game_id = g.game_id
WHERE g.game_id = '401584893';

SELECT player_id, team_id, json, updated_at FROM player_game_stats_current WHERE game_id = '401584893';

-- Stale games: lineup or stats older than 60s
SELECT g.game_id, g.updated_at AS game_updated_at,
       l.updated_at AS lineup_updated_at,
       (SELECT MAX(updated_at) FROM player_game_stats_current p WHERE p.game_id = g.game_id) AS stats_updated_at
FROM games_current g
JOIN game_lineup_current l ON l.game_id = g.game_id
WHERE g.completed = 0
  AND (l.updated_at < unixepoch() - 60 OR (SELECT MAX(updated_at) FROM player_game_stats_current p WHERE p.game_id = g.game_id) < unixepoch() - 60);

-- Join lineup player IDs to profiles
SELECT j.player_id, p.full_name, p.team_id, p.position
FROM (
  SELECT value AS player_id FROM json_each((SELECT home_on_court_json FROM game_lineup_current WHERE game_id = '401584893'))
  UNION SELECT value FROM json_each((SELECT away_on_court_json FROM game_lineup_current WHERE game_id = '401584893'))
) j
LEFT JOIN players p ON p.player_id = j.player_id;

-- Missing stats rate for a game (on-court vs with stats)
WITH on_court AS (
  SELECT value AS player_id FROM json_each((SELECT home_on_court_json FROM game_lineup_current WHERE game_id = '401584893'))
  UNION SELECT value FROM json_each((SELECT away_on_court_json FROM game_lineup_current WHERE game_id = '401584893'))
),
with_stats AS (SELECT player_id FROM player_game_stats_current WHERE game_id = '401584893')
SELECT (SELECT COUNT(*) FROM on_court) AS on_court_count,
       (SELECT COUNT(*) FROM with_stats) AS with_stats_count,
       (SELECT COUNT(*) FROM on_court o WHERE NOT EXISTS (SELECT 1 FROM with_stats s WHERE s.player_id = o.player_id)) AS missing_stats_count;

-- Recent cron run failures
SELECT run_id, cron, started_at, finished_at, ok, error, live_games_count, synced_games_count
FROM cron_runs
WHERE ok = 0
ORDER BY started_at DESC
LIMIT 20;

-- Recent diagnostics failures for a game
SELECT game_id, cron, created_at, ok, reasons, missing_profiles, missing_stats, notes
FROM game_sync_diagnostics
WHERE game_id = '401584893' AND ok = 0
ORDER BY created_at DESC
LIMIT 10;
```

---

## Deployment & env vars

- **Worker:** `workers/nba-data-worker` (Wrangler project: `nba-data-worker`).
- **Deploy from root:** `npm run deploy:worker` (runs `wrangler deploy` in `workers/nba-data-worker`).
- **Deploy from worker dir:** `cd workers/nba-data-worker && npx wrangler deploy` (or use `scripts/deploy.sh` there for migrate-then-deploy).

| Variable | Required | Description |
|----------|----------|-------------|
| **ESPN_BASE_URL** | Yes | e.g. `https://site.api.espn.com/apis/site/v2/sports/basketball/nba` (vars) |
| **ADMIN_KEY** | Yes | Admin and smoke/diagnostics; use **wrangler secret** in production |
| **RT_POLL_MS** | No | DO poll interval in ms (default **5000**) |
| **RT_STREAM_TOKEN** | No | Token for SSE stream (header `X-RT-TOKEN` or query `token=`); if set, required for `/v1/rt/nba/games/:gameId/stream`. **ADMIN_KEY** also allows access. Use **wrangler secret** for production |

Set secrets:

```bash
cd workers/nba-data-worker
npx wrangler secret put ADMIN_KEY
npx wrangler secret put RT_STREAM_TOKEN   # optional
```

D1 database is bound as **DB**; Durable Object class **GameRealtimeDO** is bound as **RT** (see `wrangler.toml`).

---

## Summary

- **D1** = durable, minute-level sync; use for analytics, training, and reliable ML context.
- **DO** = best-effort 5s cache + optional SSE; use for low-latency realtime when acceptable.
- **ML endpoint** `quality.ok` and `quality.reasons` (LINEUP_STALE, STATS_STALE, MISSING_STATS, MISSING_PROFILES) define the **quality gate**; only use context with `quality.ok === true` when freshness matters.
- Prefer **ETag** + **If-None-Match** on realtime context to reduce payload and re-processing.

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](./LICENSE) file for details.

Copyright © 2026 kevinpro1
