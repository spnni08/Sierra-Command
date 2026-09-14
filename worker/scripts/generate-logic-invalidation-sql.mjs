#!/usr/bin/env node
// Generates the idempotent D1 migration that keeps strategy_logic_versions
// in sync with the actual indicator/gate logic in backtest/adapters.js, and
// deletes a strategy's stale backtest_runs (+ their backtest_session_breakdown
// rows) the moment that logic changes — see worker/schema.sql's
// strategy_logic_versions comment for the full picture, and
// .github/workflows/worker-deploy.yml for where this runs (every deploy,
// after the schema/column migrations so the table already exists).
//
// Deliberately scoped to ADAPTERS in adapters.js (the entry logic a backtest
// actually runs against), per this feature's explicit design: strategy_
// settings (risk_per_trade_pct, session_filter, correlation_limit,
// news_filter_threshold) is a completely separate table this script never
// reads or touches, so tuning those in the Settings page can never trigger
// an invalidation.
//
// No manual maintenance: run it and it re-derives every strategy's hash
// straight from the current adapters.js source, per strategy_id. A strategy
// with no adapter (engine.js's "no_indicator_adapter" case) can never have
// backtest_runs in the first place, so it gets no row here — nothing to
// invalidate. The actual hash/SQL logic lives in ./lib/logic-invalidation-sql.mjs
// (unit-tested in test/logic-invalidation.test.js); this file is just the
// CLI entry point wiring it to the real ADAPTERS map and stdout.
import { ADAPTERS } from '../src/backtest/adapters.js';
import { generateInvalidationSql } from './lib/logic-invalidation-sql.mjs';

process.stdout.write(generateInvalidationSql(ADAPTERS));
