-- 查询指定比赛当前在场 10 人：号码 + 名字（主队 5 + 客队 5）
-- 在 D1 控制台或 wrangler d1 execute 时使用。game_id 已设为 401810608。
-- 当前赛季 roster 使用 season = 2025（2025-26）；若属下一赛季可把两处 2025 改为 2026。

WITH
  g AS (
    SELECT game_id, home_team_id, away_team_id
    FROM games_current
    WHERE game_id = '401810608'
  ),
  home_ids AS (
    SELECT value AS player_id
    FROM json_each((SELECT home_on_court_json FROM game_lineup_current WHERE game_id = '401810608'))
  ),
  away_ids AS (
    SELECT value AS player_id
    FROM json_each((SELECT away_on_court_json FROM game_lineup_current WHERE game_id = '401810608'))
  )
SELECT 'home' AS side, r.jersey, r.display_name
FROM g, home_ids h
JOIN rosters r ON r.player_id = h.player_id AND r.team_id = g.home_team_id AND r.season = 2025
UNION ALL
SELECT 'away' AS side, r.jersey, r.display_name
FROM g, away_ids a
JOIN rosters r ON r.player_id = a.player_id AND r.team_id = g.away_team_id AND r.season = 2025
ORDER BY side, r.jersey, r.display_name;
