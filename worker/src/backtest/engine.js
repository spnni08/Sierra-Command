// Backtest engine: walks a real historical candle series bar-by-bar through
// a strategy's existing evaluate() AND-gate (worker/src/strategies/ —
// reused as-is, not duplicated), simulates trade entries/exits against the
// appropriate cost model, and aggregates performance metrics into a new
// backtest_runs row.
//
// Only strategies with a real indicator adapter (see ./adapters.js) can run
// — see that file's comment for why the other WAVESCOUT strategies aren't
// backtestable yet (their factors gate on Pine-side semantic flags, not
// plain OHLC-derived indicators, and CoinGecko's free OHLC has no volume).
import { getStrategy } from '../strategies/index.js';
import { getAdapter } from './adapters.js';
import { fetchHistoricalCandles, assetClassFor } from './candles.js';
import { resolveWindow } from './window.js';
import { computeMetrics } from './metrics.js';
import { atr as computeAtr } from './indicators.js';
import { halfSpreadPrice as oandaHalfSpread } from '../simulation/oanda-costs.js';
import { halfSpreadPrice as cryptoHalfSpread, takerFee as cryptoTakerFee } from '../simulation/crypto-costs.js';

// crypto_baseline's slowest indicator is EMA200 — bars before that have no
// signal. Same warmup constant used regardless of adapter for now, since
// it's the only one implemented; revisit per-adapter if more are added.
const WARMUP_BARS = 200;

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function entryCost(symbol, assetClass, rawPrice, direction) {
  if (assetClass === 'crypto') {
    const half = cryptoHalfSpread(symbol, rawPrice);
    return direction === 'long' ? rawPrice + half : rawPrice - half;
  }
  const half = oandaHalfSpread(symbol);
  return direction === 'long' ? rawPrice + half : rawPrice - half;
}

function exitCost(symbol, assetClass, rawPrice, direction) {
  // Closing crosses the spread the other way — mirrors
  // simulation/execution-engine.js's checkOpenSimulatedTrades.
  if (assetClass === 'crypto') {
    const half = cryptoHalfSpread(symbol, rawPrice);
    return direction === 'long' ? rawPrice - half : rawPrice + half;
  }
  const half = oandaHalfSpread(symbol);
  return direction === 'long' ? rawPrice - half : rawPrice + half;
}

function initialFixedExit(entry, direction, exit) {
  const slDistance = entry * (exit.slPct / 100);
  const sl = direction === 'long' ? entry - slDistance : entry + slDistance;
  const tp = direction === 'long' ? entry + slDistance * exit.tp2RMultiple : entry - slDistance * exit.tp2RMultiple;
  return { sl, tp };
}

function initialTrailingExit(entry, direction, exit, atrValue) {
  const rDistance = (atrValue || entry * 0.01) * exit.trailing.atrMult;
  const sl = direction === 'long' ? entry - rDistance : entry + rDistance;
  const tp = direction === 'long' ? entry + rDistance * exit.tp2RMultiple : entry - rDistance * exit.tp2RMultiple;
  return { sl, tp, rDistance };
}

const VOLUME = { BTCUSDT: 0.1, ETHUSDT: 1.0, SOLUSDT: 10, EURUSD: 1000, SPX500: 1, NAS100: 1 };

export async function runBacktest({ strategyId, symbol, start, end }, env) {
  const strategy = getStrategy(strategyId);
  if (!strategy) return { error: 'unknown_strategy', strategyId };

  const adapter = getAdapter(strategyId);
  if (!adapter) {
    return {
      error: 'no_indicator_adapter',
      strategyId,
      message:
        'This strategy\'s factors gate on Pine-side semantic flags (S&R zones, Ichimoku, ICT swing structure, volume ratios) that are not plain OHLC-derived indicators, or need volume data CoinGecko\'s free OHLC endpoint does not provide. Only crypto_baseline/crypto_baseline_sl are backtestable today.',
    };
  }

  const upperSymbol = String(symbol ?? '').toUpperCase();
  const window = resolveWindow(upperSymbol, start, end);
  if (window.error) return { error: window.error };

  const assetClass = assetClassFor(upperSymbol);
  // EMA200 (the slowest indicator any adapter uses today) needs ~200 bars
  // of history before it produces a value — fetch extra lookback padding
  // before the requested window purely for warmup, but only ever open
  // trades on candles inside the actual requested [start, end]. Padding is
  // generous on purpose (indicator warmup days, not trading days) — crypto
  // candles here are CoinGecko's daily /market_chart series (see
  // candles.js), so 220 padding days ≈220 extra daily bars.
  const paddingDays = assetClass === 'crypto' ? 220 : 300;
  let fetchStart = new Date(window.start.getTime() - paddingDays * 86_400_000);

  // CoinGecko's free public API caps historical data at 365 days back
  // regardless of the asset's actual launch date (confirmed: requesting
  // further back 401s with error_code 10012, "exceeds the allowed time
  // range... upgrade to a paid plan"). Clamp the fetch (and, if needed, the
  // trading window itself) to that boundary rather than failing outright —
  // same "clamp and flag" pattern as the per-asset minStartDate below.
  let apiLimited = false;
  if (assetClass === 'crypto') {
    const apiLimitStart = new Date(Date.now() - 365 * 86_400_000);
    if (fetchStart < apiLimitStart) {
      fetchStart = apiLimitStart;
      apiLimited = true;
    }
    if (window.start < apiLimitStart) {
      window.start = apiLimitStart;
      apiLimited = true;
    }
  }

  let candles;
  try {
    candles = await fetchHistoricalCandles(upperSymbol, fetchStart, window.end, env);
  } catch (err) {
    return { error: 'candle_fetch_failed', message: err.message };
  }

  if (candles.length < WARMUP_BARS) {
    return {
      error: 'insufficient_candle_history',
      message: `Need at least ${WARMUP_BARS} candles (including warmup lookback) for indicator warmup (e.g. EMA200), got ${candles.length}. Try a longer window.`,
      candleCount: candles.length,
    };
  }

  const signalAt = adapter(candles);
  const atrSeries = strategy.exit.mode === 'trailing' ? computeAtr(candles, strategy.exit.trailing.atrLen) : null;
  const volume = VOLUME[upperSymbol] ?? 1;
  const windowStartMs = window.start.getTime();

  const trades = [];
  let open = null; // { direction, entry, sl, tp, openIndex }

  for (let i = WARMUP_BARS; i < candles.length; i++) {
    const candle = candles[i];

    if (open) {
      const hitSl = open.direction === 'long' ? candle.low <= open.sl : candle.high >= open.sl;
      const hitTp = open.direction === 'long' ? candle.high >= open.tp : candle.low <= open.tp;

      // Trail the stop (never loosens) before checking exits, mirroring a
      // trailing-SL variant's forward behavior.
      if (atrSeries && Number.isFinite(atrSeries[i])) {
        const trailDistance = atrSeries[i] * strategy.exit.trailing.atrMult;
        if (open.direction === 'long') open.sl = Math.max(open.sl, candle.close - trailDistance);
        else open.sl = Math.min(open.sl, candle.close + trailDistance);
      }

      if (hitSl || hitTp) {
        const rawExit = hitSl ? open.sl : open.tp;
        const fillExit = exitCost(upperSymbol, assetClass, rawExit, open.direction);
        let pnl = (open.direction === 'long' ? fillExit - open.entryFill : open.entryFill - fillExit) * volume;
        if (assetClass === 'crypto') {
          pnl -= cryptoTakerFee(upperSymbol, open.entryFill * volume) + cryptoTakerFee(upperSymbol, fillExit * volume);
        }
        trades.push({ ...open, exitFill: fillExit, exitIndex: i, reason: hitSl ? 'sl' : 'tp', pnl });
        open = null;
      }
      continue;
    }

    if (candle.timestamp < windowStartMs) continue; // still in warmup-only padding, no trading yet

    for (const direction of ['long', 'short']) {
      const signal = signalAt(i, direction);
      if (!signal) continue;
      const result = strategy.evaluate(signal);
      if (!result.passed) continue;

      const rawEntry = candle.close;
      const entryFill = entryCost(upperSymbol, assetClass, rawEntry, direction);
      const { sl, tp } =
        strategy.exit.mode === 'trailing'
          ? initialTrailingExit(entryFill, direction, strategy.exit, atrSeries[i])
          : initialFixedExit(entryFill, direction, strategy.exit);

      open = { direction, entryFill, sl, tp, openIndex: i };
      break;
    }
  }

  if (open) {
    const last = candles[candles.length - 1];
    const fillExit = exitCost(upperSymbol, assetClass, last.close, open.direction);
    let pnl = (open.direction === 'long' ? fillExit - open.entryFill : open.entryFill - fillExit) * volume;
    if (assetClass === 'crypto') {
      pnl -= cryptoTakerFee(upperSymbol, open.entryFill * volume) + cryptoTakerFee(upperSymbol, fillExit * volume);
    }
    trades.push({ ...open, exitFill: fillExit, exitIndex: candles.length - 1, reason: 'period_end', pnl });
  }

  const metrics = computeMetrics(trades);

  const id = makeId('bt');
  const createdAt = nowSql();
  const timeframeStart = window.start.toISOString().slice(0, 10);
  const timeframeEnd = window.end.toISOString().slice(0, 10);

  await env.DB.prepare(
    `INSERT INTO backtest_runs (id, strategy_id, symbol, timeframe_start, timeframe_end, sharpe, sortino, max_drawdown, profit_factor, out_of_sample_deviation, win_rate, trade_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  )
    .bind(
      id,
      strategyId,
      upperSymbol,
      timeframeStart,
      timeframeEnd,
      metrics.sharpe,
      metrics.sortino,
      metrics.maxDrawdown,
      metrics.profitFactor,
      metrics.winRate,
      metrics.tradeCount,
      createdAt
    )
    .run();

  const run = await env.DB.prepare('SELECT * FROM backtest_runs WHERE id = ?').bind(id).first();

  return {
    run,
    window: {
      start: timeframeStart,
      end: timeframeEnd,
      clamped: window.clamped || apiLimited,
      minStartDate: window.minStartDate,
      apiLimited, // true if clamped specifically by CoinGecko's 365-day free-tier cap, not the asset's minStartDate
    },
    candleCount: candles.length,
    metrics,
    trades: trades.map((t) => ({
      direction: t.direction,
      entry: t.entryFill,
      exit: t.exitFill,
      sl: t.sl,
      tp: t.tp,
      reason: t.reason,
      pnl: t.pnl,
      openedAt: candles[t.openIndex]?.timestamp,
      closedAt: candles[t.exitIndex]?.timestamp,
    })),
  };
}
