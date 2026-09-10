// crypto_ichimoku_breakout — Ichimoku Kumo (cloud) breakout with ADX regime
// filter, Chikou confirmation and volume spike. Ported from
// tradingview-bot/pinescript/strategies/crypto_ichimoku_breakout.pine +
// worker.js STRATEGIES.crypto_ichimoku_breakout.
//
// Long : close > Kumo top (max(senkouA, senkouB)) AND ADX > 22 AND
//        close > Chikou reference (price chikouShift bars ago) AND
//        volume > 1.5x average.
// Short: mirror at Kumo bottom.
import { evaluateFactors, isLong, isShort, num } from './shared.js';

export const key = 'crypto_ichimoku_breakout';
export const label = 'Crypto Ichimoku Breakout';
export const assetClass = 'crypto';
export const cooldownMinutes = 30;

export const params = {
  ADX_MIN: 22,
  VOLUME_MULTIPLIER: 1.5,
  ichimokuPeriods: { tenkan: 5, kijun: 13, senkou_b: 26, chikou_shift: 13, adx_period: 14 },
};

export const trailingStop = { enabled: true, atrMult: 2.0, atrLen: 14, anchor: 'kumo_edge' }; // wider than default: structural moves
export const exit = {};

function kumoTop(s) {
  const a = num(s.senkou_a);
  const b = num(s.senkou_b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.max(a, b);
}
function kumoBottom(s) {
  const a = num(s.senkou_a);
  const b = num(s.senkou_b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.min(a, b);
}

const factors = [
  {
    name: 'kumo_breakout',
    check: (s) => {
      const close = num(s.close ?? s.price);
      if (!Number.isFinite(close)) return false;
      if (isLong(s)) return close > kumoTop(s);
      if (isShort(s)) return close < kumoBottom(s);
      return false;
    },
  },
  {
    name: 'adx_regime_min',
    check: (s) => {
      const adx = num(s.adx);
      return Number.isFinite(adx) && adx > params.ADX_MIN;
    },
  },
  {
    name: 'chikou_confirm',
    check: (s) => {
      const close = num(s.close ?? s.price);
      const chikouRef = num(s.chikou_ref ?? s.chikou_reference);
      if (!Number.isFinite(close) || !Number.isFinite(chikouRef)) return false;
      return isLong(s) ? close > chikouRef : isShort(s) ? close < chikouRef : false;
    },
  },
  {
    name: 'volume_spike',
    check: (s) => {
      const vol = num(s.candle_volume);
      const avg = num(s.avg_volume);
      if (!Number.isFinite(vol) || !Number.isFinite(avg) || avg === 0) return false;
      return vol / avg > params.VOLUME_MULTIPLIER;
    },
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
