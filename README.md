# Sierra Command

Trading dashboard front-end (successor to WAVESCOUT) built with React + Vite. All data is static mock data — no real API/exchange integration.

## Pages

- **Multi-Chart** — tiled charts with confidence/factor indicators, bot activity feed, strategy matrix, factor utilization.
- **Pro-Terminal** — single large chart with TP/SL levels, backtest metrics, strategy-improvement suggestions, current trades.
- **Dashboard** — Live/Demo vs Backtest toggle, KPI tiles, equity curve, PNL by source, recent closed trades.
- **Log** — status/source filters, full open trades list, activity history, PNL calendar heatmap.
- **Auto-Trade** — global risk settings plus one identical settings card per strategy.
- **Einstellungen (Settings)** — PIN-protected API/connection management (Demo vs Live sections).

## Development

```bash
npm install
npm run dev
npm run build
```

## Deployment

A `firebase.json` is included for Firebase Hosting (serves the Vite `dist/` build).
