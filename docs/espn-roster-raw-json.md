# ESPN Roster API 与 rosters.raw_json 结构说明

`rosters.raw_json` 存的是 **ESPN roster API** 返回的 **单条 athlete 对象**（即 `root.athletes[i]` 或 `root.roster[i]` 的 JSON 字符串）。

---

## API 与存储

- **请求**: `GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{teamId}/roster`
- **根结构**: `{ timestamp, status, season, athletes, coach, team }`
- **我们存的**: 每条 `athletes[i]` 作为一条 roster 行的 `raw_json`（team_id, season, player_id 来自我们自己的解析）。

---

## 单条 athlete（raw_json）字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| **id** | string | 球员 ID（与 player_id 一致） |
| **uid** | string | 如 `s:40~l:46~a:4277848` |
| **guid** | string | UUID |
| **firstName** | string | 名 |
| **lastName** | string | 姓 |
| **fullName** | string | 全名 |
| **displayName** | string | 显示名 |
| **shortName** | string | 短名，如 "M. Bagley III" |
| **weight** | number | 体重（磅） |
| **displayWeight** | string | 如 "235 lbs" |
| **height** | number | 身高（英寸） |
| **displayHeight** | string | 如 "6' 10\"" |
| **age** | number | 年龄 |
| **dateOfBirth** | string | ISO 日期 |
| **debutYear** | number | 首秀年份 |
| **links** | array | 链接列表（playercard, stats, news 等） |
| **birthPlace** | object | `{ city, state, country }` |
| **college** | object | `{ id, name, shortName, abbrev, mascot, logos[] }` |
| **slug** | string | URL 段，如 "marvin-bagley-iii" |
| **headshot** | object | `{ href, alt }` 头像 URL |
| **jersey** | string | 球衣号，如 "00" |
| **position** | object | `{ id, name, displayName, abbreviation, leaf }`，如 abbreviation: "F" |
| **injuries** | array | **伤病列表**；无伤时 `[]`，有伤时为 `[{ id?, type?, status?, details?, date? }]` |
| **teams** | array | `[{ $ref: "..." }]` 当前球队 ref |
| **contracts** | array | `[{ salary, season: { year, startDate, endDate } }]` 历年合同 |
| **experience** | object | `{ years: number }` 年资 |
| **contract** | object | 当前合同详情（salary, yearsRemaining, season, active 等） |
| **status** | object | **出场/伤病状态**：`{ id, name, type, abbreviation }`，如 `{ id: "1", name: "Active", type: "active", abbreviation: "Active" }`；伤病时可能是 "Out", "Day-to-Day" 等 |

---

## 伤病与状态

- **status**：表示当前是否可出场等，常见值：
  - `Active`：正常
  - `Out`：缺阵
  - `Day-to-Day`：每日观察
  - 其他 ESPN 使用的状态文案
- **injuries**：当 `status` 非 Active 时，这里常有条目，描述伤病类型、状态、详情、日期等（具体字段以 ESPN 返回为准）。

---

## 解析与 API

- **类型**: `ESPNRosterAthlete`（见 `workers/nba-data-worker/src/types.ts`）
- **解析函数**:
  - `parseRosterRawToProfile(rawJson)`（见 `workers/nba-data-worker/src/espn.ts`）  
    从 raw_json 解析出：displayName, position, jersey, headshot, weight, height, college, birthPlace, contract, **status**（字符串）, **statusDetail**（id/name/type/abbreviation）, **injuries**（数组）, experience。供 API 使用。
  - `parseRosterRawToDbColumns(rawJson)`  
    从 raw_json 解析出扁平字段（snake_case），与 `rosters` 表列一一对应，供 sync 写入 D1。
- **rosters 表列**（除 team_id, season, player_id, raw_json, updated_at 外，均由 ESPN 解析写入）:
  - status, injuries_json（0011）
  - display_name, first_name, last_name, full_name, short_name
  - position_abbr, position_name, jersey, headshot_href
  - weight, height, age, date_of_birth, debut_year
  - college_name, birth_place_city, birth_place_state, birth_place_country
  - experience_years, contract_salary, contract_years_remaining, slug（0012）
- **API**: `GET /v1/nba/players/:playerId` 在从 roster 补全 profile 时，会返回 **profile.status**、**profile.statusDetail**、**profile.injuries**（当 raw_json 来自 roster 且解析成功时）。
