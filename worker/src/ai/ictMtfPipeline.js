// ICT MTF Discretionary AI Decision Pipeline.
//
// Flow: Pine alert → webhook → enrich with candle data → AI checklist →
//       deterministic guardrails → save to ai_decisions table (log + UI).
//       Result is NEVER auto-executed — display/confirmation only.
//
// Deterministic guardrails (outside AI, cannot be overridden):
//   1. All required factors must be met=true → otherwise force NO_TRADE.
//   2. SL must be on the correct side of entry (long: sl < entry, short: sl > entry).
//   3. Max one open AI-decision trade per asset (checked against ai_decisions).
//   4. Missing data source → factor "nicht prüfbar" → NO_TRADE.

import { CHECKLIST } from '../strategies/ictMtfDiscretionary.js';
import { callProviderPool } from './client.js';

const FACTOR_IDS = CHECKLIST.map((c) => c.id);
const REQUIRED_FACTOR_IDS = CHECKLIST.filter((c) => c.required).map((c) => c.id);

// Candle timeframes to fetch for context (Binance interval codes)
const CANDLE_TIMEFRAMES = ['5m', '15m', '1h', '4h'];
const CANDLE_LIMIT = 50; // enough context for swing/BOS/FVG detection

/**
 * Builds the system prompt with the full checklist description.
 * @param {string} direction 'long'|'short'
 * @returns {string}
 */
function buildSystemPrompt(direction) {
  const checklistText = CHECKLIST.map(
    (c) => `- id: "${c.id}" | ${c.label} (${c.timeframe.join('/')}) | required: ${c.required}\n  ${c.description}`
  ).join('\n');

  return `Du bist ein präziser ICT/SMC-Handelsanalyst. Du bewertest eine Handelsgelegenheit anhand einer festen Checkliste.

Checkliste (alle Faktoren PFLICHT):
${checklistText}

Trade-Richtung: ${direction.toUpperCase()}

Regeln:
- Bewerte jeden Faktor anhand der Kerzendaten.
- Ist ein Faktor wegen fehlender Datenquelle nicht prüfbar, setze met=false und beschreibe dies in evidence.
- Antworte AUSSCHLIESSLICH mit einem JSON-Objekt (kein Text davor/danach).
- Ungültiges JSON oder fehlende Faktoren → decision muss NO_TRADE sein.
- exit_rule ist immer "gegen_bos_ms_15m".

JSON-Schema (streng einhalten):
{
  "decision": "LONG" | "SHORT" | "NO_TRADE",
  "factors": [
    { "id": "<factor_id>", "met": true|false, "evidence": "<kurz, mit Preisen/Zeiten>" }
  ],
  "entry": <number|null>,
  "stop_loss": <number|null>,
  "exit_rule": "gegen_bos_ms_15m",
  "confidence": <0.0 bis 1.0>,
  "reason": "<kurze Begründung>"
}`;
}

/**
 * Fetches candle data for a symbol across multiple timeframes.
 * Returns a map of timeframe → candles array, or empty array on failure.
 * Uses the existing /binance/candles route logic (direct upstream call).
 * @param {string} symbol e.g. 'BTCUSDT'
 * @param {object} env
 * @returns {Promise<Record<string, Array<{timestamp,open,high,low,close}>>>}
 */
async function fetchCandleData(symbol, env) {
  const result = {};
  // Binance Futures Testnet (matches existing routes/binance.js pattern).
  // If the testnet WAF blocks (known issue — see binance.js header), candles
  // will be empty and affected factors become "nicht prüfbar" → NO_TRADE.
  const BINANCE_API = 'https://testnet.binancefuture.com';

  for (const tf of CANDLE_TIMEFRAMES) {
    try {
      const url = new URL(`${BINANCE_API}/fapi/v1/klines`);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('interval', tf);
      url.searchParams.set('limit', String(CANDLE_LIMIT));

      const res = await fetch(url.toString());
      if (!res.ok) {
        result[tf] = [];
        continue;
      }
      const raw = await res.json();
      if (!Array.isArray(raw)) {
        result[tf] = [];
        continue;
      }
      // Binance kline format: [openTime, open, high, low, close, volume, ...]
      result[tf] = raw.map((k) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
      }));
    } catch {
      result[tf] = [];
    }
  }
  return result;
}

/**
 * Formats candle data as a compact text block for the AI prompt.
 * @param {Record<string, Array>} candles
 * @returns {string}
 */
function formatCandlesForPrompt(candles) {
  return CANDLE_TIMEFRAMES.map((tf) => {
    const data = candles[tf];
    if (!data || data.length === 0) {
      return `\n## ${tf}\nKeine Daten verfügbar (<PLATZHALTER_ORDERFLOW_QUELLE> nicht verbunden oder Testnet-WAF-Block).`;
    }
    const last5 = data.slice(-5);
    const rows = last5
      .map((c) => `  ${new Date(c.timestamp).toISOString()} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`)
      .join('\n');
    return `\n## ${tf} (letzte ${data.length} Kerzen, die 5 neuesten):\n${rows}`;
  }).join('\n');
}

/**
 * Checks if there is already an open AI decision for this symbol.
 * "Open" means decision is LONG or SHORT and no exit signal has been stored.
 * @param {string} symbol
 * @param {object} env
 * @returns {Promise<boolean>}
 */
async function hasOpenAiDecision(symbol, env) {
  try {
    const row = await env.DB.prepare(
      `SELECT id FROM ai_decisions WHERE symbol = ? AND decision IN ('LONG','SHORT') AND exited_at IS NULL LIMIT 1`
    )
      .bind(symbol)
      .first();
    return !!row;
  } catch {
    // DB unavailable — conservatively assume there IS an open decision so we
    // return NO_TRADE rather than proceeding without the guardrail.
    return true;
  }
}

/**
 * Applies deterministic guardrails to the AI response.
 * Returns a (possibly overridden) decision object.
 * @param {AiDecisionRaw} aiData
 * @param {string} direction
 * @returns {{decision: string, overrideReason: string|null}}
 */
export function applyGuardrails(aiData, direction) {
  // Rule 1: all required factors must be met
  for (const id of REQUIRED_FACTOR_IDS) {
    const f = aiData.factors.find((x) => x.id === id);
    if (!f || !f.met) {
      return {
        decision: 'NO_TRADE',
        overrideReason: `required_factor_not_met: ${id}`,
      };
    }
  }

  // Rule 2: AI decision must match the signal direction
  if (aiData.decision !== 'NO_TRADE' && aiData.decision !== direction.toUpperCase()) {
    return {
      decision: 'NO_TRADE',
      overrideReason: `direction_mismatch: ai=${aiData.decision} signal=${direction.toUpperCase()}`,
    };
  }

  // Rule 3: SL plausibility (only when entry and sl are set)
  if (aiData.decision !== 'NO_TRADE' && aiData.entry != null && aiData.stop_loss != null) {
    const entry = Number(aiData.entry);
    const sl = Number(aiData.stop_loss);
    if (Number.isFinite(entry) && Number.isFinite(sl)) {
      const isLong = aiData.decision === 'LONG';
      if (isLong && sl >= entry) {
        return { decision: 'NO_TRADE', overrideReason: `sl_wrong_side: long sl=${sl} >= entry=${entry}` };
      }
      if (!isLong && sl <= entry) {
        return { decision: 'NO_TRADE', overrideReason: `sl_wrong_side: short sl=${sl} <= entry=${entry}` };
      }
    }
  }

  return { decision: aiData.decision, overrideReason: null };
}

/**
 * Main pipeline entry point. Called from routes/webhook.js after structural
 * validation.
 *
 * @param {{ symbol: string, direction: string, price: number, signalId: string }} signal
 * @param {object} env Cloudflare Worker env
 * @returns {Promise<{ decisionId: string, decision: string, guardrailOverride: string|null, providerId: string|null, error: string|null }>}
 */
export async function runIctMtfPipeline(signal, env) {
  const { symbol, direction, price, signalId } = signal;

  // Max one open trade per asset
  const alreadyOpen = await hasOpenAiDecision(symbol, env);
  if (alreadyOpen) {
    return await saveDecision(env, {
      signalId,
      symbol,
      direction,
      price,
      decision: 'NO_TRADE',
      factors: [],
      entry: null,
      stop_loss: null,
      confidence: 0,
      reason: 'already_open_decision_for_symbol',
      guardrailOverride: 'max_one_open_per_asset',
      providerId: null,
      providerAttempts: null,
      error: null,
    });
  }

  // Fetch candle data across timeframes
  const candles = await fetchCandleData(symbol, env);
  const candleText = formatCandlesForPrompt(candles);

  const systemPrompt = buildSystemPrompt(direction);
  const userPrompt = `Symbol: ${symbol}
Aktueller Preis: ${price}
Signal-Richtung: ${direction.toUpperCase()}

Kerzendaten:
${candleText}

Liquidity Heatmap: <PLATZHALTER_HEATMAP_QUELLE> (nicht verbunden — für SL-Platzierung hinter Heatmap-Wand nicht verwendbar, Standard-FVG-SL verwenden)

Bewerte jetzt die Checkliste und antworte mit dem JSON.`;

  const poolResult = await callProviderPool('live', systemPrompt, userPrompt, FACTOR_IDS, env);

  if (!poolResult.data) {
    // All providers failed → NO_TRADE
    return await saveDecision(env, {
      signalId,
      symbol,
      direction,
      price,
      decision: 'NO_TRADE',
      factors: [],
      entry: null,
      stop_loss: null,
      confidence: 0,
      reason: 'all_ai_providers_failed',
      guardrailOverride: null,
      providerId: null,
      providerAttempts: poolResult.attempts,
      error: poolResult.error,
    });
  }

  const aiData = poolResult.data;
  const { decision: finalDecision, overrideReason } = applyGuardrails(aiData, direction);

  return await saveDecision(env, {
    signalId,
    symbol,
    direction,
    price,
    decision: finalDecision,
    factors: aiData.factors,
    entry: aiData.entry,
    stop_loss: aiData.stop_loss,
    confidence: aiData.confidence,
    reason: aiData.reason,
    guardrailOverride: overrideReason,
    providerId: poolResult.providerId,
    providerAttempts: poolResult.attempts ?? null,
    error: null,
  });
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function saveDecision(env, params) {
  const {
    signalId,
    symbol,
    direction,
    price,
    decision,
    factors,
    entry,
    stop_loss,
    confidence,
    reason,
    guardrailOverride,
    providerId,
    providerAttempts,
    error,
  } = params;

  const id = makeId('aidec');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  try {
    await env.DB.prepare(
      `INSERT INTO ai_decisions
         (id, signal_id, symbol, direction, price, decision, factors_json,
          entry, stop_loss, exit_rule, confidence, reason,
          guardrail_override, provider_id, provider_attempts_json, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        id,
        signalId ?? null,
        symbol,
        direction,
        price,
        decision,
        JSON.stringify(factors),
        entry ?? null,
        stop_loss ?? null,
        'gegen_bos_ms_15m',
        confidence,
        reason,
        guardrailOverride ?? null,
        providerId ?? null,
        providerAttempts ? JSON.stringify(providerAttempts) : null,
        error ?? null,
        now
      )
      .run();
  } catch (dbErr) {
    // DB write failure — return in-memory result without crashing
    return {
      decisionId: id,
      decision,
      guardrailOverride: guardrailOverride ?? null,
      providerId: providerId ?? null,
      error: `db_write_failed: ${dbErr.message}`,
    };
  }

  return {
    decisionId: id,
    decision,
    guardrailOverride: guardrailOverride ?? null,
    providerId: providerId ?? null,
    error: error ?? null,
  };
}
