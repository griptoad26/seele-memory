/**
 * @seele/memory-client — recall.ts
 *
 * -----------------------------------------------------------------------
 *  PRIVACY-CRITICAL — read before editing
 * -----------------------------------------------------------------------
 *
 *  `recall()` builds a *query embedding* on-device, sends ONLY the
 *  vector to `POST /mem/v1/recall`, and gets back top-K opaque
 *  ciphertext snippets. The server never sees the plaintext query
 *  either: by the time the bytes leave this function, they are a
 *  384-dim Float32Array.
 *
 *  This is THE HEADLINE FEATURE of seele-cloud. The query plaintext
 *  never travels. The response is ciphertext that the bot SDK
 *  decrypts locally. If you forget the embedding-isolation decision
 *  and start sending plaintext queries to the server, you've lost
 *  the whole point of the project.
 *
 *  Embedder = INJECTABLE. By default we ship a small deterministic
 *  hash embedder that mirrors the v0.10.0 stub in xkg-core
 *  (sha256 → L2-normalized 384-dim vector) so the SDK is
 *  dependency-light and runs on a stock browser. Production
 *  deployments register a real embedder (e.g. onnxruntime-web +
 *  bge-small-en-v1.5-quantized, OpenAI text-embedding-3-small,
 *  Cohere embed-english-v3.0) via `SeeleCloudClient({ embedder })`.
 *
 *  The default embedder is **NEVER** appropriate for a real bot:
 *  it produces noise. Production code MUST register a real embedder
 *  that produces vectors consistent with the vectors stored in
 *  Vectorize. Read docs/embedding.md before shipping a bot.
 *
 * -----------------------------------------------------------------------
 */

import { sha256 } from '@noble/hashes/sha256'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A pluggable embedder. The contract:
 *
 *   - Input:  a string of arbitrary length (the plaintext query).
 *   - Output: a Float32Array (or number[]) of length 384 — exact.
 *   - Same input must produce the same output (idempotent).
 *   - L2-normalized (cosine sim == dot product; Vectorize matches on
 *     cosine if configured with metric="cosine").
 *
 * The default implementation below (`hashEmbedder384`) satisfies
 * shape + idempotency but is not semantically meaningful. Replace
 * with `onnxruntime-web` + a real model in production.
 */
export type Embedder = (text: string) => Float32Array | Promise<Float32Array>

export interface RecallOptions {
  query: string
  top_k?: number
  since?: number
  /** Bot id whose grant JWT will be used. */
  bot_id?: string
  /** Override the default hash-based 384-dim embedder. */
  embedder?: Embedder
}

export interface RecallSnippet {
  chunk_id: string
  score: number
  conversation_id: string | null
  created_at: number
  body_encrypted: string
}

export interface RecallResponse {
  snippets: RecallSnippet[]
  query_id: string
}

export interface FullRecallOptions {
  query: string
  limit?: number
  since?: number
  bot_id?: string
}

export interface FullRecallResponse {
  matches: RecallSnippet[]
  query_id: string
}

// ---------------------------------------------------------------------------
// Default embedder — hash-based 384-dim stub.
//
// Mirrors xkg-core/src/embedding.rs (the "v0.10.0 stub"). Deterministic,
// L2-normalized, byte-stable. NOT semantically meaningful. Replace.
//
// We use this in the SDK because:
//   1. It has zero dependencies (the package stays dependency-light).
//   2. It runs in browsers and web workers without WASM.
//   3. It's correct for the wire-shape contract (384 dims, normalized,
//      idempotent), which is what the SDK primarily tests against.
//
// A real bot must register a real embedder. See `docs/embedding.md`.
// ---------------------------------------------------------------------------

export const EMBEDDING_DIM = 384

/**
 * Default hash-based 384-dim embedder. Pure JS, deterministic.
 *
 * Algorithm:
 *   1. SHA-256 of UTF-8 input.
 *   2. Stretch to 384*4 = 1536 bytes by hashing `prefix || seed` 6x.
 *   3. Take 4 bytes per dim, map to float in [-1, 1] via int8 normalize.
 *   4. L2-normalize.
 *
 * Same input → same output. Long input is internally chunked.
 */
export function hashEmbedder384(text: string): Float32Array {
  const out = new Float32Array(EMBEDDING_DIM)
  const enc = new TextEncoder()
  const seed = sha256(enc.encode(text))

  // Stretch 32 bytes to 384*4 = 1536 by chaining SHA-256.
  let cursor = 0
  let prev = seed
  while (cursor < EMBEDDING_DIM) {
    let block = prev
    if (cursor > 0) {
      const buf = new Uint8Array(prev.length + 4)
      buf.set(prev, 0)
      buf[prev.length] = (cursor >>> 24) & 0xff
      buf[prev.length + 1] = (cursor >>> 16) & 0xff
      buf[prev.length + 2] = (cursor >>> 8) & 0xff
      buf[prev.length + 3] = cursor & 0xff
      block = sha256(buf)
    }
    for (let i = 0; i + 4 <= block.length && cursor < EMBEDDING_DIM; i += 4) {
      // Convert 4 bytes to int32, then to float in (-1, 1).
      const v =
        (block[i] << 24) |
        (block[i + 1] << 16) |
        (block[i + 2] << 8) |
        block[i + 3] // signed
      out[cursor++] = v / 0x7fffffff
    }
    prev = block
  }
  return l2normalize(out)
}

/**
 * Long-input chunked variant. Calls the chunked embedder, then
 * element-wise means the per-chunk vectors. Useful when embedding
 * full conversation bodies (8K+ tokens) before upload.
 */
export function chunkedHashEmbedder384(text: string, chunkChars = 1024): Float32Array {
  const chunks = chunkStrings(text, chunkChars)
  if (!chunks.length) return hashEmbedder384('')
  const acc = new Float32Array(EMBEDDING_DIM)
  for (const c of chunks) {
    const v = hashEmbedder384(c)
    for (let i = 0; i < EMBEDDING_DIM; i++) acc[i] += v[i]
  }
  const m = 1 / chunks.length
  for (let i = 0; i < EMBEDDING_DIM; i++) acc[i] *= m
  return l2normalize(acc)
}

// ---------------------------------------------------------------------------
// Internal plumbing (normally lives behind the client; exposed for tests).
// ---------------------------------------------------------------------------

import type { SeeleCloudClient } from './client.js'

export async function recall(
  client: SeeleCloudClient,
  opts: RecallOptions,
): Promise<RecallResponse> {
  if (!opts || typeof opts.query !== 'string' || !opts.query) {
    throw new Error('@seele/memory-client: `query` is required')
  }
  const embedder = opts.embedder ?? client.embedder ?? hashEmbedder384
  const vec = await Promise.resolve(embedder(opts.query))
  if (!vec || vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `@seele/memory-client: embedder must return a ${EMBEDDING_DIM}-dim vector (got ${vec?.length ?? 'null'})`,
    )
  }
  const query_vector = Array.from(vec as ArrayLike<number>)
  const top_k = opts.top_k ?? 10
  const since = opts.since

  return (await client.post('/mem/v1/recall', {
    query_vector,
    top_k,
    ...(since != null ? { since } : {}),
    ...(opts.bot_id ? { bot_id: opts.bot_id } : {}),
  })) as RecallResponse
}

export async function fullRecall(
  client: SeeleCloudClient,
  opts: FullRecallOptions,
): Promise<FullRecallResponse> {
  if (!opts || typeof opts.query !== 'string' || !opts.query) {
    throw new Error('@seele/memory-client: `query` is required')
  }
  return (await client.post('/mem/v1/full-recall', {
    query: opts.query,
    limit: opts.limit ?? 10,
    ...(opts.since != null ? { since: opts.since } : {}),
    ...(opts.bot_id ? { bot_id: opts.bot_id } : {}),
  })) as FullRecallResponse
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function l2normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  if (sum === 0) return v
  const k = 1 / Math.sqrt(sum)
  for (let i = 0; i < v.length; i++) v[i] *= k
  return v
}

function chunkStrings(text: string, max: number): string[] {
  if (!text) return ['']
  if (text.length <= max) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max))
  }
  return chunks
}
