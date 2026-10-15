import { describe, it, expect } from 'vitest';
import { ADAPTERS, getAdapterStatus } from '../src/backtest/adapters.js';
import { BACKTEST_ADAPTER_STATUS } from '../../src/lib/backtestAdapters.js';

// The UI (src/pages/ProTerminal.jsx) cannot import the worker, so it mirrors
// the adapter status by hand. A strategy with a worker adapter that is
// missing there shows up as "Noch kein Adapter" in the picker — exactly the
// stale status crypto_ict_smc had. This test makes that drift a CI failure.
describe('UI adapter status mirror', () => {
  it('lists every worker adapter, and nothing else', () => {
    expect(Object.keys(BACKTEST_ADAPTER_STATUS).sort()).toEqual(Object.keys(ADAPTERS).sort());
  });

  it('agrees with the worker on full vs partial for every strategy', () => {
    for (const id of Object.keys(ADAPTERS)) {
      expect(BACKTEST_ADAPTER_STATUS[id], id).toBe(getAdapterStatus(id));
    }
  });
});
