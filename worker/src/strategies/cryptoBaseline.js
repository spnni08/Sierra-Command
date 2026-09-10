// crypto_baseline — Kontrollgruppe: RSI + EMA200 trend-pullback.
// Ported from tradingview-bot/pinescript/strategies/crypto_baseline.pine +
// worker.js STRATEGIES.crypto_baseline / CANDIDATE_SCORING_DEFAULTS.crypto_baseline.
//
// Long : close > EMA200 (uptrend) AND RSI oversold pullback (< rsiLong=35)
//        AND |emaDistPct| in the 0.5-1.3% sweet spot AND RSI outside the
//        55-65 dead zone.
// Short: mirror — close < EMA200 AND RSI overbought rally (> rsiShort=65)
//        AND emaDistPct sweet spot AND RSI outside the 35-45 dead zone.
import { evaluateFactors, isLong, isShort, num } from './shared.js';

export const key = 'crypto_baseline';
export const label = 'Crypto Baseline (RSI+EMA200)';
export const assetClass = 'crypto';

export const params = {
  RSI_LONG_OVERSOLD: 35,
  RSI_SHORT_OVERBOUGHT: 65,
  EMA_DIST_MIN_PCT: 0.5,
  EMA_DIST_MAX_PCT: 1.3,
  RSI_DEAD_ZONE_LONG: [55, 65],
  RSI_DEAD_ZONE_SHORT: [35, 45],
};

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'atr' };
export const exit = {};

function emaDistPct(signal) {
  const close = num(signal.close ?? signal.price);
  const ema = num(signal.ema200);
  if (!Number.isFinite(close) || !Number.isFinite(ema) || ema === 0) return NaN;
  return Math.abs((close - ema) / ema) * 100;
}

const factors = [
  {
    name: 'trend_ema200',
    check: (s) => {
      const close = num(s.close ?? s.price);
      const ema = num(s.ema200);
      if (!Number.isFinite(close) || !Number.isFinite(ema)) return false;
      return isLong(s) ? close > ema : isShort(s) ? close < ema : false;
    },
  },
  {
    name: 'rsi_pullback_trigger',
    check: (s) => {
      const rsi = num(s.rsi);
      if (!Number.isFinite(rsi)) return false;
      return isLong(s) ? rsi < params.RSI_LONG_OVERSOLD : isShort(s) ? rsi > params.RSI_SHORT_OVERBOUGHT : false;
    },
  },
  {
    name: 'ema_dist_sweet_spot',
    check: (s) => {
      const d = emaDistPct(s);
      return Number.isFinite(d) && d >= params.EMA_DIST_MIN_PCT && d <= params.EMA_DIST_MAX_PCT;
    },
  },
  {
    name: 'rsi_outside_dead_zone',
    check: (s) => {
      const rsi = num(s.rsi);
      if (!Number.isFinite(rsi)) return false;
      const [lo, hi] = isLong(s) ? params.RSI_DEAD_ZONE_LONG : params.RSI_DEAD_ZONE_SHORT;
      return !(rsi >= lo && rsi <= hi);
    },
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
