// POST /backtest/run — triggers a real backtest (see ../backtest/engine.js).
//
// Runs synchronously in a single Worker invocation, not an async
// start+poll job: the work here is one external fetch (CoinGecko/Twelve
// Data) followed by a pure in-memory loop over at most a few thousand
// candles (30 days of 4h crypto candles ≈180 bars, multi-year daily
// forex/index candles ≈2-3k bars) — no per-candle network calls, no
// external waiting. That's low-hundreds-of-ms of real work, comfortably
// inside a Worker's request time budget (Cloudflare's CPU-time limit is
// what actually constrains a Worker, and this is I/O-bound, not
// CPU-bound). An async job queue would be the right call if this ever
// needs to backtest tick-level data or run many years of intraday bars,
// but isn't needed for the daily/4h granularity this engine uses today.
import { runBacktest } from '../backtest/engine.js';

export async function handleBacktestRoute(request, url, env) {
  const path = url.pathname.replace(/^\/backtest/, '');

  if (path === '/run' && request.method === 'POST') {
    return runRoute(request, env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function runRoute(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { strategy_id: strategyId, symbol, start, end } = body || {};
  if (!strategyId || !symbol) {
    return Response.json({ error: 'invalid_body', message: 'Expected { strategy_id, symbol, start?, end? }' }, { status: 400 });
  }

  try {
    const result = await runBacktest({ strategyId, symbol, start, end }, env);
    if (result.error) {
      return Response.json({ error: result.error, ...result }, { status: 400 });
    }
    return Response.json({ data: result });
  } catch (err) {
    return Response.json({ error: 'backtest_failed', message: err.message }, { status: 500 });
  }
}
