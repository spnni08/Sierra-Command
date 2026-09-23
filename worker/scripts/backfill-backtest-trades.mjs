#!/usr/bin/env node
// One-time backfill: re-runs every strategy's most recent existing
// backtest_runs row (same strategy_id/symbol/start/end) against the LIVE
// deployed worker, so strategies backtested before backtest_trades existed
// end up with real per-trade data too (see worker/schema.sql's
// backtest_trades comment and worker/src/backtest/engine.js's runBacktest).
//
// NOT wired into CI/worker-deploy.yml — this is a manually-run migration
// tool, same pattern as scripts/generate-logic-invalidation-sql.mjs's
// sibling but deliberately kept separate from it, since this one makes real
// network calls to CoinGecko/Twelve Data (via the worker) and can take
// minutes, not something every deploy should pay for.
//
// Prerequisites:
//   - This PR's schema/engine changes must already be deployed (merged to
//     main -> worker-deploy.yml has run), otherwise POST /backtest/run on
//     the live worker won't have the backtest_trades table to write to.
//   - Env vars: SIERRA_USERNAME, SIERRA_PASSWORD (the real login — never
//     hardcode credentials in this file or pass them on the command line
//     where shell history would keep them).
//   - Optional: SIERRA_WORKER_URL (defaults to the production worker),
//     SIERRA_BACKFILL_THROTTLE_MS (defaults to 2000 — CoinGecko/Twelve
//     Data have no documented hard rate limit in this codebase, see
//     routes/coingecko.js's/candles.js's comments, so this is a
//     conservative fixed delay between runs rather than a measured limit).
//
// Usage:
//   SIERRA_USERNAME=... SIERRA_PASSWORD=... node scripts/backfill-backtest-trades.mjs
//
// Safety: NEVER deletes or overwrites an existing backtest_runs row. Each
// re-run is a fresh POST /backtest/run (engine.js only ever INSERTs). After
// each re-run, the new row's trade_count/win_rate/profit_factor are
// compared against the OLD aggregate-only row's values; a mismatch is
// reported, never silently resolved or hidden — see the final summary.
// /stats/strategies always reads the newest run per (strategy_id, symbol)
// regardless of outcome here, so a clean re-run is immediately reflected
// there with no further action needed.

const BASE_URL = process.env.SIERRA_WORKER_URL || 'https://sierra-command-worker.vinhehemar.workers.dev';
const USERNAME = process.env.SIERRA_USERNAME;
const PASSWORD = process.env.SIERRA_PASSWORD;
const THROTTLE_MS = parseInt(process.env.SIERRA_BACKFILL_THROTTLE_MS || '2000', 10);

if (!USERNAME || !PASSWORD) {
  console.error('Set SIERRA_USERNAME and SIERRA_PASSWORD env vars before running this script.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.data?.token) throw new Error('login succeeded but response had no token');
  return body.data.token;
}

async function getJson(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  return body.data;
}

async function runBacktest(token, { strategy_id, symbol, start, end }) {
  const res = await fetch(`${BASE_URL}/backtest/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ strategy_id, symbol, start, end }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    return { status: res.status, body: null };
  }
  return { status: res.status, body };
}

function closeEnough(a, b, eps = 1e-6) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return Math.abs(a - b) < eps;
}

// Twelve Data reports throttling as HTTP 200 with {"status":"error", ...} in
// the response body (see worker/src/backtest/candles.js's comment), which
// the worker surfaces here as a candle_fetch_failed error — not a distinct
// HTTP status code, so detection has to inspect the body's shape.
function looksTransient(result) {
  return result.status !== 200 && result.body?.error === 'candle_fetch_failed';
}

async function main() {
  console.log(`Logging in against ${BASE_URL}...`);
  const token = await login();

  console.log('Fetching all existing backtest_runs...');
  const allRuns = await getJson('/api/backtest-runs', token);

  // Only the newest run per (strategy_id, symbol) is re-run — this mirrors
  // /stats/strategies' own "latest run per symbol wins" rule exactly, so
  // the backfill targets precisely the set of runs that endpoint will
  // actually read once this completes.
  const latestByKey = new Map();
  for (const run of allRuns) {
    const key = `${run.strategy_id}::${run.symbol}`;
    const existing = latestByKey.get(key);
    if (!existing || run.created_at > existing.created_at) latestByKey.set(key, run);
  }
  const targets = [...latestByKey.values()];
  console.log(`${allRuns.length} total backtest_runs rows -> ${targets.length} (strategy, symbol) combinations to re-run.\n`);

  const results = { ok: [], mismatch: [], failed: [] };

  for (const [i, run] of targets.entries()) {
    const label = `${run.strategy_id} / ${run.symbol} (${run.timeframe_start} -> ${run.timeframe_end})`;
    process.stdout.write(`[${i + 1}/${targets.length}] ${label} ... `);

    const params = { strategy_id: run.strategy_id, symbol: run.symbol, start: run.timeframe_start, end: run.timeframe_end };
    let attempt = await runBacktest(token, params);

    if (looksTransient(attempt)) {
      process.stdout.write('transient failure, retrying after backoff... ');
      await sleep(THROTTLE_MS * 5);
      attempt = await runBacktest(token, params);
    }

    if (attempt.status !== 200) {
      const reason = attempt.body?.error || attempt.body?.message || `HTTP ${attempt.status}`;
      console.log(`FAILED: ${reason}`);
      results.failed.push({ strategy_id: run.strategy_id, symbol: run.symbol, reason });
      await sleep(THROTTLE_MS);
      continue;
    }

    const newRun = attempt.body.data.run;
    const tradeCountMatches = newRun.trade_count === run.trade_count;
    const winRateMatches = closeEnough(newRun.win_rate, run.win_rate);
    const profitFactorMatches = closeEnough(newRun.profit_factor, run.profit_factor);

    if (tradeCountMatches && winRateMatches && profitFactorMatches) {
      console.log(`ok (${newRun.trade_count} trades)`);
      results.ok.push({ strategy_id: run.strategy_id, symbol: run.symbol, trade_count: newRun.trade_count });
    } else {
      // Never overwritten or deleted — the old row stays exactly as it was;
      // this is purely a report for a human to look at.
      console.log('MISMATCH vs. the old aggregate row — nothing changed, flagged below.');
      results.mismatch.push({
        strategy_id: run.strategy_id,
        symbol: run.symbol,
        old: { trade_count: run.trade_count, win_rate: run.win_rate, profit_factor: run.profit_factor },
        new: { trade_count: newRun.trade_count, win_rate: newRun.win_rate, profit_factor: newRun.profit_factor },
      });
    }

    await sleep(THROTTLE_MS);
  }

  console.log('\n=== Summary ===');
  console.log(`OK:       ${results.ok.length}`);
  console.log(`Mismatch: ${results.mismatch.length}`);
  console.log(`Failed:   ${results.failed.length}`);

  if (results.mismatch.length > 0) {
    console.log('\n--- Mismatches (old aggregate row left untouched) ---');
    for (const m of results.mismatch) {
      console.log(`${m.strategy_id} / ${m.symbol}:`);
      console.log(`  old: trade_count=${m.old.trade_count} win_rate=${m.old.win_rate} profit_factor=${m.old.profit_factor}`);
      console.log(`  new: trade_count=${m.new.trade_count} win_rate=${m.new.win_rate} profit_factor=${m.new.profit_factor}`);
    }
  }
  if (results.failed.length > 0) {
    console.log('\n--- Failed re-runs ---');
    for (const f of results.failed) {
      console.log(`${f.strategy_id} / ${f.symbol}: ${f.reason}`);
    }
  }

  process.exitCode = results.mismatch.length > 0 || results.failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
