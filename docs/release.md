# Releasing seele-cloud

**This is the procedure for publishing a seele-cloud release.** It is the
single repeatable path from "code on disk" to "a tagged, deployed, reindexed
release a consumer can pin."

The executable version of this document is [`../scripts/release.sh`](../scripts/release.sh).
Everything below is what that script does and why.

---

## TL;DR

```bash
export CLOUDFLARE_API_TOKEN=<token with D1 + Vectorize + Workers-write>
export CLOUDFLARE_ACCOUNT_ID=4240b199ca30d185e7954e6166582e7c

./scripts/release.sh --version 1.0.0
git push origin v1.0.0
```

The script refuses to publish if the tree is dirty, if the version in
`worker/src/index.js` disagrees with `--version`, if `CHANGELOG.md` has no
matching section, if the test suite fails, if the token is missing a scope,
or if the live endpoint does not report the version it just deployed.

---

## 1. Prerequisites

### Credentials

The Cloudflare API token must have all three of these permissions:

| Permission | Why |
|---|---|
| Account → **Workers Scripts → Edit** | `wrangler deploy` |
| Account → **D1 → Edit** | `wrangler d1 migrations apply --remote` |
| Account → **Vectorize → Edit** | the reindex (`list-vectors`, `get-vectors`, `delete-vectors`, `upsert`) |

Set it in the environment:

```bash
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_ACCOUNT_ID=4240b199ca30d185e7954e6166582e7c
```

Or put the bare token on the first line of `~/.cloudflare-credentials` and the
account id on the second — the script reads that file when the environment
variable is unset.

> [!WARNING]
> **The token currently in `~/.cloudflare-credentials` is read-only.** It
> authenticates and can list Workers metadata, but every write fails:
> Workers with `No access to the specified resource`, D1 and Vectorize with
> `Authentication error [code: 10000]`. The release script probes all three
> scopes up front and tells you exactly which ones are missing, instead of
> failing halfway through a deploy.

### Local tooling

```bash
cd worker && npm ci
```

Node 22.5+ is required — the composite-FK regression test uses `node:sqlite`.

---

## 2. What the script does

### Step 1 — verify

- The working tree must be clean.
- `worker/src/index.js`'s `VERSION` must equal the `--version` argument.
- `CHANGELOG.md` must contain a `## [<version>]` section.
- `npm test` (the worker vitest suite) must pass.
- `npm run test:e2e` (the local 3-device sync suite) must pass.

The e2e suite runs against a **local** D1 and can never contact production.
The production probe is a separate script and requires an explicit opt-in
flag.

### Step 2 — D1 migrations

```bash
npx wrangler d1 migrations apply seele-memory-db --remote
```

Applies `worker/migrations/*.sql` in order:

| Migration | What it does |
|---|---|
| `0001_initial.sql` | Base schema: `users`, `devices`, `conversations`, `encrypted_chunks`, `bots` |
| `0002_alter_encrypted_chunks.sql` | Adds `client_msg_id`, `device_id`, `vector_id`; adds the dedupe unique index |
| `0003_device_revocation.sql` | Adds `devices.revoked_at` + the active-devices index |
| `0004_fix_devices_unique_index.sql` | **Drops and recreates `idx_devices_user_device` as UNIQUE** — the fix for the defect that broke every upload in production |

> [!IMPORTANT]
> `0004` is the one that matters. Without it, `POST /api/sync/upload` fails
> with
> `D1_ERROR: foreign key mismatch - "conversations" referencing "devices"`
> on **100% of uploads**. The Worker can also self-heal this at runtime
> (`ensureSchema()` in `src/db.js` drops the index before recreating it),
> so deploying is sufficient — but applying the migration is the correct
> and recommended path, because the runtime repair costs a schema probe on
> the first upload of every cold start.

### Step 3 — deploy

```bash
npx wrangler deploy --message "Release 1.0.0"
```

### Step 4 — Vectorize reindex

See [§ Reindexing](#3-reindexing-the-vectorize-index) below.

The script also stamps `LAST_REINDEX_AT` (a plain var in `wrangler.toml`)
with the UTC timestamp of the reindex and re-deploys with it, so the health
endpoint reports when the index was last rebuilt.

### Step 5 — verify live

- `GET https://seele-memory.griptoad.workers.dev/api/mem/health` must return
  HTTP 200 with `version` equal to the released version.
- `POST /api/sync/upload` is probed with an invalid token. It must return
  **401**, not **500**. A 500 means the D1 schema is still broken.

### Step 6 — tag

```bash
git tag -s v1.0.0 -m "seele-cloud v1.0.0"   # signed, if a GPG key is configured
git tag -a v1.0.0 -m "seele-cloud v1.0.0"   # otherwise: annotated, not signed
git push origin v1.0.0
```

The script creates a **signed** tag when `git config user.signingkey` is set
and a **plain annotated** tag otherwise. It never blocks a release on a
missing GPG setup, but it tells you which one you got.

---

## 3. Reindexing the Vectorize index

### Why the reindex is awkward

**The server cannot re-embed.** This is not a limitation of the current
implementation — it is the design. The Worker holds ciphertext and vectors;
the plaintext exists only on a device that holds the BIP-39-derived content
key. So there is no server-side job that can take a stored chunk and
compute a better embedding for it.

The consequence is that the vectors already sitting in the Vectorize index
were produced by whichever embedder the uploading client used:

- the SDK's default `hashEmbedder384()` — shape-correct (384 dims,
  L2-normalized) but **not semantically meaningful**;
- `xkg-core`'s equivalent deterministic hash embedder — same situation.

So the current index holds vectors whose cosine similarity carries no
semantic information. Semantic recall against it returns near-noise.

### What the reindex script does

`./scripts/release.sh --reindex-only`:

1. Lists the vector ids in `seele-memory-embeddings`.
2. Reads the vectors back with `wrangler vectorize get-vectors`.
3. Deletes them (`wrangler vectorize delete-vectors`).
4. Re-uploads them under the same ids (`wrangler vectorize upsert`).

This **preserves the id↔chunk mapping** — the ids are chunk ids — while
making the stub problem explicit and, more importantly, giving you a clean
index to rebuild from.

> [!WARNING]
> The delete is destructive by design, and the corpus is briefly
> unrecallable between steps 3 and 4. Pass `--no-destructive-reindex` to
> skip the delete and leave the stub vectors in place.

### Rebuilding with a real embedder

The actual semantic rebuild is a **client-side** operation, because only
the client can decrypt:

1. Open a client session with the recovery phrase.
2. Enumerate the user's chunks.
3. Decrypt each `body_encrypted` locally with the content key.
4. Embed the plaintext with a real model (see [`embedding.md`](./embedding.md)).
5. Upsert the new vectors under the original chunk ids.

Until that runs, semantic recall is degraded. The keyword path
(`POST /mem/v1/full-recall`) is unaffected and still works.

### Making the reindex reproducible

The vectors are not stored in D1 in float form — `encrypted_chunks.embedding`
is an opaque byte blob for keyword joins, and the float vector only ever
existed in the original upload envelope and in Vectorize. That is what
makes the reindex client-side.

If you want the reindex to be automatic in future, the natural change is to
persist the float vector in D1 alongside the chunk (it is not plaintext — it
is a vector of a plaintext, which the server already has by design). That
is a schema change and out of scope for v1.0.0.

---

## 4. Running the steps by hand

If you prefer not to use the script, the equivalent commands are:

```bash
cd worker

# 1. verify
npm ci
npm test
npm run test:e2e

# 2. migrate
npx wrangler d1 migrations apply seele-memory-db --remote

# 3. deploy
npx wrangler deploy --message "Release 1.0.0"

# 4. reindex
#    list-vectors emits JSON (--json); get-vectors emits NDJSON, which is
#    exactly what upsert --file consumes, so it pipes straight through.
npx wrangler vectorize list-vectors seele-memory-embeddings --count 1000 --json
npx wrangler vectorize get-vectors seele-memory-embeddings --ids <id> <id> ... > vectors.ndjson
npx wrangler vectorize delete-vectors seele-memory-embeddings --ids <id> <id> ...
npx wrangler vectorize upsert seele-memory-embeddings --file vectors.ndjson

# 5. verify
curl -sS https://seele-memory.griptoad.workers.dev/api/mem/health | jq
node test/e2e_multidevice_sync.mjs \
  --base https://seele-memory.griptoad.workers.dev --devices 3 \
  --i-understand-this-writes-to-production

# 6. tag
git tag -s v1.0.0 -m "seele-cloud v1.0.0"
git push origin v1.0.0
```

---

## 5. After the release

- **Publish the SDK** if its version changed:
  `npm publish --workspace @seele/memory-client` from the repo root.
  The SDK is currently at `0.1.0` and is versioned independently of the
  Worker.
- **Update `CHANGELOG.md`**'s `## [Unreleased]` section as work lands.
- **Push the tag** — the script only creates it locally.

---

## 6. Troubleshooting

**`Cannot publish with the current token`**
The token is missing a scope. The script names which one. Fix it at
<https://dash.cloudflare.com/profile/api-tokens>.

**`health endpoint returned HTTP 429`**
Cloudflare is rate-limiting the host you're releasing from. Wait and retry.
This is not a deploy failure.

**`Live Worker reports version 'X', expected 'Y'`**
Either the deploy did not take effect, or you are hitting
`seele.agency` (which is shadowed by GitHub Pages and returns HTML).
The reliable endpoint is `seele-memory.griptoad.workers.dev`.

**`sync upload returned 500`**
The D1 schema is still broken. Apply the migrations:
`npx wrangler d1 migrations apply seele-memory-db --remote`.

**`Version mismatch: worker/src/index.js says 'X', release says 'Y'`**
Edit `VERSION` in `worker/src/index.js` to match. It is the value the
health endpoint and the `x-seele-version` header report.

---

## See also

- [`../CHANGELOG.md`](../CHANGELOG.md) — what shipped in each release
- [`../SPEC.md`](../SPEC.md) — the protocol contract
- [`embedding.md`](./embedding.md) — swapping the stub embedder for a real one
- [`../worker/ACCESS.md`](../worker/ACCESS.md) — Cloudflare Access setup and the credential history
- [`../worker/README.md`](../worker/README.md) — the Worker's own runbook
