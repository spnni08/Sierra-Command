// crypto_flawless_victory — Pine v5 port of the "Flawless Victory" strategy
// (ML-generated Bollinger/RSI/MFI combo). Three selectable variants (v1: no
// SL/TP, v2/v3: fixed % SL/TP) reported via the payload's `version` field.
// Ported from
// tradingview-bot/pinescript/strategies/crypto_flawless_victory.pine +
// worker.js STRATEGIES.crypto_flawless_victory.
//
// Pine gates itself hard (cross-event trigger + RSI/MFI guard + optional
// HTF trend filter) — the worker only checks that a valid version is
// reported and, if the payload says the HTF filter was active, that it was
// also passed (no silent bypass of an enabled Pine-side filter).
import { evaluateFactors } from './shared.js';

export const key = 'crypto_flawless_victory';
export const label = 'Crypto Flawless Victory';
export const assetClass = 'crypto';

export const params = {
  VALID_VERSIONS: ['v1', 'v2', 'v3'],
};

export const trailingStop = { enabled: true, atrMult: 1.5, atrLen: 14, anchor: 'atr' };
export const exit = {}; // v1 uses EXIT_CONFIG defaults; v2/v3 send sl/tp directly in the payload

const factors = [
  {
    name: 'bb_rsi_mfi_cross_trigger',
    check: (s) => !!(s.bb_buy_trigger || s.bb_sell_trigger || s.trigger),
  },
  {
    name: 'valid_version',
    check: (s) => params.VALID_VERSIONS.includes(String(s.version ?? '').toLowerCase()),
  },
  {
    name: 'htf_filter_passed_if_active',
    check: (s) => (s.htf_filter_active ? !!s.htf_filter_passed : true),
  },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
