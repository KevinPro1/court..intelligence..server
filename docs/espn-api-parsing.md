# ESPN API parsing: shape assumptions and fallbacks

This doc lists where we parse ESPN responses and what paths/fallbacks we use so tables do not stay empty when the API shape changes.

---

## 1. Scoreboard (`/scoreboard`, `?dates=YYYYMMDD`)

| Table / effect | Parser | Primary path | Fallbacks added |
|----------------|--------|--------------|------------------|
| `games_current`, `teams` | `parseScoreboard` | `data.events` | `data.day.events`, `data.scoreboard.events` |
| Per-event teams | `normalizeEvent` → `getTeamFromCompetitor` | `event.competitors` | **`event.competitions[0].competitors`** (current ESPN shape) |
| Team id | `getTeamFromCompetitor` | `team.id`, `competitor.id` | `team.uid`, `competitor.uid` |
| Status | `normalizeEvent` | `event.status` | `event.competitions[0].status` |

**Previously wrong:** We only read `event.competitors`; ESPN returns `event.competitions[0].competitors`. That caused empty `home_team_id` / `away_team_id` and empty lineup/roster12.

---

## 2. Summary (`/summary?event=gameId`)

| Table / effect | Parser | Primary path | Fallbacks added |
|----------------|--------|--------------|------------------|
| Plays (PBP) | `extractPlays` | `root.plays`, `header.competitions[0].plays` | `root.competitions[0].plays` |
| Boxscore players | `parseBoxscorePlayers` | **`root.boxscore.players`** (summary: each item has `team` + `statistics[0].athletes[]`) | `root.boxscore.teams`; `header.competitions[0].boxscore` when root box has no teams/players |
| Substitutions | `parsePlayByPlaySubstitutions` | Uses `extractPlays` output | (same as above) |

**Summary boxscore shape:** `boxscore.players[]` = 2 entries (one per team); each has `team.id` and `statistics[0].athletes[]` with `{ athlete: { id, displayName, jersey, position }, starter, stats }`. `boxscore.teams[]` only has team-level stats (no player list).

---

## 3. Teams (`/teams`)

| Table / effect | Parser | Primary path | Fallbacks added |
|----------------|--------|--------------|------------------|
| `teams` | `parseAllNbaTeams` | `root.sports[0].leagues[0].teams` | `root.leagues[0].teams` (scoreboard-style root) |

---

## 4. Team roster (`/teams/:teamId` or `/teams/:teamId/roster`)

| Table / effect | Parser | Primary path | Fallbacks added |
|----------------|--------|--------------|------------------|
| `players`, `rosters` | `parseTeamRoster` | `root.athletes`, `root.roster`, `root.team.athletes`, `root.team.roster` | `root.players`, `root.team.players` |

---

## 5. Athlete season stats (`/athletes/:playerId?season=YYYY`)

| Table / effect | Parser | Primary path | Fallbacks added |
|----------------|--------|--------------|------------------|
| `player_season_stats` | `parseAthleteSeasonStats` | `root.statistics`, `root.stats`, `root.splits` | `root.athlete.statistics`, `root.season.statistics`; splits/categories array; always store at least `raw` so table is not empty when API shape differs |

---

## Roster raw_json normalization

Roster rows store ESPN’s full athlete object in `raw_json`. We normalize it for API use:

- **Parser**: `parseRosterRawToProfile(raw_json)` in espn.ts. Handles both top-level athlete object and `{ athlete: {...} }`.
- **Output**: `NormalizedRosterProfile` (id, displayName, position, jersey, headshot, weight, height, college, birthPlace, contract, status, experience).
- **API**: `GET /v1/nba/players/:playerId` returns `profile` (from players table + roster raw parsed), optional `?raw=1`, optional `seasonStats` (current season from `player_season_stats`). `GET /v1/nba/players/:playerId/season-stats` returns season stats (single season with `?season=YYYY` or all seasons without param).

---

## 6. Active12 / roster12 (no direct ESPN call)

| Table / effect | Logic | Change |
|----------------|--------|--------|
| `team_roster_12_current` | `updateTeamsActive12FromBoxscore` | **Skip empty `team_id`** so we never write a row for `team_id=""` when scoreboard has no team data. |

---

## Quick check if a table is empty

1. **games_current** – `home_team_id` / `away_team_id` empty → scoreboard: use `event.competitions[0].competitors` and team id fallbacks (done).
2. **teams** – empty → `/teams` response: try `root.leagues[0].teams` (done).
3. **rosters** / **players** – empty → roster response: try `root.players`, `root.team.players` (done); also confirm roster URL and that cron/refresh ran.
4. **player_season_stats** – empty → athlete stats response: try `root.athlete.statistics`, `root.season.statistics` (done).
5. **game_lineup_current** – empty lineup → needs valid `games_current.home_team_id`/`away_team_id` and boxscore players; summary boxscore fallback added (done).
6. **team_roster_12_current** – row with `player_ids_json=[]` for `team_id=""` → skip writing when team id is empty (done).

If a table is still empty after deploy, capture the raw ESPN response for that endpoint and compare keys to the paths above.
