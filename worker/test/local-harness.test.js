/**
 * Unit tests for the local e2e harness's own helpers.
 *
 * The harness is test infrastructure, but it has sharp edges that can
 * silently weaken the e2e suite:
 *
 *   * `splitStatements` — if it drops or corrupts a statement, the
 *     migrations would apply incompletely and the e2e suite would run
 *     against a schema that does not match production. Worse, it could
 *     fail silently: a missing statement means a missing table, and the
 *     e2e test might still pass on the paths that don't touch it.
 *
 *   * `assertLocalOnly` — if it lets a production host through, the
 *     e2e suite writes real data to the live database. This guard is
 *     the single thing standing between the suite and production, so
 *     it gets its own tests.
 */

import { describe, it, expect } from 'vitest';
import { splitStatements, assertLocalOnly } from './local-worker.js';
import { LocalVectorize } from './local-vectorize.js';
import { fixtureVector, cosine } from './local-worker.js';

describe('splitStatements', () => {
  it('splits on semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('drops leading line comments', () => {
    expect(splitStatements('-- a comment\nSELECT 1;')).toEqual(['SELECT 1']);
  });

  it('drops block comments', () => {
    expect(splitStatements('/* block */ SELECT 1;')).toEqual(['SELECT 1']);
  });

  it('does NOT split on a semicolon inside a string literal', () => {
    const stmts = splitStatements("INSERT INTO t VALUES ('a;b');");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("'a;b'");
  });

  it('handles doubled quotes as an escaped quote, not the end of the string', () => {
    const stmts = splitStatements("INSERT INTO t VALUES ('it''s; fine');");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("it''s; fine");
  });

  it('keeps a final statement with no trailing semicolon', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('returns an empty array for comment-only input', () => {
    expect(splitStatements('-- nothing here\n/* nor here */')).toEqual([]);
  });

  it('applies the shipped migrations without losing a statement', async () => {
    // Read the real migration files and assert every one of them yields
    // at least one executable statement. A migration that parsed to
    // nothing would mean the e2e suite ran against an incomplete schema.
    const { readFile, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const sql = await readFile(join(dir, f), 'utf8');
      const stmts = splitStatements(sql);
      expect(stmts.length, `${f} produced no statements`).toBeGreaterThan(0);
      for (const s of stmts) {
        expect(s.trim().length).toBeGreaterThan(0);
        expect(s.trim()).not.toBe('--');
      }
    }
  });
});

describe('assertLocalOnly', () => {
  it('allows loopback hosts', () => {
    expect(() => assertLocalOnly(new URL('http://127.0.0.1:8788/x'))).not.toThrow();
    expect(() => assertLocalOnly(new URL('http://localhost:8788/x'))).not.toThrow();
  });

  it('blocks the production Worker hostname', () => {
    expect(() =>
      assertLocalOnly(new URL('https://seele-memory.griptoad.workers.dev/mem/v1/recall'))
    ).toThrow(/never touch production/i);
  });

  it('blocks arbitrary remote hosts', () => {
    expect(() => assertLocalOnly(new URL('https://example.com/x'))).toThrow();
    expect(() => assertLocalOnly(new URL('http://10.0.0.5/x'))).toThrow();
  });

  it('does not accept a lookalike host that merely contains 127.0.0.1', () => {
    expect(() => assertLocalOnly(new URL('http://127.0.0.1.evil.com/x'))).toThrow();
  });
});

describe('LocalVectorize', () => {
  it('stores the exact floats it was given', async () => {
    const v = new LocalVectorize({ dimensions: 4 });
    const vals = [0.1, 0.2, 0.3, 0.4];
    await v.upsert([{ id: 'a', values: vals }]);
    expect(v.raw('a')).toEqual(vals);
  });

  it('computes a real cosine similarity, not a canned score', async () => {
    const v = new LocalVectorize({ dimensions: 3 });
    await v.upsert([{ id: 'a', values: [1, 0, 0] }]);
    const exact = await v.query([1, 0, 0], { topK: 1 });
    expect(exact.matches[0].score).toBeCloseTo(1, 10);
    const orth = await v.query([0, 1, 0], { topK: 1 });
    expect(orth.matches[0].score).toBeCloseTo(0, 10);
    const neg = await v.query([-1, 0, 0], { topK: 1 });
    expect(neg.matches[0].score).toBeCloseTo(-1, 10);
  });

  it('rejects a query with the wrong dimensionality', async () => {
    const v = new LocalVectorize({ dimensions: 3 });
    await expect(v.query([1, 2], { topK: 1 })).rejects.toThrow(/query dim 2 != index dim 3/);
  });

  it('returns the stored vector from getVectors', async () => {
    const v = new LocalVectorize({ dimensions: 3 });
    await v.upsert([{ id: 'a', values: [0.5, 0.25, 0.125] }]);
    const got = await v.getVectors(['a']);
    expect(got.vectors[0].values).toEqual([0.5, 0.25, 0.125]);
  });
});

describe('fixtureVector', () => {
  it('is deterministic', () => {
    expect(fixtureVector(3)).toEqual(fixtureVector(3));
  });

  it('is L2-normalized', () => {
    const v = fixtureVector(5);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it('is not all zeros', () => {
    expect(fixtureVector(1).some((x) => x !== 0)).toBe(true);
  });

  it('differs between seeds', () => {
    expect(fixtureVector(1)).not.toEqual(fixtureVector(2));
  });

  it('has the right dimensionality', () => {
    expect(fixtureVector(1)).toHaveLength(384);
    expect(fixtureVector(1, 8)).toHaveLength(8);
  });

  it('agrees with the cosine helper', () => {
    const a = fixtureVector(1);
    expect(cosine(a, a)).toBeCloseTo(1, 10);
    expect(cosine(a, fixtureVector(9))).toBeLessThan(0.999);
  });
});
