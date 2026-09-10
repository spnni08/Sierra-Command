// crypto_sr_bollinger — Bollinger Bands (20, 2) used directly as S&R levels
// (the band IS the trigger, not a confirmation on a volume-profile zone).
// Ported from
// tradingview-bot/pinescript/strategies/crypto_sr_bollinger.pine +
// worker.js STRATEGIES.crypto_sr_bollinger.
//
// Long : low pierces the lower band, close back inside it (bounce) AND
//        close > EMA200 (trend context).
// Short: mirror at the upper band. Shorts default OFF in Pine (same
//        structural-underperformance reasoning as crypto_sr_volume) but,
//        unlike sr_volume, not a hard worker-side reject — Pine's toggle is
//        the source of truth here.
import { evaluateFactors, isLong, isShort, num } from './shared.js';

export const key = 'crypto_sr_bollinger';
export const label = 'Crypto S&R Bollinger Bounce';
export const assetClass = 'crypto';

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'bollinger_band_edge' };
export const exit = {};

const factors = [
  {
    name: 'band_bounce_trigger',
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
    name: 'ema200_trend_context',
    check: (s) => {
      const close = num(s.close ?? s.price);
      const ema = num(s.ema200);
      if (!Number.isFinite(close) || !Number.isFinite(ema)) return false;
      return isLong(s) ? close > ema : isShort(s) ? close < ema : false;
    },
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
