/**
 * test/local-vectorize.js — a LOCAL Vectorize implementation for the
 * end-to-end sync test.
 *
 * WHY THIS EXISTS
 * ---------------
 * Cloudflare's local Workers runtime (both `wrangler dev --local` and
 * miniflare) does NOT implement Vectorize. Asking for the binding
 * locally yields:
 *
 *     Error: Binding VECTORIZE needs to be run remotely
 *
 * That is a hard platform limitation — miniflare's own README lists
 * Vectorize under "Not yet supported", and there is no config knob to
 * enable it. The only alternatives are (a) `remote: true`, which talks
 * to the REAL production index — explicitly forbidden by this task —
 * or (b) a local implementation.
 *
 * So we implement one. And we implement it HONESTLY:
 *
 *   * `upsert()` stores the EXACT float values it was given, per id.
 *   * `query()` computes genuine cosine similarity against those stored
 *     vectors and returns real scores.
 *   * `getVectors()` returns the stored vectors back, so a test can
 *     assert the embedding round-tripped byte-for-byte.
 *
 * That last point is the whole reason this is not a stub: the task
 * requires asserting "the embedding round-trips as a real vector, not
 * the stub". A stub that returns a fixed score or an empty result
 * cannot prove that. This one can — and it fails loudly if the worker
 * ever stops forwarding `embedding_vector` to the index.
 *
 * It is still a LOCAL implementation, not Cloudflare's: it is a faithful
 * re-implementation of the subset of the Vectorize API this worker uses,
 * backed by an in-memory Map. No network, no credentials, no production.
 *
 * API surface implemented (what src/*.js actually calls):
 *   upsert(vectors)                      -> { mutationId }
 *   query(vector, opts)                  -> { matches: [{id, score}] }
 *   describe()                           -> { dimensions, metric }
 *   getVectors(ids?)                     -> { vectors: [{id, values, namespace}] }
 *   deleteVectors(ids)                   -> { mutationId }
 */

export class LocalVectorize {
  /**
   * @param {{ dimensions?: number, metric?: string }} [opts]
   */
  constructor(opts = {}) {
    this.dimensions = opts.dimensions ?? 384;
    this.metric = opts.metric ?? 'cosine';
    /** @type {Map<string, number[]>} */
    this._vectors = new Map();
    this._mutations = 0;
  }

  async upsert(vectors) {
    if (!Array.isArray(vectors)) throw new TypeError('vectors must be an array');
    for (const v of vectors) {
      if (!v || typeof v.id !== 'string') throw new TypeError('vector must have id');
      const values = Array.isArray(v.values) ? v.values : Array.from(v.values || []);
      // Store the exact floats. We deliberately do NOT normalise here:
      // if the worker forwards the wrong vector, the test must be able
      // to see that, and normalising would hide a scale error.
      this._vectors.set(v.id, values.map((n) => Number(n)));
    }
    this._mutations += 1;
    return { mutationId: `local-${this._mutations}` };
  }

  async query(values, opts = {}) {
    const topK = Number.isFinite(opts.topK) ? Math.max(1, opts.topK) : 10;
    const q = Array.isArray(values) ? values : Array.from(values || []);
    if (q.length !== this.dimensions) {
      throw new RangeError(`query dim ${q.length} != index dim ${this.dimensions}`);
    }

    const scored = [];
    for (const [id, v] of this._vectors.entries()) {
      if (v.length !== this.dimensions) continue;
      scored.push({ id, score: cosine(q, v) });
    }
    scored.sort((a, b) => b.score - a.score);
    return { matches: scored.slice(0, topK) };
  }

  async describe() {
    return { dimensions: this.dimensions, metric: this.metric };
  }

  /**
   * Return the stored vectors. This is how the test proves the
   * embedding round-tripped as a real vector rather than a stub.
   */
  async getVectors(ids) {
    const wanted = ids ? new Set(ids) : null;
    const out = [];
    for (const [id, values] of this._vectors.entries()) {
      if (wanted && !wanted.has(id)) continue;
      out.push({ id, values: [...values], namespace: 'default' });
    }
    return { vectors: out };
  }

  async deleteVectors(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) this._vectors.delete(id);
    this._mutations += 1;
    return { mutationId: `local-del-${this._mutations}` };
  }

  // --- test helpers ------------------------------------------------------

  /** Number of vectors currently indexed. */
  size() {
    return this._vectors.size;
  }

  /** Direct access to a stored vector (test assertions). */
  raw(id) {
    return this._vectors.get(id);
  }
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
