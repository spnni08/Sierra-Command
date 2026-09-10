# Sierra Command

Trading dashboard front-end (successor to WAVESCOUT) built with React + Vite. All data is static mock data — no real API/exchange integration.

## Pages

- **Multi-Chart** — tiled TradingView charts with confidence/factor indicators, bot activity feed, strategy matrix, factor utilization.
- **Pro-Terminal** — single large TradingView chart with an Entry/SL/TP badge row, backtest metrics, strategy-improvement suggestions, current trades.
- **Dashboard** — Live/Demo vs Backtest toggle, KPI tiles, equity curve, PNL by source, recent closed trades.
- **Log** — status/source filters, full open trades list, activity history, PNL calendar heatmap.
- **Auto-Trade** — global risk settings plus one identical settings card per strategy.
- **Einstellungen (Settings)** — PIN-protected API/connection management (Demo vs Live sections).

## Charts (TradingView embed widget)

Multi-Chart and Pro-Terminal render live price charts using TradingView's
**free "Advanced Chart" embed widget** (`https://s3.tradingview.com/tv.js`,
wrapped by `src/components/TradingViewWidget.jsx`) — not the paid,
self-hosted Advanced Charts Library. TradingView supplies its own price data
directly for these charts, so no Binance/Alpha Vantage/CoinGecko wiring is
needed for chart rendering itself; those integrations remain in place for
other purposes (see `worker/` routes).

Internal symbol codes are mapped to TradingView tickers in
`TV_SYMBOL_MAP` inside `TradingViewWidget.jsx`:

| App symbol | TradingView ticker |
|---|---|
| BTC | `BINANCE:BTCUSDT` |
| ETH | `BINANCE:ETHUSDT` |
| SOL | `BINANCE:SOLUSDT` |
| EURUSD | `FX:EURUSD` |
| S&P 500 | `SP:SPX` |
| NASDAQ | `NASDAQ:NDX` |

**Color-scheme note:** the app's own `CandlestickChart.jsx` (still used for
the equity-curve line charts on Pro-Terminal and Dashboard) deliberately
uses a neutral grey-up / black-down palette instead of the conventional
green/red, matching the app's overall design language. The free TradingView
embed widget's `overrides` config *does* expose
`mainSeriesProperties.candleStyle.upColor` / `downColor` (and related
border/wick colors), so `TradingViewWidget.jsx` reads the same `--up` /
`--down` / `--wick` CSS custom properties used by `CandlestickChart.jsx` and
applies them to the TradingView widget — the candle palette matches across
both chart types, in both light and dark theme. (Had the free widget not
exposed candle-color overrides, this would instead be documented here as an
accepted design deviation rather than worked around.)

Because the free embed doesn't expose chart-internals APIs, Pro-Terminal no
longer draws TP/SL lines on the chart itself; instead it shows an
Entry/SL/TP/P&L badge row above the chart, sourced from the same trade the
"Aktuelle Trades" table below it uses, so the numbers never diverge.

## Development

```bash
npm install
npm run dev
npm run build
```

## Deployment

A `firebase.json` is included for Firebase Hosting (serves the Vite `dist/` build).
