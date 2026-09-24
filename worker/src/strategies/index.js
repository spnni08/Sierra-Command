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
import * as ictSweepMss from './ictSweepMss.js';
import * as scKeylevelSweep from './scKeylevelSweep.js';

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
      // signalOnlyExit (currently only crypto_flawless_victory's v1) opts
      // the BASE registry entry only out of the usual fixed %SL/R-TP
      // bracket — see that module's comment and backtest/engine.js's
      // exit.mode:'signal' path. The "(SL)" variant below is untouched.
      exit: mod.signalOnlyExit ? { mode: 'signal' } : buildExit(mod.exit, mod.trailingStop, 'fixed'),
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

// crypto_flawless_victory_v2/_v3: unlike every other "(SL)" pairing above
// (same evaluate(), fixed-vs-trailing exit swap), v2/v3 are genuinely
// different Pine-side entry/exit logic bundled under one strategy() script
// (see cryptoFlawlessVictory.js's header comment and the .pine source) — not
// a trailing-stop variant of the base key. They reuse the SAME evaluate()
// (the `version` factor already gates v1/v2/v3 generically; the adapter
// picks which BB/RSI/MFI combination feeds the signal per version — see
// backtest/adapters.js) and are registered here as their own keys, following
// this file's existing convention of one registry entry per strategyId
// string (same key/label/assetClass/evaluate/exit shape as every other
// entry), rather than looping them through buildRegistry()'s generic
// base+"_sl" pairing (which would also bolt on a redundant trailing-SL
// variant that has no Pine equivalent for v2/v3).
STRATEGY_REGISTRY.crypto_flawless_victory_v2 = {
  key: 'crypto_flawless_victory_v2',
  label: `${cryptoFlawlessVictory.label} v2`,
  assetClass: cryptoFlawlessVictory.assetClass,
  cooldownMinutes: null,
  disableShorts: false,
  evaluate: cryptoFlawlessVictory.evaluate,
  exit: cryptoFlawlessVictory.V2_EXIT,
};
STRATEGY_REGISTRY.crypto_flawless_victory_v3 = {
  key: 'crypto_flawless_victory_v3',
  label: `${cryptoFlawlessVictory.label} v3`,
  assetClass: cryptoFlawlessVictory.assetClass,
  cooldownMinutes: null,
  disableShorts: false,
  evaluate: cryptoFlawlessVictory.evaluate,
  exit: cryptoFlawlessVictory.V3_EXIT,
};

// ict_sweep_mss / ict_sweep_mss_sl — like crypto_flawless_victory_v2/v3
// above, this doesn't fit buildRegistry()'s generic base+"_sl" fixed-%-vs-
// ATR-trailing pairing: both variants need structure-derived absolute
// entry/SL/TP levels straight off the adapter's signal (sweep-low-based SL,
// next-untouched-swing-high TP — not a %/ATR multiple), via engine.js's
// exit.mode:'levels'. The _sl variant layers breakeven-at-1R +
// trail-under-new-confirmed-swing-point management on top of those same
// initial levels (exit.mode:'levels_trailing') rather than swapping to a
// generic ATR trail — see ictSweepMssAdapter.js's trailAnchorAt and
// engine.js's exit.mode:'levels_trailing' block.
STRATEGY_REGISTRY.ict_sweep_mss = {
  key: 'ict_sweep_mss',
  label: ictSweepMss.label,
  assetClass: ictSweepMss.assetClass,
  cooldownMinutes: null,
  disableShorts: false,
  evaluate: ictSweepMss.evaluate,
  exit: { mode: 'levels' },
};
STRATEGY_REGISTRY.ict_sweep_mss_sl = {
  key: 'ict_sweep_mss_sl',
  label: `${ictSweepMss.label} (SL)`,
  assetClass: ictSweepMss.assetClass,
  cooldownMinutes: null,
  disableShorts: false,
  evaluate: ictSweepMss.evaluate,
  exit: { mode: 'levels_trailing' },
};

// sc_keylevel_sweep — session-key-level sweep -> CHoCH -> confluence-zone
// entry, exit.mode:'levels' like ict_sweep_mss (structure-derived SL/TP off
// the signal — see routes/webhook.js's computeBracket()), but with no
// "(SL)" trailing twin: the strategy's own spec (scKeylevelSweep.js) only
// describes a single fixed SL/TP scheme, not a trailing-management scheme,
// so only the base key is registered here.
STRATEGY_REGISTRY.sc_keylevel_sweep = {
  key: 'sc_keylevel_sweep',
  label: scKeylevelSweep.label,
  assetClass: scKeylevelSweep.assetClass,
  cooldownMinutes: null,
  disableShorts: false,
  evaluate: scKeylevelSweep.evaluate,
  exit: scKeylevelSweep.exit,
};

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
