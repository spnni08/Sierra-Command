// Simulated OANDA demo execution for forex/index instruments (EURUSD,
// SPX500, NAS100). There is no real OANDA account behind this — the demo
// account was never opened because OANDA's KYC (tax ID / photo ID) was not
// completed — so orders are never sent to a broker. Instead an order is
// filled against real Twelve Data market data, with the static OANDA cost
// model from ./oanda-costs.js applied around the raw price, and the result
// is stored as a normal `trades` row (source = 'oanda_demo_simulated') so
// the rest of the app (dashboard, log, PNL) treats it identically to a real
// fill.
//
// Originally used Alpha Vantage, whose free tier's 25-requests/day cap this
// engine alone would burn through; moved to Twelve Data (800/day, 8/min)
// for the same reason routes/twelvedata.js replaced routes/alphavantage.js
// for historical candles.
//
// SL/TP are not resolved synchronously at open time — this is a REST lookup,
// not a streaming/tick feed, so "fortlaufende Prüfung" (the ongoing SL/TP
// check) is a separate step, `checkOpenSimulatedTrades`, meant to be invoked
// repeatedly going forward (e.g. from a scheduled trigger, or the
// /simulation/oanda/check endpoint) rather than a synchronous backtest replay
// over historical bars.

import { halfSpreadPrice, resolveOandaCostSymbol } from './oanda-costs.js';

const TWELVE_DATA_API = 'https://api.twelvedata.com';

// Same ETF-proxy convention as routes/twelvedata.js's SYMBOL_MAP — Twelve
// Data's free tier has no raw index quote endpoint either, so index
// instruments are tracked via their standard tracking ETF. The proxy trades
// at a different absolute scale than the real index (e.g. SPY ~= SPX/10), so
// the simulated spread is applied at the proxy's scale, not the real
// index's — an accepted approximation given there is no real quote source
// to match.
const TWELVE_DATA_SYMBOL_MAP = { EURUSD: 'EUR/USD', SPX500: 'SPY', NAS100: 'QQQ' };

async function fetchRawPrice(symbol, env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error('twelvedata_not_configured');
  }

  const tdSymbol = TWELVE_DATA_SYMBOL_MAP[symbol];
  if (!tdSymbol) throw new Error(`unsupported_symbol:${symbol}`);

  const upstream = new URL(`${TWELVE_DATA_API}/price`);
  upstream.searchParams.set('symbol', tdSymbol);
  upstream.searchParams.set('apikey', env.TWELVE_DATA_API_KEY);

  const res = await fetch(upstream.toString());
  if (!res.ok) throw new Error(`twelvedata_upstream_error:${res.status}`);
  const data = await res.json();

  // Twelve Data returns 200 with {"status":"error", ...} on bad/throttled
  // requests rather than a non-2xx status, so surface that explicitly.
  if (data.status === 'error') throw new Error(`twelvedata_api_error:${data.message ?? 'unknown'}`);

  const price = parseFloat(data.price);
  if (!Number.isFinite(price)) throw new Error('twelvedata_bad_response');
  return price;
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function makeTradeId(symbol) {
  return `sim-${symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Simulate opening a market order: fetches the current real price from Alpha
 * Vantage, applies half the static OANDA spread against the trader (worse
 * price on entry, same as a real broker fill), and persists the result as an
 * open `trades` row. Returns the stored trade plus the raw (pre-spread)
 * price so callers can show how much the spread moved the fill.
 */
export async function openSimulatedTrade(order, env) {
  const rawSymbol = order?.symbol;
  const direction = order?.direction;
  const volume = order?.volume;
  const sl = order?.sl ?? null;
  const tp = order?.tp ?? null;

  const symbol = resolveOandaCostSymbol(rawSymbol);
  if (!symbol) {
    throw new Error(`unsupported_symbol:${rawSymbol}`);
  }
  if (direction !== 'long' && direction !== 'short') {
    throw new Error('invalid_direction: expected "long" or "short"');
  }
  if (typeof volume !== 'number' || !(volume > 0)) {
    throw new Error('invalid_volume: expected a positive number');
  }

  const rawPrice = await fetchRawPrice(symbol, env);
  const half = halfSpreadPrice(symbol);
  // Buy at the (higher) ask, sell at the (lower) bid — the spread always
  // costs the trader, same as a real broker fill around the mid price.
  const entry = direction === 'long' ? rawPrice + half : rawPrice - half;

  const id = makeTradeId(symbol);
  const openedAt = nowSql();

  await env.DB.prepare(
    `INSERT INTO trades (id, signal_id, symbol, direction, entry, sl, tp, volume, source, status, pnl, exit_mode, opened_at, closed_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'oanda_demo_simulated', 'open', NULL, 'fixed', ?, NULL)`
  )
    .bind(id, symbol, direction, entry, sl, tp, volume, openedAt)
    .run();

  const trade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(id).first();

  return { trade, rawPrice, spreadApplied: entry - rawPrice };
}

function pnlFor(direction, entry, exit, volume) {
  const diff = direction === 'long' ? exit - entry : entry - exit;
  return diff * volume;
}

/**
 * The "fortlaufende Prüfung" step: re-checks every open simulated trade
 * against the current real price and closes it once SL or TP has been
 * touched, mirroring the backtest fill logic but walking forward against
 * live quotes on each call instead of replaying historical bars. Meant to
 * be invoked repeatedly (poll / scheduled trigger) rather than run once.
 */
export async function checkOpenSimulatedTrades(env) {
  const { results: openTrades } = await env.DB.prepare(
    `SELECT * FROM trades WHERE source = 'oanda_demo_simulated' AND status = 'open'`
  ).all();

  const closed = [];
  const priceCache = new Map();

  for (const trade of openTrades) {
    let rawPrice = priceCache.get(trade.symbol);
    if (rawPrice === undefined) {
      try {
        rawPrice = await fetchRawPrice(trade.symbol, env);
      } catch {
        continue; // leave this trade open and try again on the next check
      }
      priceCache.set(trade.symbol, rawPrice);
    }

    const half = halfSpreadPrice(trade.symbol);
    // Closing crosses the spread the other way: a long exits at the (lower)
    // bid, a short exits at the (higher) ask.
    const exitPrice = trade.direction === 'long' ? rawPrice - half : rawPrice + half;

    const hitSl = trade.sl != null && (trade.direction === 'long' ? exitPrice <= trade.sl : exitPrice >= trade.sl);
    const hitTp = trade.tp != null && (trade.direction === 'long' ? exitPrice >= trade.tp : exitPrice <= trade.tp);

    if (!hitSl && !hitTp) continue;

    const fillPrice = hitSl ? trade.sl : trade.tp;
    const pnl = pnlFor(trade.direction, trade.entry, fillPrice, trade.volume);
    const closedAt = nowSql();

    await env.DB.prepare(
      `UPDATE trades SET status = 'closed', pnl = ?, closed_at = ? WHERE id = ?`
    )
      .bind(pnl, closedAt, trade.id)
      .run();

    closed.push({ id: trade.id, symbol: trade.symbol, reason: hitSl ? 'sl' : 'tp', fillPrice, pnl });
  }

  return { checked: openTrades.length, closed };
}
