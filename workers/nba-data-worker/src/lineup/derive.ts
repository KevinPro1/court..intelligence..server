// NEW FILE: Lineup derivation from boxscore starters + play-by-play substitutions.
// CHANGED: Deterministic ordered arrays + membership sets; remove from both set+array; trim from front (oldest), never remove just-added; cursor reset when maxSeq < cursorSeq.

import type { SubstitutionEvent, BoxscorePlayer } from "../types";

export interface DeriveLineupInput {
  prevLineup?: { homeOnCourtIds: string[]; awayOnCourtIds: string[] };
  startersFromBoxscore: { homeTeamId: string; awayTeamId: string; homeStarters: string[]; awayStarters: string[] };
  substitutions: SubstitutionEvent[];
  cursorSeq: number;
}

export interface DeriveLineupResult {
  homeOnCourtIds: string[];
  awayOnCourtIds: string[];
  confidence: number;
  derivedFrom: string;
  newCursorSeq: number;
}

const MAX_ON_COURT = 5;

/**
 * CHANGED: Use homeArr/homeSet and awayArr/awaySet (ordered list + membership set).
 * When playerOutId: remove from both set and array for that team.
 * When playerInId: append to array if not in set; add to set; enforce MAX_ON_COURT by trimming from FRONT (oldest) but NEVER remove the just-added player.
 * Cursor: if maxSeq in substitutions < cursorSeq, treat as reset — rebuild from starters and set cursorSeq=0.
 * derivedFrom remains "playbyplay" if substitutions.length > 0 else "boxscore".
 */
export function deriveLineup(input: DeriveLineupInput): DeriveLineupResult {
  const { startersFromBoxscore, substitutions, cursorSeq } = input;
  const { homeTeamId, awayTeamId, homeStarters, awayStarters } = startersFromBoxscore;

  // CHANGED: ordered arrays + membership sets (no random pop; deterministic trim from front).
  let homeArr: string[] = input.prevLineup?.homeOnCourtIds?.slice(0, MAX_ON_COURT) ?? homeStarters.slice(0, MAX_ON_COURT);
  let awayArr: string[] = input.prevLineup?.awayOnCourtIds?.slice(0, MAX_ON_COURT) ?? awayStarters.slice(0, MAX_ON_COURT);
  if (homeArr.length === 0 && homeStarters.length > 0) homeArr = homeStarters.slice(0, MAX_ON_COURT);
  if (awayArr.length === 0 && awayStarters.length > 0) awayArr = awayStarters.slice(0, MAX_ON_COURT);

  const homeSet = new Set<string>(homeArr);
  const awaySet = new Set<string>(awayArr);

  // CHANGED: cursor reset — if max seq in substitutions < cursorSeq, rebuild from starters and process from seq 0.
  const maxSeqInSubs = substitutions.length > 0 ? Math.max(...substitutions.map((s) => s.seq)) : 0;
  let newCursorSeq = cursorSeq;
  let subsAfterCursor: SubstitutionEvent[];

  if (maxSeqInSubs < cursorSeq) {
    homeArr = homeStarters.slice(0, MAX_ON_COURT);
    awayArr = awayStarters.slice(0, MAX_ON_COURT);
    homeSet.clear();
    awaySet.clear();
    homeArr.forEach((id) => homeSet.add(id));
    awayArr.forEach((id) => awaySet.add(id));
    newCursorSeq = 0;
    subsAfterCursor = [...substitutions].sort((a, b) => a.seq - b.seq);
  } else {
    subsAfterCursor = substitutions.filter((s) => s.seq > cursorSeq).sort((a, b) => a.seq - b.seq);
  }

  let ambiguousSkipped = false;

  for (const sub of subsAfterCursor) {
    newCursorSeq = Math.max(newCursorSeq, sub.seq);
    const teamId = sub.teamId;
    const isHome = teamId === homeTeamId;
    const isAway = teamId === awayTeamId;
    let removedFromHome = false;
    let removedFromAway = false;

    // CHANGED: When playerOutId — remove from both set and array for that team.
    if (sub.playerOutId) {
      const inHome = homeSet.has(sub.playerOutId);
      const inAway = awaySet.has(sub.playerOutId);
      if (isHome && inHome) {
        homeSet.delete(sub.playerOutId);
        homeArr = homeArr.filter((id) => id !== sub.playerOutId);
      } else if (isAway && inAway) {
        awaySet.delete(sub.playerOutId);
        awayArr = awayArr.filter((id) => id !== sub.playerOutId);
      } else if (!isHome && !isAway) {
        if (inHome) {
          homeSet.delete(sub.playerOutId);
          homeArr = homeArr.filter((id) => id !== sub.playerOutId);
          removedFromHome = true;
        } else if (inAway) {
          awaySet.delete(sub.playerOutId);
          awayArr = awayArr.filter((id) => id !== sub.playerOutId);
          removedFromAway = true;
        }
      }
    }

    // CHANGED: When playerInId — append to array if not in set; ensure membership; enforce MAX_ON_COURT by trimming from FRONT (oldest), never remove just-added.
    if (sub.playerInId) {
      const alreadyHome = homeSet.has(sub.playerInId);
      const alreadyAway = awaySet.has(sub.playerInId);
      if (alreadyHome || alreadyAway) continue;

      if (isHome) {
        homeArr.push(sub.playerInId);
        homeSet.add(sub.playerInId);
        trimFromFront(homeArr, homeSet, MAX_ON_COURT, sub.playerInId);
      } else if (isAway) {
        awayArr.push(sub.playerInId);
        awaySet.add(sub.playerInId);
        trimFromFront(awayArr, awaySet, MAX_ON_COURT, sub.playerInId);
      } else {
        if (removedFromHome || (homeArr.length < MAX_ON_COURT && !removedFromAway)) {
          homeArr.push(sub.playerInId);
          homeSet.add(sub.playerInId);
          trimFromFront(homeArr, homeSet, MAX_ON_COURT, sub.playerInId);
        } else if (removedFromAway || awayArr.length < MAX_ON_COURT) {
          awayArr.push(sub.playerInId);
          awaySet.add(sub.playerInId);
          trimFromFront(awayArr, awaySet, MAX_ON_COURT, sub.playerInId);
        } else {
          ambiguousSkipped = true;
        }
      }
    }
  }

  // Fallback: if one side has < 5 but starters have 5, fill from first missing starter (avoids 4-on-court when a sub had null in/out).
  fillUpToFiveFromStarters(homeArr, homeSet, homeStarters, MAX_ON_COURT);
  fillUpToFiveFromStarters(awayArr, awaySet, awayStarters, MAX_ON_COURT);

  const homeOnCourtIds = homeArr.slice(0, MAX_ON_COURT);
  const awayOnCourtIds = awayArr.slice(0, MAX_ON_COURT);

  let confidence = 0.5;
  if (homeOnCourtIds.length === MAX_ON_COURT && awayOnCourtIds.length === MAX_ON_COURT) confidence = 0.9;
  else if (homeOnCourtIds.length === MAX_ON_COURT || awayOnCourtIds.length === MAX_ON_COURT) confidence = 0.7;
  if (ambiguousSkipped && confidence > 0.6) confidence = 0.6;

  const derivedFrom = substitutions.length > 0 ? "playbyplay" : "boxscore";

  return {
    homeOnCourtIds,
    awayOnCourtIds,
    confidence,
    derivedFrom,
    newCursorSeq,
  };
}

/**
 * CHANGED: Trim from front (oldest) until length <= maxLen; NEVER remove the justAddedId.
 */
function trimFromFront(arr: string[], set: Set<string>, maxLen: number, justAddedId: string): void {
  while (arr.length > maxLen) {
    const idx = arr.findIndex((id) => id !== justAddedId);
    if (idx === -1) break;
    const removed = arr[idx];
    set.delete(removed);
    arr.splice(idx, 1);
  }
}

/** If arr has < maxLen and starters has more, add first missing starter until arr has maxLen (avoids 4-on-court when a sub had null in/out). */
function fillUpToFiveFromStarters(arr: string[], set: Set<string>, starters: string[], maxLen: number): void {
  for (const id of starters) {
    if (arr.length >= maxLen) break;
    if (set.has(id)) continue;
    arr.push(id);
    set.add(id);
  }
}

/** Normalize team id for comparison (DB/ESPN may be string or number). */
function normTeamId(v: string | number | undefined | null): string {
  if (v == null) return "";
  return String(v);
}

/**
 * Build starters from boxscore players (isStarter === true), split by teamId.
 */
export function getStartersFromBoxscore(
  boxscorePlayers: BoxscorePlayer[],
  homeTeamId: string,
  awayTeamId: string
): { homeTeamId: string; awayTeamId: string; homeStarters: string[]; awayStarters: string[] } {
  const homeStarters: string[] = [];
  const awayStarters: string[] = [];
  const home = normTeamId(homeTeamId);
  const away = normTeamId(awayTeamId);
  for (const p of boxscorePlayers) {
    if (!p.isStarter) continue;
    const tid = normTeamId(p.teamId);
    if (tid === home) homeStarters.push(p.playerId);
    else if (tid === away) awayStarters.push(p.playerId);
  }
  return { homeTeamId: home, awayTeamId: away, homeStarters, awayStarters };
}
