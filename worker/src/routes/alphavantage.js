// Alpha Vantage routes — GET/data-only, no order execution (Alpha Vantage is a
// market-data-only API anyway; there's nothing to trade through it).
// Used for forex and index candles, which Binance/OANDA don't both cover.
const ALPHA_VANTAGE_API = 'https://www.alphavantage.co/query';

// Alpha Vantage has no raw stock-index endpoint on the free tier — S&P 500 and
// NASDAQ are tracked here via their standard ETF proxies (SPY, QQQ) through
// the regular TIME_SERIES_* endpoints, same as WAVESCOUT's approach.
const FOREX_PAIRS = {
  EURUSD: { from: 'EUR', to: 'USD' },
};
const INDEX_PROXIES = {
  SP500: 'SPY',
  SPX: 'SPY',
  NASDAQ: 'QQQ',
  NDX: 'QQQ',
};

export async function handleAlphaVantageRoute(request, url, env) {
  const path = url.pathname.replace(/^\/alphavantage/, '');

  if (path === '/candles' && request.method === 'GET') {
    return getCandles(url, env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function getCandles(url, env) {
  if (!env.ALPHA_VANTAGE_API_KEY) {
    return Response.json({ status: 'not_configured', provider: 'alphavantage' }, { status: 200 });
  }

  const symbol = (url.searchParams.get('symbol') || 'EURUSD').toUpperCase();
  const interval = url.searchParams.get('interval') || 'daily'; // daily|intraday
  const intradayInterval = url.searchParams.get('intraday_interval') || '60min';

  const upstream = new URL(ALPHA_VANTAGE_API);
  upstream.searchParams.set('apikey', env.ALPHA_VANTAGE_API_KEY);

  if (FOREX_PAIRS[symbol]) {
    const { from, to } = FOREX_PAIRS[symbol];
    upstream.searchParams.set('function', interval === 'daily' ? 'FX_DAILY' : 'FX_INTRADAY');
    upstream.searchParams.set('from_symbol', from);
    upstream.searchParams.set('to_symbol', to);
    if (interval !== 'daily') upstream.searchParams.set('interval', intradayInterval);
  } else if (INDEX_PROXIES[symbol]) {
    upstream.searchParams.set(
      'function',
      interval === 'daily' ? 'TIME_SERIES_DAILY' : 'TIME_SERIES_INTRADAY'
    );
    upstream.searchParams.set('symbol', INDEX_PROXIES[symbol]);
    if (interval !== 'daily') upstream.searchParams.set('interval', intradayInterval);
  } else {
    return Response.json(
      {
        error: 'unsupported_symbol',
        symbol,
        supported: [...Object.keys(FOREX_PAIRS), ...Object.keys(INDEX_PROXIES)],
      },
      { status: 400 }
    );
  }

  const res = await fetch(upstream.toString());
  if (!res.ok) {
    return Response.json({ error: 'alphavantage_upstream_error', status: res.status }, { status: 502 });
  }
  const data = await res.json();

  // Alpha Vantage returns 200 with an error message body on bad/throttled
  // requests rather than a non-2xx status, so surface that explicitly.
  if (data['Error Message'] || data['Note'] || data['Information']) {
    return Response.json({ error: 'alphavantage_api_error', detail: data }, { status: 502 });
  }

  return Response.json(data);
}
