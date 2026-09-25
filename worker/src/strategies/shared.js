// Shared helpers for the strategy modules in this directory.
//
// Ported from spnni08/tradingview-bot worker.js: each strategy there gates
// entries with a hard AND-chain of factor checks (no additive score — see
// worker.js CANDIDATE_SCORING_DEFAULTS, hardAnd:true). `evaluateFactors`
// used to reproduce that as a hard gate here too (`passed` blocked the
// trade). That's no longer true — see routes/webhook.js's header comment on
// the 2026-09-25 decision: the field-mapping audit against the *current*
// tradingview-bot Pine scripts found most factors permanently failing on
// renamed/missing payload fields (Sierra Command's JS was ported once and
// never resynced), not on genuine market conditions. Pine already gates the
// signal hard before it ever calls alert() — Sierra Command re-checking a
// stale copy of that gate just silently drops real signals. So: Pine's
// signal is now the source of truth (see checkStructuralValidity in
// webhook.js, the only thing that can still reject a trade at the payload
// level), and `evaluateFactors` is informational-only — matched/failed/
// missing are stored per signal/trade for later analysis, never used to
// block. `legacyPassed` reproduces the old hard-AND result (missing fields
// still count against it) purely for audit/comparison against pre-2026-09-25
// behavior — nothing reads it to gate a trade.
//
// `missing` vs `failed`: a factor whose declared `fields` (the payload keys
// its `check` reads) aren't present in the signal is `missing`, not
// `failed` — that distinguishes "Pine and Sierra Command have drifted apart
// on this field" from "the condition was genuinely evaluated and didn't
// hold". `fields` is optional; a factor that doesn't declare it is always
// either matched or failed, never missing (used for factors that only read
// signal.direction, which structural validation already guarantees).

export const DEFAULT_EXIT = { slPct: 1.0, tp2RMultiple: 1.5 }; // EXIT_CONFIG default (1% SL, 1.5R TP2)

export const DEFAULT_TRAILING = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'atr' };

/**
 * Evaluate an ordered list of {name, check(signal) => boolean, fields?:
 * string[]} factors. Returns {legacyPassed, matched, failed, missing} — see
 * this file's header comment. `missing` is an array of {name, fields}
 * (which declared fields were absent for that factor); such a factor is
 * skipped (not called), landing in neither matched nor failed.
 */
export function evaluateFactors(signal, factors) {
  const matched = [];
  const failed = [];
  const missing = [];
  for (const factor of factors) {
    const declaredFields = factor.fields ?? [];
    const missingFields = declaredFields.filter((f) => signal[f] === undefined || signal[f] === null);
    if (missingFields.length > 0) {
      missing.push({ name: factor.name, fields: missingFields });
      continue;
    }
    let ok;
    try {
      ok = !!factor.check(signal);
    } catch {
      ok = false;
    }
    if (ok) matched.push(factor.name);
    else failed.push(factor.name);
  }
  const legacyPassed = failed.length === 0 && missing.length === 0;
  return { legacyPassed, matched, failed, missing };
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
