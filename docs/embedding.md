# Embedding — `docs/embedding.md`

This page documents the **embedding isolation decision** and how to
swap the SDK's default hash-based stub for a real model.

## TL;DR

By default `@seele/memory-client` ships with `hashEmbedder384()` — a
shape-correct, deterministic embedder that produces L2-normalized
384-dim vectors from any string. **It is not semantically meaningful.**
It exists so the SDK has zero ML dependencies and runs on any platform.

For a real bot you must register a production embedder. The vectors
your local embedder produces MUST be the same shape (384 dims,
L2-normalized) AND semantically aligned with the vectors stored in
Cloudflare Vectorize. If your client-side embedder and the server-side
vectors diverge, recall quality silently falls to noise.

## Why 384 dims?

The Worker expects 384-dim Float32 query vectors in
`POST /mem/v1/recall`. The dim count is set in `wrangler.toml` and
mirrors `bge-small-en-v1.5` — a strong, ~30MB-quantized multilingual
embedding model. Vectorize matches on cosine sim.

If you want a different dim count, change `EXPECTED_VECTOR_DIMS` in
`worker/src/recall.js` and re-deploy — every embedder must match.

## Swapping in `onnxruntime-web` + `bge-small-en-v1.5`

```ts
import * as ort from 'onnxruntime-web'

let session: ort.InferenceSession | null = null

async function getSession(): Promise<ort.InferenceSession> {
  if (session) return session
  // Host the model yourself or via a CDN you control — pin it to a
  // specific URL with a checksum. Default CDN below is illustrative.
  session = await ort.InferenceSession.create(
    'https://your-cdn.example.com/bge-small-en-v1.5-quantized.onnx',
    { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
  )
  return session
}

async function meanPool(hidden: Float32Array, mask: BigInt64Array, dim: number): Promise<Float32Array> {
  const n = mask.length
  const out = new Float32Array(dim)
  for (let i = 0; i < n; i++) {
    if (mask[i] === 0n) continue
    for (let j = 0; j < dim; j++) {
      out[j] += hidden[i * dim + j]
    }
  }
  let norm = 0
  for (const x of out) norm += x * x
  if (norm > 0) {
    const k = 1 / Math.sqrt(norm)
    for (let i = 0; i < dim; i++) out[i] *= k
  }
  return out
}

// Naive whitespace tokenizer — replace with a real BPE tokenizer for
// production. The shape of `input_ids` and `attention_mask` is what
// ORT expects; not the exact IDs.
async function tokenize(text: string, maxLen = 128): Promise<{ ids: BigInt64Array; mask: BigInt64Array }> {
  const ids: bigint[] = []
  const mask: bigint[] = []
  ids.push(101n) // [CLS]
  mask.push(1n)
  for (const w of text.split(/\s+/).slice(0, maxLen - 2)) {
    ids.push(BigInt(w.length)) // placeholder; replace with vocab lookup
    mask.push(1n)
  }
  ids.push(102n) // [SEP]
  mask.push(1n)
  while (ids.length < maxLen) {
    ids.push(0n)
    mask.push(0n)
  }
  return { ids: BigInt64Array.from(ids), mask: BigInt64Array.from(mask) }
}

export async function bgeEmbed(text: string): Promise<Float32Array> {
  const s = await getSession()
  const { ids, mask } = await tokenize(text)
  const out = await s.run({
    input_ids: ids,
    attention_mask: mask,
  })
  const hidden = out.last_hidden_state.data as Float32Array
  return meanPool(hidden, mask, 384)
}
```

Then wire it into the SDK:

```ts
import { SeeleCloudClient } from '@seele/memory-client'
import { bgeEmbed } from './bge-embed'

const client = new SeeleCloudClient({
  baseUrl: 'https://seele-memory.griptoad.workers.dev',
  deviceToken: '...',
  embedder: bgeEmbed,
})
```

## Cloud embedding APIs (OpenAI, Cohere, etc.)

The SDK works with any embedder that returns `Float32Array` (or
`number[]`) of length 384. Cloud providers offer much higher
quality but route your query plaintext through their infrastructure.

**Privacy tradeoff.** If the embedder is remote, the query plaintext
effectively travels — just to OpenAI instead of seele-cloud. The
seele-cloud threat model assumes the embedder runs on-device. If
you opt for a remote embedder, treat it as another party in your
trust boundary and document the choice.

## Cross-impl determinism

The Rust side computes a deterministic hash-based embedder in v0.10.0
(`xkg-core/src/embedding.rs`) — i.e. it does NOT run ONNX. This means
Rust-captured vectors and SDK-side queries do not currently align
semantically. v0.11.0 brings the same ONNX model to the Rust side so
both implementations produce real vectors. Until then, recall across
xkg-desktop → Claude bots returns near-zero-relevance results for
captures made on devices running the Rust embedder.

This is a known limitation. The SDK ships today because:
- The wire contract is shape-correct and round-trips.
- Bot SDKs with their own embedder (most server-side bots) get the
  full pipeline working today.
- The v0.11.0 worker is a small follow-up.

## Checklist for going to prod

- [ ] Pick a 384-dim model (BGE, MiniLM, E5, or whatever fits your domain).
- [ ] Decide on-device vs remote (privacy tradeoff).
- [ ] Pin the ONNX model file behind a stable URL with a SHA-256 checksum.
- [ ] Strip the Vite/Webpack dev server's `Headers` filter (`cross-origin-embedder-policy`, etc.) — ONNX fetches won't work over a normal CORS-flavored dev server.
- [ ] Benchmark recall latency against your typical bot turn budget.
- [ ] Validate cross-impl determinism with the test fixture in `keytree.test.ts`.
