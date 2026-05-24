# NBA Data Worker — API 与数据表说明

本文档用中文说明 **nba-data-worker** 的架构、数据表用途以及 API 列表与用法。

---

## 一、架构概览

### 1.1 整体流程

```
ESPN 公开 API → Worker（拉取 + 解析）→ D1 数据库 → 对外 REST API
```

- **数据源**：ESPN 公开接口（scoreboard、summary、teams、roster、athletes 等），无需鉴权。
- **运行环境**：Cloudflare Worker，绑定 **D1（SQLite）** 和可选 **Durable Object（实时轮询）**。
- **更新方式**：定时 Cron（1 分钟 / 2 分钟 / 6 小时 / 24 小时） + 可选 Admin 手动刷新。

### 1.2 目录与职责

| 目录/文件 | 职责 |
|-----------|------|
| `src/index.ts` | 路由：健康检查、游戏列表、NBA/ML/Admin/Debug/RT 等 API |
| `src/cron/sync.ts` | Cron 入口、scoreboard/直播同步、阵容推导、roster/赛季统计/近期出场刷新 |
| `src/db.ts` | D1 查询与写入（表访问、批量 upsert、分块 IN 查询等） |
| `src/espn.ts` | 请求 ESPN、解析 scoreboard/summary/roster/athlete 等 JSON |
| `src/lineup/derive.ts` | 从 boxscore 先发 + 换人事件推导当前场上 5+5 阵容 |
| `src/active12/deriveActive12.ts` | 从 boxscore 推导每队「活跃 12 人」并写入 roster12 |
| `src/roster12/derive.ts` | roster12 的约束与质量（位置、近期出场等） |
| `src/position.ts` | 位置归一化（G/F/C）、从 stats 数组解析出场时间 |
| `src/types.ts` | 公共类型（Env、NormalizedGame、BoxscorePlayer 等） |
| `migrations/*.sql` | D1 表结构及参考数据（如 player_game_stats_keys） |

### 1.3 Cron 节奏

| Cron | 表达式 | 做什么 | 更新的表/数据 |
|------|--------|--------|----------------|
| 1m | `*/1 * * * *` | 若有直播：拉 scoreboard + 同步所有直播场次（不写 boxscore 快照） | games_current、games_snapshot、teams、refresh_state；每场：players、player_game_stats_current、game_lineup_current、game_playbyplay_cursor、game_sync_diagnostics |
| 2m | `*/2 * * * *` | scoreboard + 同步所有直播场次（每隔一次写 boxscore 快照） | 同上 + game_boxscore_snapshot |
| 6h | `0 */6 * * *` | refreshTeamRosters、buildRecentUsage、buildTeamRoster12Current | teams、players、rosters、player_recent_usage、team_roster_12_current、refresh_state |
| 24h | `0 0 * * *` | refreshPlayerSeasonStats、清理 7 天 games_snapshot、24 小时 game_boxscore_snapshot | player_season_stats、refresh_state；删除过期快照 |

---

## 二、数据表说明

所有时间戳均为 **Unix 秒（整数）**，除非另注。主键与更新来源见下表。

### 2.1 比赛与状态

| 表名 | 用途 | 主键 | 更新来源 |
|------|------|------|----------|
| **games_current** | 当前赛程/直播：每场比赛一行，比分、节次、主客队等 | game_id | 1m/2m scoreboard + sync；Admin refresh |
| **games_snapshot** | 历史 scoreboard 快照，用于回放/排查；保留 7 天 | (game_id, fetched_at) | 1m/2m 拉 scoreboard 时写入；24h 清理 |
| **refresh_state** | 单例：上次拉取时间、直播场数、cron 锁、最近错误 | key（固定 "singleton"） | 各 cron 与 sync 更新 |

### 2.2 球队与球员

| 表名 | 用途 | 主键 | 更新来源 |
|------|------|------|----------|
| **teams** | NBA 30 支球队 id、名称、缩写 | team_id | scoreboard 写入；6h 从 ESPN /teams 补全 |
| **players** | 球员档案：id、姓名、球队、位置、号码、头像等 | player_id | 直播 sync 的 boxscore 球员；6h roster 刷新 |
| **rosters** | 每队每赛季名单；raw_json 存 ESPN 原始球员对象，用于 API 标准化与回退 | (team_id, season, player_id) | 6h refreshTeamRosters |

### 2.3 阵容与直播数据

| 表名 | 用途 | 主键 | 更新来源 |
|------|------|------|----------|
| **game_lineup_current** | 每场当前场上 5+5：home_on_court_json、away_on_court_json；由 boxscore 先发 + 换人推导 | game_id | syncLiveGameSummary、syncOneGameNow |
| **game_playbyplay_cursor** | 每场 PBP 已处理到的 event seq，用于增量解析换人 | game_id | 同上 |
| **player_game_stats_current** | 每场每人当前 boxscore 统计；json 为数组，顺序见 player_game_stats_keys | (game_id, player_id) | 同上 |
| **player_game_stats_keys** | 参考表：player_game_stats_current.json 数组下标 0–13 的含义（MIN、PTS、FG…） | ordinal (0–13) | migration 写入，静态 |
| **game_boxscore_snapshot** | 每场 boxscore 原始 JSON 快照；保留 24 小时 | (game_id, fetched_at) | 2m 间隔写入；syncOneGameNow?boxscore=1；24h 清理 |

### 2.4 聚合与衍生

| 表名 | 用途 | 主键 | 更新来源 |
|------|------|------|----------|
| **player_recent_usage** | 每人在某队某赛季「近期」出场：场次、总分钟、先发次数（14 天窗口）；用于 roster12 排序 | (player_id, season, window_days) | 6h buildRecentUsage（先 boxscore 快照，无快照时用 player_game_stats_current 回退） |
| **team_roster_12_current** | 每队每赛季「活跃 12 人」：player_ids_json、positions_json、约束与质量 | (team_id, season) | 6h buildTeamRoster12Current |
| **player_season_stats** | 每人每赛季统计：perGame/totals/advanced/raw，供 ML 或前端 | (player_id, season, stat_type) | 24h refreshPlayerSeasonStats；Admin refresh-player-stats |

### 2.5 运维与观测

| 表名 | 用途 | 主键 | 更新来源 |
|------|------|------|----------|
| **cron_runs** | 每次 Cron 执行记录：cron 表达式、开始/结束、ok/error、计数等 | run_id | runScheduledCron |
| **game_sync_diagnostics** | 每场每次 sync 的简单诊断：阵容人数、cursor、缺失 profile/stats、原因等 | id | syncLiveGameSummary、syncOneGameNow |
| **error_log** | 错误流水：时间、scope、key、message（截断） | id | 各 sync/cron 出错时写入 |

---

## 三、API 列表

### 3.1 公开 API（无需鉴权）

成功响应形如：`{ "ok": true, "data": ..., "meta": { "serverTimeUtc", "source": "espn", "cacheHit" } }`。多数支持 **ETag** 与 **If-None-Match** 返回 304。

| 方法 | 路径 | 说明 | 典型 Cache-Control |
|------|------|------|--------------------|
| GET | `/v1/health` | 健康检查 | no-store |
| GET | `/v1/games/live` | 当前直播比赛列表 | public, max-age=15 |
| GET | `/v1/games/today` | 今日比赛，可选 `?date=YYYYMMDD` | public, max-age=30 |
| GET | `/v1/games/:gameId` | 单场当前信息 + 最新 snapshot | public, max-age=15 |
| GET | `/v1/state` | refresh_state 状态（上次拉取、直播数、错误等） | public, max-age=10 |
| GET | `/v1/nba/games/:gameId/lineup` | 该场当前阵容（主客各 5 人 profile + confidence） | public, max-age=15 |
| GET | `/v1/nba/games/:gameId/boxscore` | 该场最新 boxscore 原始 JSON | public, max-age=30 |
| GET | `/v1/nba/games/:gameId/players/stats` | 该场每位球员当前统计（playerId、teamId、stats） | public, max-age=15 |
| GET | `/v1/nba/stats-keys` | player_game_stats_current.json 数组下标说明（ordinal、key、label、description） | public, max-age=86400 |
| GET | `/v1/nba/players/:playerId` | 球员标准化档案（来自 players + roster raw_json）；可选 `?raw=1`、`?seasonStats=0` | public, max-age=60 |
| GET | `/v1/nba/players/:playerId/season-stats` | 该球员赛季统计；`?season=YYYY` 单赛季，否则全部赛季 | public, max-age=60 |
| GET | `/v1/nba/teams/:teamId/roster12` | 该队当前赛季 roster12（12 人 + 位置 + 近期出场/赛季统计等）；可选 `?season=YYYY`、`?includePastSeasons=1` | public, max-age=60 |
| GET | `/v1/ml/games/:gameId/context` | ML 用：比赛 + 阵容 + 直播统计 + 可选赛季统计 + quality 对象；可选 `?includeSeason=1`、`?includeRoster12=1`、`?includePastSeasons=1` | public, max-age=15 |
| GET | `/` | 服务名、健康、比赛数等简要信息 | no-store |

### 3.2 Admin API（需 Header `X-ADMIN-KEY`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/admin/refresh` | 触发一次 scoreboard + 直播同步 |
| POST | `/v1/admin/refresh-rosters` | 刷新 30 队 roster（teams、players、rosters） |
| POST | `/v1/admin/refresh-player-stats` | 刷新球员赛季统计（player_season_stats），会请求 ESPN |
| POST | `/v1/admin/refresh-recent-usage` | 按当前数据重算 player_recent_usage（14 天窗口） |
| POST | `/v1/admin/games/:gameId/sync` | 单场同步；可选 `?boxscore=1` 写入 boxscore 快照 |
| GET | `/v1/admin/smoke` | 烟雾测试：表存在性、refresh_state、样本查询等 |
| GET | `/v1/admin/diagnostics/state` | 状态诊断：refresh_state、锁、直播数等 |
| GET | `/v1/admin/diagnostics/games` | 最近若干场摘要（含 lineup、stats 更新时间等） |
| GET | `/v1/admin/diagnostics/game/:gameId` | 单场详细诊断 |

### 3.3 Debug API（需 `X-ADMIN-KEY`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/debug/games/:gameId/sync-diagnostics` | 该场 sync 诊断记录列表 |
| GET | `/v1/debug/games/:gameId/quick` | 该场简要：game、lineup、boxscore 时间、诊断摘要 |
| GET | `/v1/debug/teams/:teamId/active12` | 该队 active12 推导上下文（调试用） |
| GET | `/v1/debug/cron-runs` | 最近 Cron 执行记录 |

### 3.4 实时（Durable Object）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/rt/nba/games/:gameId/context` | 通过 DO 拉取该场最新 context |
| GET | `/v1/rt/nba/games/:gameId/stream` | 流式轮询（需 RT 相关 token 等配置） |

---

## 四、关键字段说明

### 4.1 player_game_stats_current.json

`json` 为 **数组**，顺序与 `player_game_stats_keys` 表（及 `GET /v1/nba/stats-keys`）一致：

| 下标 | 含义 | 示例值 |
|------|------|--------|
| 0 | MIN 出场时间（分钟） | "38" |
| 1 | PTS 得分 | "26" |
| 2 | FG 投篮（命中-出手） | "10-16" |
| 3 | 3PT 三分 | "5-7" |
| 4 | FT 罚球 | "1-2" |
| 5 | REB 篮板 | "6" |
| 6 | AST 助攻 | "0" |
| 7 | TO 失误 | "1" |
| 8 | STL 抢断 | "2" |
| 9 | BLK 盖帽 | "0" |
| 10 | OREB 前场板 | "1" |
| 11 | DREB 后场板 | "5" |
| 12 | PF 犯规 | "2" |
| 13 | +/- 正负值 | "+5" |

### 4.2 game_lineup_current

- **home_on_court_json** / **away_on_court_json**：主客队当前场上 5 人的 `player_id` 数组。
- **derived_from**：`"boxscore"`（仅先发）或 `"playbyplay"`（先发+换人）。
- **confidence**：0–1，越高表示推导越可信。

### 4.3 ML context 的 quality 对象

- **ok**：是否通过内部质量检查（阵容/统计新鲜度、缺失数等）。
- **reasons**：未通过时的原因，如 `LINEUP_STALE`、`STATS_STALE`、`MISSING_STATS`、`MISSING_PROFILES`。
- **lineupAgeSec** / **statsAgeSec**：阵容、统计距上次更新的秒数。
- **missingProfiles** / **missingStats**：缺姓名、缺统计的场上人数。
- **profileFromRoster**：姓名来自 roster 回退的人数（roster 6h 一更）。

---

## 五、部署与配置

- **部署**：`workers/nba-data-worker/scripts/deploy.sh`（先迁移 D1，再 `wrangler deploy`）。
- **环境变量**（wrangler.toml / 控制台）：`ADMIN_KEY`、`ESPN_BASE_URL`、`RT_POLL_MS`、`RT_STREAM_TOKEN` 等。
- **D1**：`beyondmarket_nba`，binding 名为 `DB`。
- **Cron**：见 1.3 节；最少 1 分钟粒度。

---

## 六、参考

- 表结构以 `migrations/*.sql` 为准。
- 类型与行结构见 `src/types.ts`、`src/db.ts`。
- 英文详细说明见项目根目录 `README.md`。
