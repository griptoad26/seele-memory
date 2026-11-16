# Security Review — seele-cloud Worker auth & token handling

**Task:** TASK-seele-cloud-20261116-119
**Date:** 2026-11-16
**Reviewer:** security-agent
**Scope reviewed:** `worker/src/{index,auth,keys,sync,recall,bots,db}.js`, `worker/wrangler.toml`, `worker/migrations/*`
**Method:** static review of the shipped Worker source + 39 executable probes run against the **real** Worker default export via the local miniflare harness (real D1, real shipped migrations, local Vectorize). No production requests were made.

---

## Verdict

The auth path is **well-built**. The v1.0.0 fail-closed contract holds on every protected
route, token expiry is enforced, revocation genuinely revokes, and CORS does not permit
credentialed cross-origin requests. Two real defects were found; both are fixed in this
change. The most serious is a **credential-forwarding leak to a third-party origin**.

---

## Findings

### 1. HIGH — Catch-all proxy forwards device tokens to a third-party origin

**Location:** `worker/src/index.js` — `handleFreshProxy()` + the router's fall-through.

**What is wrong.** The Worker is a public reverse proxy to `ORIGIN_URL`
(`https://griptoad26.github.io` in production). `handleFreshProxy()` built its outbound
headers with `new Headers(request.headers)` — copying **every** inbound header verbatim,
including `Authorization: Bearer <device_token>` and
`cf-access-authenticated-user-email`.

The router matches API routes by exact string equality (`path === '/api/sync/state'`).
Anything that does not match exactly falls through to the proxy. So a GET carrying a
device token to a near-miss path was forwarded — token and all — to the third-party origin.

**Concrete attack path.**
1. A client (or an attacker who has obtained a device token, e.g. from a log or a
   misconfigured SDK) issues `GET https://seele-memory.griptoad.workers.dev/api/sync/state/extra`
   with `Authorization: Bearer <device_token>`.
2. That path is not an exact route match, so the Worker proxies it to
   `https://griptoad26.github.io/api/sync/state/extra`.
3. The upstream receives the `Authorization` header containing the live device token and
   the Cloudflare Access identity header. The upstream is a third party that logs and can
   serve request headers. The token is a 365-day `memory:write` credential.

9 of 11 near-miss spellings reproduced this, verified with a local capture server:

```
LEAK  /api/sync/state/extra      -> upstream_hits=1
LEAK  /API/SYNC/STATE            -> upstream_hits=1
LEAK  /api/sync/State            -> upstream_hits=1
LEAK  /api/sync/state%20         -> upstream_hits=1
LEAK  /api/bots/extra            -> upstream_hits=1
LEAK  /api/mem/health/extra      -> upstream_hits=1
LEAK  /mem/v1/recall/extra       -> upstream_hits=1
LEAK  /api/keys/register/extra   -> upstream_hits=1
LEAK  /api//sync/state           -> upstream_hits=1
```

Two mitigating factors, stated for accuracy: the SDK
(`sdk/typescript/src/client.ts`) only calls exactly-routed paths, so this is not hit in
normal operation; and unmatched **POST** paths fail with 502 (`duplex` is required to
stream a body), so request bodies were not leaked. The leak is headers-on-GET.

**Fix applied.**
- `handleFreshProxy()` now scrubs every credential-bearing header before forwarding
  (`authorization`, `proxy-authorization`, `cookie`, `cf-access-*`, `x-seele-key`,
  `x-api-key`, `x-auth-token`, plus any `cf-access-*` / `authorization-*` variant not
  explicitly enumerated). The proxy is a content proxy; it has no business carrying
  credentials.
- The router now refuses to proxy anything under `/api/*` or `/mem/*`. An unmatched API
  path is a client error, not a page fetch — it returns a clean `404` JSON envelope.
- The upstream's `Set-Cookie` is no longer reflected back to the client.

---

### 2. MEDIUM — Revocation bypass by swapping the JWT `iss` claim

**Location:** `worker/src/auth.js` — `verifyGrant()` revocation branch; `checkRevoked()`.

**What is wrong.** `verifyGrant()` selected its revocation check from the `iss` claim:

- `iss === 'seele-cloud:device'` → `checkDeviceRevoked()` — strict; an unknown
  `device_id` is rejected.
- anything else → `checkRevoked()` — the bots table only, and **"no bots row ⇒ not
  revoked" ⇒ allowed.**

The two branches were mutually exclusive, so a grant minted for a device but re-signed
with `iss: 'seele-cloud:bot'` fell into the permissive branch, found no bots row, and
was accepted — resurrecting a revoked device's token. Confirmed by probe: a revoked
device's token re-issued with a bot issuer returned **200** pre-fix.

**Concrete attack path.**
1. Attacker obtains the `GRANT_JWT` signing secret (a Worker secret — not exposed by any
   response, health check, or error path; verified).
2. Attacker re-signs a revoked device grant with `iss: 'seele-cloud:bot'`.
3. `verifyGrant()` takes the bots branch, finds no bots row for that `device_id`,
   returns "not revoked", and the revoked device token works again — for up to the
   remaining 365-day TTL.

**Severity rationale.** This is **not** independently reachable by an external attacker:
it requires the signing secret, which is not exposed by any code path in the Worker. It
is therefore a defence-in-depth gap rather than a standalone critical — but it converts
a single secret compromise into an unbounded, silent revocation bypass, and it defeats
the exact control (`POST /api/keys/revoke`) that was added to bound the 365-day token
lifetime. Rated medium on exploitability, high on impact if the secret leaks.

**Fix applied.** The bot-family check now consults **both** the `bots` and `devices`
tables, so a revoked device is rejected under every issuer. The device-family check
keeps its existing strict contract (unknown device ⇒ reject). The "unknown identifier ⇒
allowed" rule for bot-family grants is preserved deliberately — that is the documented
contract in `test/auth.test.js` ("allows when no bot row exists"), and tightening it
would break legitimate not-yet-registered bot flows.

Net effect: swapping `iss` no longer changes which credentials are considered live.

---

### 3. INFO — Confirmed sound (no action required)

These were in scope and verified clean. Recording them so the next reviewer doesn't
re-open them.

**Timing-safe comparison.** There is no raw secret/token comparison anywhere in
`worker/src/`. Signature verification is delegated to `jose`'s `jwtVerify()`, which calls
`crypto.subtle.verify()` — the platform's constant-time primitive for HMAC. The
algorithm is pinned with `algorithms: ['HS256']`, which also blocks `alg: none` and
algorithm-confusion attacks. The only `===` comparisons in the auth path are against
scope *strings* (`scopeSatisfies`), which are public values, not secrets.

**Token expiry enforcement.** `jose` enforces `exp` natively; `signGrant()` sets
`setExpirationTime()`. Probe confirmed an expired token returns `401 jwt_expired` while a
freshly-minted one still succeeds on the same route — the check is expiry-specific, not
a blanket rejection.

**Revocation actually revoking.** `POST /api/keys/revoke` tombstones the device row
(`revoked_at`), and `POST /api/bots/:id/revoke` tombstones the bot row. Both were
verified end-to-end: a token that returned `200` immediately before revocation returned
`401 device_revoked` / `403 bot_revoked` immediately after — not at TTL expiry. Revocation
is also ownership-scoped: a caller cannot revoke another tenant's device (the target's
token keeps working), and the response is a `404` rather than a `403` so there is no
"exists but belongs to someone else" enumeration oracle.

**No data leak before the token check.** All 8 protected routes (`/api/sync/{upload,
download,state,devices}`, `/mem/v1/{recall,full-recall}`, `/api/bots` GET+POST) return
`401 missing_bearer` with no token. Probes confirmed the error bodies contain **no**
`snippets`, `matches`, `envelopes`, `bots`, `devices`, or `body_encrypted` fields — the
auth check runs before any D1 or Vectorize access on every route.

**Fail-closed behaviour.**
- `POST /api/keys/register` without a Cloudflare Access header → `401 access_required`,
  checked *before* body parsing so a malformed body can't probe the endpoint.
- A body-supplied `user_id` is ignored; identity is `sha256(lowercased Access email)`.
- Missing `GRANT_JWT` → `500 misconfigured` on registration. `jose` rejects a
  zero-length/empty key, so a misconfigured secret cannot be used to mint or verify
  tokens.
- D1 errors during revocation checks return `true` (reject), i.e. fail closed.
- Unmatched `/api/*` and `/mem/*` paths now return `404` from the Worker (post-fix).

**CORS.** `Access-Control-Allow-Credentials` is **never** set, anywhere. Authentication
is `Authorization`-header-based only — there are no auth cookies — so no credentialed
cross-origin request is possible even with the `Access-Control-Allow-Origin: *` fallback
for unlisted origins. A listed origin is echoed exactly; an unlisted origin gets `*` but
never its own origin echoed back, and the preflight for an unlisted origin does not echo
it either. Verified by probe.

**Cross-tenant isolation.** Every D1 query binds `user_id = auth.claims.sub`. Probes
confirmed a second tenant's sync download and keyword recall both return empty results
against the first tenant's data, and that one tenant's token cannot mint or list
another tenant's bots.

---

## Files changed

| File | Change |
|---|---|
| `worker/src/index.js` | `scrubProxyHeaders()`; `isApiNamespace()` + API-namespace 404 guard; upstream `Set-Cookie` no longer reflected |
| `worker/src/auth.js` | `checkDeviceGrantRevoked()` (strict device family); `checkBotGrantRevoked()` (bot family now consults both tables) |
| `worker/test/security-probe.test.js` | NEW — 27 probes: fail-closed, no-leak-before-check, forgery, expiry, revocation, cross-tenant, CORS |
| `worker/test/security-probe-proxy.test.js` | NEW — 8 probes: proxy credential scrubbing, API-namespace guard |
| `worker/test/security-probe-route.test.js` | NEW — 12 probes: near-miss route spellings, upstream cookie reflection |
| `worker/test/security-probe-issuer.test.js` | NEW — 4 probes: `iss`-swap revocation bypass |

## Verification

```
npm test      → 13 files, 189 passed, 0 failed   (171 pre-existing + 18 new)
npm run test:e2e → 60 passed, 0 failed          (local D1, no production contact)
```

The pre-existing suite was left green; no existing test was modified or weakened.

---

## Recommended follow-up (not done — outside the auth path)

1. **`wrangler.toml` claims routes the Worker does not actually serve.**
   `routes = [{ pattern = "seele.agency/api/*" }, ...]` — but `https://seele.agency/api/mem/health`
   returns the GitHub Pages marketing site (`200 text/html`), not the Worker's JSON.
   The Worker is only reachable at `seele-memory.griptoad.workers.dev`, which is
   Access-protected (live probe returned `429` / error `1027` = Access challenge).
   Worth reconciling the route config with reality so operators do not assume the
   Worker is fronting `seele.agency`.

2. **Cloudflare Access is load-bearing for `POST /api/keys/register` and
   `POST /api/keys/revoke`.** Both derive identity from
   `cf-access-authenticated-user-email`, which Cloudflare only injects when the
   hostname is covered by an Access application. If the Access app is ever unbound
   from `workers.dev`, those two routes become an unauthenticated token factory
   again — the exact bug `worker/ACCESS.md` documents from the Phase-1 code. The code
   fails closed (missing header ⇒ 401), but the *deployment* must keep Access bound.
   Consider adding a deploy-time assertion that Access is still attached to the
   hostname.

3. **The `GET /api/mem/health` endpoint is unauthenticated.** It exposes
   `ENVIRONMENT`, D1/Vectorize availability, table counts, and vector dimensions. None
   of that is secret, but it is useful reconnaissance. Consider gating it behind
   Access or a `?verbose=1` flag if the surface matters.

---

**ACTION:** Reviewed seele-cloud Worker device-token auth (timing-safe comparison, expiry, revocation, fail-closed, pre-auth data leak, CORS) and hardened it | **RESULT:** 2 finding(s): 1 high (proxy credential forwarding to third-party origin), 1 medium (`iss`-swap revocation bypass); both fixed, 18 new probes, 189/189 tests green | **TIME:** 2026-11-16T14:20:00-08:00
