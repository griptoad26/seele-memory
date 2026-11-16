# Self-host seele-cloud

This page takes a **fresh machine from zero to a running seele-cloud
Worker** (D1 + Vectorize + a live API), without asking anyone a
question.

If you just want to *consume* the public deployment, skip this page and
use the SDK defaults — see [Using the SDK](#using-the-sdk) at the
bottom.

> **Status:** validated against worker `v0.2.0-phase2`. The commands
> below were run against this repo's own Worker. Steps that require
> permissions you may not have are marked ⚠️ with the exact scope.

---

## What you need

1. **A Cloudflare account.** The free tier is enough for development.
2. **The Workers Paid plan** ($5/mo) — Workers + Pages are bundled.
   The free tier does **not** allow Workers deployments.
3. **A custom domain on Cloudflare** (optional; you can use the
   auto-generated `workers.dev` hostname instead).
4. **Node.js 20+** (the Worker uses ESM and `node:test`-style tooling).
5. **An API token with the exact permissions in the next section.**
   This is the step that most often blocks people — read it carefully.

---

## ⚠️ The API token — exact permissions required

Everything in this guide runs through the Cloudflare API using
`CLOUDFLARE_API_TOKEN`. A token missing **either** permission below
will authenticate fine and then fail with a misleading error.

| Permission | Why it is needed | What happens without it |
|---|---|---|
| **Account → Workers Scripts → Edit** | `wrangler deploy` | `No access to the specified resource` at `.../workers/scripts/<name>/versions` |
| **Account → D1 → Edit** | `wrangler d1 create`, `wrangler d1 migrations apply` | `The given account is not valid or is not authorized to access this service` (**code 7403**) |

Optional, only if you use a custom domain or a zone:

| Permission | Why |
|---|---|
| **Zone → Workers Routes → Edit** | `wrangler route add` |
| **Zone → DNS → Edit** | adding the `api.` subdomain record |
| **Zone → Zone → Read** | resolving `zone_name` in `wrangler.toml` |

### Creating the token

Dashboard → **My Profile → API Tokens → Create Token** → **Create
Custom Token**.

- **Permissions:** add *Account → Workers Scripts → Edit* and
  *Account → D1 → Edit*. Add the zone-level ones only if you need a
  custom domain.
- **Account Resources:** *Include → Specific account → your account*.
- **Zone Resources:** *Include → Specific zone → your zone* (or *All
  zones* for a first run).

> ### ⚠️ Use an **API Token**, not a User API Key
>
> The token must be a `cfat_…` **API Token** with the scopes above.
>
> A `cfut_…` **User API Token** (the kind `wrangler login` writes to
> `~/.cloudflare-credentials`) authenticates and can *read* Workers
> metadata, but typically carries **neither D1 write nor Workers
> Scripts write**. It fails at exactly the wrong moment — after you
> think everything is set up.
>
> **How to tell which you have:** the prefix. `cfat_` = API Token with
> scopes. `cfut_` = User API Token. `wrangler login` writes a `cfut_`.
>
> **If you are using a `~/.cloudflare-credentials` file**, it is a
> **two-line** file:
>
> ```
> cfat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
> 4240b199ca30d185e7954e6166582e7c
> ```
>
> Line 1 is the token, line 2 is the account ID. Export them
> **separately** — passing the whole file as `CLOUDFLARE_API_TOKEN`
> yields `Invalid format for Authorization header [code: 6003]`:
>
> ```bash
> export CLOUDFLARE_API_TOKEN="$(sed -n '1p' ~/.cloudflare-credentials | tr -d '\n\r')"
> export CLOUDFLARE_ACCOUNT_ID="$(sed -n '2p' ~/.cloudflare-credentials | tr -d '\n\r')"
> ```

**Confirm the token before going further:**

```bash
npx wrangler whoami
```

You should see your account name and ID. `whoami` succeeding does
**not** prove you have write scopes — it only proves the token is
valid. The real test is step 3.

---

## 1. Clone

```bash
git clone https://github.com/griptoad26/seele-memory.git
cd seele-memory/worker
```

Use the **HTTPS** URL above. The `git@github.com:` SSH form only works
if you already have a GitHub SSH key registered; on a fresh machine it
fails with `Permission denied (publickey)`.

The Worker lives in the `worker/` subdirectory. Everything below is run
from there.

---

## 2. Install dependencies

```bash
npm install
```

This is required — the Worker imports [`jose`](https://www.npmjs.com/package/jose)
for JWT signing/verification, and `vitest` for the test suite. There is
no root-level `package.json`; `worker/` is its own npm package.

---

## 3. Create the resources

```bash
npx wrangler d1 create seele-memory-db
npx wrangler vectorize create seele-memory-vec --dimensions=384 --metric=cosine
```

Copy the printed `database_id` and `index_name` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "seele-memory-db"
database_id = "<your-database-id>"

[[vectorize]]
binding = "VECTORIZE"
index_name = "seele-memory-vec"
```

> **Vectorize index name ≠ binding.** `index_name` is the Cloudflare
> resource; `binding` is the variable the Worker reads (`env.VECTORIZE`).
> Mismatch them and you get `binding not configured` at runtime.
>
> The dimension **must** be `384` — that is the embedding width of
> `bge-small-en-v1.5`, and recall silently returns nothing otherwise.

Also set the account ID (used by `wrangler` and by `wrangler route add`):

```toml
# wrangler.toml
account_id = "<your-account-id>"
```

---

## 4. Set the signing secret

```bash
npx wrangler secret put GRANT_JWT
```

Paste a 32-byte random value:

```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

`GRANT_JWT` is the **only** secret the Worker reads
(`env.GRANT_JWT`). It signs both device tokens and bot grants.

> **One secret, two places.** The local `.dev.vars` file and the remote
> `wrangler secret` are different stores and do not sync. If you use
> both, set the same value in each.

---

## 5. Run migrations

```bash
npx wrangler d1 migrations apply seele-memory-db --remote
```

This applies `worker/migrations/*.sql` in order:

| Migration | Adds |
|---|---|
| `0001_initial.sql` | users, devices, bots, conversations, messages, chunks |
| `0002_alter_encrypted_chunks.sql` | schema gap fix for `encrypted_chunks` |
| `0003_device_revocation.sql` | `devices.revoked_at` — **required for `POST /api/keys/revoke`** |

> **Migrations are forward-only.** There is no `migrate down`. To roll
> back, write the reverse SQL by hand and apply it as a new migration.
>
> Skipping `0003` means revocation endpoints will 500.

---

## 6. Deploy

```bash
npx wrangler deploy
```

The Worker publishes to its own hostname via `workers_dev = true`:

```
https://seele-memory.<your-subdomain>.workers.dev
```

That URL is your **canonical API base URL**.

> **The first 60–120s after deploy:** new `workers.dev` hosts need time
> to issue the edge certificate; early requests fail with
> `sslv3 alert handshake failure`. That is normal, not your bug.

### Custom domain (optional)

```bash
# The zone must already be on Cloudflare.
npx wrangler route add "api.yourdomain.com/*" seele-memory
```

Then declare the routes in `wrangler.toml`:

```toml
routes = [
  { pattern = "api.yourdomain.com/api/*", zone_name = "yourdomain.com" },
  { pattern = "api.yourdomain.com/mem/*", zone_name = "yourdomain.com" },
]
```

> **Conflict with Pages.** Cloudflare Pages custom domains take
> precedence over Worker routes on the same hostname. If a Pages site
> occupies `yourdomain.com`, the Worker routes for `/api/*` and
> `/mem/*` will **not** fire — Pages wins the hostname match first.
> Workarounds are in `worker/ROUTING.md`.

---

## 7. ⚠️ Cloudflare Access — required for device registration

**Device registration derives identity from Cloudflare Access and
nowhere else.** `POST /api/keys/register` reads the
`cf-access-authenticated-user-email` header; if it is absent the
request is rejected with **401 `access_required`**. A `user_id` in the
request body is **ignored** and cannot substitute for the header.

So you must attach Access to the hostname you are serving the API from:

1. **Zero Trust → Access → Applications → Add** → *Self-hosted*.
2. **Application domain**: the API hostname — e.g.
   `seele-memory.<your-subdomain>.workers.dev` (or
   `api.yourdomain.com`).
3. **Add a policy**: e.g. email ends in `@yourdomain.com`, or an
   allowlist of specific addresses.
4. Save.
5. Re-deploy (the Worker reads the header at request time, but the
   Access app must exist before the header is injected):
   ```bash
   npx wrangler deploy
   ```

> ### ⚠️ The Worker trusts the header — it does not verify a JWT
>
> The Worker reads `cf-access-authenticated-user-email` **directly**. It
> does **not** validate a `Cf-Access-Jwt-Assertion` token.
>
> This is safe *only because Cloudflare strips that header from
> client-supplied requests* and re-injects it only for allowlisted
> identities. That stripping only happens if **Access is actually bound
> to the hostname**.
>
> **If Access is not bound, anyone can send the header themselves and
> mint a device token for any identity.** Treat "Access is bound to my
> API hostname" as a hard requirement of this guide, not an
> optimisation. Verify it with the smoke test below — the request must
> come back **401**, not 200.

---

## 8. Smoke test

```bash
# 1. Health — no auth required.
curl -s https://YOUR-HOST/api/mem/health
# expect: {"ok":true,...}

# 2. Device registration — must be 401 without an Access identity.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://YOUR-HOST/api/keys/register \
  -H 'content-type: application/json' \
  -d '{"device":{"device_id":"d1","name":"laptop","platform":"linux","app_version":"0.2.0"}}'
# expect: 401   <-- proves the endpoint fails closed
#
# A 200 here means Access is NOT bound to your hostname. Stop and
# complete step 7 before exposing this Worker.
```

Then, from a browser or `curl` **through an Access-authenticated
session**, registration should succeed and return a device token:

```json
{
  "user_id": "<derived from your Access email>",
  "device_id": "d1",
  "device_token": "<HS256 JWT>",
  "token_type": "Bearer",
  "expires_at": "<365 days out>",
  "scope": "memory:write"
}
```

> **Do not put `user_id` in the request body.** The fixed endpoint
> ignores it. If you pass it you will get a confusing 401 on a
> correctly-configured deployment.
>
> The device token is long-lived (**365 days**) — that is by design for
> a device credential, which is why `POST /api/keys/revoke` exists.

### Mint a bot and recall

```bash
# Mint a bot grant from the device token.
curl -X POST https://YOUR-HOST/api/bots \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <device_token>' \
  -d '{"name":"my-bot","ttl_seconds":900}'

# Recall using the bot's short-lived grant JWT.
curl -X POST https://YOUR-HOST/mem/v1/recall \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <bot_grant_jwt>' \
  -d '{"query_vector":[...384 floats...],"top_k":5}'
```

Bot grants default to **15 minutes** (`GRANT_JWT_DEFAULT_TTL_SECONDS`);
device tokens default to **365 days**.

---

## 9. Run the test suite

```bash
npm test
```

Expected: **74 tests passing** across 5 files (`auth`, `keys`, `sync`,
`recall`, `bots`). The suite runs entirely against in-memory fakes — no
Cloudflare account or network access needed.

---

## Using the SDK

```bash
npm install @seele/memory-client
```

```ts
import { SeeleCloudClient } from '@seele/memory-client'

const client = new SeeleCloudClient({
  baseUrl: 'https://seele-memory.<your-subdomain>.workers.dev',
  // optional — defaults to the official public deployment
})

// Enroll this device. Requires the request to carry a CF Access identity.
const { device_token } = await client.registerDevice({
  user_id: 'ignored-by-the-server',
  device: {
    device_id: 'd1',
    name: 'laptop',
    platform: 'linux',
    app_version: '0.2.0',
  },
})

const bot = await client.createBot({ name: 'my-bot', ttl_seconds: 900 })
```

`DEFAULT_BASE_URL` points at the official public deployment — pass
`baseUrl` to override it.

> The SDK's `RegisterDeviceRequest` still has a required `user_id`
> field for backwards compatibility. The server **ignores it**;
> identity always comes from Cloudflare Access.

---

## Limitations

- **Webhooks are HTTP-only.** No iOS/Android FFI bridge yet.
- **Shamir share recovery is opt-in** and not yet automated.
- **Custom domains conflict with Pages** on the same hostname (see
  `worker/ROUTING.md`).
- **Access must be bound** for device registration to work at all —
  see step 7.
- **Cross-embedding recall needs matching embedders.** The JS Worker
  and the Rust `xkg-core` must use the same model
  (`bge-small-en-v1.5`, 384 dims). v0.11.0 replaced the Rust
  hash-based stub with a real ONNX embedder; earlier captures encoded
  with the old stub will not recall correctly and must be re-embedded.
  See `docs/embedding.md`.

## Hidden gotchas

- **Vectorize dimension must be 384.** Mismatched dimensions produce a
  binding error, not a soft failure.
- **`GRANT_JWT` is one secret in two stores** (local `.dev.vars` and
  remote `wrangler secret`). They do not sync.
- **The first 60–120s after deploy** can fail with
  `sslv3 alert handshake failure` while the edge certificate is issued.
- **D1 migrations are forward-only.**
- **Workers.dev vs Pages:** Pages wins the hostname match. If your
  routes "don't fire", check for a Pages project on that hostname
  first.
- **`wrangler whoami` succeeding does not mean you can deploy.** It
  only validates the token. A `cfut_` user token passes `whoami` and
  then fails at deploy with 7403 / "No access to the specified resource".
