// Strategy registry: maps every strategy id seeded in worker/schema.sql
// (11 base WAVESCOUT strategies + their trailing-SL "(SL)" variants, 22
// total) to its module. Each module implements the same AND-gated factor
// logic as tradingview-bot/worker.js — see shared.js for the evaluation
// helper and buildExit() for the fixed-vs-trailing exit bracket.
//
// A "(SL)" variant is NOT a separate signal detector: it reuses the base
// module's `evaluate()` (same entry logic) and only swaps the exit config
// from a fixed %SL/R-TP bracket to a trailing stop anchored per
// module.trailingStop.anchor (see buildExit in shared.js).
import { buildExit } from './shared.js';

import * as cryptoBaseline from './cryptoBaseline.js';
import * as cryptoSrVolume from './cryptoSrVolume.js';
import * as cryptoOrderflowBreakout from './cryptoOrderflowBreakout.js';
import * as cryptoIchimokuBreakout from './cryptoIchimokuBreakout.js';
import * as cryptoSrBollinger from './cryptoSrBollinger.js';
import * as cryptoSrExclusion from './cryptoSrExclusion.js';
import * as cryptoIctSmc from './cryptoIctSmc.js';
import * as cryptoFlawlessVictory from './cryptoFlawlessVictory.js';
import * as cryptoMfiEngulfing from './cryptoMfiEngulfing.js';
import * as cryptoHolyGrailAdxSmaBb from './cryptoHolyGrailAdxSmaBb.js';
import * as cryptoBbRsiTrendfilter from './cryptoBbRsiTrendfilter.js';

// Order matches worker.js STRATEGIES registration order (crypto_baseline
// first as the control group, then the rest in tradingview-bot integration
// order) so schema.sql and this registry read the same list.
export const BASE_STRATEGIES = [
  cryptoBaseline,
  cryptoSrVolume,
  cryptoOrderflowBreakout,
  cryptoIchimokuBreakout,
  cryptoSrBollinger,
  cryptoSrExclusion,
  cryptoIctSmc,
  cryptoFlawlessVictory,
  cryptoMfiEngulfing,
  cryptoHolyGrailAdxSmaBb,
  cryptoBbRsiTrendfilter,
];

/**
 * Builds the full 22-entry registry: `<key>` (fixed exit) and `<key>_sl`
 * (trailing exit, same evaluate()). Keys match the `strategies.id` values
 * seeded in worker/schema.sql.
 */
function buildRegistry() {
  const registry = {};
  for (const mod of BASE_STRATEGIES) {
    registry[mod.key] = {
      key: mod.key,
      label: mod.label,
      assetClass: mod.assetClass,
      cooldownMinutes: mod.cooldownMinutes ?? null,
      disableShorts: mod.disableShorts ?? false,
      evaluate: mod.evaluate,
      exit: buildExit(mod.exit, mod.trailingStop, 'fixed'),
    };
    registry[`${mod.key}_sl`] = {
      key: `${mod.key}_sl`,
      label: `${mod.label} (SL)`,
      assetClass: mod.assetClass,
      cooldownMinutes: mod.cooldownMinutes ?? null,
      disableShorts: mod.disableShorts ?? false,
      evaluate: mod.evaluate,
      exit: buildExit(mod.exit, mod.trailingStop, 'trailing'),
    };
  }
  return registry;
}

export const STRATEGY_REGISTRY = buildRegistry();

export function getStrategy(strategyKey) {
  return STRATEGY_REGISTRY[strategyKey] ?? null;
}

/**
 * Evaluates a raw signal payload against a registered strategy (base or
 * "(SL)" variant) and returns the pass/fail result plus the resolved exit
 * config for that variant.
 */
export function evaluateSignal(strategyKey, signal) {
  const strategy = getStrategy(strategyKey);
  if (!strategy) {
    return { passed: false, error: 'unknown_strategy', strategyKey };
  }
  const result = strategy.evaluate(signal);
  return { ...result, strategyKey, exit: strategy.exit };
}
