// The rest of the app (strategy asset_classes, backtest symbols, the symbol
// tile bar) consistently uses no-separator symbols (EURUSD, BTCUSDT,
// SPX500). Some seeded/real trades rows carry EUR_USD instead — normalized
// for display/matching only, never rewritten in the DB, since that's a
// display-layer inconsistency, not a trade-identity change.
export function normalizeSymbol(sym) {
  return String(sym ?? '').replace(/_/g, '');
}
