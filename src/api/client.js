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
