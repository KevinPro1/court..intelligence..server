import { describe, it, expect } from "vitest";
import {
    todayYmdEastern,
    tomorrowYmdEastern,
    dateYmdDaysAgoEastern,
    currentSeasonStartYearUtc,
    dateYmdToSeason,
} from "./date";

describe("date utils (America/New_York)", () => {
    it("todayYmdEastern returns YYYYMMDD string", () => {
        const s = todayYmdEastern();
        expect(s).toMatch(/^\d{8}$/);
        expect(s.length).toBe(8);
    });

    it("todayYmdEastern handles late night ET correctly", () => {
        // 2024-01-01 22:00:00 ET is 2024-01-02 03:00:00 UTC
        // We want 20240101
        const d = new Date("2024-01-02T03:00:00Z"); // 10 PM ET
        expect(todayYmdEastern(d)).toBe("20240101");
    });

    it("todayYmdEastern handles early morning ET correctly", () => {
        // 2024-01-02 01:00:00 ET is 2024-01-02 06:00:00 UTC
        // We want 20240102
        const d = new Date("2024-01-02T06:00:00Z"); // 6 AM UTC = 1 AM ET
        expect(todayYmdEastern(d)).toBe("20240102");
    });

    it("tomorrowYmdEastern next day logic", () => {
        const d = new Date("2024-01-31T12:00:00Z"); // Jan 31
        // tomorrow is Feb 1
        expect(tomorrowYmdEastern(d)).toBe("20240201");
    });

    it("dateYmdDaysAgoEastern subtraction logic", () => {
        const d = new Date("2024-01-15T12:00:00Z"); // Jan 15
        const ago = dateYmdDaysAgoEastern(14, d); // Jan 1
        expect(ago).toBe("20240101");
    });
});

describe("season utils", () => {
    it("currentSeasonStartYearUtc returns current year for Oct-Dec", () => {
        const d = new Date("2024-10-01T00:00:00Z");
        expect(currentSeasonStartYearUtc(d)).toBe(2024);
    });

    it("currentSeasonStartYearUtc returns previous year for Jan-Sep", () => {
        const d = new Date("2025-02-01T00:00:00Z");
        expect(currentSeasonStartYearUtc(d)).toBe(2024);
    });

    it("dateYmdToSeason parses YYYYMMDD correctly", () => {
        expect(dateYmdToSeason("20241022")).toBe(2024);
        expect(dateYmdToSeason("20250415")).toBe(2024); // April 2025 is part of 2024-25 season
    });

    it("dateYmdToSeason parses YYYY-MM-DD correctly", () => {
        expect(dateYmdToSeason("2024-10-22")).toBe(2024);
        expect(dateYmdToSeason("2025-02-14")).toBe(2024);
    });
});
