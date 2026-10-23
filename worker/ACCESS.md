# CF Access on `seele-memory.griptoad.workers.dev` — findings & remediation

Status as of **2026-10-23**. Companion to [`ROUTING.md`](./ROUTING.md).

## TL;DR — there is a live auth bypass, not just an open health endpoint

The task brief described this as "an unauthenticated edge that currently exposes only
`GET /api/mem/health` plus structured 400/401 responses." **That is wrong, and
understates the severity.** While verifying the Access claim I found that an
unauthenticated caller can mint a valid, signed, 365-day `memory:write` bearer token
and use it to read data. Details in [Finding 1](#finding-1-critical-anonymous-token-minting).

Until Finding 1 is fixed, re-binding the Access policy is a **defence-in-depth** fix,
not the fix for the vulnerability itself — because the token endpoint is reachable
without an Access session by design (see [Finding 2](#finding-2-why-access-does-not-close-it)).

---

## Finding 1 (CRITICAL): anonymous token minting

`POST /api/keys/register` is unauthenticated and takes the caller's identity as a
request-body field. It returns a signed HS256 `device_token` with `scope=memory:write`
and a 365-day TTL.

Reproduced end-to-end from a clean client with no credentials:

```bash
curl -sS -X POST https://seele-memory.griptoad.workers.dev/api/keys/register \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"attacker-probe-002",
       "device":{"device_id":"probe-dev-002","name":"probe",
                 "platform":"linux","app_version":"0.10.0"}}'
```

```json
{"user_id":"attacker-probe-002","device_id":"probe-dev-002",
 "device_token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
 "token_type":"Bearer","expires_at":"2027-10-23T01:51:12.000Z",
 "scope":"memory:write"}
```

That token then authenticates against protected routes:

```bash
curl -sS -H "Authorization: Bearer $TOK" \
  https://seele-memory.griptoad.workers.dev/api/sync/devices
# {"devices":[{"device_id":"probe-dev-002","name":"probe",...}]}
```

Note: `/api/sync/devices` answers `GET` here; the route table registers it for `GET`,
and the `405` in earlier probing was a method mismatch in the probe, not a block.

**Impact:** cross-tenant impersonation. `user_id` is fully caller-controlled, so an
attacker can enrol a device into *any* `user_id` and receive a token scoped to that
tenant — then read that tenant's devices, recall over their memory index, and (once
Phase-3 sync carries content) upload/download their data.

### Root cause

`src/keys.js` documents this as a deliberate Phase-1 shortcut:

> The user_id comes from CF Access in production … For v0.10.0 we accept the
> user_id directly in the request body **because Access is not yet attached to the
> workers.dev hostname** … The brief and SPEC both treat this as Phase 1 acceptance;
> **we don't gate on Access here.**

So this is a known trade-off that outlived its phase. It is not an accident.

### Fix

The real fix is to stop trusting a body-supplied `user_id`. In priority order:

1. **Derive identity from the Access session**, not the body. When Access is
   correctly bound, Cloudflare injects `cf-access-authenticated-user-email` into the
   proxied request. `handleRegisterDevice` should derive `user_id` from that header and
   **reject the request when the header is absent**, rather than falling back to the body.
   This makes Access load-bearing for authz rather than decorative.
2. **Fail closed on a missing Access header.** A one-line existence check at the top of
   `handleRegisterDevice` closes the bypass outright, even before Access is re-bound —
   it converts today's open endpoint into a hard 401.
3. Only then re-bind Access to the workers.dev hostname (below), which restores the
   email-link allowlist as the real gate.

Option 2 is a ~3-line change and is the highest severity-reduction-per-line fix
available today. Do it first.

---

## Finding 2: Access does NOT intercept workers.dev — verified

The brief asked me to verify this claim empirically rather than assert it. **I did,
and the claim holds — Access does not currently intercept the workers.dev hostname.**

Evidence that requests reach the Worker untouched by any Access layer:

```bash
# Protected route, zero credentials:
curl -sS https://seele-memory.griptoad.workers.dev/api/bots
# {"error":"missing_bearer","message":"Authorization: Bearer <grant_jwt> header is required"}
```

A `401 missing_bearer` JSON body can only be produced **by the Worker's own code**.
Cloudflare Access never returns a JSON error envelope — it returns a `302` to its
login page or an HTML challenge. Same result across `GET /api/bots`,
`POST /mem/v1/recall`, `POST /api/sync/upload`, `GET /api/sync/devices`, and
`GET /api/sync/state`.

Separately, the health endpoint returns `200` + JSON, and response headers show
`server: cloudflare` with no `cf-access-*` headers and no `location` header.

So: **the workers.dev hostname is reachable and served today, with no Access session
of any kind.** That is the expected and correct baseline — it is *why* the
misconfiguration exists. It does not contradict the claim; it confirms the gap.

### Why Access alone does not close Finding 1

Important nuance for whoever applies the fix: attaching Access to the workers.dev
hostname gates `/api/keys/register` behind a login, which does mitigate Finding 1.
But it is a *network-front-door* mitigation. The route still accepts a body-supplied
`user_id` for any caller who is merely *inside* the allowlist, so a single
allowlisted account can still enrol devices into any other `user_id` on a shared
deployment. The identity must come from the Access header, not the body — see Fix
above.

### Does the Access app still exist and work on `seele.agency`?

I could not verify the `seele.agency` app directly, because that hostname is answered
by the Pages project, not by Access — `curl -sSI https://seele.agency/api/mem/health`
returns `200 text/html` (the marketing page), never a 302. So the existing Access app
may well still be configured and healthy; it is simply attached to a hostname that
the Worker no longer serves. That matches `ROUTING.md` exactly.

---

## Verification check: 302 vs 200

Once Access is bound to the workers.dev hostname, the check is:

```bash
curl -sSI https://seele-memory.griptoad.workers.dev/api/mem/health
```

| Result | Meaning |
|---|---|
| `HTTP/2 302` + `location: https://<team>.cloudflareaccess.com/cdn-cgi/access/login/...` | ✅ Access is live and intercepting |
| `HTTP/2 200` + JSON body | ❌ Access is not bound (current state) |

For the record, the **current** state is the 200/JSON case:

```json
{"ok":true,"service":"seele-cloud","version":"0.2.0-phase2","phase":2,
 "environment":"production","checks":{"d1":{"ok":true,"tables":6},
 "vectorize":{"ok":true,"dimensions":384}},"last_reindex_at":null}
```

---

## Why this was not done programmatically

The task expected the CF token to be in the environment. **It is not.** This agent's
environment is stripped to the bare minimum:

```
$ env | grep -iE 'cloudflare|cf_|cfpat'
(no output)
```

`env` contains only `OPENCLAW_PATH_BOOTSTRAPPED` and `PATH`. `npx wrangler whoami`
returns `You are not authenticated. Please run wrangler login.` There is no `cfat_`
token in `~/.git-credentials`, `~/.bashrc`, `~/.profile`, `~/.zshrc`, or
`~/.config/.wrangler`.

I therefore could not even reach the Access API to probe whether the token's *scope*
covers Zero Trust — the question the task asked me to settle. Two separate obstacles,
and the credential one is absolute: without any token there is nothing to scope-check.

For the record, the expected answer to the scope question is still **no**: CF Access /
Zero Trust policies are administered under a separate permission scope
(`Access: Apps and Policies`) from the Workers scope (`Workers Scripts`,
`Workers D1`, `Workers Vectorize`). The pre-existing `error 10405` on a `PUT` to
script settings is consistent with a Workers-scoped token. Even given a valid token,
re-binding the Access app is a dashboard action. Treat the click-path below as the
required route, and re-verify the scope yourself if you hold a broader token.

---

## Click-path: re-bind the Access app to workers.dev (Option A)

This is the decision I'd recommend, and it is the smaller change of the two options in
the task brief. Requires a Cloudflare dashboard session for the account
`4240b199ca30d185e7954e6166582e7c`.

**Preferred approach — edit the existing app (keeps the policy intact):**

1. Sign in at <https://one.dash.cloudflare.com> and select the account
   **Griptoad.26@gmail.com's Account** (`4240b199…`).
2. Left rail → **Access** → **Applications**. (In the newer Zero Trust nav this is
   under **Access** → **Applications**; if you land on "Zero Trust" home, use the
   left sidebar.)
3. Find the existing self-hosted application whose domain is `seele.agency`
   (there may be two entries — one for `/api/*`, one for `/mem/*`; **update both**).
   If you cannot find it, it was never created — use the "Add an application" path below.
4. Click the app → **Edit** (pencil icon, top right of the app's page).
5. In the **Application domain** section:
   - **Subdomain**: leave blank.
   - **Domain**: change `seele.agency` → `seele-memory.griptoad.workers.dev`
   - **Path**: change `/api/*` → `/api/*` (unchanged). For the second app, `/mem/*`
     stays `/mem/*`.
6. Click **Save**.

**If no app exists yet, create one:**

1. **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. **Application name**: `seele-memory-api` (and a second one named
   `seele-memory-mem` for the `/mem/*` path).
3. **Session duration**: leave at default (24h).
4. **Add a public hostname**:
   - **Subdomain**: blank
   - **Domain**: `seele-memory.griptoad.workers.dev`
   - **Path**: `/api/*` (then repeat for `/mem/*`)
5. Click **Add application**.
6. **Policy** tab → **Add policy**:
   - **Policy name**: `allow-emails`
   - **Action**: **Allow**
   - **Selector**: **Emails** → add the allowlist address(es).
     (If the existing policy was "One-time PIN", the selector stays **Emails** with
     **Include** → **Everyone**; keep whatever the existing app had — do not widen it.)
7. **Save**.

### Verify

```bash
curl -sSI https://seele-memory.griptoad.workers.dev/api/mem/health
```

Expect `HTTP/2 302` with a `location:` pointing at
`*.cloudflareaccess.com/cdn-cgi/access/login/`. If you still get `200` + JSON, the app
is not bound to this hostname — check that you saved the *hostname* change (step 5) and
that both `/api/*` and `/mem/*` apps were updated.

### Order of operations — do the code fix first

Do **not** treat step 6 above as sufficient on its own. Sequence it as:

1. Fix `keys.js` to fail closed on a missing Access header (Finding 1, fix option 2).
2. Re-bind Access (click-path above).
3. Verify with the 302 curl **and** re-run the Finding 1 reproduction — it must now
   return `403`/`302` at the edge rather than a token.

Doing the code fix first means the window between deploy and dashboard change is not
exploitable.

---

## Cleanup note

The reproduction created two live rows in D1 (users `attacker-probe-001`,
`attacker-probe-002`; devices `probe-dev-001`, `probe-dev-002`) with live
`memory:write` tokens valid until **2027-10-23**. There is no `DELETE` route and no
revocation endpoint for device tokens, so they cannot be invalidated from the API.
Remove them with direct D1 access:

```bash
wrangler d1 execute seele-memory-db --remote \
  --command "DELETE FROM devices WHERE device_id LIKE 'probe-dev-%'; \
             DELETE FROM users  WHERE user_id   LIKE 'attacker-probe-%';"
```

This is the strongest argument for the fix in Finding 1: **tokens are not
revocable.** Any token ever minted by that endpoint stays valid for a year regardless
of what is done to the Access policy afterwards.

---

## Also worth correcting

The co-resident `seele-fresh` proxy answers with `x-seele-fresh` /
`x-seele-origin: https://griptoad26.github.io/...` headers and GitHub Pages 404 HTML
for paths it does not own. That is expected (it is the cache-busting Worker described
in `wrangler.toml`), but it makes the API surface confusing to probe — several
first-pass probes returned GitHub Pages HTML that looked like a redirect. The real
route table is in `src/index.js`; health lives at `/api/mem/health`, and the versioned
recall/sync routes are `/mem/v1/recall`, `/api/sync/upload`, `/api/sync/download`,
`/api/sync/state`, `/api/sync/devices`, `/api/bots`, `/api/keys/register`.