// OANDA routes — GET/data-only in this step, no order execution.
const OANDA_PRACTICE_API = 'https://api-fxpractice.oanda.com';

export async function handleOandaRoute(request, url, env) {
  const path = url.pathname.replace(/^\/oanda/, '');

  if (path === '/candles' && request.method === 'GET') {
    return getCandles(url, env);
  }

  if (path === '/account-status' && request.method === 'GET') {
    return getAccountStatus(env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function getCandles(url, env) {
  const instrument = url.searchParams.get('instrument') || 'EUR_USD';
  const granularity = url.searchParams.get('granularity') || 'H1';
  const count = url.searchParams.get('count') || '100';

  if (!env.OANDA_API_TOKEN) {
    return Response.json({ status: 'not_configured', provider: 'oanda' }, { status: 200 });
  }

  const upstream = new URL(`${OANDA_PRACTICE_API}/v3/instruments/${instrument}/candles`);
  upstream.searchParams.set('granularity', granularity);
  upstream.searchParams.set('count', count);

  const res = await fetch(upstream.toString(), {
    headers: { Authorization: `Bearer ${env.OANDA_API_TOKEN}` },
  });
  if (!res.ok) {
    return Response.json({ error: 'oanda_upstream_error', status: res.status }, { status: 502 });
  }
  const data = await res.json();
  return Response.json(data);
}

async function getAccountStatus(env) {
  if (!env.OANDA_API_TOKEN || !env.OANDA_ACCOUNT_ID) {
    return Response.json({ status: 'not_configured', provider: 'oanda' }, { status: 200 });
  }

  const res = await fetch(`${OANDA_PRACTICE_API}/v3/accounts/${env.OANDA_ACCOUNT_ID}/summary`, {
    headers: { Authorization: `Bearer ${env.OANDA_API_TOKEN}` },
  });
  if (!res.ok) {
    return Response.json({ error: 'oanda_upstream_error', status: res.status }, { status: 502 });
  }
  const data = await res.json();
  return Response.json({ status: 'ok', provider: 'oanda', account: data.account });
}
