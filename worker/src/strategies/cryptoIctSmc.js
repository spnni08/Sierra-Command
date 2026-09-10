// crypto_ict_smc — ICT / Smart Money Concepts. Ported from
// tradingview-bot/pinescript/strategies/crypto_ict_smc.pine + worker.js
// STRATEGIES.crypto_ict_smc / CANDIDATE_SCORING_DEFAULTS.crypto_ict_smc.
//
// Pine gates itself hard (HTF zone touch + N-of-{BOS,OB,SMT} confirmations);
// the worker only re-checks the payload's reported booleans/counters — no
// independent FVG/OB/swing geometry recompute (that logic lives exclusively
// in Pine / backtest/ict_smc as the reference spec).
//
// Long/Short: htf zone touch AND confirmations_count >= min_confirmations
// (default MIN_CONFIRMATIONS=2, mirrors backtest/ict_smc StrategyParams).
// Trailing-SL anchor: last HL (long) / LH (short) swing point, per the
// task's known anchor mapping.
import { evaluateFactors, isLong, isShort, num } from './shared.js';

export const key = 'crypto_ict_smc';
export const label = 'Crypto ICT/SMC';
export const assetClass = 'crypto';

export const params = {
  MIN_CONFIRMATIONS: 2,
};

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'swing_point' };
export const exit = {}; // EXIT_CONFIG defaults — Pine's own OB/swing SL stays payload telemetry only, see worker.js comment

const factors = [
  {
    name: 'htf_zone_touch',
    check: (s) => !!(s.htf_zone_touch ?? s.zone_touch),
  },
  {
    name: 'min_confirmations',
    check: (s) => {
      const count = num(s.confirmations_count);
      const min = num(s.min_confirmations);
      const threshold = Number.isFinite(min) ? min : params.MIN_CONFIRMATIONS;
      return Number.isFinite(count) && count >= threshold;
    },
  },
  {
    name: 'direction_present',
    check: (s) => isLong(s) || isShort(s),
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
