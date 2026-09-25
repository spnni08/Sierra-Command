// crypto_sr_exclusion — S&R zone touch (no volume component) + RSI
// trend-bounce direction as a hard precondition, followed by a graduated
// NEGATIVE-only score filter (4 x 20pt criteria, threshold >=60 -> at most
// one may fail). Ported from
// tradingview-bot/pinescript/strategies/crypto_sr_exclusion.pine +
// worker.js CANDIDATE_SCORING_DEFAULTS.crypto_sr_exclusion.
//
// Precondition (hard reject if violated):
//   - S&R zone touch (classic pivot support/resistance, not volume profile)
//   - RSI trend-bounce direction: LONG needs RSI turning UP out of oversold
//     (rsi > RSI_LONG_MIN), SHORT mirrored (rsi < RSI_SHORT_MAX) — same
//     directionality as crypto_sr_volume, NOT the inverted mean-reversion
//     reading used by crypto_sr_bollinger.
// Negative score (each criterion only ever REMOVES points when the adverse
// condition is present — never a substitute path to a pass):
//   - no_atr_spike, no_thin_volume, rsi_not_opposite_extreme, cooldown_elapsed
import { evaluateFactors, isLong, isShort, num } from './shared.js';

export const key = 'crypto_sr_exclusion';
export const label = 'Crypto S&R Exclusion Filter';
export const assetClass = 'crypto';

export const params = {
  RSI_LONG_MIN: 40,
  RSI_SHORT_MAX: 60,
  RSI_LONG_OVERBOUGHT_MAX: 70,
  RSI_SHORT_OVERSOLD_MIN: 30,
  COOLDOWN_MINUTES: 10,
  THRESHOLD: 60, // out of 80 (4 x 20) -> at most one negative criterion may fire
};

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'sr_zone' };
export const exit = {};

// `fields` per shared.js's header comment. crypto_sr_exclusion.pine's
// current f_payload() sends `trigger` as "SR_SUPPORT_BOUNCE"/
// "SR_RESISTANCE_BOUNCE" (never "SUPPORT_TOUCH"/"RESISTANCE_TOUCH"/
// "SR_TOUCH"), and sends `atrSpike`/`thinVolume` (camelCase, not the
// snake_case `atr_spike`/`thin_volume` below) while never sending
// `cooldown_active` at all — verified 2026-09-25. `sr_zone_touch` is
// therefore expected to land in `failed` (the field IS present, just never
// with a value this check recognizes) rather than `missing`; the three
// negative criteria are expected in `missing`.
const preconditionFactors = [
  {
    name: 'sr_zone_touch',
    fields: ['trigger'],
    check: (s) => {
      const trigger = String(s.trigger ?? s.setup_type ?? '').toUpperCase();
      return trigger === 'SUPPORT_TOUCH' || trigger === 'RESISTANCE_TOUCH' || trigger === 'SR_TOUCH';
    },
  },
  {
    name: 'rsi_trend_bounce_direction',
    fields: ['rsi'],
    check: (s) => {
      const rsi = num(s.rsi);
      if (!Number.isFinite(rsi)) return false;
      return isLong(s) ? rsi > params.RSI_LONG_MIN : isShort(s) ? rsi < params.RSI_SHORT_MAX : false;
    },
  },
];

// Negative-score criteria: `true` means the criterion GIVES its 20 points
// (i.e. the adverse condition is ABSENT). All four passing => full 80. This
// score is informational only as of 2026-09-25 (see shared.js's header
// comment) — nothing reads it to block a trade anymore, only `legacyScore`
// for audit/comparison against the pre-2026-09-25 behavior.
const negativeCriteria = [
  { name: 'no_atr_spike', points: 20, fields: ['atr_spike'], check: (s) => !s.atr_spike },
  { name: 'no_thin_volume', points: 20, fields: ['thin_volume'], check: (s) => !s.thin_volume },
  {
    name: 'rsi_not_opposite_extreme',
    points: 20,
    fields: ['rsi'],
    check: (s) => {
      const rsi = num(s.rsi);
      if (!Number.isFinite(rsi)) return true;
      return isLong(s)
        ? rsi <= params.RSI_LONG_OVERBOUGHT_MAX
        : isShort(s)
          ? rsi >= params.RSI_SHORT_OVERSOLD_MIN
          : true;
    },
  },
  { name: 'cooldown_elapsed', points: 20, fields: ['cooldown_active'], check: (s) => !s.cooldown_active },
];

export function evaluate(signal) {
  const precondition = evaluateFactors(signal, preconditionFactors);

  let legacyScore = 0;
  const matched = [...precondition.matched];
  const failed = [...precondition.failed];
  const missing = [...precondition.missing];
  for (const c of negativeCriteria) {
    const missingFields = (c.fields ?? []).filter((f) => signal[f] === undefined || signal[f] === null);
    if (missingFields.length > 0) {
      missing.push({ name: c.name, fields: missingFields });
      continue;
    }
    if (c.check(signal)) {
      legacyScore += c.points;
      matched.push(c.name);
    } else {
      failed.push(c.name);
    }
  }

  const legacyPassed = precondition.legacyPassed && legacyScore >= params.THRESHOLD;
  return { legacyPassed, matched, failed, missing, legacyScore };
}
