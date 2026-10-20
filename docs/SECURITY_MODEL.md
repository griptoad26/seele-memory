# Security Model — seele-memory

Phase 1 outline. Final doc lands with TASK-093.

## What the server holds

- Ciphertext blobs (encrypted with user's content key)
- Embeddings (computed on-device at capture time, server never sees plaintext)
- Per-bot scope manifests
- Public keys

## What the server does NOT hold

- User's master keypair (only public)
- BIP-39 recovery phrase
- Plaintext conversation bodies
- Plaintext search queries

## Threat model

- **Server compromise**: yields ciphertext + embeddings only. Embeddings are lossy but not zero-risk for short text.
- **Bot compromise**: blast radius limited by per-bot scope tags. Grant JWT exp short (~15min).
- **Device loss**: user recovers via BIP-39 phrase on a new device. Same keys, full archive.
- **Loss of mnemonic**: requires user-side Shamir shares (3-of-5) configured at first sync. Opt-in.
