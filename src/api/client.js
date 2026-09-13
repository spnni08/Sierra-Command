// Thin fetch helper for the Cloudflare Worker + D1 backend. Structural data
// only (strategies, trades, activity log, backtest runs) — live price data
// stays on mock/Alpha Vantage/Binance and does not go through this client.

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
