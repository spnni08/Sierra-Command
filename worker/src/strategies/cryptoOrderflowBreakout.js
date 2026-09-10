// crypto_orderflow_breakout — range breakout (last N candles) confirmed by
// a volume spike. Ported from
// tradingview-bot/pinescript/strategies/crypto_orderflow_breakout.pine +
// worker.js STRATEGIES.crypto_orderflow_breakout /
// CANDIDATE_SCORING_DEFAULTS.crypto_orderflow_breakout.
//
// Long : close > range_high(N=20) + edge buffer AND volume > volMult(2.0x)
//        avg volume AND close > EMA200 (trend filter) AND RSI(9) not
//        exhausted against the breakout direction (SHORT rejects RSI9<25,
//        LONG rejects RSI9>75 — a Pine breakout riding an already-exhausted
//        move).
// Short: mirror at range_low.
import { evaluateFactors, isLong, isShort, num } from './shared.js';

export const key = 'crypto_orderflow_breakout';
export const label = 'Crypto Orderflow Breakout';
export const assetClass = 'crypto';
export const cooldownMinutes = 30;

export const params = {
  RANGE_N: 20,
  MIN_VOL_RATIO: 1.5, // hard-AND minimum (worker.js CANDIDATE_SCORING_DEFAULTS.crypto_orderflow_breakout)
  VOL_MULT: 2.0,       // Pine-side trigger threshold
  RISK_PCT: 0.25,
};

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'atr' };
export const exit = {};

const factors = [
  {
    name: 'range_breakout_trigger',
    check: (s) => {
      const close = num(s.close ?? s.price);
      const high = num(s.range_high);
      const low = num(s.range_low);
      if (!Number.isFinite(close)) return false;
      if (isLong(s)) return Number.isFinite(high) && close > high;
      if (isShort(s)) return Number.isFinite(low) && close < low;
      return false;
    },
  },
  {
    name: 'volume_ratio_min',
    check: (s) => {
      const vol = num(s.candle_volume);
      const avg = num(s.avg_volume);
      if (!Number.isFinite(vol) || !Number.isFinite(avg) || avg === 0) return false;
      return vol / avg >= params.MIN_VOL_RATIO;
    },
  },
  {
    name: 'ema200_trend_filter',
    check: (s) => {
      const close = num(s.close ?? s.price);
      const ema = num(s.ema200);
      if (!Number.isFinite(close) || !Number.isFinite(ema)) return false;
      return isLong(s) ? close > ema : isShort(s) ? close < ema : false;
    },
  },
  {
    name: 'rsi9_not_exhausted',
    check: (s) => {
      const rsi9 = num(s.rsi9);
      if (!Number.isFinite(rsi9)) return true; // degrade-pass, matches worker.js "missing field != counter-trend"
      return isLong(s) ? rsi9 <= 75 : isShort(s) ? rsi9 >= 25 : true;
    },
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
