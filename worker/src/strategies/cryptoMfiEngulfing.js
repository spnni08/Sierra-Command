// crypto_mfi_engulfing — MFI(14) extreme zone + filtered engulfing reversal.
// Ported from
// tradingview-bot/pinescript/strategies/crypto_mfi_engulfing.pine +
// worker.js STRATEGIES.crypto_mfi_engulfing.
//
// MFI extremes at 10/90 (deliberately rarer/stronger than the classic 80/20
// MFI thresholds). "Filtered" engulfing: a plain 2-candle engulfing is not
// enough on its own — Pine additionally requires the pattern to occur at
// the MFI extreme (the worker trusts Pine's own geometry check and only
// re-verifies the reported booleans).
import { evaluateFactors, isLong, isShort, num } from './shared.js';

export const key = 'crypto_mfi_engulfing';
export const label = 'Crypto MFI Engulfing';
export const assetClass = 'crypto';

export const params = {
  MFI_OVERSOLD_EXTREME: 10,
  MFI_OVERBOUGHT_EXTREME: 90,
};

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'atr' };
export const exit = {};

const factors = [
  {
    name: 'mfi_extreme_zone',
    check: (s) => {
      const mfi = num(s.mfi);
      if (!Number.isFinite(mfi)) return false;
      return isLong(s) ? mfi <= params.MFI_OVERSOLD_EXTREME : isShort(s) ? mfi >= params.MFI_OVERBOUGHT_EXTREME : false;
    },
  },
  {
    name: 'filtered_engulfing_pattern',
    check: (s) => !!(s.engulfing_bullish || s.engulfing_bearish || s.engulfing),
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
