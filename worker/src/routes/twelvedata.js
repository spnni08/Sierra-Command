// Twelve Data routes — forex/index historical candles for backtesting.
// Replaces routes/alphavantage.js entirely: Alpha Vantage's free tier caps
// out at 25 requests/day, which the OANDA simulation engine alone burns
// through fast (see worker/src/simulation/execution-engine.js). Twelve
// Data's free tier (800 requests/day, 8/minute) is the replacement for both
// this historical-candles route and that engine's live-price lookups.
//
// Needs env.TWELVE_DATA_API_KEY (free registration at twelvedata.com) —
// mirrors the not_configured fallback the old Alpha Vantage route used when
// its key wasn't set yet.
const TWELVE_DATA_API = 'https://api.twelvedata.com';

// Twelve Data takes forex pairs as "EUR/USD" and indices as their own
// symbols; SPX/NASDAQ don't have a free-tier raw index feed either, so this
// keeps using the SPY/QQQ ETF proxies already established by the Alpha
// Vantage route this replaces (same caveat: proxy price, not the real index
// level).
const SYMBOL_MAP = {
  EURUSD: 'EUR/USD',
  EUR_USD: 'EUR/USD',
  SP500: 'SPY',
  SPX: 'SPY',
  SPX500: 'SPY',
  NASDAQ: 'QQQ',
  NDX: 'QQQ',
  NAS100: 'QQQ',
};

export async function handleTwelveDataRoute(request, url, env) {
  const path = url.pathname.replace(/^\/twelvedata/, '');

  if (path === '/candles' && request.method === 'GET') {
    return getCandles(url, env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function getCandles(url, env) {
  if (!env.TWELVE_DATA_API_KEY) {
    return Response.json({ status: 'not_configured', provider: 'twelvedata' }, { status: 200 });
  }

  const symbol = (url.searchParams.get('symbol') || 'EURUSD').toUpperCase();
  const interval = url.searchParams.get('interval') || '1day'; // Twelve Data interval string, e.g. 1min/5min/1h/1day
  const outputsize = url.searchParams.get('outputsize') || '30';

  const tdSymbol = SYMBOL_MAP[symbol];
  if (!tdSymbol) {
    return Response.json(
      { error: 'unsupported_symbol', symbol, supported: Object.keys(SYMBOL_MAP) },
      { status: 400 }
    );
  }

  const upstream = new URL(`${TWELVE_DATA_API}/time_series`);
  upstream.searchParams.set('symbol', tdSymbol);
  upstream.searchParams.set('interval', interval);
  upstream.searchParams.set('outputsize', outputsize);
  upstream.searchParams.set('apikey', env.TWELVE_DATA_API_KEY);

  const res = await fetch(upstream.toString());
  if (!res.ok) {
    return Response.json({ error: 'twelvedata_upstream_error', status: res.status }, { status: 502 });
  }
  const data = await res.json();

  // Twelve Data returns 200 with {"status":"error", ...} on bad/throttled
  // requests rather than a non-2xx status, so surface that explicitly.
  if (data.status === 'error' || !Array.isArray(data.values)) {
    return Response.json({ error: 'twelvedata_api_error', detail: data }, { status: 502 });
  }

  // Normalize into the same {timestamp, open, high, low, close} shape as
  // routes/coingecko.js. Twelve Data returns newest-first; keep chronological
  // order like CoinGecko's /ohlc does.
  const candles = data.values
    .map((v) => ({
      // Twelve Data's datetime is "YYYY-MM-DD" for daily+ intervals and
      // "YYYY-MM-DD HH:mm:ss" for intraday ones — normalize both to ISO 8601
      // UTC before parsing (it doesn't send a timezone offset; Twelve Data
      // quotes are UTC by default).
      timestamp: Date.parse(v.datetime.replace(' ', 'T') + (v.datetime.includes(':') ? 'Z' : 'T00:00:00Z')),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse();

  return Response.json({ data: { symbol, td_symbol: tdSymbol, interval, candles } });
}
