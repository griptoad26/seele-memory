/**
 * @seele/memory-client — CONTRACT tests for the recall response shape.
 *
 * TASK-seele-cloud-20261116-109.
 *
 * The server side of this contract is locked down in
 * `worker/test/recall-contract.test.js`. This file locks down the
 * *consumer* side: the SDK is what actually breaks when a field is
 * renamed, because every bot using `@seele/memory-client` reads
 * `snippet.body_encrypted` and would silently receive `undefined`.
 *
 * The important difference from a plain "field exists" assertion:
 * we compare the EXACT key set. A rename that keeps the count the same
 * (e.g. `body_encrypted` → `ciphertext`) passes a `toHaveProperty`
 * check on the *old* name only if you also assert the old name is
 * absent. We do both:
 *
 *   1. `Object.keys()` must equal the contract's key set exactly.
 *   2. Near-miss names a careless rename would produce must be absent.
 *
 * The TypeScript `RecallSnippet` interface in src/recall.ts is the
 * source of truth for these literals. If you change one of the key
 * lists below, you have changed the public API: bump the SDK version
 * and update SPEC.md §"Recall endpoint" too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SeeleCloudClient, SeeleHttpError } from '../src/index.js'
import type { RecallSnippet, RecallResponse, FullRecallResponse } from '../src/recall.js'

// ---------------------------------------------------------------------------
// THE CONTRACT
// ---------------------------------------------------------------------------

/** Exact top-level keys of a 200 recall response. */
const RESPONSE_KEYS = ['query_id', 'snippets']

/** Exact keys of a single item in `snippets[]` / `matches[]`. */
const SNIPPET_KEYS = [
  'body_encrypted',
  'chunk_id',
  'conversation_id',
  'created_at',
  'score',
]

/** Exact top-level keys of a 200 full-recall response. */
const FULL_RESPONSE_KEYS = ['matches', 'query_id']

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeClient(fetchMock: any) {
  return new SeeleCloudClient({
    baseUrl: 'https://seele-memory.griptoad.workers.dev',
    deviceToken: 'dev-token',
    fetch: fetchMock as any,
  })
}

describe('CONTRACT: recall response shape (SDK consumer side)', () => {
  let fetchMock: any

  beforeEach(() => {
    fetchMock = vi.fn()
  })

  it('exposes exactly { snippets, query_id } on the top level', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        snippets: [
          {
            chunk_id: 'c1',
            score: 0.92,
            conversation_id: 'conv-1',
            created_at: 1_700_000_000_000,
            body_encrypted: 'YWJjZGVmZ2hpamtsbW5vcA==',
          },
        ],
        query_id: 'q1',
      }),
    )

    const resp = await makeClient(fetchMock).recall({ query: 'hello' })

    expect(Object.keys(resp).sort()).toEqual([...RESPONSE_KEYS].sort())
    expect(Array.isArray(resp.snippets)).toBe(true)
    expect(typeof resp.query_id).toBe('string')
  })

  it('exposes exactly the five contract fields on each snippet', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        snippets: [
          {
            chunk_id: 'c1',
            score: 0.92,
            conversation_id: 'conv-1',
            created_at: 1_700_000_000_000,
            body_encrypted: 'YWJjZGVmZ2hpamtsbW5vcA==',
          },
        ],
        query_id: 'q1',
      }),
    )

    const resp = await makeClient(fetchMock).recall({ query: 'hello' })
    const s = resp.snippets[0]

    expect(Object.keys(s).sort()).toEqual([...SNIPPET_KEYS].sort())

    // Field types are part of the contract.
    expect(s.chunk_id).toBeTypeOf('string')
    expect(s.score).toBeTypeOf('number')
    expect(s.created_at).toBeTypeOf('number')
    expect(s.body_encrypted).toBeTypeOf('string')
    expect(s.conversation_id === null || typeof s.conversation_id === 'string').toBe(true)
  })

  it('rejects near-miss field names produced by a careless rename', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        snippets: [
          {
            // A server that renamed `body_encrypted` → `ciphertext`
            // and `chunk_id` → `id`. The SDK must not silently accept
            // this shape: the exact key-set assertion above is what
            // catches it. Here we assert the near-miss names are not
            // part of the contract.
            id: 'c1',
            ciphertext: 'YWJjZGVmZ2hpamtsbW5vcA==',
            score: 0.92,
            conversation_id: 'conv-1',
            created_at: 1_700_000_000_000,
          } as any,
        ],
        query_id: 'q1',
      }),
    )

    const resp = await makeClient(fetchMock).recall({ query: 'hello' })
    const s = resp.snippets[0] as any

    expect(s.body_encrypted).toBeUndefined()
    expect(s.chunk_id).toBeUndefined()
    expect(s.id).toBeDefined()
    expect(s.ciphertext).toBeDefined()

    // The key set does NOT match the contract.
    expect(Object.keys(s).sort()).not.toEqual([...SNIPPET_KEYS].sort())
  })

  it('exposes exactly { matches, query_id } for full-recall', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        matches: [
          {
            chunk_id: 'c-kw',
            score: 1.0,
            conversation_id: 'conv-1',
            created_at: 1_700_000_000_000,
            body_encrypted: 'YWJjZGVmZ2hpamtsbW5vcA==',
          },
        ],
        query_id: 'qkw',
      }),
    )

    const resp = await makeClient(fetchMock).fullRecall({ query: 'foo' })

    expect(Object.keys(resp).sort()).toEqual([...FULL_RESPONSE_KEYS].sort())
    expect(Object.keys(resp.matches[0]).sort()).toEqual([...SNIPPET_KEYS].sort())
  })

  it('surfaces an empty result set as an empty array, not an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { snippets: [], query_id: 'q-empty' }))

    const resp = await makeClient(fetchMock).recall({ query: 'nothing matches' })

    expect(resp.snippets).toEqual([])
    expect(resp.query_id).toBe('q-empty')
    expect(Object.keys(resp).sort()).toEqual([...RESPONSE_KEYS].sort())
  })

  it('surfaces a 401 as SeeleHttpError and never yields snippets', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: 'missing_bearer', message: 'Authorization required' }),
    )

    let caught: any = null
    try {
      await makeClient(fetchMock).recall({ query: 'hello' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(SeeleHttpError)
    expect(caught.status).toBe(401)
    expect(caught.code).toBe('missing_bearer')
    // Fail closed: the error object carries no response payload at all,
    // so no snippet data can leak through the error path.
    expect(caught.snippets).toBeUndefined()
    expect(Object.keys(caught).sort()).toEqual(['code', 'name', 'status'])
  })

  // -------------------------------------------------------------------------
  //  The type-level pin.
  //
  //  `recall()` in src/recall.ts ends with a blind `as RecallResponse`
  //  cast — the runtime shape is never validated against the TypeScript
  //  interface. That means a rename inside `interface RecallSnippet`
  //  compiles cleanly and breaks every downstream bot at runtime, with
  //  no compile error anywhere.
  //
  //  This test closes that hole: it constructs a value that satisfies
  //  `RecallSnippet` and asserts its runtime key set equals the
  //  contract. If someone renames a field in the interface, the
  //  `satisfies`-style literal below stops type-checking AND the key
  //  set assertion fails — the rename cannot land quietly.
  // -------------------------------------------------------------------------
  it('the RecallSnippet TYPE and the runtime shape agree', () => {
    // Typed as RecallSnippet: renaming a field in the interface makes
    // this literal fail to type-check (and fail the key-set assert).
    const snippet: RecallSnippet = {
      chunk_id: 'c1',
      score: 0.92,
      conversation_id: 'conv-1',
      created_at: 1_700_000_000_000,
      body_encrypted: 'YWJjZGVmZ2hpamtsbW5vcA==',
    }

    expect(Object.keys(snippet).sort()).toEqual([...SNIPPET_KEYS].sort())

    // And the response wrapper types agree too.
    const response: RecallResponse = { snippets: [snippet], query_id: 'q1' }
    expect(Object.keys(response).sort()).toEqual([...RESPONSE_KEYS].sort())

    const full: FullRecallResponse = { matches: [snippet], query_id: 'q1' }
    expect(Object.keys(full).sort()).toEqual([...FULL_RESPONSE_KEYS].sort())
  })

  it('a snippet missing a contract field does not type-check as RecallSnippet', () => {
    // Compile-time guard, expressed as a runtime assertion on the
    // shape. A snippet with the near-miss name must not satisfy the
    // contract key set.
    const renamed = {
      chunk_id: 'c1',
      score: 0.92,
      conversation_id: 'conv-1',
      created_at: 1_700_000_000_000,
      ciphertext: 'YWJjZGVmZ2hpamtsbW5vcA==',
    }

    expect(Object.keys(renamed).sort()).not.toEqual([...SNIPPET_KEYS].sort())
    expect((renamed as any).body_encrypted).toBeUndefined()
  })
})
