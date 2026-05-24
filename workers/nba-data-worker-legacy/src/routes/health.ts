/**
 * Health check route.
 */

import type { Env } from "../types";

export async function healthGet(_request: Request, env: Env): Promise<Response> {
  const body = {
    ok: true,
    service: "court-intel-worker",
    timestamp: new Date().toISOString(),
  };
  return Response.json(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
