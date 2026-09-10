// Kraken routes — GET/data-only in this step, no order execution.
const KRAKEN_PUBLIC_API = 'https://api.kraken.com/0/public';

export async function handleKrakenRoute(request, url, env) {
  const path = url.pathname.replace(/^\/kraken/, '');

  if (path === '/ohlc' && request.method === 'GET') {
    return getOhlc(url);
  }

  if (path === '/account-status' && request.method === 'GET') {
    return getAccountStatus(env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function getOhlc(url) {
  const pair = url.searchParams.get('pair') || 'XBTUSD';
  const interval = url.searchParams.get('interval') || '60'; // minutes

  const upstream = new URL(`${KRAKEN_PUBLIC_API}/OHLC`);
  upstream.searchParams.set('pair', pair);
  upstream.searchParams.set('interval', interval);

  const res = await fetch(upstream.toString());
  if (!res.ok) {
    return Response.json({ error: 'kraken_upstream_error', status: res.status }, { status: 502 });
  }
  const data = await res.json();
  return Response.json(data);
}

async function getAccountStatus(env) {
  // Kraken's Demo (paper trading) accounts require authenticated private API
  // calls. Credentials are read from D1 (encrypted) / Worker secrets, not
  // hardcoded. Until credentials are configured via the Settings page, report
  // "not_configured" rather than failing.
  if (!env.KRAKEN_API_KEY || !env.KRAKEN_API_SECRET) {
    return Response.json({ status: 'not_configured', provider: 'kraken' }, { status: 200 });
  }

  // Placeholder for signed private endpoint call (Kraken REST requires
  // HMAC-SHA512 signing of nonce+payload) — implemented once demo credentials
  // are wired up in a later step.
  return Response.json({ status: 'not_implemented', provider: 'kraken' }, { status: 501 });
}
