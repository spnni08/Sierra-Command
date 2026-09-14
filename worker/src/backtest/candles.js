// Historical candle fetching for the backtest engine — calls CoinGecko /
// Twelve Data directly (same pattern as simulation/execution-engine.js's
// fetchRawPrice: no internal HTTP round-trip through this Worker's own
// /coingecko or /twelvedata routes).

const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const TWELVE_DATA_API = 'https://api.twelvedata.com';

const CRYPTO_IDS = { BTCUSDT: 'bitcoin', ETHUSDT: 'ethereum', SOLUSDT: 'solana' };
const FOREX_INDEX_SYMBOLS = { EURUSD: 'EUR/USD', SPX500: 'SPY', NAS100: 'QQQ' };

export function assetClassFor(symbol) {
  const s = String(symbol ?? '').toUpperCase();
  if (CRYPTO_IDS[s]) return 'crypto';
  if (FOREX_INDEX_SYMBOLS[s]) return 'forex_index';
  return null;
}

function daysBetween(startDate, endDate) {
  return Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000);
}

// CoinGecko's /ohlc endpoint (used by routes/coingecko.js) switches to
// coarse 4-day bars once the requested range exceeds ~90 days — nowhere
// near enough history for a 200-bar EMA200 warmup over any realistic
// backtest window. /market_chart gives one real daily close per day over
// much longer ranges instead, so the backtest engine uses that: a
// synthesized OHLC candle per day with open=high=low=close=that day's
// price. This trades away real intraday high/low (SL/TP touch checks
// against a day's close only, not its true range — a known, documented
// simplification) for having genuinely enough history to warm up
// indicators at all.
async function fetchCryptoCandles(symbol, startDate, endDate, env) {
  const coinId = CRYPTO_IDS[symbol];
  const spanDays = Math.max(1, daysBetween(startDate, endDate));

  const upstream = new URL(`${COINGECKO_API}/coins/${coinId}/market_chart`);
  upstream.searchParams.set('vs_currency', 'usd');
  upstream.searchParams.set('days', String(spanDays));
  upstream.searchParams.set('interval', 'daily');
  if (env.COINGECKO_API_KEY) upstream.searchParams.set('x_cg_demo_api_key', env.COINGECKO_API_KEY);

  // CoinGecko's edge blocks requests with no (or an empty) User-Agent header
  // with a bare 403 — confirmed while testing this module locally under
  // `wrangler dev`/workerd, which sends no default UA the way a browser
  // would. Not a proxy or auth issue; just needs any identifying UA.
  const res = await fetch(upstream.toString(), { headers: { 'User-Agent': 'SierraCommandBacktest/1.0' } });
  if (!res.ok) throw new Error(`coingecko_upstream_error:${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw?.prices)) throw new Error('coingecko_bad_response');

  // /market_chart also returns total_volumes (real, CoinGecko-aggregated
  // 24h volume across exchanges) alongside prices — not the same thing as a
  // single exchange's candle-level volume the original Pine strategies read,
  // but genuine, non-fabricated volume data, so it's attached here. Matched
  // to each price point by array index (both arrays are the same length,
  // same daily cadence, from the same response).
  const volumes = Array.isArray(raw.total_volumes) ? raw.total_volumes : [];

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  return raw.prices
    .map(([timestamp, price], i) => ({
      timestamp,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volumes[i]?.[1] ?? NaN,
    }))
    .filter((c) => c.timestamp >= startMs && c.timestamp <= endMs);
}

// CoinGecko's /ohlc `days` values only accept this exact enum (see
// routes/coingecko.js's ALLOWED_DAYS) — granularity is auto-selected by
// CoinGecko per bucket (confirmed empirically against the live API, with
// COINGECKO_API_KEY set — the key only raises rate limits, granularity is
// identical to anonymous access, per CoinGecko's own docs: "Auto-
// granularity is tied to the `days` parameter only, not the plan tier"):
//   1-30 days  -> 30min (days=1-2) or 4-hour (days=3-30) bars, real O/H/L/C
//   90-365 days -> 4-day bars, still real O/H/L/C (never flat — unlike
//                  /market_chart, this is genuine intrabar-aggregated OHLC
//                  at every bucket, just coarser as the window widens)
// 'max' errors on the free/Demo tier past 365 days ("Public API users are
// limited to querying historical data within the past 365 days").
const OHLC_DAYS_BUCKETS = [1, 7, 14, 30, 90, 180, 365];

function pickOhlcDaysBucket(spanDays) {
  for (const bucket of OHLC_DAYS_BUCKETS) {
    if (spanDays <= bucket) return bucket;
  }
  return 365; // free-tier hard cap — caller's own >365-day clamping (window.js) already prevents spanDays from exceeding this in practice
}

// Real O/H/L/C candles for strategies whose factors need actual candle body/
// wick geometry (engulfing patterns, wick-touch-inside-band criteria) —
// crypto_mfi_engulfing and crypto_holy_grail_adx_sma_bb, see adapters.js.
// Every other crypto adapter uses fetchCryptoCandles()'s /market_chart
// (flat OHLC, but much longer real history at daily granularity) instead;
// this is the one exception, deliberately not shared, since most existing
// factors need long EMA/SMA warmup /market_chart is much better suited for.
//
// CoinGecko's /ohlc has NO volume field at all (confirmed empirically —
// each row is exactly [timestamp, open, high, low, close]), so MFI (which
// needs volume) can't be computed from /ohlc alone. This merges in
// /market_chart's real daily total_volumes by calendar day (UTC) as a
// second fetch — an intra-day /ohlc bar gets that whole day's aggregate
// volume, not its own slice of it (there's no finer-grained real volume
// source available), a coarser number than a true per-bar volume would be
// but a real, non-fabricated one.
async function fetchCryptoRealOhlcCandles(symbol, startDate, endDate, env) {
  const coinId = CRYPTO_IDS[symbol];
  const spanDays = Math.max(1, daysBetween(startDate, endDate));
  const bucket = pickOhlcDaysBucket(spanDays);
  const headers = { 'User-Agent': 'SierraCommandBacktest/1.0' };

  const ohlcUrl = new URL(`${COINGECKO_API}/coins/${coinId}/ohlc`);
  ohlcUrl.searchParams.set('vs_currency', 'usd');
  ohlcUrl.searchParams.set('days', String(bucket));
  if (env.COINGECKO_API_KEY) ohlcUrl.searchParams.set('x_cg_demo_api_key', env.COINGECKO_API_KEY);

  const volumeUrl = new URL(`${COINGECKO_API}/coins/${coinId}/market_chart`);
  volumeUrl.searchParams.set('vs_currency', 'usd');
  volumeUrl.searchParams.set('days', String(bucket));
  volumeUrl.searchParams.set('interval', 'daily');
  if (env.COINGECKO_API_KEY) volumeUrl.searchParams.set('x_cg_demo_api_key', env.COINGECKO_API_KEY);

  const [ohlcRes, volumeRes] = await Promise.all([
    fetch(ohlcUrl.toString(), { headers }),
    fetch(volumeUrl.toString(), { headers }),
  ]);
  if (!ohlcRes.ok) throw new Error(`coingecko_upstream_error:${ohlcRes.status}`);
  if (!volumeRes.ok) throw new Error(`coingecko_upstream_error:${volumeRes.status}`);

  const ohlcRaw = await ohlcRes.json();
  if (!Array.isArray(ohlcRaw)) throw new Error('coingecko_bad_response');
  const volumeRaw = await volumeRes.json();
  if (!Array.isArray(volumeRaw?.total_volumes)) throw new Error('coingecko_bad_response');

  const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
  const volumeByDay = new Map(volumeRaw.total_volumes.map(([ts, vol]) => [dayKey(ts), vol]));

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  return ohlcRaw
    .map(([timestamp, open, high, low, close]) => ({
      timestamp,
      open,
      high,
      low,
      close,
      volume: volumeByDay.get(dayKey(timestamp)) ?? NaN,
    }))
    .filter((c) => c.timestamp >= startMs && c.timestamp <= endMs);
}

async function fetchForexIndexCandles(symbol, startDate, endDate, env) {
  if (!env.TWELVE_DATA_API_KEY) throw new Error('twelvedata_not_configured');
  const tdSymbol = FOREX_INDEX_SYMBOLS[symbol];

  const upstream = new URL(`${TWELVE_DATA_API}/time_series`);
  upstream.searchParams.set('symbol', tdSymbol);
  upstream.searchParams.set('interval', '1day');
  upstream.searchParams.set('start_date', startDate.toISOString().slice(0, 10));
  upstream.searchParams.set('end_date', endDate.toISOString().slice(0, 10));
  upstream.searchParams.set('apikey', env.TWELVE_DATA_API_KEY);

  const res = await fetch(upstream.toString());
  if (!res.ok) throw new Error(`twelvedata_upstream_error:${res.status}`);
  const data = await res.json();
  if (data.status === 'error' || !Array.isArray(data.values)) {
    throw new Error(`twelvedata_api_error:${data.message ?? 'unknown'}`);
  }

  return data.values
    .map((v) => ({
      timestamp: Date.parse(v.datetime.replace(' ', 'T') + (v.datetime.includes(':') ? 'Z' : 'T00:00:00Z')),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse(); // Twelve Data returns newest-first
}

// Strategies whose adapter needs real candle body/wick geometry — see
// fetchCryptoRealOhlcCandles's comment. Kept here (not in adapters.js) so
// candles.js doesn't import adapters.js just to know this; adapters.js
// stays the single source of truth for which strategy IDs exist at all.
export const REAL_OHLC_STRATEGY_IDS = new Set([
  'crypto_mfi_engulfing',
  'crypto_mfi_engulfing_sl',
  'crypto_holy_grail_adx_sma_bb',
  'crypto_holy_grail_adx_sma_bb_sl',
]);

/**
 * Fetches and returns chronologically-sorted candles for the given
 * symbol/date range. `strategyId` is optional and only changes behavior for
 * crypto: the handful of strategies in REAL_OHLC_STRATEGY_IDS get real
 * O/H/L/C (+ merged-in daily volume) from /ohlc instead of the flat-OHLC
 * /market_chart every other crypto adapter uses.
 */
export async function fetchHistoricalCandles(symbol, startDate, endDate, env, strategyId) {
  const cls = assetClassFor(symbol);
  if (cls === 'crypto') {
    return REAL_OHLC_STRATEGY_IDS.has(strategyId)
      ? fetchCryptoRealOhlcCandles(symbol, startDate, endDate, env)
      : fetchCryptoCandles(symbol, startDate, endDate, env);
  }
  if (cls === 'forex_index') return fetchForexIndexCandles(symbol, startDate, endDate, env);
  throw new Error(`unsupported_symbol:${symbol}`);
}
