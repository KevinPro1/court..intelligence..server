import { describe, it, expect } from "vitest";
import { deriveRoster12, type DeriveRoster12Input } from "./derive";
import type { RosterPlayerRow, RecentUsageRow, PlayerRow, SeasonStatsByPlayer } from "../db";

describe("deriveRoster12", () => {
    const teamId = "team_1";
    const season = 2024;

    const mockRoster = (ids: string[], positions: Record<string, string>): RosterPlayerRow[] => {
        return ids.map((id) => ({
            player_id: id,
            team_id: teamId,
            season,
            raw_json: JSON.stringify({ position: positions[id] || "G" }),
        }));
    };

    const mockPlayers = (ids: string[], positions: Record<string, string>): Map<string, PlayerRow> => {
        const m = new Map();
        ids.forEach((id) => {
            m.set(id, {
                player_id: id,
                full_name: `Player ${id}`,
                team_id: teamId,
                position: positions[id] || "G",
                jersey: "0",
                headshot: "",
                updated_at: 0,
            });
        });
        return m;
    };

    const mockUsage = (ids: string[], scores: Record<string, number>): Map<string, RecentUsageRow> => {
        const m = new Map();
        ids.forEach((id) => {
            // rough score reverse engineering: score = 1000*games + 2*min.
            // let's just set games=score/1000.
            const s = scores[id] || 0;
            m.set(`${teamId}:${id}`, {
                player_id: id,
                team_id: teamId,
                season,
                window_days: 14,
                games_appeared: s / 1000,
                minutes_total: 0,
                starts: 0,
                last_seen_at: Date.now() / 1000,
                updated_at: 0,
            });
        });
        return m;
    };

    it("selects top 12 by score", () => {
        // 15 players, all G to ignore position constraints for now (except min G is met)
        const ids = Array.from({ length: 15 }, (_, i) => `p${i + 1}`);
        const positions: Record<string, string> = {};
        const scores: Record<string, number> = {};
        ids.forEach((id, i) => {
            positions[id] = "G";
            scores[id] = 100 + i; // p15 has highest score
        });

        const input: DeriveRoster12Input = {
            rosterOrder: mockRoster(ids, positions),
            playersMap: mockPlayers(ids, positions),
            recentUsageMap: mockUsage(ids, scores),
            seasonStatsMap: new Map(),
            teamId,
            season,
        };

        const result = deriveRoster12(input);
        expect(result.playerIds.length).toBe(12);
        // Should verify it picked the highest scores. p15 down to p4.
        expect(result.playerIds).toContain("p15");
        expect(result.playerIds).toContain("p4");
        expect(result.playerIds).not.toContain("p1"); // lowest score
    });

    it("enforces constraints: must have 1 C", () => {
        // 11 Gs with high score, 1 C with low score, 3 Gs with medium score.
        // Logic should pick the C even if low score.
        const ids = ["c1", ...Array.from({ length: 14 }, (_, i) => `g${i + 1}`)];
        const positions: Record<string, string> = { c1: "C" };
        const scores: Record<string, number> = { c1: 10 }; // very low

        ids.forEach((id) => {
            if (id !== "c1") {
                positions[id] = "G";
                scores[id] = 10000; // very high
            }
        });

        const input: DeriveRoster12Input = {
            rosterOrder: mockRoster(ids, positions),
            playersMap: mockPlayers(ids, positions),
            recentUsageMap: mockUsage(ids, scores),
            seasonStatsMap: new Map(),
            teamId,
            season,
        };

        const result = deriveRoster12(input);
        expect(result.playerIds).toContain("c1");
        expect(result.quality.counts.C).toBeGreaterThanOrEqual(1);
    });
});
