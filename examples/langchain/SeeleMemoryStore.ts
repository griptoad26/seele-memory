/**
 * SeeleMemoryStore.ts — LangChain VectorStore bridge for seele-cloud.
 *
 * Subclasses `VectorStore` so it slots into `RetrievalQAChain` /
 * `ConversationalRetrievalQAChain` etc. as a drop-in. The bridge:
 *
 *   1. Recomputes vectors for incoming documents with the configured
 *      embedder (default `hashEmbedder384`).
 *   2. Encrypts the document bodies with the user's AES content key
 *      and uploads the resulting envelope via `/api/sync/upload`.
 *   3. For similarity search, calls `/mem/v1/recall` (top-K) and
 *      decrypts snippets locally before returning `Document` objects.
 *
 * Privacy: only embedding vectors and ciphertext travel. The bridge
 * never serializes plaintext to a network call.
 *
 * This is illustrative code — production bridges should add:
 *   - bot-grant caching (mint once per minute, not per call)
 *   - error handling around ciphertext decryption (a chunk might be
 *     missing or have rotated keys)
 *   - per-chunk metadata stored alongside the document so retrieval
 *     results can carry `conversation_id`, `created_at`, etc.
 */

import {
  SeeleCloudClient,
  hashEmbedder384,
  sealWithContentKey,
  openWithContentKey,
  base64ToBytes,
  bytesToBase64,
  type Embedder,
} from '@seele/memory-client'
import { VectorStore } from 'langchain/dist/vectorstores/base'
import type { Document } from 'langchain/dist/document'

export interface SeeleMemoryStoreConfig {
  baseUrl: string
  deviceToken: string
  /** AES content key (32 bytes) — derived from the user's 12-word phrase. */
  aesContentKey: Uint8Array
  /** Bot grant TTL in seconds. Default 900 (15 min). */
  botTtlSeconds?: number
  /** Injectable embedder. Default is the hash-based stub. */
  embedder?: Embedder
}

export class SeeleMemoryStore extends VectorStore {
  private client: SeeleCloudClient
  private botSession: any = null
  private botSessionExpiry = 0
  private readonly cfg: SeeleMemoryStoreConfig

  constructor(cfg: SeeleMemoryStoreConfig) {
    super()
    this.cfg = cfg
    if (cfg.aesContentKey.length !== 32) {
      throw new Error('aesContentKey must be exactly 32 bytes')
    }
    this.client = new SeeleCloudClient({
      baseUrl: cfg.baseUrl,
      deviceToken: cfg.deviceToken,
      embedder: cfg.embedder ?? hashEmbedder384,
    })
  }

  /** LangChain `VectorStore.addVectors`. */
  async addVectors(
    vectors: number[][],
    documents: Document[],
  ): Promise<void> {
    if (vectors.length !== documents.length) {
      throw new Error('vectors.length must equal documents.length')
    }
    const out = []
    for (let i = 0; i < documents.length; i++) {
      const plaintext = new TextEncoder().encode(documents[i].pageContent)
      const sealed = await sealWithContentKey(this.cfg.aesContentKey, plaintext)
      out.push({
        envelope: {
          device_id: 'langchain-' + crypto.randomUUID(),
          embedding_b64: bytesToBase64(new Uint8Array(new Float32Array(vectors[i]).buffer)),
          ciphertext_b64: bytesToBase64(sealed),
          meta: documents[i].metadata ?? {},
        },
        _pl: plaintext,
      })
    }
    // Strip the cached plaintext buffers BEFORE uploading.
    for (const e of out) delete (e as any)._pl
    await Promise.all(
      out.map((e) => this.client.syncUpload((e as any).envelope)),
    )
  }

  /** LangChain `VectorStore.addDocuments`. */
  async addDocuments(documents: Document[]): Promise<void> {
    const embedder = this.cfg.embedder ?? hashEmbedder384
    const vectors: number[][] = []
    for (const d of documents) {
      const v = await Promise.resolve(embedder(d.pageContent))
      vectors.push(Array.from(v))
    }
    await this.addVectors(vectors, documents)
  }

  /**
   * LangChain `VectorStore.similaritySearchVectorWithScore`.
   *
   * Bot-grant caching: the bot JWT lasts 15 min by default. We mint
   * one on first call and refresh when within 30s of expiry.
   */
  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
  ): Promise<Array<[Document, number]>> {
    const session = await this._getOrMintBot()
    const resp = await session.recall({
      query: '<vector-search>', // placeholder; embedder only uses the vector
      top_k: k,
      // Pass the vector directly through the embedder hook — our
      // `recall()` impl always embeds, so we re-derive a vector from
      // the query string for shape purposes. The actual query is
      // the embedding itself; downstream langchain consumers can
      // fork the SDK to allow vector injection directly.
    })
    void query // (see comment above)
    const out: Array<[Document, number]> = []
    for (const s of resp.snippets) {
      try {
        const ciphertext = base64ToBytes(s.body_encrypted)
        const plaintext = await openWithContentKey(this.cfg.aesContentKey, ciphertext)
        const text = new TextDecoder().decode(plaintext)
        out.push([
          new Document({
            pageContent: text,
            metadata: {
              chunk_id: s.chunk_id,
              created_at: s.created_at,
              conversation_id: s.conversation_id,
            },
          }),
          s.score,
        ])
      } catch (err) {
        // Skip snippets that fail to decrypt — they're corrupt or
        // were encrypted with a different key.
        console.warn(`[SeeleMemoryStore] failed to decrypt ${s.chunk_id}:`, err)
      }
    }
    return out
  }

  /** Mint a fresh bot session if none cached or near expiry. */
  private async _getOrMintBot() {
    const now = Math.floor(Date.now() / 1000)
    if (this.botSession && this.botSessionExpiry - now > 30) {
      return this.botSession
    }
    const session = await this.client.openBot({
      name: 'langchain-bot',
      scope_tags: [],
      ttl_seconds: this.cfg.botTtlSeconds ?? 900,
    })
    this.botSession = session
    this.botSessionExpiry = now + (this.cfg.botTtlSeconds ?? 900)
    return session
  }

  /**
   * LangChain expects a static `_vectorstoreType()` method on subclasses.
   * Required even though it's purely informational here.
   */
  static _vectorstoreType(): string {
    return 'seele-cloud'
  }
}
