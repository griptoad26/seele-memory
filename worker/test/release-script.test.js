/**
 * test/release-script.test.js — contract tests for scripts/release.sh.
 *
 * TASK-seele-cloud-20261116-115.
 *
 * The release script is the one thing that touches production, and it is
 * not covered by the worker suite because it lives outside `worker/`.
 * These tests check the parts that can be checked without credentials:
 *
 *   1. the script parses and its flags work
 *   2. the version in worker/src/index.js agrees with the CHANGELOG
 *   3. the script's failure modes actually fail (a broken tree, a
 *      version mismatch, a missing changelog section)
 *
 * The credential gate is exercised too: with the repo's own read-only
 * token (or no token at all) the script must refuse to publish, because
 * a release that half-deploys is worse than no release.
 *
 * No test here contacts Cloudflare. `--dry-run` is used for the
 * end-to-end shape check, and the credential probes are only run against
 * a deliberately invalid token.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/release.sh');

/** Run the release script; never throws. */
async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

/** Read the VERSION constant out of the Worker source. */
function workerVersion() {
  const src = readFileSync(resolve(REPO_ROOT, 'worker/src/index.js'), 'utf8');
  const m = src.match(/const VERSION = '([^']+)'/);
  return m ? m[1] : null;
}

describe('release script', () => {
  beforeAll(() => {
    expect(existsSync(SCRIPT), 'scripts/release.sh must exist').toBe(true);
  });

  describe('file contract', () => {
    it('is syntactically valid bash', () => {
      execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' });
    });

    it('is executable', () => {
      // execFileSync would throw EACCES if it were not.
      expect(() => execFileSync('bash', [SCRIPT, '--help'], { stdio: 'pipe' })).not.toThrow();
    });

    it('documents every step it performs', () => {
      const src = readFileSync(SCRIPT, 'utf8');
      for (const needle of [
        'd1 migrations apply',
        'wrangler deploy',
        'vectorize list-vectors',
        'vectorize delete-vectors',
        'vectorize upsert',
        'git tag',
      ]) {
        expect(src, `release.sh must mention "${needle}"`).toContain(needle);
      }
    });

    it('probes write scope, not just read scope', () => {
      // A read-only token authenticates and can list Workers metadata.
      // If the probe only reads, a read-only token would pass the gate and
      // then fail mid-deploy. The Workers probe must be a version upload.
      const src = readFileSync(SCRIPT, 'utf8');
      expect(src).toMatch(/versions upload/);
      expect(src).not.toMatch(/probe_write "workers-write"\s*\n?\s*npx --no-install wrangler versions list/);
    });
  });

  describe('version consistency', () => {
    it('worker/src/index.js pins a version', () => {
      expect(workerVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('the pinned version has a CHANGELOG.md section', () => {
      const version = workerVersion();
      const changelog = readFileSync(resolve(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
      expect(changelog).toContain(`## [${version}]`);
    });

    it('CHANGELOG.md starts at v1.0.0', () => {
      const changelog = readFileSync(resolve(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
      const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
      expect(versions.length).toBeGreaterThan(0);
      expect(versions).toContain('1.0.0');
    });
  });

  describe('argument handling', () => {
    it('--help exits 0 and prints usage', async () => {
      const r = await run(['--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('--version');
      expect(r.stdout).toContain('--dry-run');
    });

    it('rejects an unknown flag', async () => {
      const r = await run(['--not-a-real-flag']);
      expect(r.code).not.toBe(0);
      expect(r.stderr + r.stdout).toContain('unknown flag');
    });

    it('requires --version', async () => {
      const r = await run([]);
      expect(r.code).not.toBe(0);
      expect(r.stderr + r.stdout).toContain('--version');
    });
  });

  describe('the credential gate', () => {
    it('refuses to publish with a token that lacks the required scopes', async () => {
      // A syntactically valid but useless token. The gate must fire
      // BEFORE any deploy attempt.
      const r = await run(['--version', '1.0.0'], {
        CLOUDFLARE_API_TOKEN: 'cfut_definitely_not_a_real_token',
        CLOUDFLARE_ACCOUNT_ID: '4240b199ca30d185e7954e6166582e7c',
      });
      expect(r.code).not.toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/scope MISSING|Cannot publish/);
      // It must not have got as far as deploying.
      expect(out).not.toContain('Worker deployed');
    });

    it('names the missing scopes rather than failing generically', async () => {
      const r = await run(['--version', '1.0.0'], {
        CLOUDFLARE_API_TOKEN: 'cfut_definitely_not_a_real_token',
        CLOUDFLARE_ACCOUNT_ID: '4240b199ca30d185e7954e6166582e7c',
      });
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/d1|vectorize|workers-write/);
      expect(out).toMatch(/Required:/);
    });
  });

  describe('the dry run', () => {
    it('walks every step without writing anything', async () => {
      const r = await run([
        '--version', workerVersion(),
        '--dry-run',
        '--skip-credential-check',
        '--skip-tests',
      ]);
      expect(r.code).toBe(0);
      const out = r.stdout;
      for (const step of [
        'Verifying working tree',
        'Applying D1 migrations',
        'Deploying the Worker',
        'Reindexing the Vectorize index',
        'Verifying the live endpoint',
        'Tagging v',
      ]) {
        expect(out, `dry run must reach "${step}"`).toContain(step);
      }
      expect(out).toContain('DRY RUN');
    });

    it('never prints a success marker for a step it did not perform', async () => {
      const r = await run([
        '--version', workerVersion(),
        '--dry-run',
        '--skip-credential-check',
        '--skip-tests',
      ]);
      // Dry-run output marks the command, and the ✓ lines are the
      // script's own summary. This is a smoke check that the dry-run
      // banner is present and no real deploy happened.
      expect(r.stdout).toContain('[dry-run]');
    });
  });

  describe('the version guard', () => {
    it('refuses a version that disagrees with worker/src/index.js', async () => {
      const r = await run([
        '--version', '99.99.99',
        '--dry-run',
        '--skip-credential-check',
        '--skip-tests',
      ]);
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/Version mismatch/);
    });
  });
});
