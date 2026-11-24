// ICT MTF Discretionary AI Decision Pipeline.
//
// Flow: Pine alert → webhook → enrich with candle data + delta → AI checklist →
//       deterministic guardrails → save to ai_decisions table (log + UI).
//       Result is NEVER auto-executed — display/confirmation only.
//
// Deterministic guardrails (outside AI, cannot be overridden):
//   1. All required factors must be met=true → otherwise force NO_TRADE.
//   2. SL must be on the correct side of entry (long: sl < entry, short: sl > entry).
//   3. Max one open AI-decision trade per asset (checked against ai_decisions).
//   4. Missing data source → code (not AI) forces factor met=false → NO_TRADE.
//   5. CRV < min_crv or no estimable target → NO_TRADE.

import { CHECKLIST, MIN_CRV } from '../strategies/ictMtfDiscretionary.js';
import { callProviderPool } from './client.js';
import { fetchDeltaFootprint, isCryptoSymbol } from '../adapters/deltaFootprint.js';

const FACTOR_IDS = CHECKLIST.map((c) => c.id);
const REQUIRED_FACTOR_IDS = CHECKLIST.filter((c) => c.required).map((c) => c.id);

// Candle timeframes to fetch for context (Binance interval codes)
const CANDLE_TIMEFRAMES = ['5m', '15m', '1h', '4h'];
const CANDLE_LIMIT = 50; // enough context for swing/BOS/FVG detection

// Delta look-back window: 3 × 5-minute candles = 15 minutes
const DELTA_WINDOW_MS = 3 * 5 * 60 * 1000;

// SL buffer when adjusting behind a heat_wall (0.1% beyond the wall)
const HEAT_WALL_BUFFER_PCT = 0.001;

// Swing-finding lookback/forward width (candles on each side of the pivot)
const SWING_N = 2;

// ---- Swing / CRV helpers ---------------------------------------------------

/**
 * Finds the nearest confirmed swing high (direction='long') or swing low
 * (direction='short') in the given candles that is beyond the entry price.
 * Scans from most-recent to oldest to return the nearest level first.
 * Returns null if no swing found or data is insufficient.
 * @param {Array<{high: number, low: number}>} candles15m
 * @param {number} entry
 * @param {'long'|'short'} direction
 * @returns {number|null}
 */
export function findNearestSwingTarget(candles15m, entry, direction) {
  if (!Array.isArray(candles15m) || candles15m.length < SWING_N * 2 + 1) return null;

  // Scan from most-recent confirmable pivot backwards
  for (let i = candles15m.length - SWING_N - 1; i >= SWING_N; i--) {
    const c = candles15m[i];
    if (direction === 'long') {
      if (c.high <= entry) continue;
      let isSwing = true;
      for (let j = i - SWING_N; j <= i + SWING_N; j++) {
        if (j !== i && candles15m[j] && candles15m[j].high > c.high) {
          isSwing = false;
          break;
        }
      }
      if (isSwing) return c.high;
    } else {
      if (c.low >= entry) continue;
      let isSwing = true;
      for (let j = i - SWING_N; j <= i + SWING_N; j++) {
        if (j !== i && candles15m[j] && candles15m[j].low < c.low) {
          isSwing = false;
          break;
        }
      }
      if (isSwing) return c.low;
    }
  }
  return null;
}

/**
 * Calculates CRV given entry, stop_loss, and estimated target.
 * Returns null if any value is non-finite or risk distance is zero.
 * @param {number} entry
 * @param {number} sl
 * @param {number} target
 * @param {'long'|'short'} direction
 * @returns {number|null}
 */
export function calculateCrv(entry, sl, target, direction) {
  if (entry == null || sl == null || target == null) return null;
  const e = Number(entry);
  const s = Number(sl);
  const t = Number(target);
  if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(t)) return null;
  const riskDist = Math.abs(e - s);
  if (riskDist === 0) return null;
  const rewardDist = direction === 'long' ? t - e : e - t;
  if (rewardDist <= 0) return null;
  return rewardDist / riskDist;
}

// ---- Heat-wall SL adjustment -----------------------------------------------

/**
 * Adjusts the AI-proposed stop_loss if a heat_wall is provided and is
 * tighter (closer to entry) than the AI's SL.
 * "Behind the wall" means: for LONG, below the wall; for SHORT, above it.
 * @param {number|null} aiSl
 * @param {number} entry
 * @param {number|null} heatWall
 * @param {'long'|'short'} direction
 * @returns {number|null}
 */
export function adjustSlForHeatWall(aiSl, entry, heatWall, direction) {
  if (heatWall == null || aiSl == null) return aiSl;
  const e = Number(entry);
  const sl = Number(aiSl);
  const wall = Number(heatWall);
  if (!Number.isFinite(e) || !Number.isFinite(sl) || !Number.isFinite(wall)) return aiSl;

  if (direction === 'long') {
    // Wall must be below entry and above (tighter than) AI's SL
    if (wall < e && wall > sl) {
      return wall * (1 - HEAT_WALL_BUFFER_PCT);
    }
  } else {
    // SHORT: wall must be above entry and below (tighter than) AI's SL
    if (wall > e && wall < sl) {
      return wall * (1 + HEAT_WALL_BUFFER_PCT);
    }
  }
  return aiSl;
}

// ---- Data-availability pre-check -------------------------------------------

/**
 * Checks whether required factors have their data sources available BEFORE
 * calling the AI. Any factor whose required candle TFs are all empty, or
 * whose external data source (delta adapter) returned null, is forced to
 * { met: false, evidence: "nicht prüfbar: ..." } by code, not by the AI.
 *
 * @param {Record<string, Array>} candles  map of TF → candles array
 * @param {{delta: number}|null} deltaData  result from fetchDeltaFootprint
 * @returns {Map<string, {met: false, evidence: string}>}
 */
export function checkFactorDataAvailability(candles, deltaData) {
  const unavailable = new Map();

  for (const factor of CHECKLIST) {
    if (!factor.required) continue;

    if (factor.id === 'footprint_delta_5m') {
      if (deltaData === null) {
        unavailable.set(factor.id, {
          met: false,
          evidence: 'nicht prüfbar: Footprint/Delta-Quelle nicht verfügbar (Binance aggTrades nicht erreichbar oder Nicht-Crypto-Asset)',
        });
      }
      continue;
    }

    // For candle-based factors: if ALL required timeframes are empty → not prüfbar
    const allEmpty = factor.timeframe.every((tf) => !candles[tf] || candles[tf].length === 0);
    if (allEmpty) {
      unavailable.set(factor.id, {
        met: false,
        evidence: `nicht prüfbar: Kerzendaten für ${factor.timeframe.join('/')} nicht verfügbar`,
      });
    }
  }

  return unavailable;
}

// ---- System/user prompt builders -------------------------------------------

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
- Bewerte jeden Faktor anhand der Kerzendaten und Delta-Daten.
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

// ---- Candle fetch ----------------------------------------------------------

/**
 * Fetches candle data for a symbol across multiple timeframes.
 * Returns a map of timeframe → candles array, or empty array on failure.
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
 * Formats delta data as a text block for the AI prompt.
 * @param {{delta: number, buyVolume: number, sellVolume: number, tradeCount: number}|null} delta
 * @returns {string}
 */
function formatDeltaForPrompt(delta) {
  if (!delta) return 'Footprint/Delta: nicht verfügbar (Quelle nicht erreichbar — Faktor als nicht prüfbar markieren).';
  const sign = delta.delta >= 0 ? '+' : '';
  return `Footprint/Delta (letzte ~15 Min, Binance aggTrades):
  Käufer-Aggression (Buy Volume): ${delta.buyVolume.toFixed(4)}
  Verkäufer-Aggression (Sell Volume): ${delta.sellVolume.toFixed(4)}
  Delta: ${sign}${delta.delta.toFixed(4)} (${delta.tradeCount} Trades)`;
}

// ---- Open-decision guard ---------------------------------------------------

/**
 * Checks if there is already an open AI decision for this symbol.
 * "Open" means decision is LONG or SHORT and no exit signal has been stored.
 * Returns true (assume open → NO_TRADE) on DB error (conservative).
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

// ---- Guardrails ------------------------------------------------------------

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

// ---- Main pipeline entry point ---------------------------------------------

/**
 * Main pipeline entry point. Called from routes/webhook.js after structural
 * validation.
 *
 * @param {{ symbol: string, direction: string, price: number, signalId: string, heatWall?: number|null }} signal
 * @param {object} env Cloudflare Worker env
 * @returns {Promise<{ decisionId: string, decision: string, guardrailOverride: string|null, providerId: string|null, error: string|null, estimatedTarget: number|null, crv: number|null }>}
 */
export async function runIctMtfPipeline(signal, env) {
  const { symbol, direction, price, signalId, heat_wall: heatWall } = signal;

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
      estimatedTarget: null,
      crv: null,
      heatWall: heatWall ?? null,
    });
  }

  // Fetch candle data across timeframes
  const candles = await fetchCandleData(symbol, env);

  // Fetch delta/footprint (only for crypto; null for non-crypto or on error)
  const deltaData = isCryptoSymbol(symbol) ? await fetchDeltaFootprint(symbol, DELTA_WINDOW_MS, env) : null;

  // Rule 4: deterministic data-availability pre-check
  // If any required factor's data source is unavailable, don't call AI —
  // set those factors to "nicht prüfbar" and return NO_TRADE immediately.
  const unavailableFactors = checkFactorDataAvailability(candles, deltaData);
  const missingRequired = REQUIRED_FACTOR_IDS.filter((id) => unavailableFactors.has(id));
  if (missingRequired.length > 0) {
    const forcedFactors = FACTOR_IDS.map((id) => {
      const unavail = unavailableFactors.get(id);
      return unavail ?? { id, met: false, evidence: 'nicht bewertet (Datenlücke bei anderen Faktoren)' };
    });
    return await saveDecision(env, {
      signalId,
      symbol,
      direction,
      price,
      decision: 'NO_TRADE',
      factors: forcedFactors,
      entry: null,
      stop_loss: null,
      confidence: 0,
      reason: `data_unavailable: ${missingRequired.join(', ')}`,
      guardrailOverride: `data_missing: ${missingRequired[0]}`,
      providerId: null,
      providerAttempts: null,
      error: null,
      estimatedTarget: null,
      crv: null,
      heatWall: heatWall ?? null,
    });
  }

  const candleText = formatCandlesForPrompt(candles);
  const deltaText = formatDeltaForPrompt(deltaData);

  const systemPrompt = buildSystemPrompt(direction);
  const userPrompt = `Symbol: ${symbol}
Aktueller Preis: ${price}
Signal-Richtung: ${direction.toUpperCase()}

Kerzendaten:
${candleText}

${deltaText}

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
      estimatedTarget: null,
      crv: null,
      heatWall: heatWall ?? null,
    });
  }

  const aiData = poolResult.data;
  const { decision: guardedDecision, overrideReason } = applyGuardrails(aiData, direction);

  // Adjust SL behind heat_wall if provided and appropriate
  let finalSl = aiData.stop_loss;
  if (guardedDecision !== 'NO_TRADE' && aiData.entry != null) {
    finalSl = adjustSlForHeatWall(aiData.stop_loss, aiData.entry, heatWall ?? null, direction);
  }

  // Rule 5: CRV guardrail (only when we have a trade and entry/SL)
  let estimatedTarget = null;
  let crv = null;
  let finalDecision = guardedDecision;
  let finalOverride = overrideReason;

  if (finalDecision !== 'NO_TRADE') {
    if (aiData.entry == null || finalSl == null) {
      // Cannot evaluate CRV without both entry and SL
      finalDecision = 'NO_TRADE';
      finalOverride = 'crv_no_sl: AI did not provide entry or stop_loss';
    } else {
      estimatedTarget = findNearestSwingTarget(candles['15m'] ?? [], aiData.entry, direction);
      if (estimatedTarget != null) {
        crv = calculateCrv(aiData.entry, finalSl, estimatedTarget, direction);
      }
      if (crv == null || crv < MIN_CRV) {
        finalDecision = 'NO_TRADE';
        finalOverride = crv == null
          ? `crv_no_target: kein Swing-Ziel in 15m-Daten gefunden`
          : `crv_too_low: ${crv.toFixed(2)} < ${MIN_CRV}`;
      }
    }
  }

  return await saveDecision(env, {
    signalId,
    symbol,
    direction,
    price,
    decision: finalDecision,
    factors: aiData.factors,
    entry: aiData.entry,
    stop_loss: finalSl,
    confidence: aiData.confidence,
    reason: aiData.reason,
    guardrailOverride: finalOverride,
    providerId: poolResult.providerId,
    providerAttempts: poolResult.attempts ?? null,
    error: null,
    estimatedTarget,
    crv,
    heatWall: heatWall ?? null,
  });
}

// ---- Persistence -----------------------------------------------------------

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
    estimatedTarget,
    crv,
    heatWall,
  } = params;

  const id = makeId('aidec');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  try {
    await env.DB.prepare(
      `INSERT INTO ai_decisions
         (id, signal_id, symbol, direction, price, decision, factors_json,
          entry, stop_loss, exit_rule, confidence, reason,
          guardrail_override, provider_id, provider_attempts_json,
          error, estimated_target, crv, heat_wall, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        estimatedTarget ?? null,
        crv ?? null,
        heatWall ?? null,
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
      estimatedTarget: estimatedTarget ?? null,
      crv: crv ?? null,
    };
  }

  return {
    decisionId: id,
    decision,
    guardrailOverride: guardrailOverride ?? null,
    providerId: providerId ?? null,
    error: error ?? null,
    estimatedTarget: estimatedTarget ?? null,
    crv: crv ?? null,
  };
}
