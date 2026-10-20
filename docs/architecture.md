# Architecture — `docs/architecture.md`

End-to-end architecture of seele-cloud. This document is the public
counterpart to the private `SPEC.md` and exists for users who want
to understand (and audit) the threat model without reading the spec.

## Components

```
┌──────────────────────────────────────────────────────────────┐
│  xkg-desktop / xkg-mobile / xkg-cli  (Rust, on-device)        │
│                                                                │
│  • BIP-39 phrase → Ed25519 master + AES-256 content key       │
│  • Embeds every captured snippet before sending                │
│  • Encrypts every envelope with AES-GCM                        │
│  • mints one bot grant per LLM session via /api/bots          │
└────────────────────────────────┬─────────────────────────────┘
                                 │
                                 │   envelope = AES-GCM ciphertext
                                 │   + 384-dim Float32 embedding
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Worker — seele-memory                              │
│  https://seele-memory.griptoad.workers.dev                     │
│                                                                │
│  • /api/keys/register  → bootstrap device row                  │
│  • /api/sync/*         → envelope exchange                     │
│  • /api/bots           → mint bot + Ed25519 keypair + JWT      │
│  • /mem/v1/recall      → Vectorize query → D1 ciphertext       │
│                                                                │
│  Bindings: D1 (relational), Vectorize (semantic)               │
└────────────────────────────────┬─────────────────────────────┘
                                 │
                                 │   ciphertext only
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  Third-party LLM (Claude, GPT, custom bots)                    │
│                                                                │
│  • holds bot Ed25519 keypair (server-generated, returned once) │
│  • signs every recall call with the bot's grant JWT            │
│  • decrypts snippets locally with the user's AES content key   │
└──────────────────────────────────────────────────────────────┘
```

## Data flow — capture

1. The user types a message into an LLM UI.
2. xkg-desktop intercepts the message (a private capture transport).
3. On-device: embed the plaintext → 384-dim Float32 vector.
4. On-device: encrypt the plaintext with the user's AES content key
   (`AES-256-GCM(nonce, plaintext, AAD=vector_bytes)`).
5. Bundle `{ ciphertext, vector, conversation_id, ts }` into an
   envelope; upload to `POST /api/sync/upload`.

The Worker stores:
- `conversations` table: metadata only.
- `encrypted_chunks` table: ciphertext + the vector (denormalized
  for keyword joins). No plaintext.

The Worker **never** decrypts, and **cannot** — the content key is
not in D1, not in Vectorize, not in the Worker.

## Data flow — recall

1. A Claude "Custom Action" fires `seele-recall({ query, top_k })`.
2. The action's runtime embeds the query on-device
   (`hashEmbedder384` or a real model) and posts to `/mem/v1/recall`
   with the bot's grant JWT.
3. Worker validates grant JWT (signature + scope + revocation check
   against `bots` table).
4. Worker queries Vectorize for top-K chunk IDs, fetches the rows
   from D1 scoped to the JWT's `sub` claim.
5. Worker returns the rows: `{chunk_id, score, ciphertext}`. No
   plaintext.
6. The action runtime decrypts each snippet with the user's AES
   content key (read from secure storage), then forwards plaintext
   to the LLM as RAG context.

## Authentication

Two orthogonal auth paths:

- **Device** → long-lived HS256 JWT (1 year) with
  `scope=memory:write`, issuer `seele-cloud:device`. Used for
  `/api/keys/*` and `/api/sync/*`. The token is stored in the OS
  secure enclave / Keychain / Keystore.
- **Bot** → short-lived HS256 JWT (default 15 min, configurable up to
  24h) with `scope=memory:recall` or `memory:write`, issuer
  `seele-cloud:bot`. Used for `/mem/v1/*`. Re-mintable; the bot's
  Ed25519 private key (generated server-side, returned once at
  `/api/bots` create time) is the *outer* identity the bot SDK
  uses to call the Worker.

JWT secret `GRANT_JWT` is server-only. The Worker's `wrangler secret`
binding puts it in encrypted storage; the dashboard never shows it.
Clients cannot verify the signature without it (HS256 is symmetric).

There is no public JWK in v0.10.0. The SDK exposes a structural
`verifyGrantClaims()` that fails fast on `exp`, `scope`, `sub`,
`bot_id` mismatches without the secret. Full cryptographic checks
are only available server-side.

## Privacy model — what's where

| Datum | Where it lives | Encrypted at rest? | Notes |
|---|---|---|---|
| 12-word phrase | User's brain + their device's secure enclave | n/a | Never sent to server. |
| Ed25519 master private key | Device-only | n/a | **Never** leaves the device. |
| AES content key | Device-only | n/a | **Never** leaves the device. |
| Plaintext conversation | D1 (rows in `encrypted_chunks`) | yes — AES-256-GCM | Server cannot decrypt. |
| Embedding vector | Vectorize + D1 (denormalized) | no (see below) | 384-dim Float32. |
| Email / user_id | D1 `users` table | hashed (SHA-256, salted) | Identity only. |
| Bot's private Ed25519 key | Bot's runtime (returned once) | depends on bot's storage | Server never stores it. |
| Worker JWT secret | Cloudflare encrypted binding | yes | `wrangler secret` only. |

## Embedding isolation — the headline

Vectorize sees plaintext-derived embedding vectors. These are
*recoverable in principle* for short text but not zero-risk. They
let us do semantic search without holding keys. Tradeoffs:

- Server compromise → vectors leak. Vector quality is far weaker
  than plaintext but not nothing.
- Server compromise → ciphertext stays opaque. AES-256-GCM with a
  key the server doesn't have.
- Embedder compromise → query plaintext leaks. Mitigated by running
  the embedder on-device (the default posture for the SDK).

If you opt to use a remote embedder (OpenAI text-embedding-3-small,
Cohere, etc.), your query plaintext is also subject to that
provider's threat model. Document the choice.

## Recovery

Lost phrase → user must have set up Shamir device-shares (≥3-of-5)
on at least one enrolled device. Recovery workflow is opt-in and
not yet automated; see `SECURITY_MODEL.md` for the v0.10.0 stance.
