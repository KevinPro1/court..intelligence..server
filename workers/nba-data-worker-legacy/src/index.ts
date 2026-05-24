/**
 * Court Intelligence Worker - router entry.
 * NBA roster, player stats, and live-game API for ML/features.
 */

import { Router } from "itty-router";
import { healthGet } from "./routes/health";
import { scoreboardGet } from "./routes/scoreboard";
import { teamsGet } from "./routes/teams";
import { rosterGet } from "./routes/roster";
import { playerProfileGet, playerStatsGet } from "./routes/players";
import { gamesTodayGet, gameLiveGet } from "./routes/games";
import { handleCronSync } from "./cron/sync";
import type { Env } from "./types";

const router = Router<Request, [Env]>();

// Health
router.get("/health", healthGet);

// NBA v1 API
router.get("/v1/nba/scoreboard", scoreboardGet);
router.get("/v1/nba/teams", teamsGet);
router.get("/v1/nba/teams/:teamId/roster", (req, env) => rosterGet(req, env, (req as { params?: { teamId?: string } }).params?.teamId ?? ""));
router.get("/v1/nba/players/:playerId/profile", (req, env) => playerProfileGet(req, env, (req as { params?: { playerId?: string } }).params?.playerId ?? ""));
router.get("/v1/nba/players/:playerId/stats", (req, env) => playerStatsGet(req, env, (req as { params?: { playerId?: string } }).params?.playerId ?? ""));
router.get("/v1/nba/games/today", gamesTodayGet);
router.get("/v1/nba/games/:gameId/live", (req, env) => gameLiveGet(req, env, (req as { params?: { gameId?: string } }).params?.gameId ?? ""));

// 404
router.all("*", () => Response.json({ error: "Not Found" }, { status: 404 }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await router.handle(request, env);
    } catch (err) {
      console.error(err);
      return Response.json(
        { error: "Internal Server Error" },
        { status: 500 }
      );
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleCronSync(env, event);
  },
};
