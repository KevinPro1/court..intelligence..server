/**
 * Validate ESPN API responses match our types and parser expectations.
 * Run: npx vitest run src/espn.validate.test.ts
 * Requires network for live ESPN fetch.
 */

import { describe, it, expect } from "vitest";
import {
  fetchScoreboard,
  normalizeEvent,
  parseBoxscorePlayers,
  parseTeamRoster,
  parseRosterRawToProfile,
  parseRosterRawToDbColumns,
  parseAthleteSeasonStats,
  fetchAllNbaTeams,
  parseAllNbaTeams,
  getAthleteStatsUrl,
  fetchAthleteStats,
  parsePlayByPlaySubstitutions,
} from "./espn";
import type { BoxscorePlayer, NormalizedRosterProfile } from "./types";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

describe("ESPN response vs types", () => {
  it("scoreboard: response has events (or day.events / scoreboard.events), normalizeEvent yields game with home/away teams", async () => {
    const data = await fetchScoreboard(ESPN_BASE, "20250205");
    const events = (data as { events?: unknown[] }).events ?? (data as { day?: { events?: unknown[] } }).day?.events ?? (data as { scoreboard?: { events?: unknown[] } }).scoreboard?.events ?? [];
    expect(Array.isArray(events)).toBe(true);
    if (events.length > 0) {
      const first = events[0] as Record<string, unknown>;
      const game = normalizeEvent(first, "20250205");
      expect(game).not.toBeNull();
      const g = game!;
      expect(typeof g.gameId).toBe("string");
      expect(g.homeTeam).toBeDefined();
      expect(g.awayTeam).toBeDefined();
      expect(typeof g.homeTeam.id).toBe("string");
      expect(typeof g.awayTeam.id).toBe("string");
      expect(typeof g.homeTeam.name).toBe("string");
      expect(typeof g.awayTeam.name).toBe("string");
    }
  }, 15000);

  it("summary boxscore: parseBoxscorePlayers returns BoxscorePlayer[] with playerId, teamId, isStarter", async () => {
    const res = await fetch(`${ESPN_BASE}/summary?event=401810596`);
    const summary = (await res.json()) as unknown;
    const boxscorePlayers = parseBoxscorePlayers(summary);
    expect(Array.isArray(boxscorePlayers)).toBe(true);
    if (boxscorePlayers.length > 0) {
      const p = boxscorePlayers[0] as BoxscorePlayer;
      expect(typeof p.playerId).toBe("string");
      expect(p.playerId.length).toBeGreaterThan(0);
      expect(typeof p.fullName).toBe("string");
      expect(typeof p.isStarter).toBe("boolean");
      if (p.teamId != null) expect(typeof p.teamId).toBe("string");
    }
  }, 15000);

  it("roster: parseTeamRoster returns players with player_id, raw_json; parseRosterRawToProfile yields NormalizedRosterProfile", async () => {
    const res = await fetch(`${ESPN_BASE}/teams/1/roster`);
    const rosterJson = (await res.json()) as unknown;
    const roster = parseTeamRoster(rosterJson, "1");
    expect(Array.isArray(roster)).toBe(true);
    if (roster.length > 0) {
      const r = roster[0];
      expect(typeof r.player_id).toBe("string");
      expect(typeof r.full_name).toBe("string");
      if (r.raw_json) {
        const profile = parseRosterRawToProfile(r.raw_json);
        expect(profile).not.toBeNull();
        const p = profile as NormalizedRosterProfile;
        expect(typeof p.id).toBe("string");
        expect(typeof p.displayName).toBe("string");
        if (p.position != null) expect(typeof p.position).toBe("string");
        if (p.contract != null) {
          if (p.contract.salary != null) expect(typeof p.contract.salary).toBe("number");
          if (p.contract.yearsRemaining != null) expect(typeof p.contract.yearsRemaining).toBe("number");
        }
        if (p.birthPlace != null) expect(typeof p.birthPlace).toBe("object");
      }
    }
  }, 15000);

  it("athlete stats: parseAthleteSeasonStats returns at least one row (stat_type, json)", async () => {
    const url = getAthleteStatsUrl(ESPN_BASE, "4278039", 2025);
    const res = await fetch(url);
    const raw = (await res.json()) as unknown;
    const rows = parseAthleteSeasonStats(raw);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(typeof row.stat_type).toBe("string");
    expect(typeof row.json).toBe("string");
    const parsed = JSON.parse(row.json) as unknown;
    expect(parsed !== null && typeof parsed === "object").toBe(true);
  }, 15000);

  it("teams: parseAllNbaTeams returns ParsedNbaTeam[] with teamId, name, abbr", async () => {
    const raw = await fetchAllNbaTeams(ESPN_BASE, 8000);
    const teams = parseAllNbaTeams(raw);
    expect(Array.isArray(teams)).toBe(true);
    if (teams.length > 0) {
      const t = teams[0];
      expect(typeof t.teamId).toBe("string");
      expect(typeof t.name).toBe("string");
      expect(typeof t.abbr).toBe("string");
    }
  }, 15000);

  it("roster raw_json: parseRosterRawToDbColumns parses ESPN athlete shape (root-level id, firstName, position, injuries, status, contract)", () => {
    // Fixture matches real ESPN roster API raw_json (e.g. James Harden sample from DB).
    const espnAthlete = {
      id: "3992",
      uid: "s:40~l:46~a:3992",
      firstName: "James",
      lastName: "Harden",
      fullName: "James Harden",
      displayName: "James Harden",
      shortName: "J. Harden",
      weight: 220,
      height: 77,
      age: 36,
      dateOfBirth: "1989-08-26T07:00Z",
      debutYear: 2009,
      birthPlace: { city: "Los Angeles", state: "CA", country: "USA" },
      college: { id: "9", name: "Arizona State", abbrev: "ASU" },
      slug: "james-harden",
      headshot: { href: "https://a.espncdn.com/i/headshots/nba/players/full/3992.png", alt: "James Harden" },
      position: { id: "3", name: "Guard", displayName: "Guard", abbreviation: "G", leaf: false },
      injuries: [{ status: "Out", date: "2026-02-04T22:31Z" }],
      experience: { years: 16 },
      contract: { salary: 39446090, yearsRemaining: 2, season: { year: 2026 } },
      status: { id: "1", name: "Active", type: "active", abbreviation: "Active" },
    };
    const rawJson = JSON.stringify(espnAthlete);
    const cols = parseRosterRawToDbColumns(rawJson);
    expect(cols).not.toBeNull();
    expect(cols!.display_name).toBe("James Harden");
    expect(cols!.first_name).toBe("James");
    expect(cols!.last_name).toBe("Harden");
    expect(cols!.full_name).toBe("James Harden");
    expect(cols!.short_name).toBe("J. Harden");
    expect(cols!.position_abbr).toBe("G");
    expect(cols!.position_name).toBe("Guard");
    expect(cols!.weight).toBe(220);
    expect(cols!.height).toBe(77);
    expect(cols!.age).toBe(36);
    expect(cols!.date_of_birth).toBe("1989-08-26T07:00Z");
    expect(cols!.debut_year).toBe(2009);
    expect(cols!.college_name).toBe("Arizona State");
    expect(cols!.birth_place_city).toBe("Los Angeles");
    expect(cols!.birth_place_state).toBe("CA");
    expect(cols!.birth_place_country).toBe("USA");
    expect(cols!.experience_years).toBe(16);
    expect(cols!.contract_salary).toBe(39446090);
    expect(cols!.contract_years_remaining).toBe(2);
    expect(cols!.slug).toBe("james-harden");
    expect(cols!.status).toBe("Active");
    expect(cols!.headshot_href).toBe("https://a.espncdn.com/i/headshots/nba/players/full/3992.png");
    expect(cols!.injuries_json).toBeDefined();
    const injuries = JSON.parse(cols!.injuries_json!) as Array<{ status?: string; date?: string }>;
    expect(injuries.length).toBe(1);
    expect(injuries[0].status).toBe("Out");
    expect(injuries[0].date).toBe("2026-02-04T22:31Z");
  });

  it("roster raw_json: parseRosterRawToDbColumns accepts root.athlete wrapper (some ESPN responses)", () => {
    const wrapped = { athlete: { id: "123", displayName: "Test Player", firstName: "Test", lastName: "Player" } };
    const cols = parseRosterRawToDbColumns(JSON.stringify(wrapped));
    expect(cols).not.toBeNull();
    expect(cols!.display_name).toBe("Test Player");
    expect(cols!.first_name).toBe("Test");
    expect(cols!.last_name).toBe("Player");
  });

  it("substitution: parsePlayByPlaySubstitutions from participants (ESPN summary shape) yields playerInId and playerOutId", () => {
    const summary = {
      header: {
        competitions: [
          {
            plays: [
              {
                sequenceNumber: "51",
                type: { id: "584", text: "Substitution" },
                period: { number: 1 },
                clock: { displayValue: "7:53" },
                team: { id: "25" },
                participants: [
                  { athlete: { id: "2991350" } },
                  { athlete: { id: "4433255" } },
                ],
              },
            ],
          },
        ],
      },
    } as unknown;
    const subs = parsePlayByPlaySubstitutions(summary);
    expect(subs.length).toBe(1);
    expect(subs[0].playerInId).toBe("2991350");
    expect(subs[0].playerOutId).toBe("4433255");
    expect(subs[0].teamId).toBe("25");
  });
});
