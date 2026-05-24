/**
 * Position normalization for active-12 derivation (G/F/C groups).
 * Use player.position if available; else roster.raw_json position; else boxscore position.
 */

import type { PositionGroup } from "./types";

export type { PositionGroup };

/**
 * Normalize position string to group: G (PG, SG, G), F (SF, PF, F), C (C), else UNK.
 */
export function normalizePositionToGroup(pos: string | null | undefined): PositionGroup {
  if (pos == null || typeof pos !== "string") return "UNK";
  const u = pos.trim().toUpperCase();
  if (u === "PG" || u === "SG" || u === "G") return "G";
  if (u === "SF" || u === "PF" || u === "F") return "F";
  if (u === "C") return "C";
  return "UNK";
}

/**
 * Extract minutes from statsJson.
 * - ESPN summary boxscore: statsJson is an array [MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, +/-]; index 0 = minutes (string or number).
 * - Object shape: keys MIN, min, minutes, mins. "MM:SS" -> float minutes.
 */
export function extractMinutesFromStatsJson(
  statsJson: Record<string, unknown> | unknown[] | null | undefined
): number {
  if (statsJson == null) return 0;
  let raw: string | number | null = null;
  if (Array.isArray(statsJson) && statsJson.length > 0) {
    const first = statsJson[0];
    raw = typeof first === "string" || typeof first === "number" ? first : null;
  } else if (typeof statsJson === "object" && !Array.isArray(statsJson)) {
    const o = statsJson as Record<string, unknown>;
    raw =
      (o.MIN as string | number) ??
      (o.min as string | number) ??
      (o.minutes as string | number) ??
      (o.mins as string | number) ??
      null;
  }
  if (raw == null) return 0;
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
  if (typeof raw === "string") {
    const match = /^(\d+):(\d+)$/.exec(raw.trim());
    if (match) {
      const m = parseInt(match[1], 10);
      const s = parseInt(match[2], 10);
      if (!Number.isNaN(m) && !Number.isNaN(s)) return m + s / 60;
    }
    const n = parseFloat(raw);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}
