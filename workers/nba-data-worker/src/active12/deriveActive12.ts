/**
 * NEW: Dynamic Adjust Active 12 — per-game boxscore + recent usage scoring with position constraints.
 * Used after each boxscore sync to update both teams' team_roster_12_current in near-real-time.
 */

import * as db from "../db";
import { normalizePositionToGroup, extractMinutesFromStatsJson } from "../position";
import type { PositionGroup, Roster12Constraints, Active12Quality } from "../types";
import type { BoxscorePlayer } from "../types";

// NEW: Position minimums for dynamic active 12 (2G, 2F, 1C).
const MIN_G = 2;
const MIN_F = 2;
const MIN_C = 1;
const MAX_C = 5;
const ROSTER_12_SIZE = 12;
const CANDIDATE_CAP = 30;
const RECENCY_BONUS_DAYS = 7;

// NEW: Dynamic scoring weights.
const BOOST_IN_BOXSCORE_MINUTES = 5000;
const BOOST_IN_BOXSCORE_DNP = 500;
const PENALTY_ROSTER_NO_USAGE_NO_BOXSCORE = -200;

function recencyBonus(lastSeenAt: number | null): number {
  if (lastSeenAt == null) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const daysAgo = (nowSec - lastSeenAt) / 86400;
  if (daysAgo < 0) return 10;
  if (daysAgo < RECENCY_BONUS_DAYS) return Math.max(0, 10 - daysAgo);
  return 0;
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

/** NEW: Context for dynamic scoring — which players appeared in the current boxscore and their minutes. */
export interface DeriveActive12Context {
  /** Player IDs per team that appear in this game's boxscore. */
  boxscorePlayerIdsByTeam: Map<string, Set<string>>;
  /** Minutes played in this boxscore (for boost: minutes > 0 vs DNP). */
  boxscoreMinutesByPlayer: Map<string, number>;
}

/** NEW: Result of deriveTeamActive12 (no DB write). */
export interface DeriveTeamActive12Result {
  playerIds: string[];
  positions: Record<string, string>;
  method: string;
  constraints: Roster12Constraints;
  quality: Active12Quality;
}

/**
 * NEW: Derive active 12 for one team using recent usage + optional boxscore context.
 * Does not write to DB. Caller can pass context from current game boxscore for dynamic boost.
 */
export async function deriveTeamActive12(
  dbInstance: D1Database,
  teamId: string,
  season: number,
  windowDays: number,
  context: DeriveActive12Context
): Promise<DeriveTeamActive12Result> {
  const constraints: Roster12Constraints = { minG: MIN_G, minF: MIN_F, minC: MIN_C, maxC: MAX_C };

  const rosterOrder = await db.getRosterForTeam(dbInstance, teamId, season);
  const usageRows = await db.getRecentUsageByTeamSeasonWindow(dbInstance, teamId, season, windowDays);

  const boxscoreIds = context.boxscorePlayerIdsByTeam.get(teamId) ?? new Set<string>();

  // NEW: Candidate pool — top 20 by usage + all boxscore players for team + roster fallback, cap CANDIDATE_CAP.
  const usageTop20 = usageRows.slice(0, 20).map((r) => r.player_id);
  const candidateSet = new Set<string>(usageTop20);
  boxscoreIds.forEach((id) => candidateSet.add(id));
  for (const r of rosterOrder) {
    if (candidateSet.size >= CANDIDATE_CAP) break;
    candidateSet.add(r.player_id);
  }
  const candidateIds = Array.from(candidateSet).slice(0, CANDIDATE_CAP);

  const usageMap = new Map<string, db.RecentUsageRow>();
  const usageKey = (pid: string) => `${teamId}:${pid}`;
  for (const row of usageRows) {
    usageMap.set(usageKey(row.player_id), row);
  }

  const playersMap = candidateIds.length > 0 ? await db.getPlayersByIds(dbInstance, candidateIds) : new Map<string, db.PlayerRow>();

  const rosterIndexByPlayer = new Map<string, number>();
  rosterOrder.forEach((r, i) => rosterIndexByPlayer.set(r.player_id, i));

  interface Candidate {
    playerId: string;
    posGroup: PositionGroup;
    score: number;
    minutes_total: number;
    starts: number;
    last_seen_at: number | null;
    rosterIndex: number;
  }

  const candidates: Candidate[] = candidateIds.map((playerId) => {
    const rosterRow = rosterOrder.find((r) => r.player_id === playerId);
    const rosterIndex = rosterIndexByPlayer.get(playerId) ?? 9999;
    const player = playersMap.get(playerId);
    const posStr = player?.position ?? (rosterRow ? getPositionFromRosterRaw(rosterRow.raw_json) : null) ?? null;
    const posGroup = normalizePositionToGroup(posStr);

    const usage = usageMap.get(usageKey(playerId));
    const inBoxscore = boxscoreIds.has(playerId);
    const boxscoreMinutes = context.boxscoreMinutesByPlayer.get(playerId) ?? 0;

    let score: number;
    if (usage) {
      score =
        1000 * usage.games_appeared +
        2 * usage.minutes_total +
        200 * usage.starts +
        recencyBonus(usage.last_seen_at);
    } else {
      score = 1;
    }

    // NEW: Dynamic boost from current boxscore.
    if (inBoxscore) {
      if (boxscoreMinutes > 0) {
        score += BOOST_IN_BOXSCORE_MINUTES;
      } else {
        score += BOOST_IN_BOXSCORE_DNP;
      }
    } else if (rosterRow && !usage) {
      score += PENALTY_ROSTER_NO_USAGE_NO_BOXSCORE;
    }

    return {
      playerId,
      posGroup,
      score: Math.max(0, score),
      minutes_total: usage?.minutes_total ?? 0,
      starts: usage?.starts ?? 0,
      last_seen_at: usage?.last_seen_at ?? null,
      rosterIndex,
    };
  });

  // NEW: Stable sort — score desc, then minutes_total desc, starts desc, last_seen_at desc, rosterIndex, player_id.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.minutes_total !== a.minutes_total) return b.minutes_total - a.minutes_total;
    if (b.starts !== a.starts) return b.starts - a.starts;
    const aAt = a.last_seen_at ?? 0;
    const bAt = b.last_seen_at ?? 0;
    if (bAt !== aAt) return bAt - aAt;
    if (a.rosterIndex !== b.rosterIndex) return a.rosterIndex - b.rosterIndex;
    return a.playerId.localeCompare(b.playerId);
  });

  const selected: Candidate[] = [];
  let countG = 0;
  let countF = 0;
  let countC = 0;
  const used = new Set<string>();

  // NEW: Pick to satisfy min 2 G, 2 F, 1 C (UNK does not count toward mins).
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

  if (selected.length < ROSTER_12_SIZE) {
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
  }

  const missingG = Math.max(0, MIN_G - countG);
  const missingF = Math.max(0, MIN_F - countF);
  const missingC = Math.max(0, MIN_C - countC);
  let filledByUNK = false;
  const reasons: string[] = [];
  if (missingG > 0 || missingF > 0 || missingC > 0) reasons.push("MIN_CONSTRAINT_NOT_MET");

  const finalCounts = { G: 0, F: 0, C: 0, UNK: 0 };
  for (const c of selected) {
    finalCounts[c.posGroup]++;
    if (c.posGroup === "UNK") filledByUNK = true;
  }

  const pickedWithUsage = selected.filter((c) => usageMap.has(usageKey(c.playerId))).length;
  const usage_coverage_ratio = ROSTER_12_SIZE > 0 ? pickedWithUsage / ROSTER_12_SIZE : 0;
  const boxscore_hit_count = selected.filter((c) => boxscoreIds.has(c.playerId)).length;

  const quality: Active12Quality = {
    ok: reasons.length === 0 && selected.length === ROSTER_12_SIZE,
    reasons,
    counts: finalCounts,
    filledByUNK,
    missing:
      missingG > 0 || missingF > 0 || missingC > 0
        ? { G: missingG > 0 ? missingG : undefined, F: missingF > 0 ? missingF : undefined, C: missingC > 0 ? missingC : undefined }
        : undefined,
    candidate_count: candidates.length,
    picked_count: selected.length,
    usage_coverage_ratio,
    boxscore_hit_count,
    updated_reason: "boxscore_dynamic_adjust",
  };

  const playerIds = selected.map((c) => c.playerId);
  const positions: Record<string, string> = {};
  selected.forEach((c) => {
    positions[c.playerId] = c.posGroup;
  });

  return {
    playerIds,
    positions,
    method: "usage14d+boxscore_dynamic+pos_constraints",
    constraints,
    quality,
  };
}

/**
 * NEW: Build context from boxscore players (by team + minutes per player).
 */
export function buildActive12ContextFromBoxscore(boxscorePlayers: BoxscorePlayer[]): DeriveActive12Context {
  const boxscorePlayerIdsByTeam = new Map<string, Set<string>>();
  const boxscoreMinutesByPlayer = new Map<string, number>();
  for (const p of boxscorePlayers) {
    const teamId = p.teamId ?? "";
    if (teamId) {
      let set = boxscorePlayerIdsByTeam.get(teamId);
      if (!set) {
        set = new Set<string>();
        boxscorePlayerIdsByTeam.set(teamId, set);
      }
      set.add(p.playerId);
    }
    const minutes = extractMinutesFromStatsJson(p.statsJson ?? undefined);
    boxscoreMinutesByPlayer.set(p.playerId, minutes);
  }
  return { boxscorePlayerIdsByTeam, boxscoreMinutesByPlayer };
}

/**
 * NEW: After a game boxscore sync, update both teams' team_roster_12_current.
 * Safe to call; best-effort, never throws. Uses batch helpers only.
 */
export async function updateTeamsActive12FromBoxscore(
  dbInstance: D1Database,
  gameId: string,
  homeTeamId: string,
  awayTeamId: string,
  season: number,
  windowDays: number,
  boxscorePlayers: BoxscorePlayer[]
): Promise<void> {
  try {
    const context = buildActive12ContextFromBoxscore(boxscorePlayers);
    // Skip empty team IDs so we never write team_roster_12_current for team_id="" (e.g. when scoreboard has no team data).
    const teamIds = [homeTeamId, awayTeamId].filter((id) => id != null && String(id).trim() !== "");
    for (const teamId of teamIds) {
      try {
        const derived = await deriveTeamActive12(dbInstance, teamId, season, windowDays, context);
        // Skip writing when no players (e.g. rosters table empty); avoids filling DB with empty roster12 rows.
        if (derived.playerIds.length === 0) continue;
        await db.upsertTeamRoster12Current(dbInstance, {
          team_id: teamId,
          season,
          player_ids_json: JSON.stringify(derived.playerIds),
          // CHANGED: write positions as map (Record<string,string>) for consistent format.
          positions_json: JSON.stringify(derived.positions),
          method: derived.method,
          constraints_json: JSON.stringify(derived.constraints),
          quality_json: JSON.stringify(derived.quality),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.insertErrorLog(dbInstance, "active12", teamId, msg.slice(0, 300));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.insertErrorLog(dbInstance, "active12", gameId, msg.slice(0, 300));
  }
}
