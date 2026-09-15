import { useEffect, useRef, useState } from 'react';
import { fetchCryptoPrices, fetchForexIndexPrices } from './client';
import { normalizeSymbol } from '../lib/symbols';

const POLL_INTERVAL_MS = 20_000;

// Same symbol coverage as the worker routes this hook calls — see
// routes/coingecko.js's SYMBOL_TO_ID and routes/twelvedata.js's SYMBOL_MAP.
// Kept in sync by hand (small, stable lists); the worker still validates and
// returns unsupported_symbol if these ever drift.
const CRYPTO_SYMBOLS = new Set(['BTC', 'BTCUSDT', 'ETH', 'ETHUSDT', 'SOL', 'SOLUSDT']);
const FOREX_INDEX_SYMBOLS = new Set(['EURUSD', 'SP500', 'SPX', 'SPX500', 'NASDAQ', 'NDX', 'NAS100']);

export function assetClassFor(symbol) {
  if (CRYPTO_SYMBOLS.has(symbol)) return 'crypto';
  if (FOREX_INDEX_SYMBOLS.has(symbol)) return 'forex_index';
  return null; // no live price source for this symbol — caller shows "–"
}

// Same convention as worker/src/simulation/execution-engine.js's pnlFor —
// this is a live mark-to-market approximation (no spread/cost model
// applied), not a prediction of the exact fill price a close would get.
export function pnlFor(direction, entry, currentPrice, volume) {
  const diff = direction === 'long' ? currentPrice - entry : entry - currentPrice;
  return diff * volume;
}

/**
 * Live P/L for a list of open trades, kept current by polling the worker's
 * price proxies every 20s. `trades` should be the raw (unformatted) API
 * rows: { id, symbol, direction, entry, volume }.
 *
 * Returns a Map of trade id -> { pnl: number|null, price: number|null }.
 * `pnl`/`price` are null when the symbol has no live price source (crypto
 * order execution and most forex/index symbols beyond the simulated-OANDA
 * set) or the upstream provider failed/isn't configured — callers render
 * "–" for that rather than freezing a stale value.
 *
 * NOTE: open/close trade-notification detection used to be piggybacked onto
 * this hook's poll loop, which meant toasts only fired while a page that
 * happened to call this hook (ProTerminal/LogPage) was mounted. That logic
 * now lives in TradeNotificationsProvider (src/context/TradeNotificationsProvider.jsx),
 * mounted once at the app shell level with its own always-on poll — this
 * hook is price/PnL-only.
 */
export function useLiveTradePnl(trades) {
  const [prices, setPrices] = useState({}); // symbol -> price|null, across both asset classes

  // Only the distinct (symbol, assetClass) pairs actually need to be part of
  // the effect's dependency identity — re-running the poll loop just because
  // trade objects were recreated (e.g. a formatting re-render upstream)
  // would restart the interval for no reason. Trade rows may carry either
  // spelling (EUR_USD or EURUSD — see lib/symbols.js), so normalize before
  // matching against the known asset-class sets. Recomputed every render
  // from the live `trades` argument, so once a caller polls its trades list
  // (rather than fetching it once on mount), the symbol set driving this
  // poll stays current instead of freezing at whatever was open at mount.
  const symbolKey = [...new Set(
    trades.map((t) => normalizeSymbol(t.symbol)).filter((s) => assetClassFor(s) !== null)
  )].sort().join(',');

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const symbols = symbolKey ? symbolKey.split(',') : [];
      const cryptoSymbols = symbols.filter((s) => assetClassFor(s) === 'crypto');
      const forexIndexSymbols = symbols.filter((s) => assetClassFor(s) === 'forex_index');

      const [cryptoPrices, forexIndexPrices] = await Promise.all([
        fetchCryptoPrices(cryptoSymbols),
        fetchForexIndexPrices(forexIndexSymbols),
      ]);
      if (cancelled) return;
      setPrices({ ...cryptoPrices, ...forexIndexPrices });
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbolKey]);

  const result = new Map();
  for (const t of trades) {
    const symbol = normalizeSymbol(t.symbol);
    const price = Object.prototype.hasOwnProperty.call(prices, symbol) ? prices[symbol] : null;
    const pnl = price === null || !Number.isFinite(price)
      ? null
      : pnlFor(t.direction, t.entry, price, t.volume);
    result.set(t.id, { pnl, price });
  }
  return result;
}
