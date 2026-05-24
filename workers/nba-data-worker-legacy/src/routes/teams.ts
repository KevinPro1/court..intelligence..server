/**
 * GET /v1/nba/teams - list all teams (from KV or D1).
 */

import { fetchTeams } from "../services/espn";
import { normalizeTeamsList } from "../services/normalize";
import * as db from "../db/queries";
import {
  CACHE_KEYS,
  TTL,
  kvGet,
  kvSet,
  cacheControlHeader,
  etagFromBody,
  checkNotModified,
  isRateLimited,
} from "../cache/cache";
import type { Env } from "../types";
import type { NormalizedTeam } from "../types";

function teamRowToNormalized(row: { team_id: string; name: string; abbr: string }): NormalizedTeam {
  return {
    id: row.team_id,
    displayName: row.name,
    abbreviation: row.abbr,
    espnTeamId: row.team_id,
  };
}

export async function teamsGet(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
  if (await isRateLimited(env.KV, ip, "teams")) {
    return Response.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const cached = await kvGet<NormalizedTeam[]>(env.KV, CACHE_KEYS.teams());
  if (cached) {
    const body = JSON.stringify({ teams: cached });
    const etag = etagFromBody(body);
    if (checkNotModified(request, etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(TTL.teams),
        ETag: etag,
      },
    });
  }

  try {
    const data = await fetchTeams();
    const teams = normalizeTeamsList(data);
    if (teams.length > 0) {
      await kvSet(env.KV, CACHE_KEYS.teams(), teams, TTL.teams);
    }
    const payload = { teams };
    const body = JSON.stringify(payload);
    const etag = etagFromBody(body);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(TTL.teams),
        ETag: etag,
      },
    });
  } catch {
    const rows = await db.getAllTeams(env.DB);
    const teams = rows.map(teamRowToNormalized);
    const payload = { teams };
    const body = JSON.stringify(payload);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControlHeader(3600),
        "X-Fallback": "d1",
      },
    });
  }
}
