# NBA Data Worker (Legacy) — DO NOT DEPLOY

> **DO NOT DEPLOY THIS WORKER.**  
> This directory is the **legacy** copy of an older worker. The **production** worker is **`workers/nba-data-worker`**.  
> Deploy only the production worker. This legacy worker is kept for reference and history only.

---

## Why this exists

The root-level worker was moved here to avoid confusion. The repo’s single source of truth for production is:

- **Production worker:** `workers/nba-data-worker` (D1, Durable Objects, active12, cron, ESPN parsing).

This legacy worker uses a different stack (court-intel-db, different schema) and is **not** used in production.

---

## If you must deploy (not recommended)

Deploy is blocked unless you set:

```bash
ALLOW_LEGACY_DEPLOY=1 npm run deploy
```

Use only for one-off migrations or debugging. Do **not** use for normal deployments.
