// Static cost model for simulated crypto fills (backtest + any future live
// crypto simulation), analogous to ./oanda-costs.js. Binance access is dead
// (see routes/binance.js) and no real exchange account backs these trades,
// so this hardcodes typical, publicly documented standard-tier fee/spread
// figures rather than querying anything live.
//
// Fee model: Binance Spot's published standard (non-VIP, no BNB discount)
// taker/maker schedule — 0.1% both sides — is used as the baseline since
// this project's crypto trades already carry source='binance_testnet'.
// Spread: major-pair spot spreads on liquid exchanges are typically a few
// basis points; SOL (lower liquidity than BTC/ETH) gets a wider figure.
export const CRYPTO_COSTS = {
  BTCUSDT: {
    label: 'BTC/USDT',
    takerFeePct: 0.1, // Binance Spot standard taker fee
    makerFeePct: 0.1, // Binance Spot standard maker fee (no maker rebate on standard tier)
    typicalSpreadPct: 0.02, // ~2 bps — typical BTC/USDT top-of-book spread on a liquid exchange
  },
  ETHUSDT: {
    label: 'ETH/USDT',
    takerFeePct: 0.1,
    makerFeePct: 0.1,
    typicalSpreadPct: 0.03,
  },
  SOLUSDT: {
    label: 'SOL/USDT',
    takerFeePct: 0.1,
    makerFeePct: 0.1,
    typicalSpreadPct: 0.05, // wider — lower liquidity than BTC/ETH
  },
};

const ALIASES = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
};

export function resolveCryptoCostSymbol(symbol) {
  const s = String(symbol ?? '').toUpperCase();
  return CRYPTO_COSTS[s] ? s : ALIASES[s] ?? null;
}

export function getCryptoCosts(symbol) {
  const resolved = resolveCryptoCostSymbol(symbol);
  return resolved ? CRYPTO_COSTS[resolved] : null;
}

/**
 * Half the typical spread, as a price offset — mirrors oanda-costs.js's
 * halfSpreadPrice: a market buy fills at price*(1+halfSpread), a sell at
 * price*(1-halfSpread).
 */
export function halfSpreadPrice(symbol, price) {
  const costs = getCryptoCosts(symbol);
  if (!costs || !Number.isFinite(price)) return 0;
  return price * (costs.typicalSpreadPct / 100 / 2);
}

/** Taker fee in quote currency for a given notional (entry/exit price * volume). */
export function takerFee(symbol, notional) {
  const costs = getCryptoCosts(symbol);
  if (!costs || !Number.isFinite(notional)) return 0;
  return notional * (costs.takerFeePct / 100);
}
