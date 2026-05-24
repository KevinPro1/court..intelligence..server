/**
 * Scheduled sync jobs (Wrangler cron triggers).
 * - Every 15 min: sync today's scoreboard and persist games + team mapping.
 * - Daily (e.g. 6am ET): sync all teams list + rosters for teams playing today.
 * Optional: backfill player stats on-demand (read-through in routes).
 */

import { fetchScoreboard, fetchTeams, fetchRoster } from "../services/espn";
import { normalizeScoreboard, normalizeTeamsList } from "../services/normalize";
import type { ESPNScoreboardResponse, ESPNEvent } from "../types";
import * as db from "../db/queries";
import { CACHE_KEYS, TTL, kvSet } from "../cache/cache";
import type { Env } from "../types";

function todayYmd(): string {
  const d = new Date();
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("");
}

/**
 * Sync today's scoreboard: fetch from ESPN, upsert games and teams into D1, update KV cache.
 */
async function syncScoreboard(env: Env): Promise<void> {
  const dateYmd = todayYmd();
  try {
    const data = await fetchScoreboard(dateYmd);
    const normalized = normalizeScoreboard(data as ESPNScoreboardResponse, dateYmd);

    for (const game of normalized.games) {
      await db.upsertTeam(env.DB, {
        team_id: game.homeTeamId,
        name: game.homeTeamAbbr ?? game.homeTeamId,
        abbr: game.homeTeamAbbr ?? game.homeTeamId,
        espn_team_id: game.homeTeamId,
      });
      await db.upsertTeam(env.DB, {
        team_id: game.awayTeamId,
        name: game.awayTeamAbbr ?? game.awayTeamId,
        abbr: game.awayTeamAbbr ?? game.awayTeamId,
        espn_team_id: game.awayTeamId,
      });
      const rawEvent = (data.events ?? []).find((e: ESPNEvent) => e.id === game.id);
      await db.upsertGame(env.DB, {
        game_id: game.id,
        date_ymd: dateYmd,
        home_team_id: game.homeTeamId,
        away_team_id: game.awayTeamId,
        status: game.status,
        period: game.period,
        clock: game.displayClock,
        home_score: game.homeScore,
        away_score: game.awayScore,
        raw_json: rawEvent ? JSON.stringify(rawEvent) : "",
      });
    }

    await kvSet(env.KV, CACHE_KEYS.scoreboard(dateYmd), normalized, TTL.scoreboard);
    await kvSet(env.KV, CACHE_KEYS.gamesToday(), normalized, TTL.gamesToday);
  } catch (err) {
    console.error("syncScoreboard failed", err);
  }
}

/**
 * Sync all teams from ESPN and optionally rosters for teams playing today.
 */
async function syncTeamsAndRosters(env: Env): Promise<void> {
  try {
    const data = await fetchTeams();
    const teams = normalizeTeamsList(data);
    for (const t of teams) {
      await db.upsertTeam(env.DB, {
        team_id: t.id,
        name: t.displayName,
        abbr: t.abbreviation,
        espn_team_id: t.espnTeamId ?? t.id,
      });
    }
    if (teams.length > 0) {
      await kvSet(env.KV, CACHE_KEYS.teams(), teams, TTL.teams);
    }
  } catch (err) {
    console.error("syncTeams failed", err);
  }

  const dateYmd = todayYmd();
  const gameRows = await db.getGamesByDate(env.DB, dateYmd);
  const teamIds = new Set<string>();
  for (const g of gameRows) {
    teamIds.add(g.home_team_id);
    teamIds.add(g.away_team_id);
  }

  for (const teamId of teamIds) {
    try {
      const currentSeason = new Date().getUTCMonth() >= 9
        ? new Date().getUTCFullYear() + 1
        : new Date().getUTCFullYear();
      const rosterData = await fetchRosterSafe(teamId, currentSeason);
      if (rosterData?.athletes) {
        for (const a of rosterData.athletes as Array<{ id: string; [k: string]: unknown }>) {
          await db.upsertPlayer(env.DB, {
            player_id: a.id,
            full_name: (a.displayName ?? a.fullName ?? a.name ?? "") as string,
            team_id: teamId,
            position: (a.position as { abbreviation?: string })?.abbreviation ?? null,
            jersey: (a.jersey ?? a.jerseyNumber) as string ?? null,
            headshot: ((a.headshot as { href?: string } | undefined)?.href ?? a.photo) as string ?? null,
          });
          await db.upsertRosterRow(env.DB, {
            team_id: teamId,
            season: currentSeason,
            player_id: a.id,
            raw_json: JSON.stringify(a),
          });
        }
        await kvSet(env.KV, CACHE_KEYS.roster(teamId, currentSeason), {
          teamId,
          season: currentSeason,
          players: rosterData.athletes,
        }, TTL.roster);
      }
    } catch (err) {
      console.error("syncRoster for", teamId, err);
    }
  }
}

async function fetchRosterSafe(
  espnTeamId: string,
  season: number
): Promise<{ athletes?: unknown[] } | null> {
  try {
    const data = await fetchRoster(espnTeamId, season);
    const d = data as { athletes?: unknown[]; team?: { roster?: unknown[] } };
    if (d?.athletes) return d;
    if (d?.team?.roster) return { athletes: (d as { team: { roster: unknown[] } }).team.roster };
    return data as { athletes?: unknown[] } | null;
  } catch {
    return null;
  }
}

/**
 * Cron handler: every 15 min runs scoreboard sync; daily cron runs teams + rosters.
 * Wrangler crons: every-15-min and 0 11 * * * (11:00 UTC ≈ 6am ET).
 */
export async function handleCronSync(env: Env, event: ScheduledEvent): Promise<void> {
  const cron = event.cron ?? "";
  const isEvery15Min = cron.includes("*") && cron.includes("15");
  if (isEvery15Min) {
    await syncScoreboard(env);
  } else {
    await syncTeamsAndRosters(env);
  }
}
