// NEW FILE: Shared response helpers for API envelope and ETag.
// jsonOk, jsonErr, withEtag; meta includes serverTimeUtc, source, optional cacheHit.

import { etagFromBody, checkNotModified } from "../etag";
import type { ApiMeta } from "../types";

function metaBase(cacheHit?: boolean): ApiMeta {
  return {
    serverTimeUtc: new Date().toISOString(),
    source: "espn",
    ...(cacheHit !== undefined && { cacheHit }),
  };
}

export interface JsonOkOptions {
  status?: number;
  headers?: Record<string, string>;
  cacheControl?: string;
}

/**
 * Returns Response with envelope { ok: true, data, meta }.
 */
export function jsonOk<T>(
  request: Request,
  data: T,
  metaExtras?: Partial<ApiMeta>,
  options?: JsonOkOptions
): Response {
  const meta = { ...metaBase(metaExtras?.cacheHit), ...metaExtras };
  const envelope = { ok: true as const, data, meta };
  const body = JSON.stringify(envelope);
  return new Response(body, {
    status: options?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": options?.cacheControl ?? "public, max-age=30",
      ...options?.headers,
    },
  });
}

export interface JsonErrOptions {
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Returns Response with envelope { ok: false, error: { code, message }, meta }.
 */
export function jsonErr(
  request: Request,
  code: string,
  message: string,
  status: number = 400,
  metaExtras?: Partial<ApiMeta>,
  options?: JsonErrOptions
): Response {
  const meta = { ...metaBase(), ...metaExtras };
  const envelope = { ok: false as const, error: { code, message }, meta };
  const body = JSON.stringify(envelope);
  return new Response(body, {
    status: options?.status ?? status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...options?.headers,
    },
  });
}

/**
 * Computes ETag from envelope; returns 304 when If-None-Match matches.
 * Otherwise returns the provided Response (must have body set).
 */
export function withEtag(request: Request, envelope: unknown): Response | null {
  const bodyStr = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
  const etag = etagFromBody(bodyStr);
  if (checkNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return null;
}

/**
 * Build full Response with envelope + ETag support. Returns 304 or 200 with body.
 */
export function jsonOkWithEtag<T>(
  request: Request,
  data: T,
  metaExtras?: Partial<ApiMeta> & { cacheHit?: boolean },
  options?: JsonOkOptions
): Response {
  const meta = { ...metaBase(metaExtras?.cacheHit), ...metaExtras };
  const envelope = { ok: true as const, data, meta };
  const bodyStr = JSON.stringify(envelope);
  const etag = etagFromBody(bodyStr);
  if (checkNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(bodyStr, {
    status: options?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": options?.cacheControl ?? "public, max-age=30",
      ETag: etag,
      ...options?.headers,
    },
  });
}
