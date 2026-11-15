/**
 * Regression test for the devices unique-index defect that broke the
 * entire sync write path.
 *
 * Before the fix:
 *   POST /api/sync/upload -> HTTP 500
 *   D1_ERROR: foreign key mismatch - "conversations" referencing "devices"
 *
 * Root cause: 0001_initial.sql created idx_devices_user_device as a
 * NON-unique index, but `conversations` has a composite FK to
 * devices(user_id, device_id) which SQLite only accepts over a UNIQUE
 * index. The runtime repair in db.js used CREATE UNIQUE INDEX IF NOT
 * EXISTS, which is a no-op when a non-unique index of the same name
 * already exists.
 *
 * WHY THIS TEST USES REAL SQLITE (node:sqlite) AND NOT FakeD1:
 * FakeD1 documents "Foreign keys — never enforced", so it cannot
 * reproduce this defect at all — a FakeD1 test would pass both before
 * and after the fix and prove nothing. node:sqlite is real SQLite with
 * foreign_keys=ON, which is what D1 runs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema, _resetSchemaGuard } from '../src/db.js';

const SECRET = 'test-secret';

/**
 * Minimal D1-shaped adapter over a real SQLite database, so the
 * production `ensureSchema()` code runs unmodified.
 */
class SqliteD1 {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      bind: (...args) => ({
        ...bindable(stmt),
        run: async () => ({ success: true, meta: { changes: stmt.run(...args).changes } }),
        first: async () => stmt.get(...args) ?? null,
        all: async () => stmt.all(...args),
      }),
      run: async () => ({ success: true, meta: { changes: stmt.run().changes } }),
      first: async () => stmt.get() ?? null,
      all: async () => stmt.all(),
    };
  }
  async batch(statements) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}
function bindable(stmt) {
  return {
    run: async () => ({ success: true }),
    first: async () => stmt.get() ?? null,
    all: async () => stmt.all(),
  };
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * The schema as shipped in migrations/0001_initial.sql — including the
 * defect: a NON-unique idx_devices_user_device next to a composite FK.
 */
function seedDefectiveSchema(db) {
  db.exec(`
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE devices (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      app_version TEXT NOT NULL,
      public_key_ed25519 BLOB,
      last_seen_at INTEGER NOT NULL,
      subkey_id TEXT NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );
    CREATE TABLE conversations (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      llm_kind TEXT NOT NULL,
      title_encrypted BLOB,
      source_url_encrypted BLOB,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, conversation_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, device_id)
    );
    CREATE TABLE encrypted_chunks (
      chunk_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      body_encrypted BLOB NOT NULL,
      embedding BLOB,
      created_at INTEGER NOT NULL,
      client_msg_id TEXT,
      device_id TEXT,
      vector_id TEXT,
      FOREIGN KEY (user_id, conversation_id)
        REFERENCES conversations(user_id, conversation_id)
    );
    -- THE DEFECT: not UNIQUE, so the composite FK above is malformed.
    CREATE INDEX IF NOT EXISTS idx_devices_user_device
      ON devices (user_id, device_id);
  `);
}

function indexIsUnique(db) {
  const row = db
    .prepare(
      `SELECT "unique" AS u FROM pragma_index_list('devices')
       WHERE name = 'idx_devices_user_device'`
    )
    .get();
  return !!(row && row.u);
}

function tryInsertConversation(db) {
  db.prepare(`INSERT INTO users (user_id, created_at) VALUES ('u1', 1)`).run();
  db.prepare(
    `INSERT INTO devices
       (device_id, user_id, name, platform, app_version, last_seen_at, subkey_id)
     VALUES ('d1','u1','Device One','android','1.0.0',1,'d1')`
  ).run();
  db.prepare(
    `INSERT INTO conversations
       (conversation_id,user_id,device_id,llm_kind,created_at,updated_at)
     VALUES ('c1','u1','d1','chatgpt',1,1)`
  ).run();
}

describe('devices unique-index defect (real SQLite, FKs enforced)', () => {
  let db;
  let env;

  beforeEach(() => {
    db = makeDb();
    seedDefectiveSchema(db);
    env = { DB: new SqliteD1(db) };
    _resetSchemaGuard();
  });

  it('the shipped schema leaves the index NON-unique', () => {
    expect(indexIsUnique(db)).toBe(false);
  });

  it('REPRODUCES the production failure: inserting a conversation is rejected', () => {
    // This is the exact error the live server returned:
    //   D1_ERROR: foreign key mismatch - "conversations" referencing "devices"
    expect(() => tryInsertConversation(db)).toThrow(/foreign key mismatch/i);
  });

  it('ensureSchema makes the index UNIQUE', async () => {
    await ensureSchema(env.DB);
    expect(indexIsUnique(db)).toBe(true);
  });

  it('AFTER the repair, inserting a conversation succeeds', async () => {
    await ensureSchema(env.DB);
    expect(() => tryInsertConversation(db)).not.toThrow();
    const row = db
      .prepare(`SELECT conversation_id FROM conversations WHERE user_id='u1'`)
      .get();
    expect(row.conversation_id).toBe('c1');
  });

  it('ensureSchema is idempotent', async () => {
    await ensureSchema(env.DB);
    _resetSchemaGuard();
    await expect(ensureSchema(env.DB)).resolves.not.toThrow();
    expect(indexIsUnique(db)).toBe(true);
  });

  it('a database that is already correct is left alone', async () => {
    db.exec(`DROP INDEX IF EXISTS idx_devices_user_device;
             CREATE UNIQUE INDEX idx_devices_user_device
               ON devices (user_id, device_id);`);
    expect(indexIsUnique(db)).toBe(true);
    await ensureSchema(env.DB);
    expect(indexIsUnique(db)).toBe(true);
  });

  it('the migration SQL repairs the index', async () => {
    const mig = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../migrations/0004_fix_devices_unique_index.sql', import.meta.url), 'utf8')
    );
    db.exec(mig);
    expect(indexIsUnique(db)).toBe(true);
    expect(() => tryInsertConversation(db)).not.toThrow();
  });
});
