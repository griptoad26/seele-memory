# Self-host the Worker — `docs/self-host.md`

This page walks through deploying the seele-memory Worker against
your own Cloudflare account + a custom domain.

If you just want to consume the public deployment (no infra to
manage), skip this page and use the SDK defaults.

## What you need

1. A Cloudflare account (free tier is enough for development).
2. A Cloudflare Workers Paid plan ($5/mo for Workers + Pages).
3. A custom domain you can add to Cloudflare (e.g. `api.yourdomain.com`).
4. The `wrangler` CLI (`pnpm add -g wrangler`).

## 1. Clone and configure

```bash
git clone git@github.com:griptoad26/seele-memory.git
cd seele-memory/worker
cp ../deployments/env.example .dev.vars
```

Edit `.dev.vars` and set:

```
GRANT_JWT=<32-byte random secret, base64-or-hex>
CF_ACCESS_AUD=<your-access-app-aud>
```

Generate the JWT secret with `openssl rand -base64 32` or
`node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'`.

## 2. Create resources

```bash
# D1 database for users / devices / bots / conversations / chunks.
wrangler d1 create seele-memory-db
# → copy the database_id into wrangler.toml.

# Vectorize index (one global index, 384 dims, cosine distance).
wrangler vectorize create seele-memory-vec --dimensions=384 --metric=cosine
# → copy the index_name into wrangler.toml.
```

Edit `wrangler.toml` so the D1 binding (`DB`), Vectorize binding
(`VECTORIZE`), and JWT secret (`GRANT_JWT`) all line up:

```toml
name = "seele-memory"
main = "src/index.js"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"
database_name = "seele-memory-db"
database_id = "<your-database-id>"

[[vectorize]]
binding = "VECTORIZE"
index_name = "seele-memory-vec"

# Secret binding. `wrangler secret put GRANT_JWT` will prompt for the
# value at deploy time.
```

## 3. Run migrations

```bash
wrangler d1 migrations apply seele-memory-db --remote
```

This applies the SQL in `migrations/*.sql` to your remote D1
instance. The schema covers Phase 1 (SPEC §"Data model").

## 4. Deploy

```bash
wrangler deploy
```

The Worker publishes to its own hostname via `workers_dev = true`:

```
https://seele-memory.<your-cloudflare-subdomain>.workers.dev
```

This is the **canonical API base URL** until you attach a custom
domain (see the next section).

### Custom domain

```bash
# Add the API subdomain to Cloudflare (the zone must already be on CF).
wrangler route add "api.yourdomain.com/*" seele-memory
```

Set `cf_account_id` in `wrangler.toml` first.

Then register the route in `wrangler.toml`:

```toml
routes = [
  { pattern = "api.yourdomain.com/api/*", zone_name = "yourdomain.com" },
  { pattern = "api.yourdomain.com/mem/*", zone_name = "yourdomain.com" },
]
```

> **Conflict with Pages.** Cloudflare Pages custom domains take
> precedence over Worker routes on the same hostname. If you're also
> running a Pages site on `yourdomain.com`, the Worker routes for
> `/api/*` and `/mem/*` will not fire because Pages wins the hostname
> match first. See `deployments/ROUTING.md` (in the repo) for the
> recommended workarounds.

## 5. Cloudflare Access (optional but recommended)

For production deployments, attach Cloudflare Access to `/api/*` so
humans identify via email-link or GitHub OAuth.

CF Access docs are out of scope for this page; the dashboard steps
are:

1. **Zero Trust → Access → Applications → Add** → Self-hosted.
2. Set the application domain to `api.yourdomain.com`.
3. Add a policy: `*.yourdomain.com` emails in the allow list, OR
   `email` ends in `@yourdomain.com`.
4. Save → grab the application's **AUD** tag.
5. Set `CF_ACCESS_AUD` in `wrangler.toml` and re-deploy.

The Worker validates the `Cf-Access-Jwt-Assertion` cookie on
`/api/*` (and trusts the user's email hash). It does NOT validate
on `/mem/v1/*` because that path is bot-only, bot-trust comes from
the JWT grant instead.

## 6. Smoke test

```bash
# Health check — no auth required.
curl https://api.yourdomain.com/api/mem/health

# Register a device.
curl -X POST https://api.yourdomain.com/api/keys/register \
  -H 'content-type: application/json' \
  -d '{
    "user_id":"alice@yourdomain.com",
    "device":{"device_id":"d1","name":"laptop","platform":"linux","app_version":"0.10.0"}
  }'

# Mint a bot. Use the device_token from the previous response.
curl -X POST https://api.yourdomain.com/api/bots \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <device_token>' \
  -d '{"name":"my-bot","ttl_seconds":900}'

# Recall. Use the bot's grant.jwt from the previous response.
curl -X POST https://api.yourdomain.com/mem/v1/recall \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <bot_grant_jwt>' \
  -d '{"query_vector":[0.0, 0.1, ... 384 floats ...], "top_k":5}'
```

## 7. Wire the SDK to your deployment

```ts
import { SeeleCloudClient } from '@seele/memory-client'

const client = new SeeleCloudClient({
  baseUrl: 'https://api.yourdomain.com',
  deviceToken: '...',
})
```

The SDK's `DEFAULT_BASE_URL` constant points at the official
public deployment — pass `baseUrl` to override.

## Limitations of self-hosting in v0.10.0

- The repo is **private**. Mirror it internally if you need to.
- Webhook delivery for captures is HTTP only (no iOS/Android FFI
  bridge yet).
- Shamir share recovery is opt-in and not yet automated.
- The Rust-side embedder is the hash-based stub; until v0.11.0,
  Rust-captured snippets won't recall cleanly from a JS embedder
  bot (or vice versa). See `docs/embedding.md`.

## Hidden gotchas

- **One secret, two places.** `GRANT_JWT` lives both in
  `.dev.vars` (local) and as a `wrangler secret` (remote). They
  are not the same storage; local doesn't auto-sync to remote.
  Run `wrangler secret put GRANT_JWT` once per environment.
- **The first 60-120s after deploy.** New workers.dev hosts need
  time to issue the edge certificate; the first requests fail with
  `sslv3 alert handshake failure`. That's normal, not your bug.
- **Vectorize index name ≠ binding.** The `index_name` is the
  resource in Cloudflare; the `binding` is the variable name the
  Worker uses (`env.VECTORIZE`). Get them right or you get
  `binding not configured` at runtime.
- **D1 migrations are forward-only.** `wrangler d1 migrations
  apply --remote` runs forward migrations; to roll back, write
  reverse SQL by hand and apply it as a new migration.
