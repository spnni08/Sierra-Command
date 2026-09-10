// Shared helpers for the strategy modules in this directory.
//
// Ported from spnni08/tradingview-bot worker.js: each strategy there gates
// entries with a hard AND-chain of factor checks (no additive score — see
// worker.js CANDIDATE_SCORING_DEFAULTS, hardAnd:true) rather than a partial
// score threshold. `evaluateFactors` reproduces that: every factor must pass
// (fn(signal) === true) or the whole candidate is rejected. `matched`/
// `failed` are returned for telemetry (factor_state / signals.factor_state).

export const DEFAULT_EXIT = { slPct: 1.0, tp2RMultiple: 1.5 }; // EXIT_CONFIG default (1% SL, 1.5R TP2)

export const DEFAULT_TRAILING = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'atr' };

/**
 * Evaluate an ordered list of {name, check(signal) => boolean} factors as a
 * hard AND-chain. Returns {passed, matched, failed} — `passed` is false as
 * soon as any factor fails (short-circuits, mirroring the Pine-side hard
 * gates that never fire an alert unless every condition holds).
 */
export function evaluateFactors(signal, factors) {
  const matched = [];
  const failed = [];
  for (const factor of factors) {
    let ok;
    try {
      ok = !!factor.check(signal);
    } catch {
      ok = false;
    }
    if (ok) matched.push(factor.name);
    else failed.push(factor.name);
  }
  return { passed: failed.length === 0, matched, failed };
}

export function num(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : NaN;
}

export function upper(value) {
  return String(value ?? '').toUpperCase();
}

export function isLong(signal) {
  return upper(signal.direction) === 'LONG';
}

export function isShort(signal) {
  return upper(signal.direction) === 'SHORT';
}

/**
 * Builds the exit config for a strategy given its base EXIT_CONFIG override
 * and whether this is the trailing-SL "(SL)" variant. Base variants get a
 * fixed %SL / R-multiple TP2 bracket; trailing variants substitute a
 * per-strategy anchor for the fixed SL (see each strategy module's
 * `trailingStop.anchor`) and keep the fixed TP2 as an emergency cap only —
 * mirrors worker.js exitConfigForStrategy() + STRATEGIES[key].trailingStop.
 */
export function buildExit(exitOverride, trailingStop, exitMode) {
  const exit = { ...DEFAULT_EXIT, ...exitOverride };
  if (exitMode === 'trailing') {
    return {
      mode: 'trailing',
      tp2RMultiple: exit.tp2RMultiple,
      trailing: { ...DEFAULT_TRAILING, ...trailingStop },
    };
  }
  return { mode: 'fixed', slPct: exit.slPct, tp2RMultiple: exit.tp2RMultiple };
}
