import { describe, it, expect } from 'vitest';
import { evaluate, key, exit, requiredBacktestTimeframe } from '../src/strategies/scKeylevelSweep.js';
import { getStrategy } from '../src/strategies/index.js';

// evaluate() re-checks booleans the Pine alert script already computed
// (sweep/CHoCH/zone-confluence/RR/invalidation are never recomputed here —
// see scKeylevelSweep.js's header) — so these tests exercise the hard
// AND-gate (evaluateFactors) over that already-decided payload shape, not
// any sweep/CHoCH/zone detection logic (there is none in this file; a
// future backtest adapter owns that — see requiredBacktestTimeframe below).
const fullPassPayload = {
  direction: 'long',
  liquidity_sweep: true,
  choch_confirmed: true,
  entry_close_in_zone: true,
  confluence_min_ok: true,
  min_rr_ok: true,
  not_invalidated: true,
};

describe('scKeylevelSweep.evaluate — hard AND-gate over the Pine-computed factors', () => {
  it('passes when every factor is true', () => {
    const result = evaluate(fullPassPayload);
    expect(result.passed).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.matched.sort()).toEqual(
      ['liquidity_sweep', 'choch_confirmed', 'entry_close_in_zone', 'confluence_min_ok', 'min_rr_ok', 'not_invalidated', 'direction_present'].sort()
    );
  });

  it.each([
    'liquidity_sweep',
    'choch_confirmed',
    'entry_close_in_zone',
    'confluence_min_ok',
    'min_rr_ok',
    'not_invalidated',
  ])('fails when %s alone is false, listing it in failed', (factorName) => {
    const result = evaluate({ ...fullPassPayload, [factorName]: false });
    expect(result.passed).toBe(false);
    expect(result.failed).toEqual([factorName]);
  });

  it('direction_present passes for "long"/"short" (case-insensitive) and fails otherwise', () => {
    expect(evaluate({ ...fullPassPayload, direction: 'LONG' }).passed).toBe(true);
    expect(evaluate({ ...fullPassPayload, direction: 'short' }).passed).toBe(true);
    expect(evaluate({ ...fullPassPayload, direction: 'sideways' }).failed).toContain('direction_present');
    expect(evaluate({ ...fullPassPayload, direction: undefined }).failed).toContain('direction_present');
  });

  it('never throws on a missing/malformed payload — a throwing check just fails that factor', () => {
    expect(() => evaluate({})).not.toThrow();
    const result = evaluate({});
    expect(result.passed).toBe(false);
    expect(result.failed.length).toBeGreaterThan(0);
  });
});

describe('sc_keylevel_sweep — registered in the strategy registry', () => {
  it('is reachable via getStrategy with exit.mode:\'levels\'', () => {
    const strategy = getStrategy('sc_keylevel_sweep');
    expect(strategy).not.toBeNull();
    expect(strategy.key).toBe('sc_keylevel_sweep');
    expect(strategy.exit.mode).toBe('levels');
    expect(strategy.evaluate).toBe(evaluate);
  });

  it('has no "_sl" trailing twin (single fixed SL/TP scheme, not a trailing-management design)', () => {
    expect(getStrategy('sc_keylevel_sweep_sl')).toBeNull();
  });

  it('module exports match the registry entry', () => {
    expect(key).toBe('sc_keylevel_sweep');
    expect(exit.mode).toBe('levels');
  });

  it('documents the candle granularity a future backtest adapter must use', () => {
    expect(requiredBacktestTimeframe).toBe('5m');
  });
});
