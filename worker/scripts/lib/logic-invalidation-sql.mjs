// Pure logic for generate-logic-invalidation-sql.mjs, split out so it can
// be unit-tested without touching D1 (see worker/test/logic-invalidation.test.js
// for the round-trip-against-real-SQLite verification via wrangler d1
// execute --local, documented there rather than re-implemented as a fake).
import { createHash } from 'node:crypto';

export function hashAdapterSource(adapterFn) {
  return createHash('sha256').update(adapterFn.toString(), 'utf8').digest('hex');
}

export function sqlString(value) {
  // All values passed through here are our own strategy ids / hex hashes,
  // not external input — quoting is just SQL syntax, not an injection
  // boundary. Escaped anyway (' -> '') as cheap, standard SQLite practice.
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildStatementsForStrategy(strategyId, hash) {
  const id = sqlString(strategyId);
  const h = sqlString(hash);
  return [
    // Record "did this change actually invalidate anything" BEFORE the
    // deletes below run — has to happen first, since after the DELETE FROM
    // backtest_runs statement there would be nothing left to check against.
    `UPDATE strategy_logic_versions
SET last_invalidated_at = CASE
      WHEN logic_hash <> ${h} AND EXISTS (SELECT 1 FROM backtest_runs WHERE strategy_id = ${id})
      THEN datetime('now')
      ELSE last_invalidated_at
    END
WHERE strategy_id = ${id};`,
    // Children before parents — no PRAGMA foreign_keys=OFF/backup-restore
    // needed here (unlike the trades-table rebuild migration this mirrors
    // the spirit of): this is a plain cascade delete, not a table rebuild,
    // so normal FK enforcement is satisfied by ordering alone.
    `DELETE FROM backtest_session_breakdown
WHERE backtest_run_id IN (SELECT id FROM backtest_runs WHERE strategy_id = ${id})
  AND EXISTS (SELECT 1 FROM strategy_logic_versions WHERE strategy_id = ${id} AND logic_hash <> ${h});`,
    `DELETE FROM backtest_runs
WHERE strategy_id = ${id}
  AND EXISTS (SELECT 1 FROM strategy_logic_versions WHERE strategy_id = ${id} AND logic_hash <> ${h});`,
    // Captures the new hash. On a strategy's very first run here (no prior
    // row) this INSERTs fresh with last_invalidated_at left at its column
    // default (NULL) — an initial hash capture is not an invalidation.
    // On an unchanged hash, the WHERE clause makes this a no-op (updated_at
    // does not move for a re-deploy that didn't touch the strategy).
    `INSERT INTO strategy_logic_versions (strategy_id, logic_hash, updated_at)
VALUES (${id}, ${h}, datetime('now'))
ON CONFLICT(strategy_id) DO UPDATE SET
  logic_hash = excluded.logic_hash,
  updated_at = excluded.updated_at
WHERE strategy_logic_versions.logic_hash <> excluded.logic_hash;`,
  ];
}

// `adapters` is the ADAPTERS map from backtest/adapters.js: strategy_id ->
// adapter function. Strategies with no entry (engine.js's
// "no_indicator_adapter" case) can never have backtest_runs, so they
// deliberately get no statements — nothing to invalidate.
export function generateInvalidationSql(adapters) {
  const statements = [];
  for (const [strategyId, adapterFn] of Object.entries(adapters)) {
    statements.push(...buildStatementsForStrategy(strategyId, hashAdapterSource(adapterFn)));
  }
  return statements.join('\n\n') + '\n';
}
