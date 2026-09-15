import { useEffect, useRef } from 'react';
import { useApp } from './AppContext';
import { fetchTrades, fetchCryptoPrices, fetchForexIndexPrices } from '../api/client';
import { normalizeSymbol } from '../lib/symbols';
import { assetClassFor, pnlFor } from '../api/useLiveTradePnl';
import { pushTradeToast } from '../lib/tradeToastStore';

const POLL_INTERVAL_MS = 20_000;

/**
 * Open/close trade-notification toasts, shell-level so they fire regardless
 * of which page is active. This used to be piggybacked onto
 * useLiveTradePnl's poll loop, which only ran while ProTerminal or LogPage
 * happened to be mounted (the one hook that called it) — a trade opening or
 * closing while sitting on Dashboard/Settings/etc never toasted. Mounted
 * once in App.jsx, above the page switch, with its own always-on poll
 * independent of any one page's lifecycle.
 *
 * Renders nothing.
 */
export default function TradeNotificationsProvider() {
  const { tradeNotificationsEnabled } = useApp();

  // Snapshot of open trades seen on the previous tick, keyed by id — this is
  // how open/close events are detected: a trade present now but not before
  // just opened; one present before but missing now just closed.
  const prevTradesRef = useRef(null); // null until a baseline tick establishes it
  const pricesRef = useRef({}); // symbol -> price|null, for close-PnL estimation

  useEffect(() => {
    if (!tradeNotificationsEnabled) {
      // Reset the baseline so re-enabling doesn't diff against a snapshot
      // frozen from before notifications were turned off — the next tick
      // after re-enabling re-seeds from the CURRENT state instead of
      // announcing everything that opened/closed while disabled.
      prevTradesRef.current = null;
      return undefined;
    }

    let cancelled = false;

    async function poll() {
      let openNow;
      try {
        openNow = await fetchTrades('open');
      } catch {
        return; // network hiccup — try again next tick
      }
      if (cancelled) return;

      // Refresh live prices for whatever's open now, for close-toast PnL —
      // best-effort; a stale/missing price just means that toast shows no
      // PnL rather than a wrong one.
      const symbols = [...new Set(
        openNow.map((t) => normalizeSymbol(t.symbol)).filter((s) => assetClassFor(s) !== null)
      )];
      const cryptoSymbols = symbols.filter((s) => assetClassFor(s) === 'crypto');
      const forexIndexSymbols = symbols.filter((s) => assetClassFor(s) === 'forex_index');
      try {
        const [cryptoPrices, forexIndexPrices] = await Promise.all([
          fetchCryptoPrices(cryptoSymbols),
          fetchForexIndexPrices(forexIndexSymbols),
        ]);
        if (!cancelled) pricesRef.current = { ...pricesRef.current, ...cryptoPrices, ...forexIndexPrices };
      } catch {
        // keep the last known prices
      }

      const current = new Map(openNow.map((t) => [t.id, t]));

      if (prevTradesRef.current === null) {
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

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tradeNotificationsEnabled]);

  return null;
}
