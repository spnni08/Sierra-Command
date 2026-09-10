// crypto_sr_volume — Support/Resistance via Volume Profile (VAL/VAH/POC) +
// EMA200 trend filter. Ported from
// tradingview-bot/pinescript/strategies/crypto_sr_volume.pine + worker.js
// STRATEGIES.crypto_sr_volume.
//
// Long : price bounces off VAL (reclaim trigger) AND close > EMA200.
// Short: price rejects at VAH (breakdown trigger) AND close < EMA200.
//        Shorts are disabled by default (structural underperformance found
//        in WAVESCOUT's D1 backtests — see worker.js comment).
// No RSI gate (removed per worker.js 2026-08 decision) and no HTF bias hard
// gate (removed 2026-08-13, see worker.js BIAS_GATED_STRATEGIES comment).
import { evaluateFactors, isLong, isShort, upper } from './shared.js';

export const key = 'crypto_sr_volume';
export const label = 'Crypto S&R Volume Profile';
export const assetClass = 'crypto';
export const cooldownMinutes = 30;
export const disableShorts = true;

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'sr_zone' };
export const exit = {};

const factors = [
  {
    name: 'reclaim_breakdown_trigger',
    check: (s) => {
      const trigger = upper(s.trigger ?? s.setup_type);
      if (isLong(s)) return trigger === 'RECLAIM' || trigger === 'VAL_BOUNCE';
      if (isShort(s)) return trigger === 'BREAKDOWN' || trigger === 'VAH_REJECT';
      return false;
    },
  },
  {
    name: 'ema200_trend_filter',
    check: (s) => {
      const close = parseFloat(s.close ?? s.price);
      const ema = parseFloat(s.ema200);
      if (!Number.isFinite(close) || !Number.isFinite(ema)) return false;
      return isLong(s) ? close > ema : isShort(s) ? close < ema : false;
    },
  },
  {
    name: 'shorts_not_disabled',
    check: (s) => !(disableShorts && isShort(s)),
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
