/**
 * Active 12 derivation: ActiveScore + position constraints (minG=3, minF=3, minC=1, maxC=3).
 * Stable ordering: score desc, roster order, player_id.
 */

import { normalizePositionToGroup, extractMinutesFromStatsJson } from "../position";
import type { PositionGroup, Roster12Constraints, Roster12Quality } from "../types";
import type { RecentUsageRow, SeasonStatsByPlayer, RosterPlayerRow, PlayerRow } from "../db";

const MIN_G = 3;
const MIN_F = 3;
const MIN_C = 1;
const MAX_C = 3;
const ROSTER_12_SIZE = 12;
const WINDOW_DAYS = 14;
const RECENCY_BONUS_DAYS = 7;

function recencyBonus(lastSeenAt: number | null): number {
  if (lastSeenAt == null) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const daysAgo = (nowSec - lastSeenAt) / 86400;
  if (daysAgo < 0) return 10;
  if (daysAgo < RECENCY_BONUS_DAYS) return Math.max(0, 10 - daysAgo);
  return 0;
}

export interface Roster12Candidate {
  playerId: string;
  posGroup: PositionGroup;
  score: number;
  methodHint: "recent_usage_14d" | "season_stats_fallback" | "roster_fallback";
  rosterIndex: number;
}

export interface DeriveRoster12Input {
  rosterOrder: RosterPlayerRow[];
  playersMap: Map<string, PlayerRow>;
  recentUsageMap: Map<string, RecentUsageRow>;
  seasonStatsMap: Map<string, SeasonStatsByPlayer>;
  teamId: string;
  season: number;
}

export interface DeriveRoster12Result {
  playerIds: string[];
  positions: PositionGroup[];
  method: "recent_usage_14d" | "season_stats_fallback" | "roster_fallback";
  constraints: Roster12Constraints;
  quality: Roster12Quality;
}

function getPositionFromRosterRaw(rawJson: string | null): string | null {
  if (!rawJson || typeof rawJson !== "string") return null;
  try {
    const o = JSON.parse(rawJson) as Record<string, unknown>;
    const pos = (o.position as { abbreviation?: string })?.abbreviation ?? (o.position as string) ?? (o.pos as string);
    return pos != null ? String(pos) : null;
  } catch {
    return null;
  }
}

function getSeasonStatsMinutesAndStarts(stats: SeasonStatsByPlayer): { gamesPlayed: number; minutes: number; starts: number } {
  let gamesPlayed = 0;
  let minutes = 0;
  let starts = 0;
  try {
    const totals = (stats.totals ?? stats.perGame ?? stats.raw) as Record<string, unknown> | undefined;
    if (totals && typeof totals === "object") {
      gamesPlayed = Number((totals.games ?? totals.gamesPlayed ?? totals.gp ?? 0)) || 0;
      minutes = Number((totals.minutes ?? totals.min ?? totals.mins ?? totals.MIN ?? 0)) || 0;
      starts = Number((totals.starts ?? totals.gs ?? 0)) || 0;
    }
  } catch {
    //
  }
  return { gamesPlayed, minutes, starts };
}

export function deriveRoster12(input: DeriveRoster12Input): DeriveRoster12Result {
  const { rosterOrder, playersMap, recentUsageMap, seasonStatsMap, teamId, season } = input;
  const constraints: Roster12Constraints = { minG: MIN_G, minF: MIN_F, minC: MIN_C, maxC: MAX_C };

  const usageKey = (playerId: string) => `${teamId}:${playerId}`;

  const candidates: Roster12Candidate[] = rosterOrder.map((r, rosterIndex) => {
    const playerId = r.player_id;
    const player = playersMap.get(playerId);
    const posStr = player?.position ?? getPositionFromRosterRaw(r.raw_json) ?? null;
    const posGroup = normalizePositionToGroup(posStr);

    const usage = recentUsageMap.get(usageKey(playerId));
    const seasonStats = seasonStatsMap.get(playerId);

    let score: number;
    let methodHint: Roster12Candidate["methodHint"];

    if (usage) {
      score =
        1000 * usage.games_appeared +
        2 * usage.minutes_total +
        200 * usage.starts +
        recencyBonus(usage.last_seen_at);
      methodHint = "recent_usage_14d";
    } else if (seasonStats) {
      const { gamesPlayed, minutes, starts } = getSeasonStatsMinutesAndStarts(seasonStats);
      score = 100 * gamesPlayed + 0.5 * minutes + 50 * starts;
      methodHint = "season_stats_fallback";
    } else {
      score = 1;
      methodHint = "roster_fallback";
    }

    return { playerId, posGroup, score, methodHint, rosterIndex };
  });

  // Stable sort: score desc, then roster index, then player_id
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.rosterIndex !== b.rosterIndex) return a.rosterIndex - b.rosterIndex;
    return a.playerId.localeCompare(b.playerId);
  });

  const selected: Roster12Candidate[] = [];
  let countG = 0;
  let countF = 0;
  let countC = 0;
  const used = new Set<string>();

  // S1: Pick best to satisfy minG, minF, minC
  for (const c of candidates) {
    if (used.has(c.playerId)) continue;
    if (countG < MIN_G && c.posGroup === "G") {
      selected.push(c);
      used.add(c.playerId);
      countG++;
    } else if (countF < MIN_F && c.posGroup === "F") {
      selected.push(c);
      used.add(c.playerId);
      countF++;
    } else if (countC < MIN_C && c.posGroup === "C") {
      selected.push(c);
      used.add(c.playerId);
      countC++;
    }
  }

  // S2: Fill remaining to 12, prefer non-C if C already at maxC
  for (const c of candidates) {
    if (selected.length >= ROSTER_12_SIZE) break;
    if (used.has(c.playerId)) continue;
    if (countC >= MAX_C && c.posGroup === "C") continue;
    selected.push(c);
    used.add(c.playerId);
    if (c.posGroup === "G") countG++;
    else if (c.posGroup === "F") countF++;
    else if (c.posGroup === "C") countC++;
  }

  // S3: If still < 12, fill by roster order regardless of score
  if (selected.length < ROSTER_12_SIZE) {
    for (const r of rosterOrder) {
      if (selected.length >= ROSTER_12_SIZE) break;
      if (used.has(r.player_id)) continue;
      const c = candidates.find((x) => x.playerId === r.player_id);
      if (c && countC >= MAX_C && c.posGroup === "C") continue;
      if (c) {
        selected.push(c);
        used.add(c.playerId);
        if (c.posGroup === "G") countG++;
        else if (c.posGroup === "F") countF++;
        else if (c.posGroup === "C") countC++;
      }
    }
  }

  // S4: Allow UNK to fill missing mins if still short
  const missingG = Math.max(0, MIN_G - countG);
  const missingF = Math.max(0, MIN_F - countF);
  const missingC = Math.max(0, MIN_C - countC);
  let filledByUNK = false;
  const reasons: string[] = [];

  if (selected.length < ROSTER_12_SIZE) {
    for (const c of candidates) {
      if (selected.length >= ROSTER_12_SIZE) break;
      if (used.has(c.playerId)) continue;
      if (c.posGroup === "UNK") {
        selected.push(c);
        used.add(c.playerId);
        filledByUNK = true;
      }
    }
  }

  if (filledByUNK && (missingG > 0 || missingF > 0 || missingC > 0)) {
    reasons.push("POSITION_UNKNOWN_FILL");
  }
  if (countG < MIN_G || countF < MIN_F || countC < MIN_C) {
    reasons.push("MIN_CONSTRAINT_NOT_MET");
  }

  const finalCounts = { G: 0, F: 0, C: 0, UNK: 0 };
  for (const c of selected) {
    finalCounts[c.posGroup]++;
  }

  const method =
    selected.length > 0 && selected.every((c) => c.methodHint === "recent_usage_14d")
      ? "recent_usage_14d"
      : selected.length > 0 && selected.some((c) => c.methodHint === "recent_usage_14d")
        ? "recent_usage_14d"
        : selected.length > 0 && selected.some((c) => c.methodHint === "season_stats_fallback")
          ? "season_stats_fallback"
          : "roster_fallback";

  const quality: Roster12Quality = {
    ok: reasons.length === 0 && selected.length === ROSTER_12_SIZE,
    reasons,
    counts: finalCounts,
    filledByUNK,
    missing:
      missingG > 0 || missingF > 0 || missingC > 0
        ? { G: missingG > 0 ? missingG : undefined, F: missingF > 0 ? missingF : undefined, C: missingC > 0 ? missingC : undefined }
        : undefined,
  };

  return {
    playerIds: selected.map((c) => c.playerId),
    positions: selected.map((c) => c.posGroup),
    method,
    constraints,
    quality,
  };
}
