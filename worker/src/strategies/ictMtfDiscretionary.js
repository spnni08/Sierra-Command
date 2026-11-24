// ict_mtf_discretionary — Marvin's ICT Multi-Timeframe discretionary strategy.
//
// This module defines the checklist the AI evaluates factor-by-factor. No
// Pine indicator computes these values autonomously — the AI receives raw
// candle data and derives each factor. Pine only fires the initial alert
// (entry-zone proximity signal); the AI checklist is the real gate.
//
// All four factors are REQUIRED (required: true). If any is not met the
// decision MUST be NO_TRADE. The AI must never override this rule — the
// deterministic guardrail in ai/ictMtfPipeline.js enforces it independently.
//
// SL rule: knapp hinter der FVG-Zone; liegt laut Liquidity Heatmap eine
// größere Wand näher am Preis, SL dahinter (see ai/ictMtfPipeline.js).
// Exit rule: kein festes TP — Exit bei Gegen-BOS/MS auf dem 15m-Chart.
import { evaluateFactors } from './shared.js';

export const key = 'ict_mtf_discretionary';
export const label = 'ICT MTF (Discretretionär)';
export const assetClass = 'crypto';

// Factor checklist — stored as config, not hardcoded in AI prompts.
// The AI receives this list and must address each factor by id.
export const CHECKLIST = [
  {
    id: 'bias_1h4h',
    label: 'HTF Bias 1h/4h',
    timeframe: ['1h', '4h'],
    required: true,
    description: 'Eindeutiger bullisher oder bearisher Bias auf dem 1h- und 4h-Chart (BOS/MS, Marktstruktur, Swings). Muss mit der Trade-Richtung übereinstimmen.',
  },
  {
    id: 'bos_ms_15m',
    label: 'BOS/MS 15m in Bias-Richtung',
    timeframe: ['15m'],
    required: true,
    description: 'Break of Structure oder Market Structure Shift auf dem 15m-Chart in Richtung des HTF-Bias.',
  },
  {
    id: 'fvg_retest_15m',
    label: 'FVG-Retest 15m',
    timeframe: ['5m', '15m'],
    required: true,
    description: 'Fair Value Gap nach dem BOS/MS auf dem 15m-Chart vorhanden, Preis retestet aktuell die FVG-Zone (Kerze berührt oder ist innerhalb der Zone).',
  },
  {
    id: 'footprint_delta_5m',
    label: 'Footprint/Delta 5m Bestätigung',
    timeframe: ['5m'],
    required: true,
    description: 'Footprint- und Delta-Bestätigung innerhalb der FVG-Zone in Trade-Richtung auf dem 5m-Chart. Quelle: <PLATZHALTER_ORDERFLOW_QUELLE>. Fehlt die Quelle, Faktor als nicht prüfbar markieren.',
  },
];

// evaluateFactors-compatible factor array for webhook telemetry.
// Since the AI derives these (not Pine), all fields come from the
// ai_decisions table, not the webhook payload directly.
const factors = CHECKLIST.map((c) => ({
  name: c.id,
  check: () => false, // AI-derived only — never evaluated from raw webhook payload
}));

export function evaluate(signal) {
  // This strategy is AI-driven. evaluate() is called by the shared webhook
  // pipeline for telemetry only; all factors are "missing" because the
  // webhook payload does not contain the AI-derived values.
  void signal;
  return evaluateFactors({}, factors);
}

// Exit configuration — no fixed TP; SL behind FVG zone.
// The AI sets entry/sl; tp is null; exit_rule is gegen_bos_ms_15m.
export const exit = { mode: 'signal' }; // exit on counter-BOS/MS signal
export const trailingStop = { enabled: false };
