/**
 * Thin facade around @seele/memory-client for the Vercel example.
 *
 * Production bots would mint a bot per session and cache its grant;
 * the example keeps things inline so it's easy to read top-to-bottom.
 */

import {
  SeeleCloudClient,
  hashEmbedder384,
  openWithContentKey,
  base64ToBytes,
  type BotSession,
} from '@seele/memory-client'

export interface SeeleContext {
  baseUrl: string
  deviceToken: string
  /** AES content key (32 bytes) — derived from the user's 12-word phrase. */
  aesContentKey: Uint8Array
}

/**
 * Open a short-lived bot session for one request. A production bot
 * would cache the bot grant for its TTL (default 15 min) instead
 * of minting one per call.
 */
export async function openBotSession(
  ctx: SeeleContext,
  opts: { name: string; scopeTags?: string[] },
): Promise<BotSession> {
  const client = new SeeleCloudClient({
    baseUrl: ctx.baseUrl,
    deviceToken: ctx.deviceToken,
    embedder: hashEmbedder384,
  })
  return client.openBot({
    name: opts.name,
    scope_tags: opts.scopeTags ?? [],
    ttl_seconds: 600,
  })
}

/**
 * Recall + decrypt. Returns plaintext snippets suitable for
 * pasting into an LLM context window.
 */
export async function recallAndDecrypt(
  ctx: SeeleContext,
  session: BotSession,
  query: string,
  top_k = 5,
): Promise<Array<{ chunk_id: string; score: number; created_at: number; text: string }>> {
  const resp = await session.recall({ query, top_k })
  const out: Array<{ chunk_id: string; score: number; created_at: number; text: string }> = []
  for (const s of resp.snippets) {
    const ciphertext = base64ToBytes(s.body_encrypted)
    try {
      const plaintext = await openWithContentKey(ctx.aesContentKey, ciphertext)
      out.push({
        chunk_id: s.chunk_id,
        score: s.score,
        created_at: s.created_at,
        text: new TextDecoder().decode(plaintext),
      })
    } catch (err) {
      // Wrong key, corrupted chunk, etc. Skip this snippet rather than
      // fail the whole call — the LLM can still answer with whatever
      // survived.
      console.warn(`failed to decrypt ${s.chunk_id}:`, err)
    }
  }
  return out
}

/**
 * Plaintext search (no embedder required) — used by bots that don't
 * have a local embedding model. Slower for large corpora but no
 * client-side ML required.
 */
export async function fullRecallAndDecrypt(
  ctx: SeeleContext,
  session: BotSession,
  query: string,
  limit = 10,
): Promise<Array<{ chunk_id: string; score: number; created_at: number; text: string }>> {
  const resp = await session.fullRecall({ query, limit })
  const out: Array<{ chunk_id: string; score: number; created_at: number; text: string }> = []
  for (const s of resp.matches) {
    const ciphertext = base64ToBytes(s.body_encrypted)
    try {
      const plaintext = await openWithContentKey(ctx.aesContentKey, ciphertext)
      out.push({
        chunk_id: s.chunk_id,
        score: s.score,
        created_at: s.created_at,
        text: new TextDecoder().decode(plaintext),
      })
    } catch (err) {
      console.warn(`failed to decrypt ${s.chunk_id}:`, err)
    }
  }
  return out
}
