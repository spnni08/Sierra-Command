// crypto_bb_rsi_trendfilter — Bollinger(200, EMA-based, 0.2 stddev) as a
// TREND filter (long + tight around a slow EMA — price outside such a tight
// band is a strong directional signal, NOT a mean-reversion band like
// crypto_sr_bollinger's BB(20,2)) + RSI(3) 80/20 cross for short pullback
// entries within the established trend. Ported from
// tradingview-bot/pinescript/strategies/crypto_bb_rsi_trendfilter.pine +
// worker.js STRATEGIES.crypto_bb_rsi_trendfilter.
//
// Long : close closes ABOVE the upper (EMA-based) band (uptrend confirmed)
//        AND RSI(3) crosses UP through level 20.
// Short: close closes BELOW the lower band AND RSI(3) crosses DOWN through
//        level 80.
import { evaluateFactors, isLong, isShort, num } from './shared.js';

export const key = 'crypto_bb_rsi_trendfilter';
export const label = 'Crypto BB Trendfilter RSI';
export const assetClass = 'crypto';

export const params = {
  RSI_LEN: 3,
  RSI_LOW: 20,
  RSI_HIGH: 80,
};

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'atr' };
export const exit = {};

const factors = [
  {
    name: 'bb_trend_filter',
    check: (s) => {
      const close = num(s.close ?? s.price);
      const bbUpper = num(s.bb_upper);
      const bbLower = num(s.bb_lower);
      if (!Number.isFinite(close)) return false;
      if (isLong(s)) return Number.isFinite(bbUpper) && close > bbUpper;
      if (isShort(s)) return Number.isFinite(bbLower) && close < bbLower;
      return false;
    },
  },
  {
    name: 'rsi3_cross',
    check: (s) => {
      // Pine reports the crossover event directly; fall back to a level
      // check against rsi3 if the boolean isn't present (degrade, not fail).
      if (isLong(s) && typeof s.rsi3_cross_up === 'boolean') return s.rsi3_cross_up;
      if (isShort(s) && typeof s.rsi3_cross_down === 'boolean') return s.rsi3_cross_down;
      const rsi3 = num(s.rsi3);
      if (!Number.isFinite(rsi3)) return false;
      return isLong(s) ? rsi3 <= params.RSI_LOW : isShort(s) ? rsi3 >= params.RSI_HIGH : false;
    },
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
