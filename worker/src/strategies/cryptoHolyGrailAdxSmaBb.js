// crypto_holy_grail_adx_sma_bb — Holy Grail 2.0: ADX trend regime + SMA/BB
// pullback zone + candlestick pattern confirmation. Ported from
// tradingview-bot/pinescript/strategies/crypto_holy_grail_adx_sma_bb.pine +
// worker.js STRATEGIES.crypto_holy_grail_adx_sma_bb.
//
// ADX(14) > 25 (trending, not chop) AND price pulls back into the tight
// Bollinger zone (0.25 stddev) around SMA(20) — a wick reaches the band,
// close stays inside — AND a recognized reversal candle pattern
// (hammer/engulfing/doji) confirms.
import { evaluateFactors, isLong, isShort, num } from './shared.js';

export const key = 'crypto_holy_grail_adx_sma_bb';
export const label = 'Crypto Holy Grail ADX/SMA/BB';
export const assetClass = 'crypto';

export const params = {
  ADX_MIN: 25,
};

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'atr' };
export const exit = {};

const factors = [
  {
    name: 'adx_trending',
    check: (s) => {
      const adx = num(s.adx);
      return Number.isFinite(adx) && adx > params.ADX_MIN;
    },
  },
  {
    name: 'sma_bb_pullback_zone',
    check: (s) => {
      const close = num(s.close ?? s.price);
      const low = num(s.low);
      const high = num(s.high);
      const bbLower = num(s.bb_lower);
      const bbUpper = num(s.bb_upper);
      if (!Number.isFinite(close)) return false;
      if (isLong(s)) {
        return Number.isFinite(low) && Number.isFinite(bbLower) && low <= bbLower && close > bbLower;
      }
      if (isShort(s)) {
        return Number.isFinite(high) && Number.isFinite(bbUpper) && high >= bbUpper && close < bbUpper;
      }
      return false;
    },
  },
  {
    name: 'candle_pattern_confirm',
    check: (s) => !!(s.candle_pattern_hammer || s.candle_pattern_engulfing || s.candle_pattern_doji || s.candle_pattern),
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
