// Aggregate performance metrics from a list of closed simulated trades
// ({pnl, ...}, chronological order). Simplifications are noted inline —
// these are the standard formulas, just computed over a per-trade return
// series rather than a fixed-period (daily) equity curve, since a backtest
// here only marks equity at trade open/close, not every calendar day.

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stddev(xs, avg) {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((sum, x) => sum + (x - avg) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function computeMetrics(trades, startingEquity = 10000) {
  if (trades.length === 0) {
    return { tradeCount: 0, winRate: null, profitFactor: null, maxDrawdown: null, sharpe: null, sortino: null };
  }

  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const winRate = wins.length / trades.length;

  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Equity curve marked at each trade close, starting from a nominal
  // balance — max drawdown as the worst peak-to-trough fraction.
  let equity = startingEquity;
  let peak = startingEquity;
  let maxDD = 0;
  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Per-trade returns (pnl / equity-at-entry) as the return series for
  // Sharpe/Sortino — not annualized, since trade spacing is irregular.
  let runningEquity = startingEquity;
  const returns = pnls.map((pnl) => {
    const r = pnl / runningEquity;
    runningEquity += pnl;
    return r;
  });
  const avgReturn = mean(returns);
  const sharpe = returns.length > 1 ? avgReturn / (stddev(returns, avgReturn) || Infinity) : 0;

  const downside = returns.filter((r) => r < 0);
  const downsideDev = downside.length > 1 ? stddev(downside, 0) : 0;
  const sortino = downside.length > 1 ? avgReturn / (downsideDev || Infinity) : downside.length === 0 ? Infinity : 0;

  return {
    tradeCount: trades.length,
    winRate,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
    maxDrawdown: maxDD,
    sharpe: Number.isFinite(sharpe) ? sharpe : null,
    sortino: Number.isFinite(sortino) ? sortino : null,
  };
}
