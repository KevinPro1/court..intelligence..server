/**
 * Map ESPN API responses to our stable internal schema.
 * Deterministic, schema-stable for ML/features.
 */

import type {
  ESPNScoreboardResponse,
  ESPNEvent,
  ESPNCompetitor,
  ESPNTeamRef,
  ESPNStatus,
  NormalizedTeam,
  NormalizedGame,
  NormalizedScoreboard,
  NormalizedPlayerProfile,
  NormalizedPlayerStats,
} from "../types";

// --- Teams ---

export function normalizeTeam(ref: ESPNTeamRef, teamId?: string): NormalizedTeam {
  const id = teamId ?? ref.id ?? ref.uid ?? "";
  return {
    id,
    displayName: ref.displayName ?? ref.name ?? "",
    abbreviation: ref.abbreviation ?? "",
    espnTeamId: ref.id ?? ref.uid,
  };
}

// --- Games / Scoreboard ---

function getCompetitorScore(c: { score?: string }): number {
  const s = c.score;
  if (s === undefined || s === null) return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function getStatusDisplay(status: ESPNStatus | undefined): string {
  if (!status?.type) return "scheduled";
  const state = status.type.state ?? "";
  const detail = status.type.detail ?? "";
  if (detail) return detail;
  return state || "scheduled";
}

export function normalizeGame(event: ESPNEvent): NormalizedGame {
  const home = event.competitors?.find((c) => c.homeAway === "home");
  const away = event.competitors?.find((c) => c.homeAway === "away");
  const homeRef = home?.team;
  const awayRef = away?.team;
  const homeTeamId = homeRef?.id ?? home?.id ?? "unknown";
  const awayTeamId = awayRef?.id ?? away?.id ?? "unknown";
  const status = event.status;
  const period = status?.period ?? 0;
  const displayClock = status?.displayClock ?? "";
  const completed = status?.type?.completed ?? false;

  return {
    id: event.id,
    dateYmd: event.date ? event.date.slice(0, 10).replace(/-/g, "") : "",
    homeTeamId,
    awayTeamId,
    homeTeamAbbr: homeRef?.abbreviation,
    awayTeamAbbr: awayRef?.abbreviation,
    homeScore: getCompetitorScore((home as { score?: string }) ?? {}),
    awayScore: getCompetitorScore((away as { score?: string }) ?? {}),
    period,
    displayClock,
    status: getStatusDisplay(status),
    completed,
  };
}

export function normalizeScoreboard(data: ESPNScoreboardResponse, dateYmd: string): NormalizedScoreboard {
  const events = data.events ?? [];
  const games = events.map(normalizeGame).map((g) => ({
    ...g,
    dateYmd: g.dateYmd || dateYmd,
  }));
  return {
    date: dateYmd,
    games,
  };
}

// --- Teams list (from ESPN teams response) ---

interface ESPNTeamItem {
  id?: string;
  uid?: string;
  displayName?: string;
  name?: string;
  abbreviation?: string;
}

/**
 * Normalize ESPN teams array. Handle both { teams: [...] } and direct array.
 */
export function normalizeTeamsList(payload: unknown): NormalizedTeam[] {
  const teams: ESPNTeamItem[] = [];
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.sports)) {
      for (const sport of p.sports as Array<{ leagues?: Array<{ teams?: ESPNTeamItem[] }> }>) {
        for (const league of sport.leagues ?? []) {
          teams.push(...(league.teams ?? []));
        }
      }
    } else if (Array.isArray((p as { teams?: ESPNTeamItem[] }).teams)) {
      teams.push(...(p as { teams: ESPNTeamItem[] }).teams);
    }
  }
  return teams.map((t) => normalizeTeam(t as ESPNTeamRef, t.id ?? t.uid));
}

// --- Player profile (from ESPN athlete or roster item) ---

/**
 * Normalize player profile from ESPN athlete/roster payload.
 * TODO: Align with actual ESPN athlete response shape when confirmed.
 */
export function normalizePlayerProfile(payload: unknown, playerId: string): NormalizedPlayerProfile {
  const p = payload as Record<string, unknown> | null;
  if (!p) {
    return { playerId, fullName: "" };
  }
  const displayName = (p.displayName ?? p.fullName ?? p.name ?? "") as string;
  const teamRef = p.team as { id?: string } | undefined;
  return {
    playerId,
    fullName: displayName,
    teamId: teamRef?.id,
    position: (p.position as { abbreviation?: string } | undefined)?.abbreviation ?? (p.position as string),
    jersey: (p.jersey as string) ?? (p.jerseyNumber as string),
    headshot: ((p.headshot as { href?: string } | undefined)?.href ?? p.photo ?? p.image) as string | undefined,
  };
}

/**
 * Normalize player stats from ESPN stats payload.
 * TODO: Map ESPN stat keys to our schema when endpoint is confirmed.
 */
export function normalizePlayerStats(
  payload: unknown,
  playerId: string,
  season: number,
  statType: string = "regular"
): NormalizedPlayerStats {
  const json = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return {
    playerId,
    season,
    statType,
    json,
  };
}
