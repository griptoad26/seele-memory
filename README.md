# seele-memory

Cloud memory backend for **xkg** — an optional sync target alongside [cluster-hub](https://github.com/griptoad26/cluster-hub), with a bot-friendly recall API.

```
xkg-core  ──────►  seele-cloud  ◄──────  third-party LLMs
                  seele.agency           (Claude, GPT, custom bots)
```

See [`SPEC.md`](./SPEC.md) for the full design.

## Status

v0.10.0 milestone under active build.

| Track | Status |
|---|---|
| SPEC.md v0.1 | ✅ shipped |
| CF Worker + D1 + Vectorize | ✅ shipped (v0.2.0-phase2) |
| Recall API + bot JWT | ✅ shipped (TASK-093) |
| `@seele/memory-client` npm SDK | ✅ shipped (TASK-096) |
| xkg-core SyncTarget::SeeleCloud | 🚧 in progress (TASK-094) |
| Flutter sync target picker | ⛔ blocked on 094 (TASK-095) |

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
├── sdk/
│   └── typescript/                  @seele/memory-client (npm)
│       ├── src/
│       ├── test/                    vitest suite
│       ├── package.json
│       └── README.md
├── examples/                        Claude / Vercel AI SDK / LangChain
├── docs/                            architecture, embedding, self-host, security model
├── deployments/                     wrangler deploy + env.example
├── README.md
└── LICENSE                          MIT
```

## Using the SDK

If you're building a bot that wants to recall from a user's seele-memory
corpus, the package is on npm as `@seele/memory-client`.

```bash
npm install @seele/memory-client
```

Documentation:
- SDK reference: [`sdk/typescript/README.md`](./sdk/typescript/README.md)
- Architecture: [`docs/architecture.md`](./docs/architecture.md)
- Embedding integration (replace the default stub with a real model):
  [`docs/embedding.md`](./docs/embedding.md)
- Self-hosting the Worker: [`docs/self-host.md`](./docs/self-host.md)

Examples:
- Claude Custom Action: [`examples/claude-custom-action.json`](./examples/claude-custom-action.json)
- Vercel AI SDK: [`examples/vercel-ai-sdk/`](./examples/vercel-ai-sdk)
- LangChain: [`examples/langchain/`](./examples/langchain)

The quick-start (browser):

```ts
import {
  generateRecoveryPhrase,
  deriveKeyMaterial,
  SeeleCloudClient,
} from '@seele/memory-client'

const phrase = await generateRecoveryPhrase()
const keys = deriveKeyMaterial(phrase)

const client = new SeeleCloudClient({
  baseUrl: 'https://seele-memory.griptoad.workers.dev',
  deviceToken: '...', // from POST /api/keys/register
})

const session = await client.openBot({ name: 'claude' })
const { snippets } = await session.recall({ query: 'rust 2024 decisions', top_k: 5 })

// snippets[i].body_encrypted is ciphertext. Decrypt with keys.plaintextAesKey().
```

## Privacy model (TL;DR)

- The server holds ciphertext blobs and 384-dim embedding vectors.
- The server never sees your 12-word recovery phrase, your AES content
  key, your Ed25519 private key, or the plaintext of any query.
- Decryption happens on your device, in the bot's runtime, using a key
  derived from your phrase.
- The default embedder in the SDK is shape-correct but **not semantic** —
  swap it for `onnxruntime-web` + `bge-small-en-v1.5` (or your remote
  embedder) before shipping a bot. See `docs/embedding.md`.

For the full threat model read [`docs/architecture.md`](./docs/architecture.md)
and [`docs/SECURITY_MODEL.md`](./docs/SECURITY_MODEL.md).

