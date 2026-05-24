# Pregame Track Record – Manual Test Plan

Run all commands from the worker root: `court-intelligence-server/workers/nba-data-worker` (or your repo path, e.g. `~/Projects/court-intelligence-server/workers/nba-data-worker`).

## Prerequisites

- Apply migrations (local D1):
  ```bash
  wrangler d1 migrations apply beyondmarket_nba --local
  ```
- For remote D1 run the same without `--local`:
  ```bash
  wrangler d1 migrations apply beyondmarket_nba --remote
  ```
- Worker running: `wrangler dev` (or use staging worker URL).

---

## A) Seed one pregame call (local D1)

```bash
wrangler d1 execute beyondmarket_nba --local --command "
INSERT INTO pregame_calls
(game_id, season, created_at, game_start_time_utc, home_team_id, away_team_id, picked_team_id, ai_prob, market_prob, model_version)
VALUES
('TEST_GAME_1', 2024, strftime('%s','now')-3600, '2026-02-09T03:00:00Z', 'LAL', 'NYK', 'LAL', 0.62, 0.54, 'nba_pregame_v1');
"
```

Simulate completion and metrics:

```bash
wrangler d1 execute beyondmarket_nba --local --command "
UPDATE pregame_calls
SET completed=1, winner_team_id='LAL', settled_at=strftime('%s','now'),
  pick_correct=1,
  ai_error=(ai_prob-1)*(ai_prob-1),
  market_error=(market_prob-1)*(market_prob-1),
  beat_market=CASE WHEN ((ai_prob-1)*(ai_prob-1)) < ((market_prob-1)*(market_prob-1)) THEN 1 ELSE 0 END
WHERE game_id='TEST_GAME_1';
"
```

(Ensure `teams` has rows for LAL/NYK so abbr/name resolve, or use team_ids that exist in your DB.)

---

## B) Verify GET endpoint (local worker)

```bash
curl "http://127.0.0.1:8787/v1/nba/track-record/pregame?limit=10&rangeDays=30"
```

Expect `{ "ok": true, "data": { "summary": { ... }, "calls": [ ... ] }, "meta": { ... } }` with at least the seeded row and correct `label` (e.g. `BEAT_MARKET ✅`).

---

## C) Admin API（更新 pregame_calls 数据）

`ADMIN_KEY` 来自 `wrangler.toml` 的 `[vars]`（本地/默认值为 `change-me-in-production`；生产若用 secret 则用 `wrangler secret list` 查看）。

**1) 记录赛前快照（新增一条 pregame_call，已存在则跳过）**

```bash
# 本地
curl -X POST "http://127.0.0.1:8787/v1/admin/pregame/snapshot" \
  -H "Content-Type: application/json" \
  -H "X-ADMIN-KEY: change-me-in-production" \
  -d '{"gameId":"nba-bos-mia-2026-02-10","pickedTeamId":"BOS","aiProb":0.58,"marketProb":0.52,"season":2025,"homeTeamId":"BOS","awayTeamId":"MIA","startTimeUtc":"2026-02-10T00:00:00Z","modelVersion":"nba_pregame_v1"}'

# 生产（替换 BASE 和 ADMIN_KEY）
BASE="https://nba-data-worker.xxx.workers.dev"
curl -X POST "$BASE/v1/admin/pregame/snapshot" \
  -H "Content-Type: application/json" \
  -H "X-ADMIN-KEY: change-me-in-production" \
  -d '{"gameId":"nba-bos-mia-2026-02-10","pickedTeamId":"BOS","aiProb":0.58,"marketProb":0.52,"season":2025,"homeTeamId":"BOS","awayTeamId":"MIA","startTimeUtc":"2026-02-10T00:00:00Z","modelVersion":"nba_pregame_v1"}'
```

**2) 更新已有 pregame 行（仅 completed=0 的行：ai_prob、market_prob、picked_team_id）**

```bash
# 本地
curl -X POST "http://127.0.0.1:8787/v1/admin/pregame/update" \
  -H "Content-Type: application/json" \
  -H "X-ADMIN-KEY: change-me-in-production" \
  -d '{"gameId":"nba-bos-mia-2026-02-10","aiProb":0.62,"marketProb":0.55,"pickedTeamId":"BOS"}'

# 生产
curl -X POST "$BASE/v1/admin/pregame/update" \
  -H "Content-Type: application/json" \
  -H "X-ADMIN-KEY: change-me-in-production" \
  -d '{"gameId":"nba-bos-mia-2026-02-10","aiProb":0.62,"marketProb":0.55,"pickedTeamId":"BOS"}'
```

**3) 结算（按比赛结果更新 completed、winner、pick_correct、beat_market 等）**

```bash
curl -X POST "http://127.0.0.1:8787/v1/admin/pregame/settle" \
  -H "Content-Type: application/json" \
  -H "X-ADMIN-KEY: change-me-in-production" \
  -d '{"results":[{"gameId":"nba-bos-mia-2026-02-10","winnerTeamId":"BOS"},{"slug":"nba-lal-nyk-2026-02-09","winnerTeamId":"LAL"}]}'
```

---

## D) Webapp

1. Set env: `NBA_DATA_WORKER_URL=http://127.0.0.1:8787` (or your worker base URL). For same-origin proxy, use `ORIGIN_BASE_URL` if the worker is your API origin.
2. Open AI Track Record modal → Short-horizon tab.
3. Recent Calls should show the seeded row with Game (e.g. NYK @ LAL), Pick (LAL), AI Prob, Market Prob, and Result label (e.g. BEAT_MARKET ✅).
4. Summary should show Pick Record and Beat Market Rate from the API.

---

## Labels (reference)

- `PENDING` – game not completed
- `BEAT_MARKET ✅` – beat market and pick correct
- `BEAT_MARKET (calibration win)` – beat market, pick wrong
- `MATCH_WIN_BUT_NO_EDGE` – pick correct, did not beat market
- `MISS` – did not beat market and pick wrong
