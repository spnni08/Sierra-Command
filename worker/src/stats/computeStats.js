// Pure per-strategy stats aggregation for GET /stats/strategies — no D1
// access here, just a function over an already-fetched, already-filtered
// (single source, single symbol scope, single time range) array of closed
// trades, kept in a normalized shape so it works identically whether the
// caller fetched from `trades` (live/demo) or `backtest_trades` (backtest):
//
//   { pnl, entry, sl, tp, diff, closedAt }
//
// `diff` is the trade's signed realized price distance in the direction
// that was favorable for its own long/short direction — positive means a
// favorable move (long: exit above entry; short: exit below entry), so it
// always shares pnl's sign for a given trade. The route layer computes it
// per source:
//   - backtest_trades has an explicit exit_price: diff = direction==='long'
//     ? exit-entry : entry-exit.
//   - live/demo `trades` has no fill-price column, only pnl — but pnlFor()
//     (checkOpenTrades.js/execution-engine.js) has no fee/spread deduction,
//     so diff = pnl / volume recovers the exact same value with no
//     estimation (pnl = diff*volume by construction there).
// `diff` is null when it can't be derived exactly (e.g. volume is 0) —
// every RR-derived field below then stays null for that trade rather than
// guessing.
//
// Nothing here rounds — every value is returned full-precision; rounding
// for display is the frontend's job (Auswertung.jsx), per "nichts schätzen,
// nichts runden, bevor gerechnet wird".

// winRate/lossRate are null when there are no win/loss trades at all (only
// breakeven, or zero trades) — expectancy is then not computable. When one
// side has a zero rate (no wins, or no losses), that side's average is
// allowed to be missing (its coefficient is exactly 0, not estimated) so
// the other side can still be reported. If a side HAS a nonzero rate but no
// average is available (e.g. every winning trade is missing SL data, so no
// avgWinR exists), that is a genuine "can't compute" case, not a zero.
function expectancy(winRate, lossRate, avgWin, avgLoss) {
  if (winRate == null || lossRate == null) return null;
  if (winRate > 0 && avgWin == null) return null;
  if (lossRate > 0 && avgLoss == null) return null;
  return winRate * (avgWin ?? 0) - lossRate * (avgLoss ?? 0);
}

export function computeStrategyStatsRow(trades) {
  const tradeCount = trades.length;

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let pnlTotalUsd = 0;
  let winPnlSum = 0;
  let lossPnlSum = 0;
  let realizedRSum = 0;
  let realizedRCount = 0;
  let winRSum = 0;
  let winRCount = 0;
  let lossRSum = 0;
  let lossRCount = 0;
  let plannedRRSum = 0;
  let plannedRRCount = 0;
  let lastTradeAt = null;
  const pnlSeries = [];

  for (const t of trades) {
    pnlTotalUsd += t.pnl;
    pnlSeries.push(t.pnl);

    if (t.pnl > 0) {
      wins++;
      winPnlSum += t.pnl;
    } else if (t.pnl < 0) {
      losses++;
      lossPnlSum += Math.abs(t.pnl);
    } else {
      breakeven++;
    }

    const hasSl = t.sl != null && t.entry !== t.sl;
    if (hasSl && t.diff != null) {
      const r = t.diff / Math.abs(t.entry - t.sl);
      realizedRSum += r;
      realizedRCount++;
      if (t.pnl > 0) {
        winRSum += r;
        winRCount++;
      } else if (t.pnl < 0) {
        lossRSum += Math.abs(r);
        lossRCount++;
      }
    }
    if (hasSl && t.tp != null) {
      plannedRRSum += Math.abs(t.tp - t.entry) / Math.abs(t.entry - t.sl);
      plannedRRCount++;
    }
    if (lastTradeAt === null || t.closedAt > lastTradeAt) lastTradeAt = t.closedAt;
  }

  const winLossCount = wins + losses;
  const winRate = winLossCount > 0 ? wins / winLossCount : null;
  const lossRate = winLossCount > 0 ? losses / winLossCount : null;
  const avgWinUsd = wins > 0 ? winPnlSum / wins : null;
  const avgLossUsd = losses > 0 ? lossPnlSum / losses : null;
  const avgWinR = winRCount > 0 ? winRSum / winRCount : null;
  const avgLossR = lossRCount > 0 ? lossRSum / lossRCount : null;

  return {
    tradeCount,
    wins,
    losses,
    breakeven,
    pnlTotalUsd: tradeCount > 0 ? pnlTotalUsd : null,
    pnlTotalR: realizedRCount > 0 ? realizedRSum : null,
    winRate,
    expectancyUsd: expectancy(winRate, lossRate, avgWinUsd, avgLossUsd),
    expectancyR: expectancy(winRate, lossRate, avgWinR, avgLossR),
    avgPnlUsd: tradeCount > 0 ? pnlTotalUsd / tradeCount : null,
    avgRealizedRR: realizedRCount > 0 ? realizedRSum / realizedRCount : null,
    avgPlannedRR: plannedRRCount > 0 ? plannedRRSum / plannedRRCount : null,
    lastTradeAt,
    lowData: tradeCount < 20,
    pnlSeries,
  };
}

// Groups an already-filtered trade array by an arbitrary key function and
// runs computeStrategyStatsRow() (the exact same aggregation the main
// /stats/strategies endpoint uses) over each group — the per-asset/per-
// timeframe/per-asset-and-timeframe breakdowns in GET /stats/strategy/:id
// are all just this called with a different key, never a second metrics
// implementation. `keyFn` receives a trade and returns its group key
// (already normalized by the caller, e.g. via normalizeSymbol/
// normalizeTimeframe below); each result row carries that key back as `key`
// so the caller can attach it under whatever field name makes sense there
// (symbol, timeframe, or both for the asset x timeframe matrix).
export function groupStrategyStats(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    const key = keyFn(t);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  return [...groups.entries()].map(([key, groupTrades]) => ({
    key,
    ...computeStrategyStatsRow(groupTrades),
  }));
}

// Collapses known alternate spellings of the same asset to one canonical
// form, for GROUPING/DISPLAY only — never rewrites what's actually stored
// (trades.symbol keeps whatever it was written with). Reuses the same
// alias pairs already hand-maintained elsewhere in this codebase
// (simulation/oanda-costs.js's ALIASES, routes/twelvedata.js's SYMBOL_MAP)
// rather than inventing a new mapping; OANDA-simulated trades are already
// normalized at write time via resolveOandaCostSymbol, so this mostly
// guards against a webhook payload sending an unnormalized forex spelling
// (no alias table exists on that path today). Crypto symbols (BTCUSDT etc.)
// have no observed alternate spelling anywhere in this codebase, so they
// pass through unchanged (just uppercased).
const SYMBOL_ALIASES = {
  EUR_USD: 'EURUSD',
  'EUR/USD': 'EURUSD',
  SPX: 'SPX500',
  SP500: 'SPX500',
  US500: 'SPX500',
  NASDAQ: 'NAS100',
  NDX: 'NAS100',
  US100: 'NAS100',
};

export function normalizeSymbol(raw) {
  if (raw == null) return 'unbekannt';
  const upper = String(raw).toUpperCase().trim();
  if (!upper) return 'unbekannt';
  return SYMBOL_ALIASES[upper] ?? upper;
}

// Maps TradingView's raw {{interval}} codes (plain minute counts, or 'D'/'W'
// for daily/weekly) AND the backtest engine's own human-readable labels
// (already in the target form, e.g. '15m'/'4h' — see backtest/candles.js)
// to one consistent set, so a strategy traded live on "240" and backtested
// on "4h" land in the same matrix column instead of fragmenting into two.
// Like normalizeSymbol, this only affects GROUPING — the raw value passed
// in (whatever the webhook payload or the backtest engine actually wrote)
// is never altered in the database. Anything unrecognized, or missing
// entirely, becomes 'unbekannt' — never guessed from context.
const TRADINGVIEW_INTERVAL_CODES = {
  1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 240: '4h',
  D: '1d', '1D': '1d', W: '1w', '1W': '1w',
};
const KNOWN_TIMEFRAME_LABELS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '4d', '1w']);

export function normalizeTimeframe(raw) {
  if (raw == null) return 'unbekannt';
  const value = String(raw).trim();
  if (!value) return 'unbekannt';
  if (KNOWN_TIMEFRAME_LABELS.has(value)) return value;
  if (TRADINGVIEW_INTERVAL_CODES[value] !== undefined) return TRADINGVIEW_INTERVAL_CODES[value];
  // Present but not one of the known codes/labels above — kept as its own
  // distinct value rather than folded into 'unbekannt', which is reserved
  // for genuinely missing data. An unmapped-but-real timeframe is not the
  // same thing as "we don't know" and shouldn't be presented as such.
  return value;
}
