// Thin fetch helper for the Cloudflare Worker + D1 backend: structural data
// (strategies, trades, activity log, backtest runs) plus the live current-
// price proxies (/coingecko/price, /twelvedata/price) used for mark-to-
// market P/L on open trades.

const BASE_URL = 'https://sierra-command-worker.vinhehemar.workers.dev';

// The worker's shared API_ACCESS_TOKEN (see worker/src/auth.js) — this is a
// single-user app, so there's no per-user login, just one token Marvin
// generates once and pastes into the TokenGate prompt on first load (see
// src/components/TokenGate.jsx). Kept in localStorage, not sessionStorage,
// so it survives a browser restart; cleared automatically on a 401 so a
// wrong/revoked token re-prompts instead of looping silently.
const TOKEN_KEY = 'sierra_api_token';

export function getApiToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setApiToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage unavailable (private mode, blocked storage, ...) — the
    // token just won't persist across reloads; not fatal for this session.
  }
}

export function clearApiToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // see setApiToken
  }
}

function authHeaders() {
  const token = getApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Public routes never send the bearer token (there's nothing to check it
// against on the worker side for these — see worker/src/auth.js's
// PUBLIC_PREFIXES) and never trigger the 401-clears-token reset below, since
// they can't 401 for a bad token in the first place.
const PUBLIC_PATH_PREFIXES = ['/coingecko', '/twelvedata', '/api/public'];
function isPublicPath(path) {
  return PUBLIC_PATH_PREFIXES.some((p) => path.startsWith(p));
}

// A 401 on a protected route means the stored token is wrong or was
// rotated server-side — clear it and reload so TokenGate re-prompts, rather
// than leaving the app stuck silently re-sending a dead token.
function handleUnauthorized(path) {
  if (isPublicPath(path)) return;
  clearApiToken();
  if (typeof window !== 'undefined') window.location.reload();
}

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { ...authHeaders() } });
  if (res.status === 401) handleUnauthorized(path);
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
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ strategy_id: strategyId, symbol, start, end }),
  });
  if (res.status === 401) handleUnauthorized('/backtest/run');
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
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(settings),
  });
  if (res.status === 401) handleUnauthorized('/api/strategy-settings');
  if (!res.ok) {
    throw new Error(`Worker antwortete mit ${res.status}`);
  }
  const body = await res.json();
  return body.data;
}

// PIN unlock for the Settings page — see worker/src/routes/api.js's
// handleSettingsUnlock. Not wrapped by handleUnauthorized: a wrong PIN here
// is an expected 401 the caller (Settings.jsx) handles itself as "falscher
// PIN", not "the API token is bad" (this route is itself protected by the
// bearer token like everything else, so a token problem would already have
// surfaced elsewhere first).
export async function unlockSettingsPin(pin) {
  const res = await fetch(`${BASE_URL}/api/settings/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.data?.token || null;
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
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ active }),
  });
  if (res.status === 401) handleUnauthorized('/api/strategies');
  if (!res.ok) {
    throw new Error(`Worker antwortete mit ${res.status}`);
  }
  const body = await res.json();
  return body.data;
}
