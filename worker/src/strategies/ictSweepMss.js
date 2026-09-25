// ict_sweep_mss — Liquidity Sweep -> Displacement -> Market Structure Shift
// (MSS) -> Fair Value Gap (FVG) -> Entry -> Target. A distinct ICT model
// from crypto_ict_smc (BOS/CHoCH + order-block + FVG-existence, no
// liquidity-sweep concept at all — see cryptoIctSmc.js/ictSmcAdapter.js's
// header comments), added as its own strategy rather than folded into that
// one. Long/short are exact mirrors of each other.
//
// All entry/exit gating (sweep confirmation, displacement, MSS, FVG,
// minimum R-multiple, fill, invalidation, optional HTF bias) is already
// enforced by the adapter (backtest/ictSweepMssAdapter.js) before it ever
// emits a signal — only a fully-qualified, still-valid setup produces one at
// all. The factors below re-check the signal's own already-computed
// booleans, same pattern as crypto_ict_smc.js's factors, purely for
// evaluate()'s matched/failed telemetry (signals.factor_state) rather than
// as independent gates.
import { evaluateFactors, isLong, isShort } from './shared.js';

export const key = 'ict_sweep_mss';
export const label = 'ICT Sweep -> MSS -> FVG';
export const assetClass = 'crypto'; // also backtestable against forex/index (EURUSD, SPX500, NAS100) — see backtest/adapters.js and candles.js's fetchForexIndexCandles

export const params = {
  TIMEFRAME_DEFAULT: '15m',
};

// Declared for parity with every other strategy module's convention (see
// strategies/index.js's header comment) — NOT read by engine.js's
// exit.mode:'levels'/'levels_trailing' paths (those take sl/tp straight off
// the signal, see ictSweepMssAdapter.js), just documents the _sl variant's
// intended anchor for anyone reading this file next to the others.
export const trailingStop = { enabled: true, atrMult: null, atrLen: 14, anchor: 'swing_point_breakeven_then_trail' };
export const exit = {};

// `fields` per shared.js's header comment. No TradingView alert script
// exists yet for ict_sweep_mss (see worker README's alert-URL table) — these
// declarations are the forward-looking contract for whoever writes one,
// not evidence of current drift.
const factors = [
  { name: 'liquidity_sweep', fields: ['liquidity_sweep'], check: (s) => !!s.liquidity_sweep },
  { name: 'displacement', fields: ['displacement'], check: (s) => !!s.displacement },
  { name: 'mss', fields: ['mss'], check: (s) => !!s.mss },
  { name: 'fvg_present', fields: ['fvg_present'], check: (s) => !!s.fvg_present },
  { name: 'min_rr_ok', fields: ['min_rr_ok'], check: (s) => !!s.min_rr_ok },
  { name: 'htf_bias_ok', fields: ['htf_bias_ok'], check: (s) => !!s.htf_bias_ok },
  { name: 'direction_present', check: (s) => isLong(s) || isShort(s) },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
