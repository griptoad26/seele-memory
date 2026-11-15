# API Stability Contract & Deprecation Policy — seele-cloud

**Contract version:** `v1.0.0`
**Applies to:** seele-cloud Worker, `service: "seele-cloud"`
**Last verified:** 2026-11-14
**Status:** Ratified for v1.0.0

---

## 0. What this document is

This is the public stability contract for the seele-cloud HTTP API. It
states, for every publicly-reachable endpoint:

- what the endpoint does and what shape its responses take,
- whether that shape is **stable**, **experimental**, or **unstable**,
- and what the deprecation/removal rules are if we ever have to change it.

The goal is that an SDK author can read this file, pin against it, and
know that a minor version bump of the Worker will not break their code
without at least a documented notice period.

### 0.1 Which deployment this describes

> **We checked the CURRENT DEPLOYED Worker, not the branch.**
>
> - Deployed URL: `https://seele-memory.griptoad.workers.dev`
> - Deployed `version` field (from `GET /api/mem/health`): **`0.2.0-phase2`**
> - Verified: 2026-11-14, by issuing live requests against the deployed
>   Worker and reading its actual response bodies.
> - Branch checked for reference: `main` @ `bff6d9d`
>   (`docs(worker): record that TASK-101 fix is pushed but NOT deployed`)
>
> **Branch and deployed Worker are NOT identical.** The branch contains
> `POST /api/keys/revoke` and migration `0003_device_revocation.sql`,
> neither of which is deployed. See §4 for the exact delta. The endpoint
> table below is annotated with a **Live** column so you can tell at a
> glance which routes exist in production today.

The zone-routed alias `https://seele.agency/api/*` is a *different*
Worker in front of the same origin (the `seele-fresh` cache-busting
proxy). Requests to `seele.agency/api/*` currently return the static
site HTML rather than API JSON, and `POST` returns `405`. **Use
`seele-memory.griptoad.workers.dev` for API traffic.** This is itself
an unstable surface and is called out in §3.

---

## 1. Versioning model

The Worker reports its version in the `version` field of every JSON
response body and in `GET /api/mem/health`.

| Version string | Meaning | Stability |
|---|---|---|
| `0.x.y` | Pre-1.0. Fields may be renamed or removed in any release. | Unstable |
| `1.0.0` | First stable release. The contract in this document applies. | Stable (as marked) |
| `1.x.y` | Additive-only minor releases. No breaking changes. | Stable |
| `2.0.0` | Breaking changes permitted. Requires the §5 notice period. | Major bump |

`phase` is a separate, non-semantic field (`"phase": 2`) that tracks
internal delivery milestones. **It carries no API guarantees and may
change in any release, including patch releases.** Do not branch logic
on it.

---

## 2. Endpoint inventory

Legend for the **Stability** column:

- **Stable** — shape is guaranteed for the stated version window.
- **Experimental** — shape may change in a minor release, but the
  endpoint will not be removed without a deprecation notice.
- **Unstable** — no guarantees at all. May change or vanish in any
  release, including patch.

### 2.1 Public API — Stable

| Method | Path | Auth | Success shape | Stability |
|---|---|---|---|---|
| `GET` | `/api/mem/health` | none | `{ok, service, version, phase, environment, checks:{d1:{ok,latency_ms,tables},vectorize:{ok,latency_ms,dimensions}}, last_reindex_at, timestamp}` | **Stable** |
| `GET` | `/health` | none | identical to `/api/mem/health` (alias) | **Stable** |
| `POST` | `/api/keys/register` | CF Access identity | `{user_id, device_id, device_token, token_type:"Bearer", expires_at, scope}` | **Stable** |
| `POST` | `/api/bots` | Bearer grant (`memory:write`) | `{bot_id, user_id, name, scope_tags, grant:{jwt,expires_at,scope}, private_key, public_key, warning}` | **Stable** |
| `GET` | `/api/bots` | Bearer grant | `{bots:[{bot_id,name,scope_tags,created_at,revoked_at}]}` | **Stable** |
| `POST` | `/api/bots/{bot_id}/revoke` | Bearer grant (`memory:write`) | `{bot_id, revoked_at}` | **Stable** |
| `POST` | `/api/sync/upload` | Bearer grant (`memory:write`) | `{accepted:true, conversation_id, chunks_inserted, chunks_deduped, chunks_indexed}` | **Stable** |
| `POST` | `/api/sync/download` | Bearer grant (`memory:read`/`memory:write`) | `{envelopes:[...], next_cursor}` | **Stable** |
| `GET` | `/api/sync/devices` | Bearer grant | `{devices:[{device_id,name,platform,app_version,last_seen_at,subkey_id}]}` | **Stable** |
| `GET` | `/api/sync/state` | Bearer grant | `{...}` per-device watermark + counts | **Stable** |
| `POST` | `/mem/v1/recall` | Bearer grant (`memory:recall`/`memory:write`) | `{snippets:[...], query_id}` | **Stable** |

### 2.2 Public API — Experimental
| Method | Path | Notes | Stability |
|---|---|---|---|
| `POST` | `/mem/v1/full-recall` | Keyword/D1-LIKE recall path. Response `{matches:[...], query_id}`. Deliberately parallel to `/mem/v1/recall` but bypasses Vectorize. | **Experimental** |
| `GET` | `/api/mem/health` `→ x-seele-version` header | Response header carrying the deployed version string (live-verified: `0.2.0-phase2`). Exposed via `access-control-expose-headers`. | **Stable** header name, **Unstable** value |
| `POST` | `/api/keys/revoke` | Present on `main`, **not deployed** (see §4). Response `{ok, user_id, device_id, revoked_at}`. | **Experimental** |

### 2.3 A note on the recall path

The task brief referenced `/api/mem/v1/recall`. **That path does not
exist.** The deployed route is **`/mem/v1/recall`** (no `/api` prefix).
We probed both against the live Worker:

| Path | Deployed result |
|---|---|
| `/mem/v1/recall` | `401 {"error":"missing_bearer",...}` — the real route |
| `/api/mem/v1/recall` | `404` with an HTML body — unknown route, falls through to the origin proxy |

The `/api/mem/*` prefix is used only by `/api/mem/health`. Recall lives
under `/mem/v1/` so that the `v1` segment sits directly above the
versioned recall operation. We have documented the **actual deployed
path** here; the brief's path was a typo.

### 2.4 Explicitly unstable

| Surface | Why unstable | Stability |
|---|---|---|
| `https://seele.agency/api/*` and `https://seele.agency/mem/*` | Zone-routed path currently serves static HTML; `POST` → `405`. Behaviour is a proxy artifact, not an API contract. | **Unstable** — use the `workers.dev` origin |
| `/api/mem/health` → `phase`, `environment`, `checks.*`, `last_reindex_at` | Operational/diagnostic fields. Useful for monitoring but not part of the functional contract. | **Unstable** |
| `version` field value itself | Changes with every release by design. Parse it, but never branch on its value beyond checking the major. | **Unstable** |
| Error `message` strings | Human-readable, not machine-readable. **Branch on `error`, never on `message`.** | **Unstable** |
| `private_key` in `POST /api/bots` response | Present exactly once, at mint time. The value is stable; the *fact that it is re-returned* is not — a re-mint returns a new key. | **Stable value** |

### 2.5 Response envelope conventions

**Success** — a bare JSON object with the endpoint-specific fields. There
is no `{ok:true, data:{...}}` wrapper. The `ok` key appears on `/health`
only.

**Error** — a JSON object with **exactly two guaranteed fields**:

```json
{ "error": "<machine_code>", "message": "<human_readable>" }
```

`error` is a stable machine code. The set of codes is part of the
contract; `message` is not (see §2.4).

Current error codes:

| `error` | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed or missing request body/field. |
| `schema_error` | 400 | Body parsed but failed envelope validation. |
| `missing_bearer` | 401 | No `Authorization: Bearer <grant_jwt>` header. *(live-verified)* |
| `jwt_invalid` | 401 | Bearer token is not a parseable Compact JWS. *(live-verified)* |
| `bad_signature` | 401 | Signature verification failed. *(live-verified)* |
| `invalid_claims` | 401 | Grant JWT claims are missing or malformed. |
| `missing_sub` | 401 | Grant JWT has no `sub`. |
| `missing_bot_id` | 401 | Grant JWT has no `bot_id`. |
| `invalid_scope` | 403 | Grant lacks the required scope. |
| `user_mismatch` | 403 | Token `sub` does not match the caller's identity. |
| `not_your_bot` | 403 | Bot belongs to a different user. |
| `not_found` | 404 | Resource does not exist or is not visible to the caller. |
| `access_required` | 401/403 | Cloudflare Access identity missing or rejected. |
| `misconfigured` | 500 | Worker binding/secret is not provisioned. |
| `origin_unreachable` | 502 | Upstream origin (the `/fresh/*` proxy) is unreachable. |
| `vectorize_error` | 500 | Semantic index query failed. |
| `db_error` | 500 | D1 failure. |
| `crypto_error` | 500 | Keypair generation/derivation failed. |
| `sign_error` | 500 | JWT signing failed. |
| `internal_error` | 500 | Unclassified failure. |

Codes marked *(live-verified)* were observed in actual responses from
the deployed Worker on 2026-11-14. The rest were read from the branch
source and may differ in detail; treat the live-verified set as
authoritative for the codes it covers.

---

## 3. Stable vs experimental vs unstable — summary

**Stable** means: within the `1.x` line, the response *field names*,
their *types*, and their *presence* will not change. We may add new
optional fields, and we may add new endpoints, but we will not remove
or rename a field, and will not change a field's type.

**Experimental** means: the endpoint exists and works, but the shape may
be revised in a minor release. We will announce changes in the
changelog and via response headers, but we do not owe a notice period
on the shape itself. We will not remove an experimental endpoint
without at least the §5 minimum notice.

**Unstable** means: no guarantees. These may change in any release,
including a patch release, without any announcement. Treat them as
diagnostic surface only.

Two surfaces deserve special emphasis:

1. **`/api/keys/revoke` is experimental and currently undeployed.**
   The revocation capability is a security control and we intend to
   stabilise it; but until it is deployed and exercised in production,
   pinning to it would be pinning to something that 405s.
2. **The `seele.agency` zone path is unstable.** It is not the API
   origin. Use `seele-memory.griptoad.workers.dev`.

---

## 4. Branch vs deployed delta (as of 2026-11-14)

`main` is ahead of production. If you are reading `main` as the source
of truth, you are reading a **future** API.

| Change | On `main` | Deployed | Impact |
|---|---|---|---|
| `POST /api/keys/revoke` | ✅ present | ❌ **405** | Endpoint unusable in production. |
| `devices.revoked_at` column | ✅ migration `0003_device_revocation.sql` | ❌ not applied | Schema differs. |
| `auth.js` fail-closed device registration | ✅ | ❌ | Deployment is the older, more permissive build. |
| `encrypted_chunks.client_msg_id` | ✅ migration `0002` | ✅ applied | Schema for sync dedupe is live. |
| `encrypted_chunks.device_id` | ✅ migration `0002` | ✅ applied | Per-device cursors + device-aware recall are live. |
| `encrypted_chunks.vector_id` | ✅ migration `0002` | ✅ applied | Vectorize row lookup is live. |
| `idx_chunks_dedupe` unique index | ✅ migration `0002` | ✅ applied | Dedupe contract enforced. |

### 4.1 The `encrypted_chunks` field rename (breaking, already shipped)

This is the one response-shape change that has **already** landed, and
it is the canonical example of what this policy is for.

Migration `0002_alter_encrypted_chunks.sql` added three columns to
`encrypted_chunks` and a unique index:

| Column | Type | Purpose |
|---|---|---|
| `client_msg_id` | `TEXT` | Caller-supplied dedupe key from the sync envelope. |
| `device_id` | `TEXT` | Originating device; drives per-device cursors + device-aware recall. |
| `vector_id` | `TEXT` | Opaque handle to the matching Vectorize row (the embedding vector itself is never stored in D1). |

Plus:

```sql
CREATE UNIQUE INDEX idx_chunks_dedupe
  ON encrypted_chunks(user_id, conversation_id, client_msg_id);
CREATE INDEX idx_chunks_device
  ON encrypted_chunks(user_id, device_id, created_at);
```

**Why this was breaking:** `0001_initial.sql` defined
`encrypted_chunks` without these columns, but the sync envelope paths
already referenced them. The mismatch only surfaced on the first real
upload against the live DB — the local fake-D1 test harness is
permissive about column gaps, so the unit tests were green while
production was not. The schema moved under the API with no version
signal, which is precisely what this document exists to prevent
happening again.

**How it will not happen again:** any future additive-column migration
that changes a *response* field must ship together with (a) a `1.y.0`
version bump, (b) a `Deprecation:`/`Sunset:` header or an explicit
`/api/v1`-style alias, and (c) a changelog entry. Schema-only
migrations that do not alter a response shape continue to be applied
independently.

---

## 5. Deprecation policy

### 5.1 Minimum notice period

| Change class | Minimum notice | Mechanism |
|---|---|---|
| Removing a **stable** endpoint | **90 days** | `Deprecation` + `Sunset` headers on every response from that endpoint, changelog entry, and a notice in this document. |
| Removing a stable **response field** | **90 days** | Same as above, plus the field is made nullable for the whole grace period (never removed before the field itself). |
| Renaming a stable field | **180 days** | Old and new names are both present and populated for the full period. The old name is marked deprecated in the changelog. |
| Changing a stable field's **type** | **180 days** | New field is added alongside (e.g. `expires_at` → `expires_at_ms`); old field retained. |
| Changing an **experimental** shape | **30 days** | Changelog entry. Response headers may carry `Warning`. |
| Removing an **experimental** endpoint | **30 days** | Changelog entry + `Deprecation`/`Sunset` headers. |
| Changing an **unstable** surface | **none** | May change in any release. |

A grace period is the *minimum*. We will give more where a migration
path is non-trivial.

### 5.2 How deprecations are communicated

All four channels are used, in this order of reliability:

1. **Response headers** — on every response from a deprecated endpoint:
   ```http
   Deprecation: true
   Sunset: Wed, 21 Jan 2027 00:00:00 GMT
   Link: <https://seele-memory.griptoad.workers.dev/docs/API-STABILITY.md>; rel="deprecation"
   ```
   `Sunset` is the **HTTP-date at which the endpoint stops working**.
   `Deprecation` is the literal string `true` per RFC 8594.
2. **The changelog** — a `CHANGELOG.md` entry under a `### Deprecated`
   heading, naming the endpoint, the replacement, and the sunset date.
3. **This document** — a `## Deprecated` section listing every
   currently-deprecated endpoint, its replacement, and its sunset date.
4. **The release notes** — published with each version bump.

### 5.3 What removal looks like

When the sunset date passes, the deprecated endpoint is **removed**, not
soft-deprecated. We do not leave dead routes returning `410` indefinitely
— once the grace period is over, the route stops being routed:

- Requests receive the platform's default `404` for an unrouted path.
- The changelog records the removal with the date it happened.
- This document's `## Deprecated` section moves the entry to a
  `## Removed` section with the actual removal date.

During the grace period, deprecated endpoints continue to function
normally. A deprecated endpoint is never made to fail early — that
would turn a notice period into an outage.

### 5.4 Grace period behaviour during deprecation

- The endpoint continues to return its normal, documented responses.
- The response shape is frozen. No new fields are added to a deprecated
  endpoint, so that "the thing you depend on" stays predictable.
- The replacement endpoint, if any, is documented in the same changelog
  entry and in the `Link` header's `rel="deprecation"` target.

### 5.5 Compatibility guarantees for a stable response

Within the `1.x` line:

- **Fields are never removed** before the 90-day notice.
- **Field types never change** before the 180-day notice.
- **New fields may be added** at any time. Consumers **must** ignore
  unknown fields. This is the one way we can extend the API without
  breaking anyone, and it is why every client in the SDK must be
  written to tolerate unknown keys.
- **Enum-like values may be added.** A field documented as "one of A, B,
  C" may later contain D. Consumers must handle unknown values
  gracefully rather than erroring.
- **Error `message` text is explicitly excluded** from all guarantees.

---

## 6. Current status summary

**As of 2026-11-14, against the deployed Worker (`0.2.0-phase2`):**

- 11 endpoints are **stable** and live.
- 1 endpoint (`/api/keys/revoke`) is **experimental** and **not yet
  deployed** — it returns `405` in production.
- 1 endpoint (`/mem/v1/full-recall`) is **experimental** and live.
- The `seele.agency` zone alias is **unstable** and currently does not
  serve the API.
- The `encrypted_chunks` schema change from migration `0002` has
  **already** been applied to production and is documented in §4.1.

## 7. Reviewing this document

This contract is reviewed whenever a response shape changes, and at
minimum once per major version. If you find an endpoint that is not
listed here, or a listed endpoint whose live shape differs from the
table above, please open an issue — that is a bug in this document, and
the table must be corrected.
