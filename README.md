# seele-memory

Cloud memory backend for **xkg** — an optional sync target alongside [cluster-hub](https://github.com/griptoad26/cluster-hub), with a bot-friendly recall API.

```
xkg-core  ──────►  seele-cloud  ◄──────  third-party LLMs
                  seele.agency           (Claude, GPT, custom bots)
```

See [`SPEC.md`](./SPEC.md) for the full design.

## Status

**Pre-implementation.** v0.10.0 milestone just kicked off. Task tracking lives in the OCMI hub.

| Track | Status |
|---|---|
| SPEC.md v0.1 | ✅ shipped |
| CF Worker + D1 + Vectorize | 🚧 in progress (TASK-092) |
| Recall API + bot JWT | ⛔ blocked on 092 (TASK-093) |
| xkg-core SyncTarget::SeeleCloud | 🚧 in progress (TASK-094) |
| Flutter sync target picker | ⛔ blocked on 094 (TASK-095) |
| `@seele/memory-client` npm SDK | ⛔ blocked on 093 (TASK-096) |

## Architecture (TL;DR)

- **Devices**: xkg-desktop, xkg-mobile-flutter, xkg-cli
- **Sync target choice**: at registration time, a device picks `Local` / `ClusterHub` / `SeeleCloud`. All three speak the same envelope contract.
- **Auth**: CF Access email-link for human identity; BIP-39 passphrase derives an Ed25519 master keypair + AES-256-GCM content key. Per-bot scoped keypairs with grant JWTs.
- **Privacy**: server holds ciphertext + on-device embeddings only. Never sees plaintext.
- **Bot recall**: `POST /mem/v1/recall` returns encrypted snippets; the SDK decrypts on the bot's side.

## Repo layout

```
seele-memory/
├── SPEC.md                          ← the contract
├── worker/                          CF Worker (src/, test/, migrations/)
├── sdk/                             Client SDKs (TypeScript, Python)
├── examples/                        Claude / Vercel AI SDK / LangChain
├── docs/                            USER_GUIDE, SECURITY_MODEL, API_REFERENCE
├── deployments/                     wrangler deploy + env.example
├── README.md
└── LICENSE                          MIT
```
