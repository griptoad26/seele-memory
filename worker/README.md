# seele-cloud Worker

Cloudflare Worker implementing the seele-cloud memory backend. See
[../SPEC.md](../SPEC.md) for the full contract.

## Two co-resident responsibilities

| Mount | Role |
|-------|------|
| `/api/mem/health` | Phase 1 acceptance criterion — reports D1 + Vectorize readiness |
| `/api/keys/register`, `/api/bots*`, `/api/sync/*`, `/mem/v1/*` | Phase 2+ surface — full sync, recall, bot-grant API |
| `/fresh/*`, everything else | seele-fresh cache-busting proxy (carried over from `devops-agent/drafts/cf-worker/seele-fresh`); preserves `seele.agency`'s static GitHub Pages behavior |

## Routes (current)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/keys/register` | none | First-time device registration. Returns `device_id` + long-lived device token (JWT, 365d, scope=memory:write). |
| POST | `/api/bots` | Bearer (memory:write) | Create a bot. Returns bot_id, grant JWT (15m default), scope_tags, private_key (Ed25519 PKCS8, returned once). |
| GET | `/api/bots` | Bearer (memory:write) | List the caller's bots. |
| POST | `/api/bots/:id/revoke` | Bearer (memory:write) | Revoke a bot. Subsequent grant JWTs for this bot fail with `bot_revoked`. |
| POST | `/mem/v1/recall` | Bearer (memory:recall or write) | Vector top-K recall. Body: `{query_vector: number[384], top_k?, since?}`. Returns encrypted snippets. |
| POST | `/mem/v1/full-recall` | Bearer (memory:recall or write) | Keyword scan fallback (D1 LIKE on chunk_id). Body: `{query, limit?, since?}`. Returns encrypted snippets. |
| POST | `/api/sync/upload` | Bearer (memory:write) | Ingest one xkg-core SyncEnvelope. Dedupe on `(user_id, conversation_id, client_msg_id)`. Embedding upserted to Vectorize. |
| POST | `/api/sync/download` | Bearer (memory:recall or write) | Get envelopes since a cursor. Body: `{since?, limit?}`. |
| GET | `/api/sync/state` | Bearer (memory:recall or write) | Per-device sync watermark. Query: `?device_id=`. |
| GET | `/api/sync/devices` | Bearer (memory:recall or write) | List the caller's devices. |

All authenticated routes accept either a device grant (issuer=`seele-cloud:device`,
bot_id=device_id, 365d) or a bot grant (issuer=`seele-cloud:bot`, bot_id=row id,
≤24h). Both share the same `Bearer <jwt>` shape and JWT secret.

## Bindings (wrangler.toml)

| Binding | Type | Resource |
|---------|------|----------|
| `DB` | D1 | `seele-memory-db` |
| `VECTORIZE` | Vectorize | `seele-memory-embeddings` (384 dims, cosine) |
| `GRANT_JWT` | secret | HS256 secret for all grant JWTs. **Set via `wrangler secret put GRANT_JWT`** — never check it in. |

## Privacy model — Option D (E2EE / Sovereign)

This Worker is **stateless with respect to plaintext**. It stores:

- **Ciphertext blobs** in `encrypted_chunks.body_encrypted` (AES-256-GCM
  ciphertext, base64).
- **Embeddings** in Vectorize (`seele-memory-embeddings`, 384d cosine).
  Embeddings are computed on-device and leak less than plaintext, but
  are not zero-risk for short snippets. The tradeoff is explicit and
  documented in `src/recall.js`.
- **Public keys** in `users.public_key_ed25519` and `bots.public_key_ed25519`.
  Private keys never leave the device / bot.

The Worker **does not** store: master keypairs, BIP-39 phrases, plaintext
conversation bodies, or plaintext search queries.

### Recall round-trip

1. Bot mints query embedding locally (e.g., `@xenova/all-MiniLM-L6-v2`).
2. Bot calls `POST /mem/v1/recall` with the 384-dim vector.
3. Worker queries Vectorize for top-K chunk_ids.
4. Worker fetches those rows from D1, scoped to `user_id = claims.sub`.
5. Worker returns opaque ciphertext blobs. **The bot decrypts on its side.**
6. Bot uses decrypted snippets as RAG context.

The plaintext never crosses the Worker boundary. Cross-user isolation is
enforced at the SQL level (`WHERE user_id = ?`) — see the cross-user
isolation test in `test/recall.test.js`.

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
wrangler secret put GRANT_JWT      # paste the secret value at the prompt
wrangler deploy
```

## Verify

```bash
# Health
curl -sS https://seele-memory.griptoad.workers.dev/api/mem/health | python3 -m json.tool

# Register a device
curl -sS -X POST https://seele-memory.griptoad.workers.dev/api/keys/register \
  -H 'content-type: application/json' \
  -d '{"user_id":"u-test","device":{"device_id":"d-test","name":"d","platform":"linux","app_version":"0"}}'
```

Note: `seele.agency/api/*` does not reach this Worker (Pages custom
domains shadow Worker routes on the same hostname). The canonical base
URL is `https://seele-memory.griptoad.workers.dev`. See
`./ROUTING.md` for the long-form hostname situation and exit options.

## Tests

```bash
npm install
npm test
```

Vitest covers:

* Grant JWT — valid / expired / wrong-scope / bad-signature / claim-validation paths
* Bot lifecycle — create / list / revoke / cross-user / second-revoke idempotency
* Sync — upload (idempotent dedupe), download, state, devices
* Recall — happy-path / top_k clamping / cross-user isolation (critical) /
  Vectorize-with-phantom-id safety
* full-recall — keyword scan

Tests run against an in-memory fake D1 (`test/fake-d1.js`) and a
fake Vectorize (`test/fake-vectorize.js`); no live Cloudflare access
required for the unit suite.

## CF Access policies (manual dashboard step)

Per SPEC §"Authentication", CF Access email-link policies attach to
`/api/*` and `/mem/*` to gate user identity. **CF Access policies live in
the Cloudflare dashboard, not in wrangler.toml** — wrangler cannot manage
access apps on behalf of a zone. Until that step is done the `/api/*`
routes will accept anonymous traffic (only the unauthenticated
`/api/keys/register` will succeed; everything else requires a JWT).

## Local dev

```bash
wrangler dev --local
wrangler d1 execute seele-memory-db --local --file=migrations/0001_initial.sql
```

Note: the Vectorize binding reports `needs to be run remotely` under
`--local`. That's expected — Vectorize has no local emulator.