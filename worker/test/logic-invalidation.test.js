import { describe, it, expect } from 'vitest';
import { hashAdapterSource, generateInvalidationSql } from '../scripts/lib/logic-invalidation-sql.mjs';
import { ADAPTERS } from '../src/backtest/adapters.js';

// Round-trip against real SQLite (wrangler d1 execute --local against
// schema.sql, seeding a fake backtest_runs/backtest_session_breakdown row,
// running the generated SQL, then changing one adapter function's source
// and re-running) was verified manually during development — see this
// feature's PR description for the exact commands and observed results
// (only the changed strategy's runs were deleted; an unrelated strategy's
// runs and a same-adapter sibling strategy with no prior runs were both
// left alone; a second run with an unchanged hash was a no-op). These tests
// cover the pure hashing/SQL-generation logic that behavior depends on.

describe('hashAdapterSource', () => {
  it('gives identical strategies (same adapter function) the same hash', () => {
    // Mirrors ADAPTERS: crypto_baseline and crypto_baseline_sl both map to
    // buildCryptoBaseline — same logic, so same hash is correct, not a bug.
    expect(hashAdapterSource(ADAPTERS.crypto_baseline)).toBe(hashAdapterSource(ADAPTERS.crypto_baseline_sl));
  });

  it('gives different adapter functions different hashes', () => {
    expect(hashAdapterSource(ADAPTERS.crypto_baseline)).not.toBe(hashAdapterSource(ADAPTERS.crypto_sr_bollinger));
  });

  it('changes when a function\'s source text changes at all', () => {
    function v1(x) { return x + 1; }
    function v2(x) { return x + 2; }
    expect(hashAdapterSource(v1)).not.toBe(hashAdapterSource(v2));
  });

  it('is stable across repeated calls for the same function', () => {
    function v1(x) { return x + 1; }
    expect(hashAdapterSource(v1)).toBe(hashAdapterSource(v1));
  });
});

describe('generateInvalidationSql', () => {
  it('emits one UPDATE/DELETE/DELETE/INSERT block per strategy in the map, nothing for strategies outside it', () => {
    const sql = generateInvalidationSql({ crypto_baseline: ADAPTERS.crypto_baseline });

    expect(sql).toContain("WHERE strategy_id = 'crypto_baseline'");
    expect((sql.match(/UPDATE strategy_logic_versions/g) || []).length).toBe(1);
    expect((sql.match(/DELETE FROM backtest_session_breakdown/g) || []).length).toBe(1);
    expect((sql.match(/DELETE FROM backtest_trades/g) || []).length).toBe(1);
    expect((sql.match(/DELETE FROM backtest_runs/g) || []).length).toBe(1);
    expect((sql.match(/INSERT INTO strategy_logic_versions/g) || []).length).toBe(1);
    // no_indicator_adapter strategies (e.g. crypto_mfi_engulfing) are never
    // in ADAPTERS and must never appear here — they can't have
    // backtest_runs, so there is nothing for them to invalidate.
    expect(sql).not.toContain('crypto_mfi_engulfing');
  });

  it('covers every strategy actually registered in ADAPTERS, in one call', () => {
    const sql = generateInvalidationSql(ADAPTERS);
    for (const strategyId of Object.keys(ADAPTERS)) {
      expect(sql).toContain(`WHERE strategy_id = '${strategyId}'`);
    }
  });

  it('gates the deletes and the invalidation marker on the hash actually differing, never unconditionally', () => {
    const sql = generateInvalidationSql({ crypto_baseline: ADAPTERS.crypto_baseline });
    // Every DELETE/UPDATE must be guarded by a logic_hash <> comparison —
    // an unguarded DELETE would wipe backtest_runs on every single deploy,
    // not just on an actual logic change.
    const deleteBlocks = sql.split(/\n\n/).filter((b) => /^DELETE|^UPDATE/.test(b));
    expect(deleteBlocks.length).toBeGreaterThan(0);
    for (const block of deleteBlocks) {
      expect(block).toMatch(/logic_hash\s*<>/);
    }
  });
});
