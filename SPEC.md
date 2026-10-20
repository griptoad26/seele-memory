# seele-cloud — Cloud Memory Backend for xkg

**Version:** 0.1 (Draft — 2026-10-19)
**Status:** Pending green-light to commit to `griptoad26/seele-memory`
**Owner:** ocmi-orchestrator (relay); build executed by devops-agent + memory-agent + xkg-dev + xkg-mobile + docs-agent

---

## What this is

**seele-cloud** is an optional cloud sync target for **xkg-core**, sitting alongside the existing on-prem `cluster-hub`. It is not a separate product — it is one of two (and soon three: `Local` + `ClusterHub` + `SeeleCloud`) backends that an xkg device can push envelopes to.

```
xkg-core (Rust lib)
    │
    ├─ xkg-desktop (Tauri)          ─── uses xkg-core
    ├─ xkg-mobile-flutter           ─── uses xkg-core via FFI
    └─ xkg-cli                      ─── uses xkg-core
                                            │
                                            ▼
                          SyncClient (already in xkg-core, AES-GCM)
                                            │
                          ┌─────────────────┴─────────────────┐
                          │                                   │
                          ▼                                   ▼
                  cluster-hub                       seele-cloud
                  (on-prem, dev/test,               (cloud, prod, recall-API)
                   privacy-first)                   at seele.agency
                  http://100.112.11.35:8090/api    https://seele.agency/api
                  SyncTarget::ClusterHub            SyncTarget::SeeleCloud
```

Devices can have multiple targets active simultaneously, each with its own encryption subkey. A privacy-first user can stay on `cluster-hub` and never speak to `seele.agency`. A bot-ecosystem user points at `seele-cloud` so third-party LLMs (Claude Custom Actions, LangChain Memory, OpenAI Custom GPTs) can pull their memory.

---

## Why this exists

The on-prem `cluster-hub` solves the **device-to-device sync** problem. It does not solve:

1. **Recall from outside.** Bots running on third-party infrastructure can't reach `100.112.11.35:8090` (no public IP, no DNS, no auth bridging to Claude/OpenAI's tool-use frameworks).
2. **Bot-friendly key model.** `cluster-hub` trusts whatever device registers. Bots don't have a per-user cryptographic identity to participate in.
3. **Cloud-first latency.** Devices sometimes want to recall from places that aren't on the same LAN as the hub. A Cloudflare Worker at the edge is sub-50ms globally.

`seele-cloud` fixes all three by being a **CF Worker** that:
- Speaks the same envelope contract as `cluster-hub`.
- Adds a `/mem/v1/recall` endpoint optimized for bot RAG patterns (top-K snippets, ranked, snippet-sized).
- Holds an authentication model that bridges to OAuth/JWT providers (CF Access email-link) **and** to per-bot scoped keypairs.

---

## Privacy model — Option D (Sovereign / E2EE with passphrase recovery)

Each device generates a **BIP-39 12-word recovery phrase** at first sync. The phrase deterministically derives:
- A long-term Ed25519 master keypair (signing + identity).
- An AES-256-GCM content key (symmetric envelope encryption).

The master private key **never leaves the device**. The public key registers at `seele.agency/api/keys/{user_id}` so other devices and bots can address envelopes to this user.

### What the server holds
- **Ciphertext blobs** (envelope bodies, encrypted with the user's content key)
- **Embeddings** computed **on-device at capture time** (server never sees plaintext)
- **Per-bot scope manifests** ("Bot X may read convs tagged `#ok-for-bot-x` until grant expires")
- **Public keys** for verification
- **No symmetric keys** — server literally cannot decrypt the data

### What the server does NOT hold
- The user's master keypair
- The user's BIP-39 recovery phrase
- Plaintext conversation bodies
- Plaintext search queries
- Plaintext browser bookmarks

### Embedding model
Computed on-device using ONNX/WASM (candidates: `@xenova/all-MiniLM-L6-v2` quantized to ~30MB, or `@xenova/bge-small-en-v1.5`). Server stores vectors in Cloudflare Vectorize (built-in binding, no extra infra). Mobile APK grows by ~3-5MB; capture latency adds ~50-150ms per insertion. Battery cost acceptable for background sync.

### Bot recall flow
1. User installs xkg-desktop, generates 12-word phrase, confirms.
2. User signs in at `seele.agency` with the same phrase via browser (WebCrypto, no server roundtrip needed for key derivation — phrase → keys happen client-side).
3. User creates a bot at `seele.agency/dashboard/bots`, names it (e.g. "Claude assistant"), sets scope tags (e.g. `decisions`, `rust-projects`).
4. Bot's first recall call: presents its per-bot scoped keypair. Worker verifies signature against user's master key + scope manifest.
5. Worker runs vector + keyword search over the user's encrypted corpus, returns top-K encrypted snippets.
6. **Bot decrypts snippets on its side** using a symmetric subkey derived from the user's master key (passed via the per-session grant JWT — short-lived, ~15min).
7. Bot uses decrypted snippets as RAG context for the next model call.

### Recovery
- New device, same 12-word phrase → same keys → full archive accessible.
- Lost phrase → recovery via a pre-generated set of **device recovery shares** (Shamir's Secret Sharing split, ~3-of-5 required). Stored only client-side, never sent to server.
- This is a **deliberate non-default**: most users won't bother with shares but the option exists.

---

## Sync envelope contract

Identical to xkg-core's existing wire format. **No breaking changes.**

```json
{
  "device_id": "uuid-v4",
  "from_device_id": "uuid-v4",
  "encrypted_payload": "<base64-AES-256-GCM-ciphertext>",
  "nonce": "<base64-12-byte-nonce>",
  "ciphertext": "<base64-nonce||ciphertext combined>",
  "cursor": 0,
  "message_cursor": 0,
  "conv_cursor": 0,
  "msg_cursor": 0
}
```

`seele-cloud` accepts, stores, and forwards envelopes identically to `cluster-hub`. Devices registered through CF Access email-link auth get a `user_id` (the email's hash, salted); envelopes are tagged with `user_id` on the server side.

### Dedupe keys
- Conversations: `(user_id, conversation_id)` — idempotent.
- Messages: `(user_id, conversation_id, client_msg_id)` — idempotent.
- Bookmarks/searches: depends on the new `LLMKind::*` variants introduced for browser data.

### Sync endpoints (mirrored from cluster-hub)
```
POST   /api/sync/devices                  Register this device under user_id
POST   /api/sync/upload                   Upload one envelope (encrypted)
GET    /api/sync/download                 Get latest envelope for this device
GET    /api/sync/state                    User's sync state (cursors, last seen)
```

### Recall endpoint (NEW, only at seele-cloud)
```
POST   /mem/v1/recall                     Body: { query, top_k, kinds, scope_tags }
                                         Response: { snippets: [{id, score, encrypted_chunk, source}], query_id }
POST   /mem/v1/full-recall                Body: { ..., grant_jwt }
                                         Response: { conversations: [decrypted payloads] }
GET    /mem/v1/health                     Status: { ok, version, last_reindex_at }
```

`recall` returns encrypted chunks (vector + keyword searched). The bot SDK `@seele/memory-client` decrypts locally using the same key tree.

### Key management endpoints
```
POST   /api/keys/{user_id}/register       First-time key registration (after BIP-39 derivation)
GET    /api/keys/{user_id}                Returns public key + subkey manifests
POST   /api/keys/{user_id}/recover        Re-derive from BIP-39 (used by web sign-in)
POST   /api/bots                          Create a bot with a scoped keypair
GET    /api/bots/{bot_id}                 Bot manifest, scopes, expiry
DELETE /api/bots/{bot_id}                 Revoke bot
```

---

## Authentication

Two orthogonal auth paths:

### User auth (CF Access email-link)
- Cloudflare Access policy: `seele.agency/api/*` requires the user's email to be in an allowlist.
- Magic-link sent via Cloudflare Access built-in IdP (or a custom OAuth provider — GitHub, Google, etc.).
- Once verified, CF Access issues an `access_token` cookie that's automatically sent with all subsequent requests.
- This is **identity only** — does not unlock memory. Memory unlocks via the user's BIP-39 phrase or per-device session.

### Bot auth (per-bot scoped keypair)
- Each bot has its own Ed25519 keypair generated at bot-create time.
- Bot signs a per-request grant JWT: `{ user_id, bot_id, scopes, expires_at }` using the user's session key (derived from BIP-39 phrase in-memory on the bot's side, never sent).
- Worker validates: signature, expiry, scope match against the user's bot manifest.
- Different bots get **non-overlapping views** of the corpus by default.

### Device auth (per-device subkey)
- Each device registers a separate symmetric subkey derived from the user's master key by `HMAC(master_key, device_id)`.
- Envelopes encrypted for `cluster-hub` use a different subkey from envelopes encrypted for `seele-cloud` (because targets are independent).

---

## Data model (Cloudflare D1)

```sql
-- Users
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  public_key_ed25519 BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Devices (per-user)
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  public_key_ed25519 BLOB,
  last_seen_at INTEGER NOT NULL,
  subkey_id TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Conversations (metadata only — content is in encrypted_chunks)
CREATE TABLE conversations (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  llm_kind TEXT NOT NULL,
  title_encrypted BLOB,
  source_url_encrypted BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);

-- Encrypted chunks (the actual content)
CREATE TABLE encrypted_chunks (
  chunk_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  body_encrypted BLOB NOT NULL,
  embedding BLOB,  -- vectorize index, denormalized here for keyword joins
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, conversation_id) REFERENCES conversations(user_id, conversation_id)
);

-- Bots (per-user scoped)
CREATE TABLE bots (
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  public_key_ed25519 BLOB NOT NULL,
  scope_tags TEXT NOT NULL,    -- JSON array
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
```

Vectorize binding handles similarity search over the `embedding` vectors. D1 handles relational joins, dedupe, and metadata filtering.

---

## Repo layout

**New repo:** `github.com/griptoad26/seele-memory`

```
seele-memory/
  SPEC.md                          (this file)
  README.md
  LICENSE                          (MIT, matching the rest of xkg ecosystem)
  worker/                          Cloudflare Worker
    src/
      index.js                     Router
      auth.js                      CF Access + bot grant JWT validation
      keys.js                      Key registration + recovery
      sync.js                      /api/sync/{devices,upload,download,state}
      recall.js                    /mem/v1/recall + /mem/v1/full-recall
      bots.js                      /api/bots CRUD
      db.js                        D1 + Vectorize helpers
    test/                          Vitest suite
    wrangler.toml                  Worker config
    migrations/                    D1 schema as .sql files
  sdk/
    typescript/                    @seele/memory-client
      src/
        client.ts
        keytree.ts                 BIP-39 → Ed25519 + AES key derivation
        grants.ts                  Per-bot grant JWT minting + verification
        recall.ts                  recall() + full-recall() wrappers
      test/
      package.json
      README.md
    python/                        seele-memory (PyPI)
      src/seele_memory/
      test/
      pyproject.toml
      README.md
  examples/
    claude-custom-action.json      Drop-in tool definition for Claude
    vercel-ai-sdk/                 Next.js demo
    langchain/                     LangChain Memory subclass
  docs/
    USER_GUIDE.md
    SECURITY_MODEL.md              Key recovery, threat model, trust assumptions
    API_REFERENCE.md
    KEY_DERIVATION.md              How BIP-39 → keys → subkeys
  deployments/
    deploy.sh                      wrangler deploy + D1 migration runner
    env.example                    All required env var names + format
```

**New code in xkg-core:**
- `src/sync_target.rs` — `enum SyncTarget { Local, ClusterHub { url, token }, SeeleCloud { user_id, token } }`
- `src/keys.rs` — BIP-39 phrase → Ed25519 + AES content key (uses `bip39` + `ed25519-dalek` crates)
- `src/embedding.rs` — On-device embedding computation (candle-core + a quantized model file)
- Updates to `src/sync.rs` and `src/sync_http.rs` to handle the new target variant

**New code in xkg-mobile-flutter:**
- `lib/services/keygen.dart` — 12-word phrase generation + confirmation screen
- `lib/services/sync_target.dart` — target picker UI + secure token storage
- `lib/screens/cloud_settings.dart` — bot management screen

**No changes to cluster-hub** — it stays as-is. The `seele-cloud` Worker is an independent deploy.

---

## Phasing — what ships in v0.10.0

This is the only milestone. v0.11.0+ would be post-launch polish.

### Phase 1: Spec + Worker skeleton (Days 1-2)
- [ ] `SPEC.md` merged to `griptoad26/seele-memory` (this document)
- [ ] Worker deployed at `seele.agency/api/mem/health` returning `{ok, version}`
- [ ] D1 schema migrated
- [ ] Cloudflare Access policy attached to `/api/*`

### Phase 2: Sync mirror (Days 3-4)
- [ ] `/api/sync/{devices,upload,download,state}` match `cluster-hub`'s API exactly
- [ ] A fake xkg-desktop pointing at `seele.agency/api/sync/upload` can register + push an envelope
- [ ] Dedupe verification: re-uploading the same envelope produces no new rows

### Phase 3: xkg-core integration (Days 5-6)
- [ ] `SyncTarget::SeeleCloud` variant lands in xkg-core master
- [ ] On-device embedding computation via `candle-core` + ONNX model
- [ ] xkg-desktop settings picks `SeeleCloud` from a dropdown

### Phase 4: Recall (Days 7-8)
- [ ] `/mem/v1/recall` wired with Vectorize + D1 keyword fallback
- [ ] `/mem/v1/full-recall` with grant JWT validation
- [ ] `@seele/memory-client` npm package published

### Phase 5: Integration test (Day 9)
- [ ] Real xkg-desktop captures a conversation, pushes to `seele.agency`
- [ ] Claude Custom Action calls `/recall`, gets decrypted snippet
- [ ] Bot's response cites the captured line. Done.

---

## Out of scope (v0.10.0)

- **Web sign-in flow** (BIP-39 → keys in browser, then CF Access). Add in v0.11.0.
- **iOS/Android capture transports** (the bridge from Flutter to the worker). Use HTTP for v0.10.0.
- **Bot marketplace** (third-party bot publishing). v1.0.0 at earliest.
- **Multi-user / shared memories** (a team chat where multiple humans share a memory cloud). v1.0.0+.
- **Vectorize index sharding** (auto-scale across multiple indices). Wait for Cloudflare to ship it.
- **Browser data import** (the `LLMKind::BrowserSearch` / `BrowserBookmark` work we discussed last week). That work is tracked under a separate v0.10.0 sub-milestone; this SPEC just doesn't preclude it.

---

## Open questions for the user

These will block specific tracks but not the spec itself. Listing for transparency:

1. **Embedding model choice.** Default suggestion: `bge-small-en-v1.5` quantized to ~30MB. Alternative: `all-MiniLM-L6-v2` (smaller, weaker). Pick at implementation time.
2. **CF Access IdP.** Default suggestion: Cloudflare's built-in email-link with an allowlist. Alternative: GitHub OAuth. Pick at setup time.
3. **Subkey rotation cadence.** Default suggestion: never (user re-derives from phrase if compromised). Alternative: 90-day rolling subkey.
4. **Grant JWT default lifetime.** Default suggestion: 15 minutes (short). Some bots will want longer (Claude project contexts). Make it user-configurable in bot manifest.

None of these block Phase 1 spec merge.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Cloudflare changes Worker pricing/rate limits mid-build | Mirror critical bits to R2 (storage stays cheap even if compute changes) |
| BIP-39 phrase UX scares non-technical users | Onboard with a 60s "this is your memory key, write it down" video; offer paper wallet PDF download |
| Loss of mnemonic = loss of memory | Offer device-side Shamir shares (3-of-5) as opt-in escape hatch |
| Bot compromise leaks decrypted snippets | Per-bot scope tags limit blast radius; grant JWT exp short |
| Server compromise yields nothing usable | Embeddings are irreversible for short text but not zero-risk; encryption is the real defense |
| Discoverability of `seele.agency` for users without the worker URL | xkg-desktop's settings pane must show the URL as clickable; embed in install docs |

---

## Acceptance criteria for v0.10.0 done

1. A real xkg-desktop on the user's machine can switch its sync target to `seele.agency` and successfully push an envelope.
2. A Claude Custom Action calling `https://seele.agency/mem/v1/recall` with the user's grant returns a snippet that was just captured.
3. Bot response cites the captured line.
4. `cluster-hub` continues to work unchanged for users who don't enable `seele-cloud`.
5. `SPEC.md` is merged to `griptoad26/seele-memory` and the repo is public.

If 1-5 are all yes, the milestone is shipped. Anything less is a partial and we file new tasks.

---

_End SPEC v0.1_
