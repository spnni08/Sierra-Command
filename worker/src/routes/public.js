// Read-only, cross-project export of trade data for external dashboards
// (currently: Ground Delta's trade panel). Deliberately a narrow view, not
// a pass-through of the /api/trades shape used internally:
//   - only symbol/direction/entry/sl/tp/status/pnl/strategy_name/opened_at/
//     closed_at — no trade id, no signal_id, no source (which would leak
//     whether a trade is binance_testnet/binance_live/oanda_demo/etc), no
//     volume, no credentials of any kind.
//   - open trades plus closed trades from the last 24h only, not the full
//     history — this is a "what's happening now" snapshot, not an export
//     of the trade log.
//
// Token-gated (PUBLIC_TRADES_TOKEN, a plain shared secret in the query
// string — not a JWT/OAuth flow, deliberately, since this is a single
// read-only consumer, not a multi-tenant API). If the secret isn't
// configured, the route stays open — see wrangler.toml / worker README for
// how to set it. Set the token before sharing the URL anywhere public.
export async function handlePublicRoute(url, env) {
  const path = url.pathname.replace(/^\/api\/public/, '');

  if (path === '/trades') {
    if (env.PUBLIC_TRADES_TOKEN && url.searchParams.get('token') !== env.PUBLIC_TRADES_TOKEN) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    return getPublicTrades(env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function getPublicTrades(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT t.symbol, t.direction, t.entry, t.sl, t.tp, t.status, t.pnl,
              t.opened_at, t.closed_at, st.name as strategy_name
       FROM trades t
       LEFT JOIN signals s ON s.id = t.signal_id
       LEFT JOIN strategies st ON st.id = s.strategy_id
       WHERE t.status = 'open'
          OR (t.status = 'closed' AND t.closed_at >= datetime('now', '-24 hours'))
       ORDER BY COALESCE(t.closed_at, t.opened_at) DESC`
    ).all();

    const data = results.map((row) => ({
      symbol: row.symbol,
      direction: row.direction,
      entry: row.entry,
      sl: row.sl,
      tp: row.tp,
      status: row.status,
      pnl: row.pnl,
      strategy_name: row.strategy_name ?? null,
      opened_at: row.opened_at,
      closed_at: row.closed_at,
    }));

    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}
