// Binance Futures Testnet routes — GET/data-only in this step, no order execution.
// Base URL is Futures Testnet-specific (not Spot, not live Futures, not Kraken).
//
// Known limitation: as deployed, every request here gets a 403 from Binance
// Testnet's CloudFront WAF (confirmed both signed and unsigned; not an IP
// allowlist setting on the API key). See worker/README.md. Not working
// around it — that would mean evading Binance's bot/abuse protection.
// Re-check against the live Binance API when that integration is built.
const BINANCE_FUTURES_TESTNET_API = 'https://testnet.binancefuture.com';

export async function handleBinanceRoute(request, url, env) {
  const path = url.pathname.replace(/^\/binance/, '');

  if (path === '/candles' && request.method === 'GET') {
    return getCandles(url);
  }

  if (path === '/account-status' && request.method === 'GET') {
    return getAccountStatus(env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function getCandles(url) {
  const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
  const interval = url.searchParams.get('interval') || '1h';
  const limit = url.searchParams.get('limit') || '100';

  const upstream = new URL(`${BINANCE_FUTURES_TESTNET_API}/fapi/v1/klines`);
  upstream.searchParams.set('symbol', symbol);
  upstream.searchParams.set('interval', interval);
  upstream.searchParams.set('limit', limit);

  const res = await fetch(upstream.toString());
  if (!res.ok) {
    return Response.json({ error: 'binance_upstream_error', status: res.status }, { status: 502 });
  }
  const data = await res.json();
  return Response.json(data);
}

async function getAccountStatus(env) {
  if (!env.BINANCE_TESTNET_API_KEY || !env.BINANCE_TESTNET_API_SECRET) {
    return Response.json({ status: 'not_configured', provider: 'binance' }, { status: 200 });
  }

  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = await hmacSha256Hex(query, env.BINANCE_TESTNET_API_SECRET);

  const upstream = new URL(`${BINANCE_FUTURES_TESTNET_API}/fapi/v2/account`);
  upstream.search = `${query}&signature=${signature}`;

  const res = await fetch(upstream.toString(), {
    headers: { 'X-MBX-APIKEY': env.BINANCE_TESTNET_API_KEY },
  });
  if (!res.ok) {
    const body = await res.text();
    return Response.json(
      { error: 'binance_upstream_error', status: res.status, body },
      { status: 502 }
    );
  }
  const data = await res.json();
  return Response.json({ status: 'ok', provider: 'binance', account: data });
}

// Binance's REST auth scheme: HMAC-SHA256 over the exact query string, hex-encoded,
// appended as a `signature` param. Distinct from Kraken (HMAC-SHA512 over
// nonce+POST-data) and OANDA (bearer token, no request signing).
async function hmacSha256Hex(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
