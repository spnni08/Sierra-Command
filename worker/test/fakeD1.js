// Minimal in-memory fake D1 binding for tests: enough of `env.DB.prepare(sql)
// .bind(...args).run()/.first()/.all()` to exercise the SQL
// worker/src/routes/webhook.js and worker/src/risk/riskEngine.js issue,
// without pulling in a real sqlite dependency. Tables are plain arrays of
// row objects; queries are matched by a small regex-based parser tailored
// to this codebase's actual SQL shapes, not a general SQL engine — it does
// NOT enforce CHECK constraints (see webhook.test.js's dbExitMode note) or
// FK constraints.
//
// Seed data for `strategies`/`strategy_settings`/`app_settings` (read by
// webhook.js's getStrategyRiskContext and risk/riskEngine.js) is pre-filled
// with sane defaults matching schema.sql's own seed — see
// DEFAULT_APP_SETTINGS/seedStrategy below — so a test only needs to
// override what it actually cares about.
export function createFakeD1(overrides = {}) {
  const defaultAppSettings = [
    { key: 'auto_trading_enabled', value: 'true' },
    { key: 'max_open_positions', value: '5' },
    { key: 'daily_loss_limit_usd', value: '500' },
    { key: 'trading_hours_start_utc', value: '0' },
    { key: 'trading_hours_end_utc', value: '24' }, // tests run at arbitrary times — open by default
  ];
  // Each override REPLACES the default row of the same key (not appended
  // after it) — app_settings.key is a real PRIMARY KEY in schema.sql, so
  // there is exactly one row per key here too; a naive append would leave
  // the default 'true'/'5'/etc. as the first match a WHERE key=? lookup
  // finds, silently ignoring the override.
  const overrideKeys = new Set((overrides.app_settings ?? []).map((s) => s.key));
  const appSettings = [
    ...defaultAppSettings.filter((s) => !overrideKeys.has(s.key)),
    ...(overrides.app_settings ?? []),
  ];

  const tables = {
    signals: [],
    trades: [],
    activity_log: [],
    strategies: [],
    strategy_settings: [],
    app_settings: appSettings,
  };

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
    tables[table] = tables[table] ?? [];
    tables[table].push(row);
    return row;
  }

  // Splits a `WHERE a = ? AND b >= ? AND c < ?`-style clause into
  // [{col, op}] in source order, matching against `args` positionally —
  // every value in this codebase's WHERE clauses is either `?` or a bare
  // string/number literal (e.g. `status = 'open'`), never a subquery.
  function parseConditions(whereSql) {
    const parts = whereSql.split(/\bAND\b/i).map((p) => p.trim());
    return parts.map((p) => {
      const m = p.match(/^([\w.]+)\s*(=|>=|<=|<|>)\s*(\?|'[^']*'|\w+)$/);
      if (!m) throw new Error(`fakeD1: cannot parse WHERE condition: ${p}`);
      const [, rawCol, op, rawVal] = m;
      const col = rawCol.includes('.') ? rawCol.split('.')[1] : rawCol;
      return { col, op, literal: rawVal === '?' ? undefined : rawVal.replace(/^'|'$/g, '') };
    });
  }

  function applyConditions(rows, conditions, args) {
    // Resolve each condition's comparison value ONCE, before filtering —
    // args map positionally to conditions (one `?` per bound value), not to
    // rows. Incrementing an arg-index inside the per-row predicate (a
    // previous version of this function did) exhausts `args` after the
    // first row on any query matching more than one row.
    let argIdx = 0;
    const resolved = conditions.map((c) => ({ ...c, value: c.literal !== undefined ? c.literal : args[argIdx++] }));
    return rows.filter((row) =>
      resolved.every((c) => {
        const val = c.value;
        const cell = row[c.col];
        switch (c.op) {
          case '=':
            return String(cell) === String(val);
          case '>=':
            return cell >= val;
          case '<=':
            return cell <= val;
          case '<':
            return cell < val;
          case '>':
            return cell > val;
          default:
            throw new Error(`fakeD1: unsupported operator ${c.op}`);
        }
      })
    );
  }

  // SELECT s.active AS active, ss.session_filter AS session_filter FROM
  // strategies s LEFT JOIN strategy_settings ss ON ss.strategy_id = s.id
  // WHERE s.id = ? — the one join query in this codebase, handled directly
  // rather than generalizing JOIN support.
  function selectStrategyRiskContext(args) {
    const strategy = tables.strategies.find((s) => s.id === args[0]);
    if (!strategy) return null;
    const settings = tables.strategy_settings.find((s) => s.strategy_id === args[0]);
    return { active: strategy.active, session_filter: settings?.session_filter ?? null };
  }

  function selectOne(sql, args) {
    if (/FROM strategies s\s+LEFT JOIN strategy_settings/is.test(sql)) {
      return selectStrategyRiskContext(args);
    }
    const star = sql.match(/^\s*SELECT \* FROM (\w+) WHERE (.+?)\s*(?:LIMIT|$)/is);
    if (star) {
      const [, table, whereSql] = star;
      const rows = applyConditions(tables[table] ?? [], parseConditions(whereSql), args);
      return rows[0] ?? null;
    }
    const cols = sql.match(/^\s*SELECT (.+?) FROM (\w+)(?:\s+WHERE (.+?))?\s*(?:LIMIT\s+\d+)?\s*$/is);
    if (cols) {
      const [, colList, table, whereSql] = cols;
      const rows = whereSql ? applyConditions(tables[table] ?? [], parseConditions(whereSql), args) : tables[table] ?? [];
      if (rows.length === 0 && /^\s*SELECT 1 /i.test(sql)) return null; // existence probe, no match
      const row = rows[0];
      if (!row && !/^\s*SELECT 1 /i.test(sql)) return null;
      if (/^\s*SELECT 1 /i.test(sql)) return row ? { 1: 1 } : null;
      if (/COALESCE\(SUM\(pnl\), 0\) AS total/i.test(colList)) {
        const total = rows.reduce((sum, r) => sum + (Number(r.pnl) || 0), 0);
        return { total };
      }
      return row;
    }
    throw new Error(`fakeD1: cannot parse single-row SELECT: ${sql}`);
  }

  function selectAll(sql, args) {
    const m = sql.match(/^\s*SELECT (.+?) FROM (\w+)(?:\s+WHERE (.+?))?\s*$/is);
    if (!m) throw new Error(`fakeD1: cannot parse SELECT ... (.all()): ${sql}`);
    const [, colList, table, whereSql] = m;
    let rows = whereSql ? applyConditions(tables[table] ?? [], parseConditions(whereSql), args) : (tables[table] ?? []).slice();
    if (/COALESCE\(position_group_id, id\) AS pos_key/i.test(colList)) {
      rows = rows.map((r) => ({ pos_key: r.position_group_id ?? r.id }));
    }
    return { results: rows };
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
          if (/^\s*SELECT/i.test(sql)) return selectOne(sql, this._args);
          throw new Error(`fakeD1: unsupported .first() SQL: ${sql}`);
        },
        async all() {
          if (/^\s*SELECT/i.test(sql)) return selectAll(sql, this._args);
          throw new Error(`fakeD1: unsupported .all() SQL: ${sql}`);
        },
      };
    },
  };

  // Seed every strategy id the test suite actually posts to, active by
  // default with no session restriction — matches schema.sql's own seed
  // (active=1, session_filter='[]'). A test that needs an inactive
  // strategy or a session filter overrides the row directly via
  // `tables.strategies`/`tables.strategy_settings`.
  const KNOWN_STRATEGY_IDS = [
    'crypto_baseline', 'crypto_baseline_sl',
    'crypto_sr_volume', 'crypto_sr_volume_sl',
    'crypto_orderflow_breakout', 'crypto_orderflow_breakout_sl',
    'crypto_ichimoku_breakout', 'crypto_ichimoku_breakout_sl',
    'crypto_sr_bollinger', 'crypto_sr_bollinger_sl',
    'crypto_sr_exclusion', 'crypto_sr_exclusion_sl',
    'crypto_ict_smc', 'crypto_ict_smc_sl',
    'crypto_flawless_victory', 'crypto_flawless_victory_sl',
    'crypto_flawless_victory_v2', 'crypto_flawless_victory_v3',
    'crypto_mfi_engulfing', 'crypto_mfi_engulfing_sl',
    'crypto_holy_grail_adx_sma_bb', 'crypto_holy_grail_adx_sma_bb_sl',
    'crypto_bb_rsi_trendfilter', 'crypto_bb_rsi_trendfilter_sl',
    'ict_sweep_mss', 'ict_sweep_mss_sl',
    'sc_keylevel_sweep',
  ];
  for (const id of KNOWN_STRATEGY_IDS) {
    tables.strategies.push({ id, active: 1 });
    tables.strategy_settings.push({ strategy_id: id, session_filter: '[]' });
  }

  return { DB, tables };
}
