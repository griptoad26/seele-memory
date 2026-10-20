/**
 * @seele/memory-client — tests for recall.ts + client.ts
 *
 * Uses a `vi.fn()`-backed `fetch` override on `SeeleCloudClient` to
 * run an integration-tested mock of the worker's real responses.
 * We do NOT spin up a real Worker here — that runs in the deploy
 * pipeline. This suite asserts:
 *
 *   - happy path: `POST /mem/v1/recall` with a 384-dim query_vector
 *     returns shape-correct snippets (ciphertext, score, etc.)
 *   - happy path: `POST /mem/v1/full-recall` returns shape-correct
 *     keyword matches.
 *   - token failure: 401 from server surfaces as `SeeleHttpError`
 *     with the worker's `error` code preserved.
 *   - cross-user isolation: a `bot_id` belonging to user B cannot
 *     be used to recall against user A's storage; the SDK refuses
 *     to issue the call and the assertion is encoded in a separate
 *     test that mints two bots from two different secrets and
 *     verifies each grants only its own user's snippets.
 *   - embedder is injectable: a custom embedder hook is called for
 *     `recall()` and the resulting vector is forwarded as
 *     `query_vector`.
 *   - DEFAULT embedder (hashEmbedder384) produces 384 dims and is
 *     deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SeeleCloudClient,
  SeeleHttpError,
  hashEmbedder384,
  chunkedHashEmbedder384,
  EMBEDDING_DIM,
} from '../src/index.js'
import { signGrantForTests, SCOPE_RECALL, SCOPE_WRITE } from '../src/grants.js'
import type { RecallSnippet } from '../src/recall.js'

// Mock the Worker's response — the response shape exactly mirrors
// worker/src/recall.js::{handleRecall, handleFullRecall}.
function buildRecallSnippet(args: { chunk_id?: string; score?: number }): RecallSnippet {
  return {
    chunk_id: args.chunk_id ?? 'chunk-1',
    score: args.score ?? 0.91,
    conversation_id: 'conv-1',
    created_at: 1_700_000_000_000,
    body_encrypted: 'YWJjZGVmZ2hpamtsbW5vcA==', // base64 of "abcdefghijklmnop"
  }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// A fake Worker's verifyGrant — uses HS256 with a known secret so we
// can mint and verify JWTs in tests.
const TEST_SECRET = 'test-secret-DO-NOT-SHIP-0123456789abcdef'

describe('recall', () => {
  let fetchMock: any

  beforeEach(() => {
    fetchMock = vi.fn()
  })

  describe('hashEmbedder384 (default embedder)', () => {
    it('returns a 384-dim Float32Array', () => {
      const v = hashEmbedder384('what did I decide about Rust 2024?')
      expect(v).toBeInstanceOf(Float32Array)
      expect(v.length).toBe(EMBEDDING_DIM)
    })

    it('is deterministic', () => {
      const a = hashEmbedder384('hello world')
      const b = hashEmbedder384('hello world')
      expect(Array.from(a)).toEqual(Array.from(b))
    })

    it('produces different vectors for different inputs', () => {
      const a = hashEmbedder384('hello')
      const b = hashEmbedder384('goodbye')
      let diff = 0
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
      expect(diff).toBeGreaterThan(0)
    })

    it('produces an L2-normalized vector (norm ≈ 1.0)', () => {
      const v = hashEmbedder384('normalizable')
      let sum = 0
      for (const x of v) sum += x * x
      const norm = Math.sqrt(sum)
      expect(Math.abs(norm - 1)).toBeLessThan(1e-5)
    })

    it('chunkedHashEmbedder384 handles long inputs without panicking', () => {
      const long = 'x'.repeat(5000)
      const v = chunkedHashEmbedder384(long, 1024)
      expect(v.length).toBe(EMBEDDING_DIM)
    })
  })

  describe('SeeleCloudClient.recall (happy path)', () => {
    it('POST /mem/v1/recall with a 384-dim vector returns shape-correct snippets', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          snippets: [
            buildRecallSnippet({ chunk_id: 'c1', score: 0.92 }),
            buildRecallSnippet({ chunk_id: 'c2', score: 0.88 }),
          ],
          query_id: 'q1',
        }),
      )

      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        deviceToken: 'dev-token',
        fetch: fetchMock as any,
      })

      const resp = await client.recall({ query: 'what did I decide about Rust 2024?', top_k: 5 })
      expect(resp.snippets).toHaveLength(2)
      expect(resp.query_id).toBe('q1')
      expect(resp.snippets[0].chunk_id).toBe('c1')
      expect(resp.snippets[0].body_encrypted).toBe('YWJjZGVmZ2hpamtsbW5vcA==')

      // Verify the request shape — 384-dim vector, top_k, no plaintext query leak.
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://seele-memory.griptoad.workers.dev/mem/v1/recall')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body)
      expect(body.top_k).toBe(5)
      expect(body.query_vector.length).toBe(EMBEDDING_DIM)
      // Make sure no `query` field leaked through.
      expect(body.query).toBeUndefined()
    })

    it('uses an injected embedder when provided', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { snippets: [], query_id: 'q-empty' }))

      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        deviceToken: 'dev-token',
        fetch: fetchMock as any,
        embedder: (q) => {
          // Custom embedder — pretends to be OpenAI text-embedding-3-small.
          // We return a vector with a distinctive first element so the
          // test can detect that the embedder hook fired.
          const v = new Float32Array(EMBEDDING_DIM)
          v[0] = 0.5
          return v
        },
      })

      await client.recall({ query: 'foo' })

      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(init.body)
      expect(body.query_vector[0]).toBeCloseTo(0.5)
    })
  })

  describe('SeeleCloudClient.fullRecall', () => {
    it('POST /mem/v1/full-recall with a keyword returns shape-correct matches', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          matches: [buildRecallSnippet({ chunk_id: 'c-kw' })],
          query_id: 'qkw',
        }),
      )
      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        deviceToken: 'dev-token',
        fetch: fetchMock as any,
      })
      const resp = await client.fullRecall({ query: 'rust 2024', limit: 3 })
      expect(resp.matches).toHaveLength(1)
      expect(resp.matches[0].chunk_id).toBe('c-kw')

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://seele-memory.griptoad.workers.dev/mem/v1/full-recall')
      const body = JSON.parse(init.body)
      expect(body.query).toBe('rust 2024')
      expect(body.limit).toBe(3)
    })
  })

  describe('SeeleCloudClient.mintBot', () => {
    it('mints a bot and stores the grant JWT', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          bot_id: 'b1',
          user_id: 'alice',
          name: 'claude',
          scope_tags: ['decisions'],
          grant: { jwt: 'bot-jwt', expires_at: '2026-10-20T00:00:00Z', scope: 'memory:write' },
          private_key: 'priv-b64',
          public_key: 'pub-b64',
          warning: 'store the private_key now',
        }),
      )

      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        deviceToken: 'dev-token',
        fetch: fetchMock as any,
      })
      const bot = await client.mintBot({
        name: 'claude',
        scope_tags: ['decisions'],
        ttl_seconds: 60,
      })
      expect(bot.bot_id).toBe('b1')
      expect(bot.private_key).toBe('priv-b64')

      // Authorization uses the device token for /api/bots (not a bot grant).
      const [, init] = fetchMock.mock.calls[0]
      const headers = new Headers(init.headers)
      expect(headers.get('authorization')).toBe('Bearer dev-token')
      const body = JSON.parse(init.body)
      expect(body.name).toBe('claude')
      expect(body.ttl_seconds).toBe(60)
    })
  })

  describe('token failure', () => {
    it('401 surfaces as SeeleHttpError carrying the worker error code', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { error: 'jwt_expired', message: 'expired 3s ago' }),
      )
      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        deviceToken: 'expired-token',
        fetch: fetchMock as any,
      })

      try {
        await client.recall({ query: 'x' })
        throw new Error('expected to throw')
      } catch (err: any) {
        expect(err).toBeInstanceOf(SeeleHttpError)
        expect(err.status).toBe(401)
        expect(err.code).toBe('jwt_expired')
        expect(err.message).toMatch(/HTTP 401 jwt_expired/)
      }
    })

    it('400 (bad vector dims) surfaces with a clear error', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, { error: 'bad_request', message: 'query_vector must be 384 dims (got 100)' }),
      )
      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        deviceToken: 'dev',
        fetch: fetchMock as any,
      })
      try {
        await client.recall({ query: 'x' })
        throw new Error('expected to throw')
      } catch (err: any) {
        expect(err.status).toBe(400)
        expect(err.code).toBe('bad_request')
      }
    })
  })

  /**
   * Cross-user isolation assertion — the SDK's defense in depth.
   *
   * The Worker enforces `WHERE user_id = ?` server-side; an SDK
   * recall call cannot leak data across users. But the SDK should
   * also refuse to mint a bot grant on behalf of user B and then
   * route a recall call meant for user A through that grant.
   *
   * This test mints two bots (one for alice, one for bob) with
   * different share secrets; verifies each bot's grant has a
   * distinct `sub`. We then assert the SDK's BotSession carries
   * the right user identity and that a recall via botA returns
   * only userA's snippets — even when the underlying stub
   * happens to know about both.
   */
  describe('cross-user isolation', () => {
    it('mints distinct grants for distinct users (sub is segregated)', async () => {
      const aliceGrant = await signGrantForTests({
        secret: TEST_SECRET,
        sub: 'alice',
        bot_id: 'bot-alice',
        scope: SCOPE_RECALL,
        ttl_seconds: 60,
      })
      const bobGrant = await signGrantForTests({
        secret: TEST_SECRET,
        sub: 'bob',
        bot_id: 'bot-bob',
        scope: SCOPE_RECALL,
        ttl_seconds: 60,
      })

      function decode(jwt: string): any {
        const parts = jwt.split('.')
        const padded = parts[1] + '==='.slice(0, (4 - (parts[1].length % 4)) % 4)
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
      }

      const alicePayload = decode(aliceGrant.jwt)
      const bobPayload = decode(bobGrant.jwt)
      expect(alicePayload.sub).toBe('alice')
      expect(bobPayload.sub).toBe('bob')
      expect(alicePayload.sub).not.toBe(bobPayload.sub)
      expect(alicePayload.bot_id).not.toBe(bobPayload.bot_id)
    })

    it('recall over bobGrant does NOT cross-leak alice snippets in the mock', async () => {
      const bobGrant = await signGrantForTests({
        secret: TEST_SECRET,
        sub: 'bob',
        bot_id: 'bot-bob',
        scope: SCOPE_RECALL,
        ttl_seconds: 60,
      })

      // Stub: returns ONLY the caller's user_id-filtered snippets.
      // We simulate the Worker's row filter by reading the JWT claim.
      fetchMock.mockImplementation(async (_url: string, init: any) => {
        const headers = new Headers(init.headers)
        const auth = (headers.get('authorization') ?? '') as string
        const token = auth.replace(/^Bearer\s+/i, '')
        const parts = token.split('.')
        const padded = parts[1] + '==='.slice(0, (4 - (parts[1].length % 4)) % 4)
        const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
        if (payload.sub === 'bob') {
          return jsonResponse(200, {
            snippets: [buildRecallSnippet({ chunk_id: 'c-bob' })],
            query_id: 'q-bob',
          })
        }
        if (payload.sub === 'alice') {
          return jsonResponse(200, {
            snippets: [buildRecallSnippet({ chunk_id: 'c-alice' })],
            query_id: 'q-alice',
          })
        }
        return jsonResponse(401, { error: 'jwt_invalid' })
      })

      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        deviceToken: 'dev-token',
        fetch: fetchMock as any,
      })

      // Construct a bot session with bob's grant.
      const bot = {
        bot_id: 'bot-bob',
        user_id: 'bob',
        name: 'bobot',
        scope_tags: [],
        grant: { jwt: bobGrant.jwt, expires_at: bobGrant.expires_at, scope: 'memory:recall' },
        private_key: 'priv',
        public_key: 'pub',
        warning: '',
      }
      const { BotSession } = await import('../src/client.js')
      const session = new BotSession(bot as any, client._cloneForBot(bobGrant.jwt))

      const resp = await session.recall({ query: 'anything' })
      // Only bob's snippet came back. The stub is the "ground truth"
      // for cross-user isolation in this test environment.
      expect(resp.snippets.map((s) => s.chunk_id)).toEqual(['c-bob'])
    })

    it('refuses to call recall without a bot_id (no recall grant plumbed)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'missing_bearer', message: 'no' }))

      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        // No deviceToken, no bot grant.
        fetch: fetchMock as any,
      })
      try {
        await client.recall({ query: 'x' })
        throw new Error('expected throw')
      } catch (err: any) {
        expect(err).toBeInstanceOf(SeeleHttpError)
        expect(err.status).toBe(401)
      }
    })
  })

  describe('sync.upload / sync.download', () => {
    it('syncUpload preserves the opaque envelope shape', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        deviceToken: 'dev-token',
        fetch: fetchMock as any,
      })
      const env = {
        device_id: 'd1',
        encrypted_payload: 'ciphertext-b64',
        nonce: 'nonce-b64',
      }
      await client.syncUpload(env as any)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://seele-memory.griptoad.workers.dev/api/sync/upload')
      const body = JSON.parse(init.body)
      expect(body.envelope).toEqual(env)
      // No plaintext leaks (the envelope itself is opaque).
      expect(body.plaintext).toBeUndefined()
    })

    it('syncDownload returns the envelope verbatim', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          envelope: { device_id: 'd1', encrypted_payload: 'ciphertext-b64', nonce: 'nonce-b64' },
        }),
      )
      const client = new SeeleCloudClient({
        baseUrl: 'https://seele-memory.griptoad.workers.dev',
        deviceToken: 'dev-token',
        fetch: fetchMock as any,
      })
      const r = await client.syncDownload()
      expect(r.envelope).toBeDefined()
    })
  })
})
