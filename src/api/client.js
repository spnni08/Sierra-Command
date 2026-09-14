// Thin fetch helper for the Cloudflare Worker + D1 backend: structural data
// (strategies, trades, activity log, backtest runs) plus the live current-
// price proxies (/coingecko/price, /twelvedata/price) used for mark-to-
// market P/L on open trades.

const BASE_URL = 'https://sierra-command-worker.vinhehemar.workers.dev';

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`Worker antwortete mit ${res.status}`);
  }
  const body = await res.json();
  return body.data;
}

export function fetchStrategies() {
  return getJson('/api/strategies');
}

export function fetchTrades(status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return getJson(`/api/trades${qs}`);
}

export function fetchActivityLog(source) {
  const qs = source ? `?source=${encodeURIComponent(source)}` : '';
  return getJson(`/api/activity-log${qs}`);
}

export function fetchBacktestRuns(strategyId) {
  const qs = strategyId ? `?strategy_id=${encodeURIComponent(strategyId)}` : '';
  return getJson(`/api/backtest-runs${qs}`);
}

// { strategy_id, logic_hash, updated_at, last_invalidated_at }[] — used to
// tell "this strategy's backtest_runs were just wiped because its adapter
// logic changed" apart from "never backtested at all" (last_invalidated_at
// is null in the latter case). See worker/schema.sql's
// strategy_logic_versions comment.
export function fetchStrategyLogicVersions() {
  return getJson('/api/strategy-logic-versions');
}

// Unlike getJson, a non-2xx response here is not necessarily a transport
// failure — /backtest/run returns structured 400s for known conditions
// (no_indicator_adapter, candle_fetch_failed, insufficient_candle_history)
// that the UI needs to render as specific messages, not a generic "worker
// unreachable" error. So this always resolves with the parsed body and lets
// the caller branch on `body.error` vs `body.data`.
export async function runBacktest(strategyId, symbol, start, end) {
  const res = await fetch(`${BASE_URL}/backtest/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy_id: strategyId, symbol, start, end }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Worker antwortete mit ${res.status} (keine gültige JSON-Antwort)`);
  }
  if (!res.ok && !body.error) {
    throw new Error(`Worker antwortete mit ${res.status}`);
  }
  return body;
}

export function fetchPnlCalendar(year, month) {
  const params = new URLSearchParams();
  if (year) params.set('year', year);
  if (month) params.set('month', month);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return getJson(`/api/pnl-calendar${qs}`);
}

export function fetchCredentials() {
  return getJson('/api/credentials');
}

export async function putStrategySettings(strategyId, settings) {
  const res = await fetch(`${BASE_URL}/api/strategy-settings/${encodeURIComponent(strategyId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    throw new Error(`Worker antwortete mit ${res.status}`);
  }
  const body = await res.json();
  return body.data;
}

// Live current prices for open-trade P/L, keyed by our own symbol strings
// (not the upstream provider's). Never throws for a "no live price for this
// symbol" situation — that's an honest per-symbol gap (unsupported symbol,
// provider not configured, upstream error), not a transport failure, so
// callers get back a {symbol: price|null} map and render "–" for any null
// rather than crashing the whole table.
async function fetchLivePrices(path, symbols) {
  if (symbols.length === 0) return {};
  const qs = `?symbol=${encodeURIComponent(symbols.join(','))}`;
  try {
    const res = await fetch(`${BASE_URL}${path}${qs}`);
    if (!res.ok) return Object.fromEntries(symbols.map((s) => [s, null]));
    const body = await res.json();
    if (body.status === 'not_configured' || body.error) {
      return Object.fromEntries(symbols.map((s) => [s, null]));
    }
    return body.data?.prices || Object.fromEntries(symbols.map((s) => [s, null]));
  } catch {
    return Object.fromEntries(symbols.map((s) => [s, null]));
  }
}

// BTC/ETH/SOL (and their USDT-suffixed trade-row spellings) — see
// routes/coingecko.js's SYMBOL_TO_ID.
export function fetchCryptoPrices(symbols) {
  return fetchLivePrices('/coingecko/price', symbols);
}

// EURUSD/SPX500/NAS100 — the simulated-OANDA instruments — see
// routes/twelvedata.js's SYMBOL_MAP.
export function fetchForexIndexPrices(symbols) {
  return fetchLivePrices('/twelvedata/price', symbols);
}

export async function patchStrategyActive(strategyId, active) {
  const res = await fetch(`${BASE_URL}/api/strategies/${encodeURIComponent(strategyId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  if (!res.ok) {
    throw new Error(`Worker antwortete mit ${res.status}`);
  }
  const body = await res.json();
  return body.data;
}
