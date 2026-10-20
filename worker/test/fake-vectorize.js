/**
 * test/fake-vectorize.js — In-memory Vectorize fake for vitest.
 *
 * Supports the minimal surface src/db.js and src/recall.js use:
 *   * upsert(vectors) → returns { mutationId }
 *   * query(vector, { topK, returnMetadata, returnValues })
 *     → returns { matches: [{ id, score }] } sorted by score desc
 *   * describe() → returns { dimensions, metric }
 *
 * Scoring: cosine similarity. We do not normalize vectors — the real
 * binding also assumes the caller normalized. Tests can pre-normalize.
 */

export class FakeVectorize {
  constructor({ dimensions = 384, metric = 'cosine' } = {}) {
    this.dimensions = dimensions;
    this.metric = metric;
    this._vectors = new Map(); // id → vector[]
    this._mutations = 0;
  }

  async upsert(vectors) {
    if (!Array.isArray(vectors)) throw new TypeError('vectors must be an array');
    for (const v of vectors) {
      if (!v || typeof v.id !== 'string') throw new TypeError('vector must have id');
      const values = Array.isArray(v.values) ? v.values : Array.from(v.values || []);
      this._vectors.set(v.id, values);
    }
    this._mutations += 1;
    return { mutationId: `fake-${this._mutations}` };
  }

  async describe() {
    return { dimensions: this.dimensions, metric: this.metric };
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

  /** For test assertions. */
  size() {
    return this._vectors.size;
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