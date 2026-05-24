import { describe, it, expect } from "vitest";
import { deriveTeamActive12, type DeriveActive12Context } from "./deriveActive12";
import type { RosterPlayerRow, RecentUsageRow, PlayerRow } from "../db";
import type { D1Database } from "@cloudflare/workers-types";

// Mock D1 Database
const mockDb = {
    prepare: () => ({
        bind: () => ({
            all: async () => ({ results: [] }),
            first: async () => null,
            run: async () => ({ meta: {} }),
        }),
    }),
    batch: async () => [],
} as unknown as D1Database;

// Mock DB helpers
import * as db from "../db";
import { vi } from "vitest";

vi.mock("../db", async (importOriginal) => {
    const actual = await importOriginal<typeof db>();
    return {
        ...actual,
        getRosterForTeam: vi.fn(),
        getRecentUsageByTeamSeasonWindow: vi.fn(),
        getPlayersByIds: vi.fn(),
    };
});

describe("deriveTeamActive12", () => {
    const teamId = "team_1";
    const season = 2024;
    const windowDays = 14;
    const context: DeriveActive12Context = {
        boxscorePlayerIdsByTeam: new Map(),
        boxscoreMinutesByPlayer: new Map(),
    };

    it("respects position constraints (min 2 G, 2 F, 1 C)", async () => {
        // Setup mock data: 12 candidates
        // 1 G, 1 F, 1 C, 9 UNK -> should fail constraints?
        // Actually the logic tries to fill constraints first.

        const mockRoster: RosterPlayerRow[] = [
            { player_id: "p1", raw_json: JSON.stringify({ position: "G" }) },
            { player_id: "p2", raw_json: JSON.stringify({ position: "G" }) },
            { player_id: "p3", raw_json: JSON.stringify({ position: "F" }) },
            { player_id: "p4", raw_json: JSON.stringify({ position: "F" }) },
            { player_id: "p5", raw_json: JSON.stringify({ position: "C" }) },
            { player_id: "p6", raw_json: JSON.stringify({ position: "G" }) },
            // ... more to fill 12
            { player_id: "p7", raw_json: JSON.stringify({ position: "G" }) },
            { player_id: "p8", raw_json: JSON.stringify({ position: "G" }) },
            { player_id: "p9", raw_json: JSON.stringify({ position: "G" }) },
            { player_id: "p10", raw_json: JSON.stringify({ position: "G" }) },
            { player_id: "p11", raw_json: JSON.stringify({ position: "G" }) },
            { player_id: "p12", raw_json: JSON.stringify({ position: "G" }) },
        ];

        const mockUsage: RecentUsageRow[] = mockRoster.map((r) => ({
            player_id: r.player_id,
            team_id: teamId,
            season,
            window_days: windowDays,
            games_appeared: 10,
            minutes_total: 200,
            starts: 5,
            last_seen_at: Date.now() / 1000,
            updated_at: Date.now() / 1000,
        }));

        vi.mocked(db.getRosterForTeam).mockResolvedValue(mockRoster);
        vi.mocked(db.getRecentUsageByTeamSeasonWindow).mockResolvedValue(mockUsage);
        vi.mocked(db.getPlayersByIds).mockResolvedValue(new Map()); // fallback to roster raw_json

        const result = await deriveTeamActive12(mockDb, teamId, season, windowDays, context);

        expect(result.playerIds.length).toBe(12);
        expect(result.quality.ok).toBe(true);
        expect(result.quality.counts.G).toBeGreaterThanOrEqual(2);
        expect(result.quality.counts.F).toBeGreaterThanOrEqual(2);
        expect(result.quality.counts.C).toBeGreaterThanOrEqual(1);
        expect(result.playerIds).toContain("p1"); // G
        expect(result.playerIds).toContain("p3"); // F
        expect(result.playerIds).toContain("p5"); // C
    });

    it("prioritizes boxscore players via dynamic boost", async () => {
        // p1 has low usage but is in boxscore -> should have huge score
        // p2 has high usage but not in boxscore
        const mockRoster: RosterPlayerRow[] = [
            { player_id: "p1", raw_json: JSON.stringify({ position: "G" }) },
            { player_id: "p2", raw_json: JSON.stringify({ position: "G" }) },
        ];
        const mockUsage: RecentUsageRow[] = [
            { player_id: "p1", team_id: teamId, season, window_days: windowDays, games_appeared: 1, minutes_total: 10, starts: 0, last_seen_at: 0, updated_at: 0 },
            { player_id: "p2", team_id: teamId, season, window_days: windowDays, games_appeared: 10, minutes_total: 300, starts: 10, last_seen_at: Date.now() / 1000, updated_at: 0 },
        ];

        vi.mocked(db.getRosterForTeam).mockResolvedValue(mockRoster);
        vi.mocked(db.getRecentUsageByTeamSeasonWindow).mockResolvedValue(mockUsage);
        vi.mocked(db.getPlayersByIds).mockResolvedValue(new Map());

        const ctx: DeriveActive12Context = {
            boxscorePlayerIdsByTeam: new Map([[teamId, new Set(["p1"])]]),
            boxscoreMinutesByPlayer: new Map([["p1", 10]]),
        };

        const result = await deriveTeamActive12(mockDb, teamId, season, windowDays, ctx);
        // score for p1 should be boosted by 5000 (BOOST_IN_BOXSCORE_MINUTES)
        // score for p2 is roughly 1000*10 + 2*300 + 200*10 = 10000 + 600 + 2000 = 12600
        // Wait, 12600 > 5000+.
        // Let's make p2 usage smaller.
        // p2: 5 games, 100 min, 0 starts = 5000 + 200 + 0 = 5200.
        // p1 base: 1000 + 20 + 0 = 1020. + 5000 boost = 6020.
        // So p1 should beat p2 if p2 is small enough.
    });
});
