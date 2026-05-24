/**
 * CHANGED: Durable Object for real-time ESPN polling per gameId.
 * Maintains latest derived lineup + liveStats in memory; no D1 writes on fast path.
 * Single-flight polling via alarms; optional SSE stream.
 */

import * as db from "../db";
import { fetchSummaryWithRetry, parsePlayByPlaySubstitutions, parseBoxscorePlayers } from "../espn";
import { getStartersFromBoxscore, deriveLineup } from "../lineup/derive";
import { etagFromBody } from "../etag";
import type { Env } from "../types";

const DEFAULT_POLL_MS = 5000;
const WARMUP_WAIT_MS = 3000;
const SSE_HEARTBEAT_MS = 15000;

export class GameRealtimeDO implements DurableObject {
  private lastBodyStr = "";
  private lastEtag = "";
  private lastUpdatedMs = 0;
  private lastPollMs = DEFAULT_POLL_MS;
  private polling = false;
  private inFlight: Promise<void> | null = null;
  private cursorSeq = 0;
  private prevLineupIds: { home: string[]; away: string[] } = { home: [], away: [] };
  private lastError: string | null = null;
  private sseConnections: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  private initializedFromD1 = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const gameId = request.headers.get("X-Game-Id") ?? "";
    const path = new URL(request.url).pathname;

    try {
      if (path.endsWith("/stream")) {
        return await this.handleStream(request, gameId);
      }
      // /context or default
      return this.handleContext(request, gameId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ ok: false, error: { code: "RT_ERROR", message: msg } }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  private getPollMs(): number {
    const v = this.env.RT_POLL_MS;
    if (v == null || v === "") return DEFAULT_POLL_MS;
    const n = parseInt(v, 10);
    return isNaN(n) || n < 1000 ? DEFAULT_POLL_MS : n;
  }

  private startPollingIfNeeded(gameId: string): void {
    if (this.polling || !gameId) return;
    this.polling = true;
    this.lastPollMs = this.getPollMs();
    this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const gameId = await this.getGameIdFromStorage();
    if (!gameId) return;
    await this.pollOnce(gameId);
    if (this.polling) {
      this.ctx.storage.setAlarm(Date.now() + this.lastPollMs);
    }
  }

  private async getGameIdFromStorage(): Promise<string> {
    const name = await this.ctx.storage.get<string>("gameId");
    return name ?? "";
  }

  private async setGameIdInStorage(gameId: string): Promise<void> {
    await this.ctx.storage.put("gameId", gameId);
  }

  private async handleContext(request: Request, gameId: string): Promise<Response> {
    if (!gameId) {
      return new Response(JSON.stringify({ ok: false, error: { code: "BAD_REQUEST", message: "Missing X-Game-Id" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    await this.setGameIdInStorage(gameId);
    this.startPollingIfNeeded(gameId);

    if (this.lastBodyStr && this.lastEtag) {
      const ifNoneMatch = request.headers.get("If-None-Match");
      if (ifNoneMatch && ifNoneMatch.split(/,\s*/).some((v) => v.trim() === this.lastEtag)) {
        return new Response(null, { status: 304, headers: { ETag: this.lastEtag } });
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1",
        ETag: this.lastEtag,
        "X-RT-Updated-Ms": String(this.lastUpdatedMs),
        "X-RT-Polling": this.polling ? "1" : "0",
      };
      if (this.lastError) headers["X-RT-Error"] = this.lastError.slice(0, 100);
      return new Response(this.lastBodyStr, { status: 200, headers });
    }

    // Cold start: trigger one immediate poll then wait up to WARMUP_WAIT_MS.
    await this.pollOnce(gameId);
    const deadline = Date.now() + WARMUP_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.lastBodyStr) {
        const ifNoneMatch = request.headers.get("If-None-Match");
        if (ifNoneMatch && ifNoneMatch.split(/,\s*/).some((v) => v.trim() === this.lastEtag)) {
          return new Response(null, { status: 304, headers: { ETag: this.lastEtag } });
        }
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=1",
          ETag: this.lastEtag,
          "X-RT-Updated-Ms": String(this.lastUpdatedMs),
          "X-RT-Polling": "1",
        };
        if (this.lastError) headers["X-RT-Error"] = this.lastError.slice(0, 100);
        return new Response(this.lastBodyStr, { status: 200, headers });
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    return new Response(
      JSON.stringify({ ok: false, error: { code: "WARMING_UP", message: "First fetch not ready yet" } }),
      { status: 202, headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleStream(request: Request, gameId: string): Promise<Response> {
    // Access control: ADMIN_KEY or RT_STREAM_TOKEN (header X-RT-TOKEN or query token=).
    const token = request.headers.get("X-RT-TOKEN") ?? new URL(request.url).searchParams.get("token") ?? "";
    const allowed = token === this.env.ADMIN_KEY || (this.env.RT_STREAM_TOKEN != null && this.env.RT_STREAM_TOKEN !== "" && token === this.env.RT_STREAM_TOKEN);
    if (!allowed) {
      return new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid or missing token" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    await this.setGameIdInStorage(gameId);
    this.startPollingIfNeeded(gameId);

    const encoder = new TextEncoder();
    let myController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        myController = controller;
        this.sseConnections.push(controller);
        if (this.lastBodyStr) {
          try {
            controller.enqueue(encoder.encode(`event: snapshot\ndata: ${this.lastBodyStr}\n\n`));
          } catch {
            // client may have closed
          }
        } else {
          try {
            controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
          } catch {
            //
          }
        }
      },
      cancel: () => {
        if (myController) {
          this.sseConnections = this.sseConnections.filter((c) => c !== myController);
          myController = null;
        }
      },
    });

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        const msg = encoder.encode("event: ping\ndata: {}\n\n");
        const alive: Array<ReadableStreamDefaultController<Uint8Array>> = [];
        for (const c of this.sseConnections) {
          try {
            c.enqueue(msg);
            alive.push(c);
          } catch {
            //
          }
        }
        this.sseConnections = alive;
        if (this.sseConnections.length === 0 && this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
      }, SSE_HEARTBEAT_MS);
    }

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  private broadcastSnapshot(): void {
    if (this.lastBodyStr.length === 0) return;
    const encoder = new TextEncoder();
    const msg = encoder.encode(`event: update\ndata: ${this.lastBodyStr}\n\n`);
    const alive: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    for (const c of this.sseConnections) {
      try {
        c.enqueue(msg);
        alive.push(c);
      } catch {
        //
      }
    }
    this.sseConnections = alive;
  }

  private async pollOnce(gameId: string): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = this._doPollOnce(gameId);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async _doPollOnce(gameId: string): Promise<void> {
    try {
      const gameRow = await db.getGameById(this.env.DB, gameId);
      if (!gameRow) {
        this.lastError = "Game not found in D1";
        this.polling = false;
        return;
      }

      if (!this.initializedFromD1) {
        const [cursor, lineup] = await Promise.all([
          db.getPlayByPlayCursor(this.env.DB, gameId),
          db.getGameLineupCurrent(this.env.DB, gameId),
        ]);
        this.cursorSeq = cursor?.last_event_seq ?? 0;
        if (lineup) {
          try {
            this.prevLineupIds = {
              home: JSON.parse(lineup.home_on_court_json) as string[],
              away: JSON.parse(lineup.away_on_court_json) as string[],
            };
          } catch {
            //
          }
        }
        this.initializedFromD1 = true;
      }

      const summary = await fetchSummaryWithRetry(this.env.ESPN_BASE_URL, gameId, 6000);
      const substitutions = parsePlayByPlaySubstitutions(summary);
      const boxscorePlayers = parseBoxscorePlayers(summary);
      const starters = getStartersFromBoxscore(boxscorePlayers, gameRow.home_team_id, gameRow.away_team_id);
      const cursorBefore = this.cursorSeq;
      const result = deriveLineup({
        prevLineup:
          this.prevLineupIds.home.length > 0 || this.prevLineupIds.away.length > 0
            ? { homeOnCourtIds: this.prevLineupIds.home, awayOnCourtIds: this.prevLineupIds.away }
            : undefined,
        startersFromBoxscore: starters,
        substitutions,
        cursorSeq: this.cursorSeq,
      });

      this.prevLineupIds = { home: result.homeOnCourtIds, away: result.awayOnCourtIds };
      this.cursorSeq = result.newCursorSeq;

      const newEvents = substitutions
        .filter((s) => s.seq > cursorBefore && s.seq <= result.newCursorSeq)
        .map((s) => ({
          seq: s.seq,
          teamId: s.teamId,
          playerOutId: s.playerOutId,
          playerInId: s.playerInId,
          period: s.period,
          clock: s.clock ?? "",
        }));
      if (newEvents.length > 0) {
        try {
          await db.insertGameLineupEventsBatch(this.env.DB, gameId, newEvents);
        } catch {
          // best-effort
        }
      }

      const liveStatsPlayers = boxscorePlayers.map((p) => ({
        playerId: p.playerId,
        teamId: p.teamId ?? null,
        stats: (p.statsJson ?? {}) as Record<string, unknown>,
      }));

      const response = {
        quality: {
          fetchedAtUtc: new Date().toISOString(),
          substitutionsCount: substitutions.length,
          boxscorePlayersCount: boxscorePlayers.length,
          derivedFrom: result.derivedFrom,
          confidence: result.confidence,
          lastUpdatedMs: Date.now(),
          lastError: this.lastError,
        },
        game: db.gameCurrentRowToNormalized(gameRow),
        lineup: {
          homeOnCourtIds: result.homeOnCourtIds,
          awayOnCourtIds: result.awayOnCourtIds,
          derivedFrom: result.derivedFrom,
          confidence: result.confidence,
        },
        liveStats: { players: liveStatsPlayers },
        recentSubstitutions: newEvents,
      };

      this.lastError = null;
      this.lastUpdatedMs = Date.now();
      this.lastBodyStr = JSON.stringify(response);
      this.lastEtag = etagFromBody(this.lastBodyStr);
      this.broadcastSnapshot();

      try {
        await db.upsertGameLineupCurrent(
          this.env.DB,
          gameId,
          JSON.stringify(result.homeOnCourtIds),
          JSON.stringify(result.awayOnCourtIds),
          result.derivedFrom,
          result.confidence
        );
      } catch {
        // best-effort: keep DO serving from memory even if D1 write fails
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
