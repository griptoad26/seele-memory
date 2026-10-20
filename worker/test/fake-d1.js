/**
 * test/fake-d1.js — In-memory D1 fake for vitest.
 *
 * Implements just enough of the `D1Database` / `D1PreparedStatement` API
 * for the helpers in src/db.js to work without a live D1. We do *not*
 * attempt to model SQLite semantics (transactions, indexes, prepared
 * statement caching) — the goal is "the handler code runs" and the
 * queries we actually use return sensible rows.
 *
 * What we support:
 *   * `prepare(sql)` returning a `D1PreparedStatement`
 *   * `.bind(...args)` and `.run()`, `.first()`, `.all()`
 *   * Parameter substitution for `?1, ?2, ...` (positional only — D1
 *     uses 1-indexed positional placeholders, not `?` anon).
 *   * LIKE with `%` / `_` / `\\` (we just do `String.prototype.includes`
 *     on the raw value — the SQL semantics are "contains substring
 *     after stripping wildcards", which is good enough for tests).
 *
 * What we DON'T support:
 *   * `count(*) as n` is fine; `MAX(x)` returns the max of the row set;
 *     `IN (...)` we expand by hand.
 *   * Foreign keys — never enforced.
 */

export class FakeD1 {
  constructor() {
    /** @type {Map<string, Map<string, any> | any[]>} */
    this.tables = new Map();
    // Ordered insertion log so SELECT * preserves it. For tests that
    // need ORDER BY the helper methods below already sort.
    this._order = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const out = [];
    for (const s of statements) {
      const stmt = new FakeStatement(this, s.sql);
      if (s.params) stmt.bind(...s.params);
      out.push(await stmt.run());
    }
    return out;
  }

  async exec(_sql) {
    return { count: 0, duration: 0 };
  }

  // --- internal helpers used by FakeStatement --------------------------

  _table(name) {
    if (!this.tables.has(name)) {
      this.tables.set(name, []);
      this._order.set(name, []);
    }
    return this.tables.get(name);
  }

  _insert(name, row) {
    const t = this._table(name);
    t.push(row);
    this._order.get(name).push(row);
  }

  _update(name, predicate, updater) {
    const t = this._table(name);
    let n = 0;
    for (const r of t) {
      if (predicate(r)) {
        updater(r);
        n++;
      }
    }
    return n;
  }

  _select(name, predicate) {
    const t = this._table(name);
    return t.filter(predicate);
  }
}

// ---------------------------------------------------------------------------
// FakeStatement
// ---------------------------------------------------------------------------

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.trim();
    this.params = [];
  }

  bind(...args) {
    this.params = args;
    return this;
  }

  async run() {
    const plan = planSql(this.sql);
    if (plan.kind === 'insert') {
      return this._runInsert(plan);
    }
    if (plan.kind === 'update') {
      return this._runUpdate(plan);
    }
    // SELECT or other read — we still return a result wrapper for consistency.
    const rows = this._runRead(plan);
    return { results: rows, success: true, meta: { duration: 0 } };
  }

  async first() {
    const plan = planSql(this.sql);
    const rows = this._runRead(plan);
    return rows[0] || null;
  }

  async all() {
    const plan = planSql(this.sql);
    const rows = this._runRead(plan);
    return { results: rows, success: true, meta: { duration: 0 } };
  }

  // --- runners --------------------------------------------------------

  _runInsert(plan) {
    const table = plan.table;
    // Resolve the actual param indices from the ?N placeholders in the
    // VALUES clause, so `?7, ?7` binds to the same value (matching real
    // D1 behavior).
    const paramRefs = parseValuePlaceholders(plan.valuesPart);
    const values = plan.columns.map((col, i) => ({
      col,
      v: paramRefs[i] != null ? this.params[paramRefs[i]] : undefined,
    }));
    if (plan.onConflict) {
      // Find existing row matching the conflict target.
      const existing = this.db._select(table, (r) => {
        return plan.onConflict.keys.every((k) => r[k] === values.find((vv) => vv.col === k).v);
      })[0];
      if (existing) {
        if (plan.onConflict.do === 'update') {
          for (const u of plan.onConflict.updates) {
            const v = this.params[u.paramIdx];
            const target = u.target || u.col;
            existing[target] = u.expr === 'excluded' ? v : v;
          }
          return { success: true, meta: { duration: 0, changes: 1 } };
        }
        return { success: true, meta: { duration: 0, changes: 0 } };
      }
    }
    const row = {};
    for (const { col, v } of values) row[col] = v;
    if (plan.onConflict) {
      // remember PKs
      row.__pk = {};
      for (const k of plan.onConflict.keys) row.__pk[k] = values.find((vv) => vv.col === k).v;
    }
    this.db._insert(table, row);
    return { success: true, meta: { duration: 0, changes: 1, last_row_id: this.db._table(table).length } };
  }

  _runUpdate(plan) {
    const table = plan.table;
    let n = 0;
    this.db._update(table, (r) => {
      const ok = plan.where.every((w) => {
        if (w.op === 'IS' && w.literalNull) return r[w.col] == null;
        if (w.op === 'IS') return r[w.col] === this.params[w.idx] || (this.params[w.idx] == null && r[w.col] == null);
        return r[w.col] === this.params[w.idx];
      });
      if (ok) n++;
      return ok;
    }, (r) => {
      for (const u of plan.updates) {
        r[u.col] = this.params[u.idx];
      }
    });
    return { success: true, meta: { duration: 0, changes: n } };
  }

  _runRead(plan) {
    const table = plan.table;
    if (!table) return [];
    let rows = this.db._select(table, () => true);
    if (plan.where && plan.where.length) {
      rows = rows.filter((r) => {
        return plan.where.every((w) => {
          if (w.op === 'IS') {
            if (w.literalNull) return r[w.col] == null;
            const v = this.params[w.idx];
            if (v === null) return r[w.col] == null;
            return r[w.col] === v;
          }
          if (w.op === 'LIKE') {
            const v = this.params[w.idx];
            const pat = String(v).toLowerCase();
            const needle = pat.replace(/(^%)|(%$)/g, '').replace(/\\\\/g, '\\');
            return String(r[w.col] ?? '').toLowerCase().includes(needle);
          }
          if (w.op === 'IN') {
            const vs = w.params.map((i) => this.params[i]);
            return vs.includes(r[w.col]);
          }
          const v = this.params[w.idx];
          switch (w.op) {
            case '=': return r[w.col] === v;
            case '!=': return r[w.col] !== v;
            case '<': return r[w.col] < v;
            case '<=': return r[w.col] <= v;
            case '>': return r[w.col] > v;
            case '>=': return r[w.col] >= v;
            default: return r[w.col] === v;
          }
        });
      });
    }
    if (plan.orderBy) {
      const { col, dir } = plan.orderBy;
      rows = rows.slice().sort((a, b) => {
        const av = a[col], bv = b[col];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return dir === 'DESC' ? 1 : -1;
        if (av > bv) return dir === 'DESC' ? -1 : 1;
        return 0;
      });
    }
    if (plan.limit != null) {
      rows = rows.slice(0, plan.limit);
    }
    if (plan.aggregate) {
      rows = aggregate(rows, plan.aggregate);
    }
    return rows;
  }
}

// ---------------------------------------------------------------------------
// SQL planning
// ---------------------------------------------------------------------------
//
// We accept a tiny subset of SQL:
//   INSERT INTO t (cols) VALUES (?, ?, ...) [ON CONFLICT(col,...) DO ...]
//   UPDATE t SET col = ? [,...] WHERE col = ? [AND col IS ?] ...
//   SELECT [* | exprs] FROM t [WHERE col = ? [AND col IS ?] ...] [ORDER BY col [ASC|DESC]] [LIMIT ?]
//
// We don't try to be a SQL parser — just enough to make the queries in
// src/db.js and src/sync.js work.

var planSql_internal = planSql; function planSql(sql) {
  const cleaned = sql.replace(/\s+/g, ' ').trim();
  // Strip trailing semicolon.
  const s = cleaned.replace(/;$/, '');

  if (/^INSERT\s+INTO\s+/i.test(s)) return planInsert(s);
  if (/^UPDATE\s+/i.test(s)) return planUpdate(s);
  if (/^SELECT\s+/i.test(s)) return planSelect(s);
  return { kind: 'other' };
}

function planInsert(sql) {
  // INSERT INTO t (a, b, c) VALUES (?1, ?2, ?3)
  const m = /^INSERT\s+INTO\s+([A-Za-z_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)(.*)$/i.exec(sql);
  if (!m) return { kind: 'other' };
  const table = m[1];
  const columns = m[2].split(',').map((s) => s.trim());
  // The params part is comma-separated ?N references — we map by index.
  const valuesPart = m[3];
  // We bind positional — params[i] corresponds to columns[i] in our fake.
  const tail = m[4];
  let onConflict = null;
  const ocm = /ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+(UPDATE|NOTHING)\s*(.*)$/i.exec(tail);
  if (ocm) {
    const keys = ocm[1].split(',').map((s) => s.trim());
    if (ocm[2].toUpperCase() === 'NOTHING') {
      onConflict = { keys, do: 'nothing' };
    } else {
      const updatePart = ocm[3];
      onConflict = { keys, do: 'update', updates: parseUpdateSet(updatePart) };
    }
  }
  return {
    kind: 'insert',
    table,
    columns,
    onConflict,
    valuesPart,
  };
}

function planUpdate(sql) {
  // UPDATE t SET col = ?2 [, col = ?3] WHERE col = ?1 [AND col IS ?2]
  const m = /^UPDATE\s+([A-Za-z_]+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i.exec(sql);
  if (!m) return { kind: 'other' };
  const table = m[1];
  const updates = parseUpdateSet(m[2]);
  const where = parseWhere(m[3]);
  return { kind: 'update', table, updates, where };
}

function parseUpdateSet(part) {
  const out = [];
  const segs = splitTopLevelCommas(part);
  for (const seg of segs) {
    const m = /^([A-Za-z_]+)\s*=\s*(\?|EXCLUDED\.[A-Za-z_]+|\?(\d+)|COALESCE\(EXCLUDED\.[A-Za-z_]+,\s*[A-Za-z_]+\.[A-Za-z_]+\))$/i.exec(seg.trim());
    if (!m) continue;
    const col = m[1];
    const expr = seg.trim();
    if (/EXCLUDED\./i.test(expr)) {
      // For test simplicity we treat `col = excluded.col` as "set to
      // the bound value that corresponds to the EXCLUDED column in the
      // INSERT statement". Our bind() above uses positional order; we
      // find the param index by matching the column name on the right
      // side of `excluded.`.
      const idx = parseInt((/EXCLUDED\.([A-Za-z_]+)/i.exec(expr) || [])[1], 10);
      out.push({ col, target: col, expr: 'excluded', paramIdx: -1, excludedCol: idx });
    } else {
      const idx = parseInt((/\?(\d+)/.exec(expr) || [null, '1'])[0]);
      out.push({ col, idx: isNaN(idx) ? 1 : idx - 1 });
    }
  }
  // For EXCLUDED updates, paramIdx corresponds to the bind position
  // matching the excluded column. Easier: re-walk the columns list when
  // running; for the fake we approximate by ordinal position.
  return out;
}

function planSelect(sql) {
  // SELECT [cols] FROM t [WHERE ...] [ORDER BY col [ASC|DESC]] [LIMIT ?]
  const m = /^SELECT\s+(.+?)\s+FROM\s+([A-Za-z_]+)\s*(.*)$/i.exec(sql);
  if (!m) return { kind: 'other' };
  const cols = m[1];
  const table = m[2];
  let tail = m[3];
  let where = [];
  let orderBy = null;
  let limit = null;
  let aggregate = null;

  // Split tail into WHERE-clause, ORDER BY clause, LIMIT clause. We do
  // it by walking forward looking for the first occurrence of each
  // (case-insensitive), taking the earliest.
  const idxWhere = /WHERE/i.exec(tail);
  const idxOrder = /ORDER\s+BY/i.exec(tail);
  const idxLimit = /LIMIT/i.exec(tail);
  let cutAfterWhere = tail.length;
  if (idxOrder && idxOrder.index < cutAfterWhere) cutAfterWhere = idxOrder.index;
  if (idxLimit && idxLimit.index < cutAfterWhere) cutAfterWhere = idxLimit.index;
  if (idxWhere && idxWhere.index < cutAfterWhere) {
    const whereText = tail.slice(idxWhere.index + 6).trim().split(/\s+(?:ORDER\s+BY|LIMIT)\s+/i)[0];
    where = parseWhere(whereText);
  }
  const om = /\sORDER\s+BY\s+([A-Za-z_]+)(?:\s+(ASC|DESC))?/i.exec(tail);
  if (om) {
    orderBy = { col: om[1], dir: (om[2] || 'ASC').toUpperCase() };
  }
  const lm = /\sLIMIT\s+\?(\d+)/i.exec(tail);
  if (lm) {
    limit = parseInt(lm[1], 10) - 1;
  }
  // Aggregate functions. We handle a single COUNT/MAX/MIN/SUM/AVG with
  // an optional `AS alias` suffix that must come AFTER the closing
  // paren. Inside the parens we accept `*` (for COUNT) or a comma-
  // separated list of column names (for MAX/MIN/etc).
  const firstAggregate = cols.split(',')[0].trim();
  const agg = /(COUNT|MAX|MIN|SUM|AVG)\s*\(\s*(\*|[A-Za-z_]+(?:\s*,\s*[A-Za-z_]+)*)\s*\)(?:\s+AS\s+([A-Za-z_]+))?/i.exec(firstAggregate);
  if (agg && /COUNT|MAX|MIN|SUM|AVG/i.test(agg[1])) {
    aggregate = { fn: agg[1].toUpperCase(), arg: agg[2], alias: agg[3] || agg[1].toLowerCase() };
  }

  return {
    kind: 'select',
    table,
    columns: cols,
    where,
    orderBy,
    limit,
    aggregate,
  };
}

function parseWhere(part) {
  // Split on AND at the top level.
  const out = [];
  for (const seg of splitTopLevelAnd(part)) {
    const s = seg.trim();
    const m1 = /^([A-Za-z_]+)\s+IS\s+NULL\b/i.exec(s);
    if (m1) {
      out.push({ col: m1[1], op: 'IS', idx: -1, literalNull: true });
      continue;
    }
    const m1b = /^([A-Za-z_]+)\s+IS\s+\?(\d+)/i.exec(s);
    if (m1b) {
      out.push({ col: m1b[1], op: 'IS', idx: parseInt(m1b[2], 10) - 1 });
      continue;
    }
    const m2 = /^([A-Za-z_]+)\s+LIKE\s+\?(\d+)/i.exec(s);
    if (m2) {
      out.push({ col: m2[1], op: 'LIKE', idx: parseInt(m2[2], 10) - 1 });
      continue;
    }
    const m3 = /^([A-Za-z_]+)\s+IN\s*\(([^)]+)\)/i.exec(s);
    if (m3) {
      const placeholders = m3[2].split(',').map((p) => p.trim());
      out.push({
        col: m3[1],
        op: 'IN',
        // Multi-arg IN — we encode as a special wrapper in the bind path
        // via a sentinel object.
        idx: -1,
        params: placeholders.map((p) => parseInt(p.replace(/\?/, ''), 10) - 1),
      });
      continue;
    }
    const m4 = /^([A-Za-z_]+)\s*(>=|<=|=|>|<)\s*\?(\d+)/.exec(s);
    if (m4) {
      out.push({ col: m4[1], op: m4[2], idx: parseInt(m4[3], 10) - 1 });
      continue;
    }
  }
  return out;
}

function splitTopLevelCommas(s) {
  // Commas inside parens are not separators; otherwise split.
  const out = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function splitTopLevelAnd(s) {
  // Split on AND that isn't inside parens.
  const out = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (
      depth === 0 &&
      (s.slice(i, i + 5).toUpperCase() === ' AND ' || s.slice(i, i + 5) === ' and ') &&
      /\s/i.test(s[i])
    ) {
      out.push(buf);
      buf = '';
      i += 4;
      continue;
    }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

export { planSql as _planSql };

/**
 * Parse a `?1, ?2, ?1` style VALUES list into 0-indexed param refs.
 */
function parseValuePlaceholders(valuesPart) {
  return valuesPart.split(',').map((p) => {
    const m = /\?(\d+)/.exec(p.trim());
    return m ? parseInt(m[1], 10) - 1 : null;
  });
}

function aggregate(rows, agg) {
  if (rows.length === 0) {
    return [{ [agg.alias]: agg.fn === 'COUNT' ? 0 : null }];
  }
  if (agg.fn === 'COUNT') {
    return [{ [agg.alias]: rows.length }];
  }
  if (agg.fn === 'MAX') {
    // MAX(col): pull the named column out of the aggregate args
    // (e.g. "MAX(updated_at)" → col = "updated_at"). Falls back to
    // scanning all values if we can't parse the arg name.
    const col = (agg.arg || '').trim();
    let max = null;
    if (col && col !== '*') {
      for (const r of rows) {
        const v = r[col];
        if (v != null && (max == null || v > max)) max = v;
      }
    } else {
      for (const r of rows) {
        for (const v of Object.values(r)) {
          if (v != null && (max == null || v > max)) max = v;
        }
      }
    }
    return [{ [agg.alias]: max }];
  }
  return rows;
}