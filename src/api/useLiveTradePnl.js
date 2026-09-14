import { useEffect, useRef, useState } from 'react';
import { fetchCryptoPrices, fetchForexIndexPrices, fetchTrades } from './client';
import { normalizeSymbol } from '../lib/symbols';
import { useApp } from '../context/AppContext';
import { pushTradeToast } from '../lib/tradeToastStore';

const POLL_INTERVAL_MS = 20_000;

// Same symbol coverage as the worker routes this hook calls — see
// routes/coingecko.js's SYMBOL_TO_ID and routes/twelvedata.js's SYMBOL_MAP.
// Kept in sync by hand (small, stable lists); the worker still validates and
// returns unsupported_symbol if these ever drift.
const CRYPTO_SYMBOLS = new Set(['BTC', 'BTCUSDT', 'ETH', 'ETHUSDT', 'SOL', 'SOLUSDT']);
const FOREX_INDEX_SYMBOLS = new Set(['EURUSD', 'SP500', 'SPX', 'SPX500', 'NASDAQ', 'NDX', 'NAS100']);

function assetClassFor(symbol) {
  if (CRYPTO_SYMBOLS.has(symbol)) return 'crypto';
  if (FOREX_INDEX_SYMBOLS.has(symbol)) return 'forex_index';
  return null; // no live price source for this symbol — caller shows "–"
}

// Same convention as worker/src/simulation/execution-engine.js's pnlFor —
// this is a live mark-to-market approximation (no spread/cost model
// applied), not a prediction of the exact fill price a close would get.
function pnlFor(direction, entry, currentPrice, volume) {
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
 */
export function useLiveTradePnl(trades) {
  const [prices, setPrices] = useState({}); // symbol -> price|null, across both asset classes
  const { tradeNotificationsEnabled } = useApp();

  // Mirrors `prices` for reads from inside the poll loop's closures, where
  // the state variable itself would otherwise be stale (captured once when
  // the effect was set up, not on every tick).
  const pricesRef = useRef({});
  useEffect(() => { pricesRef.current = prices; }, [prices]);

  // Snapshot of the open trades seen on the previous tick, keyed by id —
  // this is how open/close events are detected: a trade present now but not
  // before just opened; one present before but missing now just closed.
  const prevTradesRef = useRef(null); // null until the first poll establishes a baseline
  const isFirstTickRef = useRef(true);

  // Only the distinct (symbol, assetClass) pairs actually need to be part of
  // the effect's dependency identity — re-running the poll loop just because
  // trade objects were recreated (e.g. a formatting re-render upstream)
  // would restart the interval for no reason. Trade rows may carry either
  // spelling (EUR_USD or EURUSD — see lib/symbols.js), so normalize before
  // matching against the known asset-class sets.
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

      // Open/close detection needs its own fresh read of open trades every
      // tick — the `trades` this hook receives from its caller
      // (ProTerminal/LogPage) is only fetched once on mount, so it never
      // reflects a trade opening or closing while the page stays open.
      // Piggybacked onto this same interval rather than a second poller.
      if (tradeNotificationsEnabled) {
        let openNow;
        try {
          openNow = await fetchTrades('open');
        } catch {
          return; // network hiccup — try again next tick
        }
        if (cancelled) return;
        const current = new Map(openNow.map((t) => [t.id, t]));

        if (isFirstTickRef.current || prevTradesRef.current === null) {
          isFirstTickRef.current = false;
          prevTradesRef.current = current;
          return; // don't announce already-open trades as "just opened"
        }

        const prev = prevTradesRef.current;
        for (const [id, t] of current) {
          if (!prev.has(id)) {
            pushTradeToast({ kind: 'open', symbol: normalizeSymbol(t.symbol), direction: t.direction });
          }
        }
        for (const [id, t] of prev) {
          if (!current.has(id)) {
            const symbol = normalizeSymbol(t.symbol);
            const price = pricesRef.current[symbol];
            const pnl = Number.isFinite(price) ? pnlFor(t.direction, t.entry, price, t.volume) : null;
            pushTradeToast({ kind: 'close', symbol, direction: t.direction, pnl });
          }
        }
        prevTradesRef.current = current;
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolKey, tradeNotificationsEnabled]);

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
