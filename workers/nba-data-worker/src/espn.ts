/**
 * ESPN public API fetch and parse.
 * Timeout 5-8s; defensive parsing (no crash on missing fields).
 * CHANGED: Added summary (play-by-play + boxscore) fetch and parse.
 */

import type {
  ESPNScoreboardResponse,
  ESPNEvent,
  ESPNCompetitor,
  ESPNStatus,
  NormalizedGame,
  SubstitutionEvent,
  BoxscorePlayer,
  NormalizedRosterProfile,
  RosterDbColumns,
} from "./types";

const DEFAULT_TIMEOUT_MS = 6000; // 5-8s range: use 6s

export class ESPNClientError extends Error {
  constructor(
    message: string,
    public status?: number,
    public url?: string
  ) {
    super(message);
    this.name = "ESPNClientError";
  }
}

/**
 * Fetch JSON with AbortController timeout. No retry here; caller may retry.
 */
export async function fetchJson<T = unknown>(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new ESPNClientError(`ESPN API error: ${res.status} ${res.statusText}`, res.status, url);
    }
    return (await res.json()) as T;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new ESPNClientError(`Request timeout after ${timeoutMs}ms`, undefined, url);
    }
    throw err;
  }
}

/**
 * Build scoreboard URL. Optional dates=YYYYMMDD.
 */
export function getScoreboardUrl(baseUrl: string, dateYmd?: string): string {
  const url = new URL(`${baseUrl}/scoreboard`);
  if (dateYmd) url.searchParams.set("dates", dateYmd);
  return url.toString();
}

/**
 * Fetch scoreboard from ESPN.
 */
export async function fetchScoreboard(
  baseUrl: string,
  dateYmd?: string
): Promise<ESPNScoreboardResponse> {
  const url = getScoreboardUrl(baseUrl, dateYmd);
  return fetchJson<ESPNScoreboardResponse>(url, DEFAULT_TIMEOUT_MS);
}

// CHANGED: Fetch all NBA teams so we have team_id for roster refresh even when scoreboard returns empty.
/** URL for all NBA teams (ESPN returns 30 teams with id, displayName, abbreviation). */
export function getAllNbaTeamsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/teams`;
}

export async function fetchAllNbaTeams(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  return fetchJson<unknown>(getAllNbaTeamsUrl(baseUrl), timeoutMs);
}

export interface ParsedNbaTeam {
  teamId: string;
  name: string;
  abbr: string;
}

/** Parse ESPN /teams response. Defensive; returns [] on missing/invalid. */
export function parseAllNbaTeams(json: unknown): ParsedNbaTeam[] {
  const out: ParsedNbaTeam[] = [];
  try {
    const root = json as Record<string, unknown>;
    const sports = (root?.sports as unknown[] | undefined) ?? [];
    const firstSport = Array.isArray(sports) && sports.length > 0 ? (sports[0] as Record<string, unknown>) : undefined;
    let leagues = (firstSport?.leagues as unknown[] | undefined) ?? [];
    // Fallback: some ESPN responses have leagues at root (e.g. like scoreboard).
    if (!Array.isArray(leagues) || leagues.length === 0) {
      leagues = (root?.leagues as unknown[] | undefined) ?? [];
    }
    const firstLeague = Array.isArray(leagues) && leagues.length > 0 ? (leagues[0] as Record<string, unknown>) : undefined;
    const teams = (firstLeague?.teams as unknown[] | undefined) ?? [];
    for (const t of teams as Array<Record<string, unknown>>) {
      const team = (t?.team ?? t) as Record<string, unknown>;
      const teamId = safeStr(team?.id ?? (t as { id?: string }).id);
      if (!teamId) continue;
      const name = safeStr(team?.displayName ?? (team as { name?: string }).name ?? (t as { name?: string }).name) || teamId;
      const abbr = safeStr(team?.abbreviation ?? (team as { abbr?: string }).abbr ?? (t as { abbreviation?: string }).abbreviation) || teamId;
      out.push({ teamId, name, abbr });
    }
  } catch {
    // defensive
  }
  return out;
}

// --- Defensive parsing: no crash on missing fields ---

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

function safeNum(v: unknown, def: number): number {
  if (v == null) return def;
  const n = Number(v);
  return isNaN(n) ? def : n;
}

function getTeamFromCompetitor(c: ESPNCompetitor): { id: string; name: string; abbr: string } {
  const team = c?.team;
  // ESPN may put team id in team.id, team.uid (e.g. "s:20~l:28~t:1"), or competitor.id
  const rawId = team?.id ?? team?.uid ?? (c as { id?: string }).id ?? (c as { uid?: string }).uid ?? "";
  const id = typeof rawId === "string" ? rawId : String(rawId ?? "");
  const name = team?.displayName ?? team?.name ?? "";
  const abbr = team?.abbreviation ?? "";
  return { id: safeStr(id), name: safeStr(name), abbr: safeStr(abbr) || (id || "") };
}

function getScore(c: ESPNCompetitor): number {
  const s = c?.score;
  if (s == null) return 0;
  const n = parseInt(String(s), 10);
  return isNaN(n) ? 0 : n;
}

function getStatusDisplay(status: ESPNStatus | undefined): string {
  if (!status?.type) return "scheduled";
  const detail = status.type.detail;
  if (detail != null && detail !== "") return safeStr(detail);
  return safeStr(status.type.state) || "scheduled";
}

/**
 * Normalize a single ESPN event to our NormalizedGame.
 */
export function normalizeEvent(event: ESPNEvent, dateYmd: string): NormalizedGame | null {
  const id = event?.id;
  if (id == null || id === "") return null;

  // ESPN scoreboard returns competitors inside event.competitions[0]; fallback to event.competitors.
  const comps = event?.competitions;
  const rawCompetitors =
    (Array.isArray(comps) && comps.length > 0 ? comps[0].competitors : undefined) ?? event?.competitors;
  const competitors: ESPNCompetitor[] = Array.isArray(rawCompetitors) ? rawCompetitors : [];
  const home = competitors.find((c: ESPNCompetitor) => String(c?.homeAway).toLowerCase() === "home");
  const away = competitors.find((c: ESPNCompetitor) => String(c?.homeAway).toLowerCase() === "away");
  const homeTeam = getTeamFromCompetitor(home ?? {});
  const awayTeam = getTeamFromCompetitor(away ?? {});
  const status = comps?.[0]?.status ?? event?.status;
  const period = safeNum(status?.period, 0);
  const displayClock = status?.displayClock != null ? safeStr(status.displayClock) : "";
  const completed = status?.type?.completed === true;

  let startTimeUtc: string | null = null;
  if (event?.date) {
    try {
      startTimeUtc = new Date(event.date).toISOString();
    } catch {
      startTimeUtc = safeStr(event.date);
    }
  }

  const dateFromEvent = event?.date
    ? String(event.date).slice(0, 10).replace(/-/g, "")
    : dateYmd;

  return {
    gameId: safeStr(id),
    dateYmd: dateFromEvent || dateYmd,
    startTimeUtc,
    status: getStatusDisplay(status),
    period,
    clock: displayClock,
    completed,
    homeTeam: { ...homeTeam, score: getScore(home ?? {}) },
    awayTeam: { ...awayTeam, score: getScore(away ?? {}) },
  };
}

/**
 * Parse ESPN scoreboard response into normalized games list.
 */
export function parseScoreboard(
  data: ESPNScoreboardResponse,
  dateYmd: string
): NormalizedGame[] {
  // ESPN may put events at root, or under day.events / scoreboard.events.
  const raw = data as Record<string, unknown>;
  const dayEvents = (raw?.day as Record<string, unknown> | undefined)?.events;
  const scoreboardEvents = (raw?.scoreboard as Record<string, unknown> | undefined)?.events;
  const events =
    (Array.isArray(data?.events) ? data.events : null) ??
    (Array.isArray(dayEvents) ? (dayEvents as ESPNEvent[]) : null) ??
    (Array.isArray(scoreboardEvents) ? (scoreboardEvents as ESPNEvent[]) : null) ??
    [];
  const games: NormalizedGame[] = [];
  for (const ev of events) {
    const g = normalizeEvent(ev, dateYmd);
    if (g) games.push(g);
  }
  return games;
}

// --- Summary (play-by-play + boxscore) ---

const SUMMARY_TIMEOUT_MS = 6000;

export function getSummaryUrl(baseUrl: string, gameId: string): string {
  const url = new URL(`${baseUrl}/summary`);
  url.searchParams.set("event", gameId);
  return url.toString();
}

export async function fetchSummary(
  baseUrl: string,
  gameId: string,
  timeoutMs: number = SUMMARY_TIMEOUT_MS
): Promise<unknown> {
  const url = getSummaryUrl(baseUrl, gameId);
  return fetchJson<unknown>(url, timeoutMs);
}

/** Fetch summary with max 1 retry on timeout or >=500 only. // NEW */
export async function fetchSummaryWithRetry(
  baseUrl: string,
  gameId: string,
  timeoutMs: number = SUMMARY_TIMEOUT_MS
): Promise<unknown> {
  const url = getSummaryUrl(baseUrl, gameId);
  try {
    return await fetchJson<unknown>(url, timeoutMs);
  } catch (err) {
    const isTimeout = err instanceof ESPNClientError && err.status == null;
    const is5xx = err instanceof ESPNClientError && err.status != null && err.status >= 500 && err.status < 600;
    if (!isTimeout && !is5xx) throw err;
    return fetchJson<unknown>(url, timeoutMs);
  }
}

// NEW: Extract plays array from summary using a small number of known paths (order matters).
export function extractPlays(summaryJson: unknown): unknown[] {
  try {
    const root = summaryJson as Record<string, unknown>;
    if (Array.isArray(root?.plays)) return root.plays as unknown[];
    const headerComp = root?.header as Record<string, unknown> | undefined;
    const compArr = headerComp?.competitions;
    let comps = Array.isArray(compArr) && compArr.length > 0 ? (compArr[0] as Record<string, unknown>) : undefined;
    if (!comps) {
      const rootComps = root?.competitions as unknown[] | undefined;
      comps = Array.isArray(rootComps) && rootComps.length > 0 ? (rootComps[0] as Record<string, unknown>) : undefined;
    }
    if (comps && Array.isArray(comps?.plays)) return comps.plays as unknown[];
    const gamecast = root?.gamecast as Record<string, unknown> | undefined;
    if (gamecast && Array.isArray(gamecast?.plays)) return gamecast.plays as unknown[];
    const box = root?.boxscore as Record<string, unknown> | undefined;
    if (box && Array.isArray(box?.plays)) return box.plays as unknown[];
  } catch {
    // defensive
  }
  return [];
}

/** Try multiple ESPN shapes for athlete id from substitution incoming/outgoing object. */
function athleteIdFromSubParticipant(obj: Record<string, unknown> | null | undefined): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const id =
    (obj.id != null ? safeStr(obj.id) : undefined) ||
    (obj.athleteId != null ? safeStr(obj.athleteId) : undefined) ||
    ((obj.athlete as Record<string, unknown> | undefined)?.id != null ? safeStr((obj.athlete as Record<string, unknown>).id) : undefined);
  return id && id.length > 0 ? id : undefined;
}

/**
 * ESPN summary API uses participants array only (no substitution.incoming/outgoing).
 * - If participants have type "in"/"out" or typeId 12/13, use those.
 * - Else use order: first = player in, second = player out (matches "X enters the game for Y").
 */
function playerIdsFromParticipants(play: Record<string, unknown>): { playerInId?: string; playerOutId?: string } {
  const participants = play?.participants as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(participants) || participants.length < 2) return {};
  const ids = participants.map((p) => athleteIdFromSubParticipant(p as Record<string, unknown>)).filter((id): id is string => !!id);
  if (ids.length < 2) return {};

  const withType = participants.find((p) => safeStr(p?.type ?? (p as { typeId?: string }).typeId).toLowerCase() !== "");
  if (withType) {
    let playerInId: string | undefined;
    let playerOutId: string | undefined;
    for (const p of participants) {
      const type = safeStr(p?.type ?? (p as { typeId?: string }).typeId).toLowerCase();
      const id = athleteIdFromSubParticipant(p as Record<string, unknown>);
      if (!id) continue;
      if (type === "in" || type === "13") playerInId = id;
      else if (type === "out" || type === "12") playerOutId = id;
    }
    if (playerInId != null && playerOutId != null) return { playerInId, playerOutId };
  }

  return { playerInId: ids[0], playerOutId: ids[1] };
}

/** CHANGED: Parse play-by-play for substitution events only; uses extractPlays; defensive field extraction. */
export function parsePlayByPlaySubstitutions(summaryJson: unknown): SubstitutionEvent[] {
  const out: SubstitutionEvent[] = [];
  try {
    const items = extractPlays(summaryJson);
    for (const p of items) {
      const play = p as Record<string, unknown>;
      const sub = (play?.substitution as Record<string, unknown> | undefined) ?? (play as { substitution?: Record<string, unknown> }).substitution;
      const typeObj = play?.type as Record<string, unknown> | undefined;
      const typeText = safeStr(typeObj?.text ?? (play as { typeText?: string }).typeText).toLowerCase();
      const typeId = safeStr(typeObj?.id ?? (play as { typeId?: string }).typeId);
      const isSub = !!sub || typeText.indexOf("substitution") !== -1 || typeId === "12";
      if (!isSub) continue;
      const seq = safeNum(play?.sequenceNumber ?? (play as { sequence_number?: number }).sequence_number, 0);
      const periodObj = play?.period as Record<string, unknown> | undefined;
      const period = safeNum(periodObj?.number ?? (play as { periodNumber?: number }).periodNumber ?? (play as { period_number?: number }).period_number, 0);
      const clockObj = play?.clock as Record<string, unknown> | undefined;
      const clock = safeStr(clockObj?.displayValue ?? (play as { clockDisplayValue?: string }).clockDisplayValue ?? (play as { clock_display_value?: string }).clock_display_value);
      const teamObj = play?.team as Record<string, unknown> | undefined;
      const teamId = (teamObj?.id ?? (play as { teamId?: string }).teamId ?? (play as { team_id?: string }).team_id) as string | undefined;
      const incomingObj = sub?.incoming as Record<string, unknown> | undefined;
      const outgoingObj = sub?.outgoing as Record<string, unknown> | undefined;
      let playerInId = athleteIdFromSubParticipant(incomingObj);
      let playerOutId = athleteIdFromSubParticipant(outgoingObj);
      if (playerInId == null || playerOutId == null) {
        const fromParts = playerIdsFromParticipants(play);
        if (playerInId == null && fromParts.playerInId) playerInId = fromParts.playerInId;
        if (playerOutId == null && fromParts.playerOutId) playerOutId = fromParts.playerOutId;
      }
      out.push({ seq, period, clock, teamId, playerInId, playerOutId, raw: play });
    }
  } catch {
    // defensive: return [] on any parse error
  }
  return out;
}

// --- Team roster (defensive; primary + fallback URL) ---

/** Primary URL: /roster returns root.athletes; team detail (/teams/:id) does not. */
export function getTeamRosterUrl(baseUrl: string, teamId: string): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/teams/${encodeURIComponent(teamId)}/roster`);
  return url.toString();
}

/** Fallback if /roster fails (timeout or 5xx). */
function getTeamRosterFallbackUrl(baseUrl: string, teamId: string): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/teams/${encodeURIComponent(teamId)}`);
  return url.toString();
}

/** Fetch team roster: try primary URL, on timeout or 5xx try fallback. */
export async function fetchTeamRoster(
  baseUrl: string,
  teamId: string,
  timeoutMs: number = 6000
): Promise<unknown> {
  const primary = getTeamRosterUrl(baseUrl, teamId);
  try {
    return await fetchJson<unknown>(primary, timeoutMs);
  } catch (err) {
    const isTimeout = err instanceof ESPNClientError && err.status == null;
    const is5xx = err instanceof ESPNClientError && err.status != null && err.status >= 500 && err.status < 600;
    if (!isTimeout && !is5xx) throw err;
    const fallback = getTeamRosterFallbackUrl(baseUrl, teamId);
    return fetchJson<unknown>(fallback, timeoutMs);
  }
}

export interface ParsedRosterPlayer {
  player_id: string;
  full_name: string;
  team_id: string | null;
  position: string | null;
  jersey: string | null;
  headshot: string | null;
  raw_json: string | null;
}

/** Parse roster JSON into list of players. Best-effort; return [] on any parse failure. */
export function parseTeamRoster(rosterJson: unknown, teamId: string): ParsedRosterPlayer[] {
  const out: ParsedRosterPlayer[] = [];
  try {
    const root = rosterJson as Record<string, unknown>;
    // ESPN may have athletes at root, or under team, or roster/players key.
    let list: unknown[] = [];
    if (Array.isArray(root?.athletes)) list = root.athletes as unknown[];
    else if (Array.isArray(root?.roster)) list = root.roster as unknown[];
    else if (Array.isArray(root?.players)) list = root.players as unknown[];
    else {
      const team = root?.team as Record<string, unknown> | undefined;
      if (Array.isArray(team?.athletes)) list = team.athletes as unknown[];
      else if (Array.isArray(team?.roster)) list = team.roster as unknown[];
      else if (Array.isArray(team?.players)) list = team.players as unknown[];
    }
    for (const item of list) {
      const athlete = (item as Record<string, unknown>)?.athlete ?? item;
      const rec = athlete as Record<string, unknown>;
      const player_id = safeStr(rec?.id ?? (rec as { athleteId?: string }).athleteId ?? (item as Record<string, unknown>)?.id);
      if (!player_id) continue;
      const full_name = safeStr(rec?.displayName ?? (rec as { fullName?: string }).fullName ?? (rec as { name?: string }).name ?? (item as Record<string, unknown>)?.displayName) || "Unknown";
      const position = (rec?.position as { abbreviation?: string })?.abbreviation ?? (rec as { position?: string }).position ?? null;
      const jersey = (rec?.jersey ?? (rec as { jerseyNumber?: string }).jerseyNumber ?? (item as Record<string, unknown>)?.jersey) as string | null;
      const headshotObj = rec?.headshot ?? (rec as { headShot?: unknown }).headShot ?? (item as Record<string, unknown>)?.headshot;
      const headshot = headshotObj != null && typeof headshotObj === "object" && "href" in headshotObj ? String((headshotObj as { href?: string }).href) : typeof headshotObj === "string" ? headshotObj : null;
      const raw_json = typeof item === "object" && item !== null ? JSON.stringify(item) : null;
      out.push({
        player_id,
        full_name,
        team_id: teamId || null,
        position: position ?? null,
        jersey: jersey ?? null,
        headshot: headshot ?? null,
        raw_json,
      });
    }
  } catch {
    return [];
  }
  return out;
}

// --- Roster raw_json → normalized profile (for API / D1) ---

/** Parse roster raw_json (ESPN athlete object or { athlete: {...} }) into normalized profile. Returns null on parse failure. */
export function parseRosterRawToProfile(rawJson: string | null): NormalizedRosterProfile | null {
  if (!rawJson || typeof rawJson !== "string") return null;
  try {
    const root = JSON.parse(rawJson) as Record<string, unknown>;
    const o = (root?.athlete != null && typeof root.athlete === "object" ? root.athlete : root) as Record<string, unknown>;
    const id = safeStr(o?.id ?? (o as { athleteId?: string }).athleteId);
    if (!id) return null;
    const displayName = safeStr(o?.displayName ?? (o as { fullName?: string }).fullName ?? (o as { name?: string }).name) || "Unknown";
    const pos = (o?.position as { abbreviation?: string })?.abbreviation ?? (o as { position?: string }).position;
    const jersey = (o?.jersey ?? (o as { jerseyNumber?: string }).jerseyNumber) as string | undefined;
    const headshotObj = o?.headshot ?? (o as { headShot?: unknown }).headShot;
    const headshot = headshotObj != null && typeof headshotObj === "object" && "href" in headshotObj ? String((headshotObj as { href?: string }).href) : undefined;
    const weight = typeof o?.weight === "number" ? o.weight : undefined;
    const height = typeof o?.height === "number" ? o.height : undefined;
    const collegeObj = o?.college as { name?: string } | undefined;
    const college = collegeObj?.name != null ? String(collegeObj.name) : undefined;
    const birthPlace = o?.birthPlace as { city?: string; state?: string; country?: string } | undefined;
    const contractObj = o?.contract as { salary?: number; yearsRemaining?: number; season?: { year?: number } } | undefined;
    const contract = contractObj
      ? {
          salary: typeof contractObj.salary === "number" ? contractObj.salary : undefined,
          yearsRemaining: typeof contractObj.yearsRemaining === "number" ? contractObj.yearsRemaining : undefined,
          seasonYear: (contractObj.season as { year?: number })?.year,
        }
      : undefined;
    const statusObj = o?.status as { id?: string; name?: string; type?: string; abbreviation?: string } | undefined;
    const status = statusObj?.name != null ? String(statusObj.name) : undefined;
    const statusDetail =
      statusObj && typeof statusObj === "object"
        ? {
            id: statusObj.id != null ? String(statusObj.id) : undefined,
            name: statusObj.name != null ? String(statusObj.name) : undefined,
            type: statusObj.type != null ? String(statusObj.type) : undefined,
            abbreviation: statusObj.abbreviation != null ? String(statusObj.abbreviation) : undefined,
          }
        : undefined;
    const injuriesRaw = o?.injuries as Array<Record<string, unknown>> | undefined;
    const injuries =
      Array.isArray(injuriesRaw) && injuriesRaw.length > 0
        ? injuriesRaw.map((inv) => ({
            type: (inv?.type as string) ?? undefined,
            status: (inv?.status as string) ?? undefined,
            detail: (inv?.details as { type?: string; detail?: string })?.detail ?? (inv?.details as { type?: string; detail?: string })?.type ?? undefined,
            date: (inv?.date as string) ?? undefined,
          }))
        : undefined;
    const expObj = o?.experience as { years?: number } | undefined;
    const experience = typeof expObj?.years === "number" ? expObj.years : undefined;
    return {
      id,
      displayName,
      position: pos != null ? String(pos) : undefined,
      jersey: jersey != null ? String(jersey) : undefined,
      headshot,
      weight,
      height,
      college,
      birthPlace: birthPlace && typeof birthPlace === "object" ? birthPlace : undefined,
      contract,
      status,
      statusDetail,
      injuries,
      experience,
    };
  } catch {
    return null;
  }
}

/** Parse roster raw_json into flat DB column values (snake_case). Returns null on parse failure. */
export function parseRosterRawToDbColumns(rawJson: string | null): RosterDbColumns | null {
  if (!rawJson || typeof rawJson !== "string") return null;
  try {
    const root = JSON.parse(rawJson) as Record<string, unknown>;
    const o = (root?.athlete != null && typeof root.athlete === "object" ? root.athlete : root) as Record<string, unknown>;

    const displayName = safeStr(o?.displayName ?? (o as { fullName?: string }).fullName ?? (o as { name?: string }).name);
    const pos = o?.position as { abbreviation?: string; displayName?: string; name?: string } | undefined;
    const positionAbbr = pos?.abbreviation != null ? String(pos.abbreviation) : undefined;
    const positionName = pos?.displayName ?? pos?.name;
    const jersey = (o?.jersey ?? (o as { jerseyNumber?: string }).jerseyNumber) as string | undefined;
    const headshotObj = o?.headshot ?? (o as { headShot?: unknown }).headShot;
    const headshotHref =
      headshotObj != null && typeof headshotObj === "object" && "href" in headshotObj
        ? String((headshotObj as { href?: string }).href)
        : undefined;
    const weight = typeof o?.weight === "number" ? o.weight : undefined;
    const height = typeof o?.height === "number" ? o.height : undefined;
    const age = typeof o?.age === "number" ? o.age : undefined;
    const dateOfBirth = safeStr(o?.dateOfBirth);
    const debutYear = typeof o?.debutYear === "number" ? o.debutYear : undefined;
    const collegeObj = o?.college as { name?: string } | undefined;
    const collegeName = collegeObj?.name != null ? String(collegeObj.name) : undefined;
    const birthPlace = o?.birthPlace as { city?: string; state?: string; country?: string } | undefined;
    const contractObj = o?.contract as {
      salary?: number;
      yearsRemaining?: number;
      season?: { year?: number };
    } | undefined;
    const contractSalary = typeof contractObj?.salary === "number" ? contractObj.salary : undefined;
    const contractYearsRemaining =
      typeof contractObj?.yearsRemaining === "number" ? contractObj.yearsRemaining : undefined;
    const statusObj = o?.status as { name?: string } | undefined;
    const status = statusObj?.name != null ? String(statusObj.name) : undefined;
    const injuriesRaw = o?.injuries as Array<Record<string, unknown>> | undefined;
    const injuriesArr =
      Array.isArray(injuriesRaw) && injuriesRaw.length > 0
        ? injuriesRaw.map((inv) => ({
            type: (inv?.type as string) ?? undefined,
            status: (inv?.status as string) ?? undefined,
            detail: (inv?.details as { type?: string; detail?: string })?.detail ?? (inv?.details as { type?: string; detail?: string })?.type ?? undefined,
            date: (inv?.date as string) ?? undefined,
          }))
        : undefined;
    const injuriesJson = injuriesArr != null && injuriesArr.length > 0 ? JSON.stringify(injuriesArr) : undefined;
    const expObj = o?.experience as { years?: number } | undefined;
    const experienceYears = typeof expObj?.years === "number" ? expObj.years : undefined;
    const slug = safeStr(o?.slug);

    return {
      display_name: displayName || null,
      first_name: safeStr(o?.firstName) || null,
      last_name: safeStr(o?.lastName) || null,
      full_name: safeStr(o?.fullName) || null,
      short_name: safeStr(o?.shortName) || null,
      position_abbr: positionAbbr ?? null,
      position_name: positionName != null ? String(positionName) : null,
      jersey: jersey != null ? String(jersey) : null,
      headshot_href: headshotHref ?? null,
      weight: weight ?? null,
      height: height ?? null,
      age: age ?? null,
      date_of_birth: dateOfBirth || null,
      debut_year: debutYear ?? null,
      college_name: collegeName ?? null,
      birth_place_city: birthPlace?.city ?? null,
      birth_place_state: birthPlace?.state ?? null,
      birth_place_country: birthPlace?.country ?? null,
      experience_years: experienceYears ?? null,
      contract_salary: contractSalary ?? null,
      contract_years_remaining: contractYearsRemaining ?? null,
      slug: slug || null,
      status: status ?? null,
      injuries_json: injuriesJson ?? null,
    };
  } catch {
    return null;
  }
}

// --- Athlete season stats (defensive) ---

/** site.api.espn.com path (returns 404 for /athletes/:id). Kept for fallback/legacy. */
export function getAthleteStatsUrl(baseUrl: string, playerId: string, season: number): string {
  const base = baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/athletes/${encodeURIComponent(playerId)}`);
  url.searchParams.set("season", String(season));
  return url.toString();
}

/** site.web.api.espn.com athlete stats — one request returns all seasons (averages, totals, miscellaneous). */
export const WEB_ESPN_STATS_BASE = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba";

export function getAthleteStatsUrlWeb(playerId: string): string {
  const url = new URL(`${WEB_ESPN_STATS_BASE}/athletes/${encodeURIComponent(playerId)}/stats`);
  url.searchParams.set("region", "us");
  url.searchParams.set("lang", "en");
  url.searchParams.set("contentorigin", "espn");
  return url.toString();
}

export async function fetchAthleteStatsWeb(playerId: string, timeoutMs: number = 6000): Promise<unknown> {
  return fetchJson<unknown>(getAthleteStatsUrlWeb(playerId), timeoutMs);
}

/** ESPN uses season end year (2025-26 → 2026); we use start year (2025-26 → 2025). Convert so our DB matches currentSeasonStartYearUtc. */
function espnSeasonYearToStartYear(espnYear: number): number {
  return espnYear - 1;
}

/** Parse site.web.api.espn.com stats response: categories[].name (averages/totals/miscellaneous), statistics[] per season. One row per (season, stat_type); prefer "Totals" row when same season has multiple (e.g. traded). */
export function parseAthleteSeasonStatsWeb(statsJson: unknown): Array<{ season: number; stat_type: string; json: string }> {
  const out: Array<{ season: number; stat_type: string; json: string }> = [];
  try {
    const root = statsJson as Record<string, unknown>;
    const categories = root?.categories as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(categories)) return out;
    for (const cat of categories) {
      const name = cat?.name as string | undefined;
      const statistics = cat?.statistics as Array<Record<string, unknown>> | undefined;
      const names = cat?.names as string[] | undefined;
      if (!name || !Array.isArray(statistics) || statistics.length === 0) continue;
      const statType =
        name === "averages" ? "perGame" : name === "totals" ? "totals" : name === "miscellaneous" ? "advanced" : "raw";
      const bySeason = new Map<number, { season: number; stat_type: string; json: string }>();
      for (const row of statistics) {
        const seasonObj = row?.season as Record<string, unknown> | undefined;
        const espnYear = seasonObj?.year as number | undefined;
        if (espnYear == null || !Number.isFinite(espnYear)) continue;
        const year = espnSeasonYearToStartYear(espnYear);
        const displayName = (row?.displayName as string) ?? "";
        const teamSlug = (row?.teamSlug as string) ?? "";
        const isTotals = /Totals/i.test(displayName) || /Totals/i.test(teamSlug);
        const statsArr = row?.stats as unknown[] | undefined;
        let json: string;
        if (Array.isArray(statsArr) && Array.isArray(names) && names.length > 0) {
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < Math.min(names.length, statsArr.length); i++) {
            const v = statsArr[i];
            const key = names[i];
            if (key) obj[key] = typeof v === "string" && /^-?\d*\.?\d+$/.test(v) ? parseFloat(v) : v;
          }
          json = JSON.stringify(obj);
        } else {
          json = JSON.stringify(row);
        }
        const entry = { season: year, stat_type: statType, json };
        const existing = bySeason.get(year);
        if (!existing) bySeason.set(year, entry);
        else if (isTotals) bySeason.set(year, entry);
      }
      for (const e of bySeason.values()) out.push(e);
    }
  } catch {
    // ignore
  }
  return out;
}

/** Fetch athlete stats for a season (site.api.espn.com; often 404). */
export async function fetchAthleteStats(
  baseUrl: string,
  playerId: string,
  season: number,
  timeoutMs: number = 6000
): Promise<unknown> {
  const url = getAthleteStatsUrl(baseUrl, playerId, season);
  return fetchJson<unknown>(url, timeoutMs);
}

/** Parse athlete stats JSON into rows (perGame/totals/advanced or single "raw"). Defensive; return [] on parse failure. */
export function parseAthleteSeasonStats(statsJson: unknown): Array<{ stat_type: string; json: string }> {
  const out: Array<{ stat_type: string; json: string }> = [];
  try {
    const root = statsJson as Record<string, unknown>;
    // ESPN may put statistics under root, or under athlete / season / splits.
    const stats =
      root?.statistics ??
      root?.stats ??
      root?.splits ??
      (root?.athlete as Record<string, unknown> | undefined)?.statistics ??
      (root?.season as Record<string, unknown> | undefined)?.statistics;
    if (stats != null && typeof stats === "object" && !Array.isArray(stats)) {
      const categories = stats as Record<string, unknown>;
      if (categories?.perGame != null) out.push({ stat_type: "perGame", json: JSON.stringify(categories.perGame) });
      if (categories?.totals != null) out.push({ stat_type: "totals", json: JSON.stringify(categories.totals) });
      if (categories?.advanced != null) out.push({ stat_type: "advanced", json: JSON.stringify(categories.advanced) });
      // ESPN sometimes uses "splits" or "categories" as array of { name, stats } or similar
      const splitsArr = (categories?.splits ?? categories?.categories) as unknown[] | undefined;
      if (Array.isArray(splitsArr) && splitsArr.length > 0) {
        for (const item of splitsArr) {
          if (item != null && typeof item === "object") out.push({ stat_type: "raw", json: JSON.stringify(item) });
        }
      }
      if (out.length > 0) return out;
    }
    if (Array.isArray(stats)) {
      for (const item of stats) {
        if (item != null && typeof item === "object") out.push({ stat_type: "raw", json: JSON.stringify(item) });
      }
      if (out.length > 0) return out;
    }
    // Always store at least raw so player_season_stats is not empty when API shape differs
    out.push({ stat_type: "raw", json: JSON.stringify(root) });
  } catch {
    return [];
  }
  return out;
}

/** Parse boxscore players (starters + bench). Defensive; returns [] on missing. */
export function parseBoxscorePlayers(summaryJson: unknown): BoxscorePlayer[] {
  const out: BoxscorePlayer[] = [];
  try {
    const root = summaryJson as Record<string, unknown>;
    let box = (root?.boxscore as Record<string, unknown>) ?? root;
    // Fallback: boxscore may be under header.competitions[0] when root.boxscore has no teams/players.
    const hasTeams = Array.isArray(box?.teams) || Array.isArray(box?.players);
    if (!hasTeams) {
      const headerComp = root?.header as Record<string, unknown> | undefined;
      const compArr = headerComp?.competitions as unknown[] | undefined;
      const comp0 = Array.isArray(compArr) && compArr.length > 0 ? (compArr[0] as Record<string, unknown>) : undefined;
      const nestedBox = comp0?.boxscore as Record<string, unknown> | undefined;
      if (nestedBox && (Array.isArray(nestedBox.teams) || Array.isArray(nestedBox.players))) box = nestedBox;
    }
    // Summary API: boxscore.players[] has team + statistics[0].athletes[] (real player list).
    // boxscore.teams[] has team + statistics[] = team-level stats only (no athletes).
    const teamsOrPlayers = (box?.players ?? box?.teams) as unknown[] | undefined;
    const teamList = Array.isArray(teamsOrPlayers) ? teamsOrPlayers : [];
    for (const t of teamList as Array<Record<string, unknown>>) {
      const tTeam = t?.team as Record<string, unknown> | undefined;
      const teamId = (tTeam?.id ?? (t as { id?: string }).id ?? (t as { teamId?: string }).teamId) as string | undefined;
      // Summary shape: t.statistics[0].athletes = list of { athlete, starter, stats }.
      const stat0 = Array.isArray(t?.statistics) ? (t.statistics as unknown[])[0] : undefined;
      const athletes = (stat0 as Record<string, unknown>)?.athletes as unknown[] | undefined;
      const statistics = (t?.statistics ?? t?.players ?? (t as { roster?: unknown[] }).roster) as unknown[] | undefined;
      const playerList = Array.isArray(athletes) ? athletes : (Array.isArray(statistics) ? statistics : []);
      for (const p of playerList as Array<Record<string, unknown>>) {
        const athlete = (p?.athlete ?? p) as Record<string, unknown>;
        const playerId = safeStr((athlete as Record<string, unknown>)?.id ?? (p as { id?: string }).id ?? (athlete as { athleteId?: string }).athleteId);
        if (!playerId) continue;
        const fullName = safeStr(athlete?.displayName ?? (athlete as { fullName?: string }).fullName ?? (athlete as { name?: string }).name ?? (p as { name?: string }).name) || "Unknown";
        const position = (athlete?.position as { abbreviation?: string })?.abbreviation ?? (athlete as { position?: string }).position ?? (p as { position?: string }).position;
        const jersey = (athlete?.jersey ?? (athlete as { jerseyNumber?: string }).jerseyNumber ?? (p as { jersey?: string }).jersey) as string | undefined;
        const headshot = (athlete?.headshot as { href?: string })?.href ?? (athlete as { headshot?: string }).headshot ?? (athlete as { photo?: string }).photo as string | undefined;
        const isStarter = !!(p?.starter ?? (p as { starter?: boolean }).starter ?? ((p as { order?: number }).order != null && (p as { order?: number }).order! <= 5));
        const stats = (p?.statistics ?? (p as { stats?: unknown }).stats ?? p) as Record<string, unknown> | undefined;
        const statsJson = stats && typeof stats === "object" ? stats : undefined;
        out.push({
          playerId,
          fullName,
          teamId,
          position: position ?? undefined,
          jersey: jersey ?? undefined,
          headshot: headshot ?? undefined,
          isStarter,
          statsJson,
        });
      }
    }
  } catch {
    // defensive
  }
  return out;
}
