// Minimal in-memory fake D1 binding for tests: enough of `env.DB.prepare(sql)
// .bind(...args).run()/.first()/.all()` to exercise the handful of
// INSERT/SELECT statements worker/src/routes/webhook.js issues, without
// pulling in a real sqlite dependency. Tables are plain arrays of row
// objects; INSERT/SELECT are matched by a small regex-based parser tailored
// to this codebase's SQL, not a general SQL engine.
export function createFakeD1() {
  const tables = { signals: [], trades: [], activity_log: [] };

  function insert(sql, args) {
    const m = sql.match(/INSERT INTO (\w+) \(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/is);
    if (!m) throw new Error(`fakeD1: cannot parse INSERT: ${sql}`);
    const table = m[1];
    const columns = m[2].split(',').map((c) => c.trim());
    const placeholders = m[3].split(',').map((v) => v.trim());
    let argIdx = 0;
    const row = {};
    placeholders.forEach((ph, i) => {
      const col = columns[i];
      if (ph === '?') {
        row[col] = args[argIdx++];
      } else if (ph.toUpperCase() === 'NULL') {
        row[col] = null;
      } else {
        row[col] = ph.replace(/^'|'$/g, '');
      }
    });
    tables[table].push(row);
    return row;
  }

  function select(sql, args) {
    const m = sql.match(/SELECT \* FROM (\w+) WHERE (\w+)\s*=\s*\?/i);
    if (!m) throw new Error(`fakeD1: cannot parse SELECT: ${sql}`);
    const [, table, col] = m;
    return tables[table].find((r) => r[col] === args[0]) ?? null;
  }

  const DB = {
    prepare(sql) {
      return {
        _args: [],
        bind(...args) {
          this._args = args;
          return this;
        },
        async run() {
          if (/^\s*INSERT/i.test(sql)) return { results: [insert(sql, this._args)] };
          throw new Error(`fakeD1: unsupported .run() SQL: ${sql}`);
        },
        async first() {
          if (/^\s*SELECT/i.test(sql)) return select(sql, this._args);
          throw new Error(`fakeD1: unsupported .first() SQL: ${sql}`);
        },
      };
    },
  };

  return { DB, tables };
}
