// Delta/Footprint adapter for the ICT MTF Discretionary strategy.
//
// Derives buy/sell delta and volume-by-price from Binance aggTrades.
// The aggTrades endpoint distinguishes buyer-initiated vs. seller-initiated
// trades via isBuyerMaker: true = seller hit the bid (sell aggression);
// false = buyer hit the ask (buy aggression).
//
// Only meaningful for crypto assets traded on Binance Futures. For
// non-crypto assets (EURUSD, indices, equities) there is no equivalent
// real-volume source — in those cases return null and mark the factor
// "nicht prüfbar" (see ictMtfPipeline.js).
//
// Binance may return 451 Unavailable For Legal Reasons from certain
// server egress IPs (geoblocking). Errors are surfaced as null, not
// thrown, so the caller marks the factor as "nicht prüfbar" rather
// than crashing.
//
// Interface (matches the adapter contract used by ictMtfPipeline.js):
//   fetchDeltaFootprint(symbol, windowMs, env) →
//     Promise<DeltaResult | null>
//
//   DeltaResult {
//     delta: number,       // buyVolume - sellVolume across the window
//     buyVolume: number,   // sum of buy-side aggressor volume
//     sellVolume: number,  // sum of sell-side aggressor volume
//     tradeCount: number,  // total number of aggTrades in window
//   }

const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';
// Spot endpoint used as fallback if futures returns 451 (geoblocking)
const BINANCE_SPOT_BASE = 'https://api.binance.com';
// Futures uses /fapi/v1/aggTrades; Spot uses /api/v3/aggTrades
const BINANCE_AGG_TRADES_PATH = {
  [BINANCE_FUTURES_BASE]: '/fapi/v1/aggTrades',
  [BINANCE_SPOT_BASE]: '/api/v3/aggTrades',
};

// Crypto symbols on Binance are pairs ending in USDT, BUSD, BTC, ETH, BNB.
// Non-crypto symbols (EURUSD, US30, etc.) will not resolve on Binance.
const CRYPTO_SYMBOL_RE = /^[A-Z0-9]+(USDT|BUSD|BTC|ETH|BNB)$/;

/**
 * Returns true if the symbol is a Binance-tradable crypto pair.
 * @param {string} symbol
 * @returns {boolean}
 */
export function isCryptoSymbol(symbol) {
  return CRYPTO_SYMBOL_RE.test(symbol?.toUpperCase() ?? '');
}

/**
 * Fetches aggTrades for the given symbol over a time window and
 * computes delta (buy volume minus sell volume).
 *
 * Returns null if:
 * - symbol is not a recognized crypto pair
 * - Binance returns a non-OK status (incl. 451 geoblocking)
 * - any network or JSON error occurs
 *
 * @param {string} symbol  e.g. 'BTCUSDT'
 * @param {number} windowMs  look-back window in ms (e.g. 5 * 60 * 1000)
 * @param {object} _env  Cloudflare Worker env (reserved for future auth)
 * @returns {Promise<{delta: number, buyVolume: number, sellVolume: number, tradeCount: number}|null>}
 */
export async function fetchDeltaFootprint(symbol, windowMs, _env) {
  if (!isCryptoSymbol(symbol)) return null;

  const endTime = Date.now();
  const startTime = endTime - windowMs;

  for (const baseUrl of [BINANCE_FUTURES_BASE, BINANCE_SPOT_BASE]) {
    try {
      const url = new URL(`${baseUrl}${BINANCE_AGG_TRADES_PATH[baseUrl]}`);
      url.searchParams.set('symbol', symbol.toUpperCase());
      url.searchParams.set('startTime', String(startTime));
      url.searchParams.set('endTime', String(endTime));
      url.searchParams.set('limit', '1000'); // max per request

      const res = await fetch(url.toString());
      if (!res.ok) {
        // 451 = geoblocked; fall through to spot endpoint or return null
        continue;
      }

      const trades = await res.json();
      if (!Array.isArray(trades)) continue;

      return computeDelta(trades);
    } catch {
      continue;
    }
  }

  return null; // all endpoints failed
}

/**
 * Computes delta from a raw Binance aggTrades response array.
 * Exported for unit testing without real HTTP calls.
 *
 * aggTrade fields: { a (agg id), p (price), q (qty), f, l, T (time),
 *                    m (isBuyerMaker), M (best price match) }
 *
 * @param {Array<{p: string, q: string, m: boolean}>} trades
 * @returns {{delta: number, buyVolume: number, sellVolume: number, tradeCount: number}}
 */
export function computeDelta(trades) {
  let buyVolume = 0;
  let sellVolume = 0;

  for (const t of trades) {
    const qty = parseFloat(t.q);
    if (!Number.isFinite(qty)) continue;
    if (t.m) {
      // isBuyerMaker = true → seller was aggressor (hit the bid)
      sellVolume += qty;
    } else {
      // isBuyerMaker = false → buyer was aggressor (hit the ask)
      buyVolume += qty;
    }
  }

  return {
    delta: buyVolume - sellVolume,
    buyVolume,
    sellVolume,
    tradeCount: trades.length,
  };
}
