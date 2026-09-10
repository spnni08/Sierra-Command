// Static cost model for the simulated OANDA demo execution.
//
// No real OANDA account is used (KYC — tax ID/photo ID — was not completed),
// so there is no live spread feed to query. Instead this hardcodes typical,
// publicly documented OANDA "Standard" (spread-only, no per-trade commission)
// pricing for the instruments this project trades — sourced from OANDA's own
// published typical/average spread figures for EUR/USD and its CFD index
// instruments (US SPX 500 / US Nasdaq 100), rounded to representative
// round-the-clock averages rather than session-by-session live values. These
// are deliberately static: good enough to make the simulated cost realistic,
// not a promise of OANDA's current live pricing.
//
// pip/point size: EURUSD quotes to 5 decimals, so 1 pip = 0.0001. Index CFDs
// are quoted in whole index points, so 1 "pip" there is just 1.0 point.
export const OANDA_COSTS = {
  EURUSD: {
    label: 'EUR/USD',
    pipSize: 0.0001,
    typicalSpreadPips: 1.0, // OANDA "Standard" published typical spread ~0.8-1.2 pips
    commissionPerLot: 0, // Standard pricing has no separate commission
  },
  SPX500: {
    label: 'US SPX 500 (S&P 500 CFD)',
    pipSize: 1.0,
    typicalSpreadPips: 0.4, // OANDA-published typical spread ~0.4 index points
    commissionPerLot: 0,
  },
  NAS100: {
    label: 'US Nasdaq 100 CFD',
    pipSize: 1.0,
    typicalSpreadPips: 1.0, // OANDA-published typical spread ~1.0 index point
    commissionPerLot: 0,
  },
};

// Accept the common alternate tickers used elsewhere in this codebase /
// Alpha Vantage's index proxies and map them onto the cost entries above.
const ALIASES = {
  EUR_USD: 'EURUSD',
  SPX: 'SPX500',
  SP500: 'SPX500',
  US500: 'SPX500',
  NASDAQ: 'NAS100',
  NDX: 'NAS100',
  US100: 'NAS100',
};

export function resolveOandaCostSymbol(symbol) {
  const s = String(symbol ?? '').toUpperCase();
  return OANDA_COSTS[s] ? s : ALIASES[s] ?? null;
}

export function getOandaCosts(symbol) {
  const resolved = resolveOandaCostSymbol(symbol);
  return resolved ? OANDA_COSTS[resolved] : null;
}

/**
 * Half the typical spread, in price units — the amount a simulated market
 * order's fill is pushed away from the raw mid/last price on entry (buy at
 * mid + half-spread, sell at mid - half-spread), matching how a real spread
 * is applied around a quoted mid price.
 */
export function halfSpreadPrice(symbol) {
  const costs = getOandaCosts(symbol);
  if (!costs) return 0;
  return (costs.typicalSpreadPips * costs.pipSize) / 2;
}

export function fullSpreadPrice(symbol) {
  const costs = getOandaCosts(symbol);
  if (!costs) return 0;
  return costs.typicalSpreadPips * costs.pipSize;
}
