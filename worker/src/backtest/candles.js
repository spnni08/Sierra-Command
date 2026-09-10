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

  const res = await fetch(upstream.toString());
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

/** Fetches and returns chronologically-sorted candles for the given symbol/date range. */
export async function fetchHistoricalCandles(symbol, startDate, endDate, env) {
  const cls = assetClassFor(symbol);
  if (cls === 'crypto') return fetchCryptoCandles(symbol, startDate, endDate, env);
  if (cls === 'forex_index') return fetchForexIndexCandles(symbol, startDate, endDate, env);
  throw new Error(`unsupported_symbol:${symbol}`);
}
