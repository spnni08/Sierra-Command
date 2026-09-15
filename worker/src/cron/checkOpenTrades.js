// Auto-close for open crypto (Binance) trades once SL/TP is hit. Mirrors the
// existing "fortlaufende Prüfung" pattern used for OANDA-simulated trades in
// ../simulation/execution-engine.js's checkOpenSimulatedTrades — same
// fetch-price-once-per-symbol / compare-against-SL-TP / close-and-log shape —
// but reads prices from WAVESCOUT's candle-check proxy (routes/wavescout-price.js)
// instead of Twelve Data, and only ever touches trades with
// source IN ('binance_testnet','binance_live'), so real OANDA-simulated
// trades (source = 'oanda_demo_simulated', already handled by
// checkOpenSimulatedTrades / POST /simulation/oanda/check) are never
// double-processed here.
//
// Trailing-SL trades (exit_mode = 'trailing'): this codebase does not yet
// have a live trailing-anchor recompute engine (see routes/webhook.js's
// comment on `computeBracket` — a trailing trade's SL is bootstrapped at
// open time and is "expected to move" by a later step that doesn't exist
// yet). Until that lands, the trades.sl column is the only persisted stop
// level for a trailing trade, so it is treated as the *currently active*
// stop and compared exactly like a fixed SL — the only difference is the
// activity_log / result `reason` distinguishes a trailing-stop hit
// ('trailing_stop') from a fixed SL hit ('sl'), so nothing conflates the two
// once real trailing-anchor updates start writing to `sl`.

const CRYPTO_SOURCES = ['binance_testnet', 'binance_live'];

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pnlFor(direction, entry, exit, volume) {
  const diff = direction === 'long' ? exit - entry : entry - exit;
  return diff * volume;
}

/**
 * Determine whether a trade's SL or TP has been hit at the given current
 * price, honoring long/short direction:
 *   long:  SL triggers on price <= sl,  TP triggers on price >= tp
 *   short: SL triggers on price >= sl,  TP triggers on price <= tp
 * Trailing (exit_mode='trailing') trades use the same comparison against
 * their currently-persisted `sl` — see module comment above.
 */
export function evaluateExit(trade, price) {
  if (!Number.isFinite(price)) return null;

  const isLong = trade.direction === 'long';
  const hitSl =
    trade.sl != null && (isLong ? price <= trade.sl : price >= trade.sl);
  const hitTp =
    trade.tp != null && (isLong ? price >= trade.tp : price <= trade.tp);

  if (!hitSl && !hitTp) return null;

  // SL takes priority if both are somehow touched in the same check (e.g. a
  // large gap) — conservative: assume the worse outcome was hit first.
  if (hitSl) {
    const reason = trade.exit_mode === 'trailing' ? 'trailing_stop' : 'sl';
    return { reason, fillPrice: trade.sl };
  }
  return { reason: 'tp', fillPrice: trade.tp };
}

/**
 * Fetches the latest candle-check price for `symbol` via the WAVESCOUT proxy
 * route's own upstream (routes/wavescout-price.js hits
 * `${WAVESCOUT_API_URL}/api/candle-check/latest?symbol=...`) — called
 * directly here rather than via an HTTP round-trip to our own worker, since
 * this runs from a scheduled event with no incoming Request/Response cycle.
 * Returns null (not a throw) on any failure so one bad symbol doesn't abort
 * the whole check.
 */
export async function fetchLatestCryptoPrice(symbol, env) {
  if (!env.WAVESCOUT_API_URL) return null;

  const upstream = new URL('/api/candle-check/latest', env.WAVESCOUT_API_URL);
  upstream.searchParams.set('symbol', symbol);

  let res;
  try {
    res = await fetch(upstream.toString());
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  // candle-check/latest's shape (per wavescout-price.js): a `candles` array
  // of OHLC bars; take the close of the most recent one.
  const candles = data?.candles;
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const price = Number(last?.close ?? last?.c);
  return Number.isFinite(price) ? price : null;
}

async function logActivity(env, message, relatedTradeId) {
  await env.DB.prepare(
    `INSERT INTO activity_log (id, source, message, timestamp, related_trade_id) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(makeId('log'), 'binance', message, nowSql(), relatedTradeId)
    .run();
}

/**
 * The crypto counterpart to checkOpenSimulatedTrades: loads every open
 * Binance trade grouped by symbol, fetches each symbol's latest
 * candle-check price once, and closes any trade whose SL/TP (fixed or
 * trailing) has been hit — updating status/pnl/closed_at and writing a
 * matching activity_log row. Meant to be invoked from the scheduled handler
 * (see wrangler.toml [triggers]) and, for tests/manual runs, directly.
 */
export async function checkOpenTrades(env) {
  const { results: openTrades } = await env.DB.prepare(
    `SELECT * FROM trades WHERE status = 'open' AND source IN (${CRYPTO_SOURCES.map(() => '?').join(',')})`
  )
    .bind(...CRYPTO_SOURCES)
    .all();

  const closed = [];
  const priceCache = new Map();

  for (const trade of openTrades) {
    let price = priceCache.get(trade.symbol);
    if (price === undefined) {
      price = await fetchLatestCryptoPrice(trade.symbol, env);
      priceCache.set(trade.symbol, price);
    }
    if (price == null) continue; // no price this cycle — leave open, retry next run

    const hit = evaluateExit(trade, price);
    if (!hit) continue;

    const pnl = pnlFor(trade.direction, trade.entry, hit.fillPrice, trade.volume);
    const closedAt = nowSql();

    await env.DB.prepare(
      `UPDATE trades SET status = 'closed', pnl = ?, closed_at = ? WHERE id = ?`
    )
      .bind(pnl, closedAt, trade.id)
      .run();

    const reasonLabel = hit.reason === 'tp' ? 'TP' : hit.reason === 'trailing_stop' ? 'Trailing-SL' : 'SL';
    await logActivity(
      env,
      `Auto-close ${trade.symbol} ${trade.direction.toUpperCase()} ${trade.id}: ${reasonLabel} hit @ ${hit.fillPrice} (pnl ${pnl.toFixed(4)})`,
      trade.id
    );

    closed.push({
      id: trade.id,
      symbol: trade.symbol,
      reason: hit.reason,
      fillPrice: hit.fillPrice,
      pnl,
    });
  }

  return { checked: openTrades.length, closed };
}
