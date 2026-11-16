# Changelog

All notable changes to **seele-memory** (the seele-cloud Worker, the
`@seele/memory-client` SDK, and the supporting tooling) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

Nothing yet.

---

## [1.0.0] — 2026-11-16

First published release of seele-cloud. This release marks the point at which
the Worker, the D1 schema, the Vectorize index, the recall contract, and the
TypeScript SDK are all versioned together and can be pinned by a consumer.

**Release artifacts**

- Git tag: `v1.0.0` on `main`
- Worker endpoint: `https://seele-memory.griptoad.workers.dev`
- SDK: `@seele/memory-client` on npm

**Deployment**

The Worker serving this release is published with a single command:

```bash
./scripts/release.sh
```

That script is the documented path for `wrangler deploy`, the D1 migration
apply, and the Vectorize reindex. See [`docs/release.md`](./docs/release.md)
for the full procedure, the credential requirements, and the verification
steps.

> [!IMPORTANT]
> **As of the v1.0.0 tag, the production Worker still runs the 2026-10-20
> deployment.** The commits below are merged but not live, because the
> Cloudflare API token available to this repository lacks the D1 and
> Workers-write scopes. The token can read Workers metadata but every
> write attempt fails with `No access to the specified resource` (Workers)
> or `Authentication error [code: 10000]` (D1, Vectorize).
>
> Concretely, this means the production endpoint is **missing**:
> - the `devices` unique-index repair — every conversation upload still
>   fails with `D1_ERROR: foreign key mismatch` (fixed in `b97f9f2`);
> - fail-closed device registration — the live endpoint still mints a
>   365-day token for any caller-chosen `user_id` (fixed in `75fbe14`);
> - the locked v1.0.0 recall response contract (added in `d257b1b`).
>
> See [`worker/ACCESS.md`](./worker/ACCESS.md) §"NOT DEPLOYED" for the
> credential fix and the exact commands.

### Added — Worker

- **Phase 1 Worker skeleton** — Cloudflare Worker (`seele-memory`) with D1
  and Vectorize bindings, deployed alongside the co-resident `seele-fresh`
  cache-busting proxy so one Worker serves both `/api/*`, `/mem/*` and
  `/fresh/*`. (`4ca0128`, `390ac84`, `7a5f2aa`)
- **Recall API** — `POST /mem/v1/recall` (vector + keyword paths),
  `POST /mem/v1/full-recall` (keyword-only, no-vector fallback), and
  `GET /api/mem/health`. The server stores ciphertext and vectors only; it
  never sees plaintext. (`096a7d8`)
- **Bot grants** — `POST /api/bots` creates a scoped keypair, `GET
  /api/bots/{bot_id}` returns its manifest, `DELETE /api/bots/{bot_id}`
  revokes it. Bots receive short-lived grant JWTs and call recall with
  their own scope set. (`096a7d8`)
- **Sync endpoints** — `POST /api/sync/{devices,upload,download,state}`
  speaking the shared SyncEnvelope contract used by `cluster-hub` and the
  local sync target. Dedupe is enforced at
  `(user_id, conversation_id, client_msg_id)`; re-uploading the same
  envelope is a no-op. (`096a7d8`)
- **Device revocation** — `POST /api/keys/revoke` tombstones a device
  rather than deleting it, because `conversations` carries a composite
  foreign key to `devices` and deleting the row would either be rejected
  or take the user's sync history with it. (`75fbe14`)
- **Lockdown of anonymous token minting** — device registration now fails
  closed. Previously any unauthenticated caller could
  `POST /api/keys/register {"user_id": "<anything>"}` and receive a valid
  365-day token, which let anyone impersonate any user. (`75fbe14`)
- **Recall response contract, locked to v1.0.0** — the `Snippet` object
  has exactly five keys (`chunk_id`, `score`, `conversation_id`,
  `created_at`, `body_encrypted`) and the top level is exactly
  `{ snippets, query_id }` / `{ matches, query_id }`. Both are
  machine-checked by tests on the server and the client side, so a field
  rename fails CI instead of failing in production. (`d257b1b`)

### Added — SDK

- **`@seele/memory-client` v0.1.0** — browser-first TypeScript client.
  BIP-39 recovery phrase → Ed25519 master key + AES-256-GCM content key,
  derived entirely client-side. Ships a `SeeleCloudClient`, bot session
  management (`openBot`), and recall with local decryption. (`a6f6257`)

### Fixed

- **Composite-FK schema gaps** — `encrypted_chunks` was missing
  `client_msg_id`, `device_id` and `vector_id`, and the dedupe unique
  index the spec required was never declared. Migration `0002` closes
  both. (`ac16945`)
- **Malformed composite foreign key** — `migrations/0001_initial.sql`
  created `FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id,
  device_id)` alongside a *non-unique* index of the same name. SQLite
  requires the parent key of a composite FK to be covered by a UNIQUE
  index, so it parsed the FK as malformed and refused **every** insert
  into `conversations`:

  ```
  D1_ERROR: foreign key mismatch - "conversations" referencing "devices"
  ```

  The sync write path was 100% broken, not intermittent — seele-cloud had
  never persisted a conversation in production. Migration `0004` drops the
  index and recreates it as UNIQUE; `ensureSchema()` in `src/db.js` was
  also corrected to `DROP INDEX` before `CREATE UNIQUE INDEX`, because
  `CREATE UNIQUE INDEX IF NOT EXISTS` silently skips when a non-unique
  index of the same name already exists. (`e662c25`, `b97f9f2`)

### Changed

- **Schema-guard self-healing** — `ensureSchema()` runs at the start of
  every upload and repairs the devices index in place, so deploying the
  Worker is sufficient to restore the sync path even on a database that
  predates migration `0004`. (`b97f9f2`)
- **CI hardening** — the Worker suite pins Node 22 (`node:sqlite` requires
  22.5+) and now runs on task/feature branch pushes as well as `main`.
  (`f1ba996`, `eba3f18`)
- **Self-hosting docs** — `docs/self-host.md` rewritten from "we built
  this" to a third-party zero-to-running guide. (`e0db440`)

### Known limitations

These are real, documented, and **not** fixed by this release. They are
listed here so a consumer can decide whether v1.0.0 meets their needs.

- **🔴 The production Worker is not running this release.** See the
  IMPORTANT callout above. Deploy with `./scripts/release.sh` once a token
  with D1-edit and Workers-write scopes is available.
- **🔴 Vectorize holds stub embeddings.** The SDK's default
  `hashEmbedder384()` produces shape-correct but *not semantically
  meaningful* 384-dim vectors. Vectors already written to the Vectorize
  index were produced by that stub (or by the equivalent deterministic
  hash embedder in `xkg-core`), so semantic recall quality is currently
  near-noise. A consumer must register a real embedder — see
  [`docs/embedding.md`](./docs/embedding.md) — and the index must be
  reindexed. `./scripts/release.sh` performs the reindex.
- **🟡 Cross-implementation embedder mismatch.** `xkg-core` computes a
  deterministic hash embedder in v0.10.0 and does not run ONNX, so
  captures made on the Rust desktop client do not align semantically with
  a bot's ONNX-side queries. Aligning the Rust embedder is v0.11.0 work.
- **🟡 `seele.agency/api/mem/health` is shadowed by GitHub Pages.** The
  custom-domain route returns the Pages HTML site rather than the
  Worker's JSON health payload. The reliable health endpoint is
  `https://seele-memory.griptoad.workers.dev/api/mem/health`.
- **🟡 `LAST_REINDEX_AT` is only a static var.** It is set by the reindex
  step and reported by the health endpoint, but it is not updated
  automatically by a scheduled job.

### Verification

- `npm test` (worker) — full vitest suite, including the `node:sqlite`
  real-SQLite regression test for the composite-FK defect that the
  permissive FakeD1 harness cannot reproduce.
- `npm run test:e2e` — local, repeatable 3-device sync suite against a
  local D1. It can never contact production.
- `node test/e2e_multidevice_sync.mjs --base https://... --devices 3
  --i-understand-this-writes-to-production` — the one-shot manual
  production probe. It writes real rows and refuses to run without the
  explicit opt-in flag.

---

## [0.2.0-phase2] — 2026-10-20

The last version actually deployed to production.

- Recall API, bot grants, sync endpoints, and the co-resident `seele-fresh`
  proxy were published to `seele-memory.griptoad.workers.dev`.
- The `devices` unique-index defect was **not yet fixed** — the sync write
  path was broken from this deployment onward.

---

## [0.1.0] — 2026-10-19

- `SPEC.md` v0.1 (draft) merged.
- Phase 1 Worker skeleton with D1 + Vectorize bindings and migration
  `0001_initial.sql`.
- npm publish workflow for `@seele/memory-client`.

[Unreleased]: https://github.com/griptoad26/seele-memory/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/griptoad26/seele-memory/compare/v0.2.0-phase2...v1.0.0
[0.2.0-phase2]: https://github.com/griptoad26/seele-memory/compare/v0.1.0...v0.2.0-phase2
[0.1.0]: https://github.com/griptoad26/seele-memory/releases/tag/v0.1.0
