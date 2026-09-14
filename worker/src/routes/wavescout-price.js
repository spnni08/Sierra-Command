// WAVESCOUT price routes — live/latest candle-check price data, proxied
// from the WAVESCOUT (tradingview-bot) Cloudflare Worker over plain HTTP.
// Sierra Command does NOT read WAVESCOUT's D1 database directly: WAVESCOUT
// exposes a read-only GET /api/candle-check/latest?symbol=... endpoint
// specifically so this repo can consume it instead.
//
// Needs env.WAVESCOUT_API_URL (the WAVESCOUT worker's base URL, e.g.
// https://tradingview-bot.<subdomain>.workers.dev) — set as a wrangler var
// or secret; see wrangler.toml. Until it's set this route returns
// `not_configured`, mirroring the pattern routes/twelvedata.js uses for its
// own missing-API-key case.
//
// Known gap (as of this route's introduction): WAVESCOUT's candle-check
// pipeline (crypto_candle_check.pine) currently only covers BTC and SOL.
// Sierra Command's 6 target assets are BTC, ETH, SOL, EURUSD, S&P500 and
// NASDAQ — Pine alerts for ETH, EURUSD, S&P500 and NASDAQ still need to be
// manually configured in TradingView/WAVESCOUT by the repo owner before
// this route can return live data for those symbols. Until then this route
// will faithfully proxy WAVESCOUT's response for unsupported symbols
// (typically an empty `candles` array), it does not hide the gap.

const CACHE_TTL_SECONDS = 15; // matches the Cache-Control WAVESCOUT itself sets on this endpoint

export async function handleWavescoutPriceRoute(request, url, env) {
  const path = url.pathname.replace(/^\/wavescout/, '');

  if (path === '/price' && request.method === 'GET') {
    return getLatestPrice(request, url, env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function getLatestPrice(request, url, env) {
  if (!env.WAVESCOUT_API_URL) {
    return Response.json({ status: 'not_configured', provider: 'wavescout' }, { status: 200 });
  }

  const symbol = (url.searchParams.get('symbol') || 'BTC').toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(symbol)) {
    return Response.json({ error: 'invalid_symbol', symbol }, { status: 400 });
  }

  // Short-TTL edge cache via the standard Cache API — cheap and avoids
  // hammering WAVESCOUT on every dashboard refresh, without needing a KV
  // namespace for what is a few-second freshness window.
  const cache = caches.default;
  const cacheKey = new Request(
    `${url.origin}/wavescout/price?symbol=${encodeURIComponent(symbol)}`,
    request
  );
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = new URL('/api/candle-check/latest', env.WAVESCOUT_API_URL);
  upstream.searchParams.set('symbol', symbol);

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream.toString());
  } catch (err) {
    return Response.json({ error: 'wavescout_unreachable', message: err.message }, { status: 502 });
  }

  if (!upstreamRes.ok) {
    return Response.json(
      { error: 'wavescout_upstream_error', status: upstreamRes.status },
      { status: 502 }
    );
  }

  const data = await upstreamRes.json();
  const response = Response.json(
    { data },
    { headers: { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` } }
  );

  // Cache a clone — the original body has already been consumed by .json().
  await cache.put(cacheKey, response.clone());

  return response;
}
