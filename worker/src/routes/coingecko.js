// CoinGecko routes — crypto historical candles for backtesting. Binance
// access is dead (see routes/binance.js), so this is the crypto history
// source instead. CoinGecko's public API (api.coingecko.com/api/v3) allows
// anonymous use on the free tier — no API key, no secret to configure.
const COINGECKO_API = 'https://api.coingecko.com/api/v3';

const SYMBOL_TO_ID = {
  BTC: 'bitcoin',
  BTCUSDT: 'bitcoin',
  ETH: 'ethereum',
  ETHUSDT: 'ethereum',
  SOL: 'solana',
  SOLUSDT: 'solana',
};

// CoinGecko's /ohlc endpoint only accepts these exact `days` values; the
// granularity (30min/4h/4day candles) is chosen automatically by CoinGecko
// based on which one you pass, not by a separate interval parameter.
const ALLOWED_DAYS = ['1', '7', '14', '30', '90', '180', '365', 'max'];

export async function handleCoinGeckoRoute(request, url, env) {
  const path = url.pathname.replace(/^\/coingecko/, '');

  if (path === '/candles' && request.method === 'GET') {
    return getCandles(url, env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function getCandles(url, env) {
  const symbol = (url.searchParams.get('symbol') || 'BTC').toUpperCase();
  const days = url.searchParams.get('days') || '30';

  const coinId = SYMBOL_TO_ID[symbol];
  if (!coinId) {
    return Response.json(
      { error: 'unsupported_symbol', symbol, supported: Object.keys(SYMBOL_TO_ID) },
      { status: 400 }
    );
  }

  if (!ALLOWED_DAYS.includes(days)) {
    return Response.json(
      { error: 'invalid_days', days, supported: ALLOWED_DAYS },
      { status: 400 }
    );
  }

  const upstream = new URL(`${COINGECKO_API}/coins/${coinId}/ohlc`);
  upstream.searchParams.set('vs_currency', 'usd');
  upstream.searchParams.set('days', days);
  // CoinGecko's demo/free public API key is optional but raises the rate
  // limit noticeably if set; use it when configured, otherwise fall back to
  // fully anonymous access (still works, just a lower rate limit).
  if (env.COINGECKO_API_KEY) {
    upstream.searchParams.set('x_cg_demo_api_key', env.COINGECKO_API_KEY);
  }

  const res = await fetch(upstream.toString());
  if (!res.ok) {
    return Response.json({ error: 'coingecko_upstream_error', status: res.status }, { status: 502 });
  }
  const raw = await res.json();

  if (!Array.isArray(raw)) {
    return Response.json({ error: 'coingecko_api_error', detail: raw }, { status: 502 });
  }

  // Normalize CoinGecko's [timestamp_ms, open, high, low, close] tuples into
  // the same shape backtest/candle consumers elsewhere in this codebase use.
  const candles = raw.map(([timestamp, open, high, low, close]) => ({
    timestamp,
    open,
    high,
    low,
    close,
  }));

  return Response.json({ data: { symbol, coin_id: coinId, days, candles } });
}
