# `@seele/memory-client`

Browser-first TypeScript SDK for the **[seele-cloud](https://github.com/griptoad26/seele-memory)** encrypted memory recall API.

End-to-end encrypted. The server never sees your plaintext queries, your
recovery phrase, or your AES content key. You bring a 12-word phrase; we
do the rest.

[![npm version](https://img.shields.io/npm/v/@seele/memory-client.svg)](https://www.npmjs.com/package/@seele/memory-client)
[![license](https://img.shields.io/npm/l/@seele/memory-client.svg)](./LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@seele/memory-client.svg)](https://bundlephobia.com/package/@seele/memory-client)

---

## Quick start — browser (Vite / Next.js / plain HTML)

```ts
import {
  generateRecoveryPhrase,
  deriveKeyMaterial,
  SeeleCloudClient,
} from '@seele/memory-client'

// First-time enrollment — show this once and never again.
const phrase = await generateRecoveryPhrase()
console.log('YOUR 12-WORD PHRASE:', phrase.join(' '))
const keys = deriveKeyMaterial(phrase)

// Talk to the cloud. Device token comes from /api/keys/register on first run.
const client = new SeeleCloudClient({
  baseUrl: 'https://seele-memory.griptoad.workers.dev',
  deviceToken: await getYourDeviceTokenFromSecureStorage(),
})

// Encrypt outbound envelopes with the content key.
// Server only ever sees ciphertext.
const sealed = await client.syncUpload({
  device_id: 'macbook-1',
  encrypted_payload: btoa(String.fromCharCode(...keys.plaintextAesKey())),
  nonce: '<random-per-envelope>',
})

// Mint a bot grant for the LLM that's about to run RAG against your data.
const bot = await client.mintBot({
  name: 'claude',
  scope_tags: ['decisions', 'rust-projects'],
  ttl_seconds: 900, // 15 min
})

// ⚠️ Bot calls go through the bot grant, NOT the device token.
// The server keeps embeddings and ciphertext separate; the *query*
// is also turned into a vector on-device before it leaves.
const session = client.openBot({ name: 'claude', ttl_seconds: 900 })
const snippets = await session.recall({ query: 'rust 2024 roadmap', top_k: 5 })

// snippets[i].body_encrypted is ciphertext. Decrypt with keys.plaintextAesKey().
```

> **Browser gotcha:** the package includes both ESM and CJS bundles.
> Bundlers that ignore `exports` (some older webpack configs) will
> pull in `node:buffer`-flavored code. Use the `@seele/memory-client/web`
> subpath for a stricter browser bundle.

---

## Quick start — Node 18+ (xkg-cli, server bots, scripts)

```ts
import {
  generateRecoveryPhrase,
  deriveKeyMaterial,
  SeeleCloudClient,
  hashEmbedder384,
} from '@seele/memory-client'

// Same API surface; Node 18+ exposes WebCrypto at globalThis.crypto.
// No `node:crypto` is imported — ever.
const phrase = generateRecoveryPhraseSync()
const keys = deriveKeyMaterial(phrase)

const client = new SeeleCloudClient({
  baseUrl: process.env.SEELE_CLOUD_URL!,
  deviceToken: process.env.SEELE_DEVICE_TOKEN!,
  // Production: register a real embedder here. The default hash-based
  // stub is **not** semantically meaningful — it's only shape-correct.
  embedder: hashEmbedder384,
})

// Rest of the flow is identical to the browser.
const session = client.openBot({ name: 'claude' })
const snippets = await session.recall({ query: 'rust 2024' })
console.log(snippets)
```

---

## 🔒 Privacy model — the headline feature

> **What the server can see:** embedding vectors (384-dimensional floats),
> ciphertext blobs, your public keys, and the timing/size of your requests.
>
> **What the server cannot see:** your 12-word recovery phrase, your Ed25519
> private key, your AES content key, the plaintext of any query you send,
> the plaintext of any stored snippet.

```
┌────────────────────────────┐                         ┌─────────────────────────────┐
│        YOUR DEVICE         │                         │   seele-cloud  (CF Worker)  │
│                            │                         │                             │
│  ┌──────────────────────┐  │   recall() / fullRecall │  ┌──────────────────────┐    │
│  │ 12-word phrase       │  │   ───────────────────►  │  │  Vectorize           │    │
│  │   └ HKDF → AES key   │  │   query_vector: [384]   │  │   (cosine sim)       │    │
│  │   └ HKDF → Ed25519   │  │   Bearer bot_grant_jwt  │  │  D1 (encrypted blob) │    │
│  └──────────────────────┘  │                         │  └──────────────────────┘    │
│           │                │                         │             │                │
│           │ seal (AES-GCM) │                         │             ▼                │
│           ▼                │                         │   ciphertext body_encrypted│
│  ┌──────────────────────┐  │  ◄───────────────────   │   only — server cannot open │
│  │ envelope (cipher)    │  │                         │                             │
│  └──────────────────────┘  │                         │                             │
└────────────────────────────┘                         └─────────────────────────────┘
```

The diagram above is the **only** model this SDK implements. Anything that
looks like "send plaintext to the server" is a bug. If you find yourself
tempted to add such an endpoint, don't — find a way to keep the encryption
on-device.

**Embedding isolation rationale.** The Server holds vectors in Cloudflare
Vectorize so it can do semantic search. A 384-dim float vector is
*recoverable in principle* for short text (that's an inherent property of
fixed-dim embeddings) but it is far less of a leak than the raw plaintext
itself, and it lets us do meaningful recall without holding keys. This is
a deliberate trade-off encoded at every level of the SDK:

- The SDK's default `hashEmbedder384()` is a *shape-correct, non-semantic*
  stub. Replace it with `onnxruntime-web` + a real model (see
  [`docs/embedding.md`](../../docs/embedding.md)) before shipping a bot.
- The `/mem/v1/recall` API expects a `query_vector`, never a `query`
  string. The SDK enforces this in its request shape.
- Decrypting returned snippets happens **on the bot's machine**, not
  on the server. The bot holds the AES key (derived from the same
  12-word phrase the user enrolled with).

---

## Installation

```bash
npm install @seele/memory-client
# or
pnpm add @seele/memory-client
yarn add @seele/memory-client
```

## API surface

| Symbol | Where | Notes |
|---|---|---|
| `generateRecoveryPhrase()` | `keytree` | 12-word BIP-39 English phrase. Show once. |
| `deriveKeyMaterial(phrase)` | `keytree` | Deterministically derives the user's Ed25519 master keypair + AES content key. Same phrase → same keys, on every device, forever. |
| `sealWithContentKey` / `openWithContentKey` | `keytree` | AES-256-GCM content key use. Round-trip without ever touching the server. |
| `KeyMaterial.zeroize()` | `keytree` | Wipes secret bytes on drop. Best-effort, not airtight — handle with care. |
| `signGrantForTests(secret, …)` | `grants` | Server-side only. Used to mint JWTs in tests/dev tooling. Never expose the secret to clients. |
| `verifyGrantClaims(jwt)` | `grants` | Client-side claim check (exp, scope, sub, bot_id). Pre-flights server 401/403s. |
| `verifyGrant(jwt, secret)` | `grants` | Full cryptographic check. Server-side / tests only. |
| `hashEmbedder384(text)` | `recall` | Default 384-dim embedder. Shape-correct, **not semantic**. Replace with a real model in production. |
| `chunkedHashEmbedder384(text)` | `recall` | Long-input variant. |
| `recall(client, opts)` | `recall` | Build query embedding, call `/mem/v1/recall`, return opaque ciphertext snippets. |
| `fullRecall(client, opts)` | `recall` | Same shape but keyword scan (no embedder needed). |
| `SeeleCloudClient` | `client` | Network surface. |
| `BotSession` | `client` | Wraps a freshly-minted bot grant and exposes typed recall. |

## Recipes

### Mint a bot per Claude conversation

```ts
const client = new SeeleCloudClient({ baseUrl: DEFAULT, deviceToken })
const session = await client.openBot({
  name: `claude-${Date.now()}`,
  scope_tags: ['decisions'],
  ttl_seconds: 900,
})
const snippets = await session.recall({ query: 'what did I decide about x?' })
```

### Use a real embedder (production)

```ts
import * as ort from 'onnxruntime-web'

let session: ort.InferenceSession | null = null
async function loadEmbedder() {
  if (session) return session
  session = await ort.InferenceSession.create('/path/to/bge-small-en-v1.5-quantized.onnx')
  return session
}

const bge = async (text: string): Promise<Float32Array> => {
  const s = await loadEmbedder()
  // Tokenize, run, mean-pool, L2-normalize.
  // (See docs/embedding.md for the full pattern.)
  const vec = await runBge(s, text) // your helper
  return vec
}

const client = new SeeleCloudClient({
  baseUrl: DEFAULT,
  deviceToken,
  embedder: bge,
})
```

### Decrypt returned snippets

```ts
const session = await client.openBot({ name: 'claude' })
const snippets = await session.recall({ query: 'rust 2024' })
for (const s of snippets) {
  const ciphertext = Uint8Array.from(atob(s.body_encrypted), c => c.charCodeAt(0))
  const plaintext = await openWithContentKey(keys.plaintextAesKey(), ciphertext)
  console.log(new TextDecoder().decode(plaintext))
}
```

---

## Examples

- [`examples/claude-custom-action.json`](../../examples/claude-custom-action.json) — copy-pastable Claude "Custom Action" config.
- [`examples/vercel-ai-sdk`](../../examples/vercel-ai-sdk) — minimal Vercel AI SDK `tool` definition.
- [`examples/langchain`](../../examples/langchain) — LangChain JS `MemoryVectorStore`-style bridge.

## Tested

```
$ npm test

 ✓ test/grants.test.ts  (18 tests)
 ✓ test/recall.test.ts  (16 tests)
 ✓ test/keytree.test.ts (18 tests)

 Tests  52 passed (52)
```

The test suite covers:

- Phrase generation, validation, and round-trip
- Ed25519 sign/verify
- AES-256-GCM seal/open (round-trip and wrong-key failure)
- JWT mint and verification (matching/expired/wrong-secret/wrong-scope)
- Recall happy-path against a stubbed server
- 401 / 400 surface as `SeeleHttpError` carrying the worker error code
- **Cross-user isolation**: two distinct bot grants (alice + bob) each
  return only their own user's snippets under the in-test stub.

## Browser support

- Chrome / Edge 108+
- Firefox 110+
- Safari 16+

You need `crypto.subtle` (i.e. a secure context — `https://` or
`localhost`) to import this package. Calling `crypto.subtle` over
plaintext http throws.

## License

MIT — same as the rest of the xkg ecosystem.
