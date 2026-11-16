# seele-memory

Cloud memory backend for **xkg** — an optional sync target alongside [cluster-hub](https://github.com/griptoad26/cluster-hub), with a bot-friendly recall API.

```
xkg-core  ──────►  seele-cloud  ◄──────  third-party LLMs
                  seele.agency           (Claude, GPT, custom bots)
```

See [`SPEC.md`](./SPEC.md) for the full design.
See [`CHANGELOG.md`](./CHANGELOG.md) for what shipped in each release.
See [`docs/release.md`](./docs/release.md) for how to publish one.

## Status

**v1.0.0** is tagged. The production Worker still runs the 2026-10-20
deployment — see [`CHANGELOG.md`](./CHANGELOG.md) §"Known limitations" for
exactly what is not live and why, and [`worker/ACCESS.md`](./worker/ACCESS.md)
for the credential fix.

| Track | Status |
|---|---|
| SPEC.md v0.1 | ✅ shipped |
| CF Worker + D1 + Vectorize | ✅ shipped (v1.0.0) |
| Recall API + bot JWT | ✅ shipped (TASK-093) |
| `@seele/memory-client` npm SDK | ✅ shipped (TASK-096) |
| Release script + CHANGELOG | ✅ shipped (TASK-115) |
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
├── CHANGELOG.md                    ← what shipped, per release
├── worker/                          CF Worker (src/, test/, migrations/)
├── sdk/
│   └── typescript/                  @seele/memory-client (npm)
│       ├── src/
│       ├── test/                    vitest suite
│       ├── package.json
│       └── README.md
├── examples/                        Claude / Vercel AI SDK / LangChain
├── docs/                            architecture, embedding, release, self-host, security model
├── scripts/release.sh               ← publish a release: migrate, deploy, reindex, tag
├── deployments/                     wrangler deploy + env.example
├── README.md
└── LICENSE                          MIT
```

## Releasing

```bash
export CLOUDFLARE_API_TOKEN=<token with D1 + Vectorize + Workers-write>
export CLOUDFLARE_ACCOUNT_ID=4240b199ca30d185e7954e6166582e7c

./scripts/release.sh --version 1.0.0
git push origin v1.0.0
```

The script verifies the tree, runs the test suites, applies the D1
migrations, deploys the Worker, rebuilds the Vectorize index, checks that
the live endpoint reports the version it just published, and creates the
git tag. It refuses to publish if the version in `worker/src/index.js`
disagrees with the changelog, or if the token is missing a scope.

Full details: [`docs/release.md`](./docs/release.md).

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

