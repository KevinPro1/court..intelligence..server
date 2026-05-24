/**
 * Centralized date and time utilities for NBA Data Worker.
 *
 * NBA Schedule is effectively US Eastern Time (ET).
 * - "Today" in NBA terms is based on ET (games can start at 10 PM ET / 03:00 UTC next day).
 * - Datestamps (YYYYMMDD) should be generated in America/New_York.
 * - Season start is roughly October.
 */

// Timezone for NBA scheduling
const NBA_TIMEZONE = "America/New_York";

/**
 * Get "today" as YYYYMMDD string in America/New_York.
 * @param now Optional Date object (default: Date.now())
 */
export function todayYmdEastern(now: Date = new Date()): string {
    const s = new Intl.DateTimeFormat("en-CA", {
        timeZone: NBA_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(now);
    return s.replace(/-/g, "");
}

/**
 * Get "tomorrow" as YYYYMMDD string in America/New_York.
 * Used for fetching games that might spill over into the next day (or previewing next day).
 */
export function tomorrowYmdEastern(now: Date = new Date()): string {
    const tomorrow = new Date(now.getTime() + 86400 * 1000);
    return todayYmdEastern(tomorrow);
}

/**
 * Get N days ago as YYYYMMDD string in America/New_York.
 */
export function dateYmdDaysAgoEastern(days: number, now: Date = new Date()): string {
    const d = new Date(now.getTime() - days * 86400 * 1000);
    return todayYmdEastern(d);
}

/**
 * Get N days ahead as YYYYMMDD string in America/New_York (e.g. 1 = tomorrow, 2 = day after).
 */
export function dateYmdDaysAheadEastern(days: number, now: Date = new Date()): string {
    const d = new Date(now.getTime() + days * 86400 * 1000);
    return todayYmdEastern(d);
}

/**
 * Determine the current NBA season start year (e.g., 2024-25 season -> 2024).
 * Logic: If current month >= 9 (October) in UTC, it's the current year.
 * Else (Jan-Sep), it's the previous year.
 *
 * Note: NBA preseason starts in October. We use UTC for simplicity as the year switchover
 * happens safely away from the season boundary (July/August/Sept).
 */
export function currentSeasonStartYearUtc(now: Date = new Date()): number {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth(); // 0-11
    // October (9) or later -> start of new season.
    // This covers regular season (Oct-April) and playoffs (April-June).
    // Verification: Oct 2024 -> 2024. Feb 2025 -> 2024.
    return month >= 9 ? year : year - 1;
}

/**
 * Alias for currentSeasonStartYearUtc to match some existing code patterns.
 */
export function getCurrentSeasonYear(now: Date = new Date()): number {
    return currentSeasonStartYearUtc(now);
}

/**
 * Derive season start year from a YYYYMMDD or YYYY-MM-DD string.
 * @param dateYmd "20241025" or "2024-10-25"
 */
export function dateYmdToSeason(dateYmd: string): number {
    const s = String(dateYmd).trim();
    let y: number;
    let m: number;

    if (s.includes("-")) {
        const [yy, mm] = s.split("-").map(Number);
        y = yy;
        m = mm; // 1-12
    } else if (/^\d{8}$/.test(s)) {
        y = parseInt(s.slice(0, 4), 10);
        m = parseInt(s.slice(4, 6), 10); // 01-12
    } else {
        return 0;
    }

    if (!Number.isFinite(y) || !Number.isFinite(m)) return 0;
    // Match currentSeasonStartYearUtc logic: Oct (10) or later is new season
    return m >= 10 ? y : y - 1;
}
