import { useEffect, useRef, useId } from 'react';
import { useApp } from '../context/AppContext';

// Maps the app's internal symbol codes to TradingView ticker syntax for the
// free TradingView "Advanced Chart" embed widget (tv.js). This is the public,
// no-key embed — NOT the paid, self-hosted Advanced Charts Library.
//
// Symbol choices, verified against TradingView's own symbol pages:
//  - BTC/ETH/SOL: BINANCE:<X>USDT — Binance is TradingView's standard,
//    always-available crypto data source for these pairs.
//  - EURUSD: FX:EURUSD — TradingView's FX (ICE) consolidated feed.
//  - S&P 500: OANDA:SPX500USD — SP:SPX and NASDAQ:NDX (the raw index feeds)
//    turned out NOT to resolve on the free embed widget in practice: it
//    silently fell back to the widget's default demo symbol (AAPL) instead
//    of erroring, which is why both S&P 500 and NAS 100 tiles were showing
//    "Apple Inc". OANDA:SPX500USD is TradingView's standard CFD-tracked S&P
//    500 feed and is confirmed to resolve correctly on the free widget.
//  - NASDAQ: OANDA:NAS100USD — same situation; this is TradingView's
//    standard CFD-tracked Nasdaq-100 feed, confirmed working on the free
//    widget.
export const TV_SYMBOL_MAP = {
  BTC: 'BINANCE:BTCUSDT',
  BTCUSD: 'BINANCE:BTCUSDT',
  ETH: 'BINANCE:ETHUSDT',
  ETHUSD: 'BINANCE:ETHUSDT',
  SOL: 'BINANCE:SOLUSDT',
  SOLUSD: 'BINANCE:SOLUSDT',
  EURUSD: 'FX:EURUSD',
  'S&P500': 'OANDA:SPX500USD',
  SPX500: 'OANDA:SPX500USD',
  NASDAQ: 'OANDA:NAS100USD',
  NAS100: 'OANDA:NAS100USD',
};

// TradingView interval codes: 1, 5, 15, 30, 60, 240, D, W, M.
const TF_TO_TV_INTERVAL = {
  M1: '1', M5: '5', M15: '15', M30: '30',
  H1: '60', H4: '240', D1: 'D', W1: 'W',
};

let tvScriptPromise = null;
function loadTvScript() {
  if (window.TradingView) return Promise.resolve();
  if (!tvScriptPromise) {
    tvScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://s3.tradingview.com/tv.js';
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return tvScriptPromise;
}

/**
 * Reusable free TradingView "Advanced Chart" embed widget.
 *
 * Known limitation (see README "TradingView widget color scheme" section):
 * the app's own CandlestickChart uses a deliberate neutral grey (up) /
 * black (down) color scheme instead of TradingView's default green/red.
 * The free embed widget DOES expose `overrides` for
 * `mainSeriesProperties.candleStyle.*`, so we apply the same neutral
 * palette here, read live from the app's CSS custom properties, keeping
 * the TradingView chart visually consistent with the rest of the app.
 *
 * @param {string} symbol - internal symbol code (see TV_SYMBOL_MAP), or a
 *   raw TradingView ticker (e.g. "BINANCE:BTCUSDT") if it already contains ":".
 * @param {string} interval - internal timeframe code (M1/M5/M15/H1/H4/D1/...)
 *   or a raw TradingView interval code.
 */
export default function TradingViewWidget({ symbol, interval = 'M15', height }) {
  const { theme } = useApp();
  const containerId = 'tv-widget-' + useId().replace(/[:]/g, '');
  const containerRef = useRef(null);
  const widgetRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const host = containerRef.current;
    if (!host) return undefined;

    const tvSymbol = symbol.includes(':') ? symbol : (TV_SYMBOL_MAP[symbol] || symbol);
    const tvInterval = TF_TO_TV_INTERVAL[interval] || interval;

    const cs = getComputedStyle(host.closest('[data-theme]') || document.documentElement);
    const C = (k, fallback) => cs.getPropertyValue(k).trim() || fallback;
    const upColor = C('--up', '#a2a2ab');
    const downColor = C('--down', '#0d0d10');
    const downEdge = C('--downedge', downColor);
    const wickColor = C('--wick', upColor);
    const bg = C('--chart', theme === 'dark' ? '#0c0c0e' : '#ffffff');
    const gridColor = C('--grid', theme === 'dark' ? '#1a1a1e' : '#e9ecf0');

    loadTvScript().then(() => {
      if (cancelled || !containerRef.current || !window.TradingView) return;
      host.innerHTML = '';
      widgetRef.current = new window.TradingView.widget({
        autosize: true,
        symbol: tvSymbol,
        interval: tvInterval,
        timezone: 'Etc/UTC',
        theme: theme === 'dark' ? 'dark' : 'light',
        style: '1',
        locale: 'de_DE',
        toolbar_bg: bg,
        enable_publishing: false,
        allow_symbol_change: false,
        hide_side_toolbar: true,
        hide_top_toolbar: false,
        withdateranges: false,
        save_image: false,
        container_id: containerId,
        // Neutral grey/black candle scheme, matching CandlestickChart.jsx.
        overrides: {
          'mainSeriesProperties.candleStyle.upColor': upColor,
          'mainSeriesProperties.candleStyle.downColor': downColor,
          'mainSeriesProperties.candleStyle.borderUpColor': upColor,
          'mainSeriesProperties.candleStyle.borderDownColor': downEdge,
          'mainSeriesProperties.candleStyle.wickUpColor': wickColor,
          'mainSeriesProperties.candleStyle.wickDownColor': wickColor,
          'paneProperties.background': bg,
          'paneProperties.vertGridProperties.color': gridColor,
          'paneProperties.horzGridProperties.color': gridColor,
        },
      });
    }).catch(() => {
      if (!cancelled && host) {
        host.innerHTML = '<div style="padding:12px;font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--txt3)">TradingView-Chart konnte nicht geladen werden.</div>';
      }
    });

    return () => {
      cancelled = true;
      if (host) host.innerHTML = '';
      widgetRef.current = null;
    };
    // Re-create the widget whenever symbol, interval or theme changes —
    // the free embed has no supported "update in place" API for these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, theme]);

  return (
    <div
      id={containerId}
      ref={containerRef}
      style={{ width: '100%', height: height || '100%' }}
    />
  );
}
