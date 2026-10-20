# seele-cloud Worker

Cloudflare Worker implementing the seele-cloud memory backend. See
[../SPEC.md](../SPEC.md) for the full contract.

## Two co-resident responsibilities

| Mount | Role |
|-------|------|
| `/api/mem/health` | Phase 1 acceptance criterion — reports D1 + Vectorize readiness |
| `/api/sync/*`, `/mem/v1/*`, `/api/keys/*`, `/api/bots*` | Phase 2/4 surface — returns `501 not_implemented` with a roadmap payload until real handlers ship (TASK-093 etc.) |
| `/fresh/*`, everything else | seele-fresh cache-busting proxy (carried over from `devops-agent/drafts/cf-worker/seele-fresh`); preserves `seele.agency`'s static GitHub Pages behavior |

The proxy exists because `seele.agency` is a GitHub Pages site; the proxy
strips Cloudflare caching so users always get fresh content.

## Bindings (wrangler.toml)

| Binding | Type | Resource |
|---------|------|----------|
| `DB` | D1 | `seele-memory-db` |
| `VECTORIZE` | Vectorize | `seele-memory-embeddings` (384 dims, cosine) |

Both are referenced via `index_name` / `database_name` so wrangler resolves
them at deploy time against the account's resource list.

## Provisioning (one-time)

```bash
./scripts/provision.sh --apply
```

Creates `seele-memory-db` (D1) and `seele-memory-embeddings` (Vectorize,
384d cosine), then patches `wrangler.toml` with the real D1 database ID.

## Deploy

```bash
./scripts/deploy.sh
# or step-by-step:
wrangler d1 execute seele-memory-db --remote --file=migrations/0001_initial.sql
wrangler deploy
```

## Verify

```bash
curl -sS https://seele.agency/api/mem/health | python3 -m json.tool
```

Expected:

```json
{
  "ok": true,
  "service": "seele-cloud",
  "version": "0.1.0-phase1",
  "phase": 1,
  "checks": { "d1": { "ok": true, "tables": 6 }, "vectorize": { "ok": true } }
}
```

## Planned-route behavior (501 payload)

Any request to a Phase 2+ endpoint (e.g. `POST /api/sync/upload`) returns:

```http
HTTP/1.1 501 Not Implemented
content-type: application/json

{
  "error": "not_implemented",
  "phase": 1,
  "path": "/api/sync/upload",
  "planned": "POST — upload one encrypted envelope (Phase 2)",
  "message": "seele-cloud is at Phase 1. See SPEC.md for the phased rollout."
}
```

This intentionally avoids `404` so the Phase 5 integration test can assert
"route exists" without depending on real handlers.

## CF Access policies (manual dashboard step)

Per SPEC.md §"Authentication", CF Access email-link policies attach to
`/api/*` and `/mem/*` to gate user identity. **CF Access policies live in
the Cloudflare dashboard, not in wrangler.toml** — wrangler cannot manage
access apps on behalf of a zone. The required steps are:

1. Cloudflare dashboard → `seele.agency` zone → **Access** → **Applications**.
2. Create a self-hosted application:
   * Name: `seele-cloud-api`
   * Domain: `seele.agency`
   * Path: `/api/*` (add a second application or a second policy with path `/mem/*`)
   * Identity providers: Cloudflare's built-in email-link
3. Allowlist rule: emails matching `CF_ACCESS_ALLOWED_EMAILS` (see
   `../../deployments/env.example`).

Until that step is done the `/api/*` routes will accept anonymous traffic,
which is fine for Phase 1 (the routes are 501-only anyway).

## Local dev

```bash
wrangler dev --local
wrangler d1 execute seele-memory-db --local --file=migrations/0001_initial.sql
```

Note: the Vectorize binding reports `needs to be run remotely` under
`--local`. That's expected — Vectorize has no local emulator.
