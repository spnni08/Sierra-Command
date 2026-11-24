// AI client — sends a checklist prompt to a provider pool, returns the first
// valid structured JSON response. Used by ai/ictMtfPipeline.js only.
//
// Failover: on 429 or provider-unavailable, skips to the next in priority order.
// Invalid JSON or missing required fields → NO_TRADE (never guess/hallucinate).
// CF Workers AI uses env.AI binding (no HTTP call, different call path).

import { getProviders, getApiKey } from './providers.js';

/**
 * @typedef {object} AiDecisionRaw
 * @property {'LONG'|'SHORT'|'NO_TRADE'} decision
 * @property {Array<{id: string, met: boolean, evidence: string}>} factors
 * @property {number|null} entry
 * @property {number|null} stop_loss
 * @property {'gegen_bos_ms_15m'} exit_rule
 * @property {number} confidence
 * @property {string} reason
 */

const REQUIRED_DECISION_VALUES = new Set(['LONG', 'SHORT', 'NO_TRADE']);

/**
 * Validates a parsed AI response object against the expected schema.
 * Returns {ok: true, data} or {ok: false, error}.
 * @param {unknown} parsed
 * @param {string[]} factorIds
 * @returns {{ok: boolean, data?: AiDecisionRaw, error?: string}}
 */
export function validateAiResponse(parsed, factorIds) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'not_an_object' };
  }

  if (!REQUIRED_DECISION_VALUES.has(parsed.decision)) {
    return { ok: false, error: `invalid_decision: ${parsed.decision}` };
  }

  if (!Array.isArray(parsed.factors)) {
    return { ok: false, error: 'factors_not_array' };
  }

  for (const id of factorIds) {
    const f = parsed.factors.find((x) => x?.id === id);
    if (!f) return { ok: false, error: `missing_factor: ${id}` };
    if (typeof f.met !== 'boolean') return { ok: false, error: `factor_met_not_boolean: ${id}` };
    if (typeof f.evidence !== 'string' || !f.evidence.trim()) {
      return { ok: false, error: `factor_evidence_empty: ${id}` };
    }
  }

  if (parsed.exit_rule !== 'gegen_bos_ms_15m') {
    return { ok: false, error: `wrong_exit_rule: ${parsed.exit_rule}` };
  }

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: `invalid_confidence: ${parsed.confidence}` };
  }

  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
    return { ok: false, error: 'reason_empty' };
  }

  return {
    ok: true,
    data: {
      decision: parsed.decision,
      factors: parsed.factors.map((f) => ({ id: f.id, met: f.met, evidence: f.evidence })),
      entry: parsed.entry != null ? (Number.isFinite(Number(parsed.entry)) ? Number(parsed.entry) : null) : null,
      stop_loss: parsed.stop_loss != null ? (Number.isFinite(Number(parsed.stop_loss)) ? Number(parsed.stop_loss) : null) : null,
      exit_rule: 'gegen_bos_ms_15m',
      confidence,
      reason: parsed.reason.trim(),
    },
  };
}

/**
 * Extracts a JSON object from a string that may contain markdown code fences.
 * Returns the parsed object or throws.
 * @param {string} text
 * @returns {unknown}
 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

/**
 * Calls a single OpenAI-compatible provider.
 * @param {import('./providers.js').Provider} provider
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} env
 * @returns {Promise<{ok: boolean, text?: string, status?: number, error?: string}>}
 */
async function callOpenAiCompatible(provider, systemPrompt, userPrompt, env) {
  const apiKey = getApiKey(provider, env);
  if (!apiKey) return { ok: false, error: 'no_api_key' };

  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 1024,
  };

  let res;
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `fetch_error: ${err.message}` };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: `http_${res.status}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'invalid_json_response' };
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return { ok: false, error: 'no_content' };
  return { ok: true, text };
}

/**
 * Calls the Cloudflare Workers AI binding (env.AI).
 * @param {import('./providers.js').Provider} provider
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} env
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
async function callCfWorkersAi(provider, systemPrompt, userPrompt, env) {
  if (!env.AI) return { ok: false, error: 'cf_ai_binding_missing' };

  let result;
  try {
    result = await env.AI.run(provider.model, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
  } catch (err) {
    return { ok: false, error: `cf_ai_error: ${err.message}` };
  }

  const text = result?.response;
  if (typeof text !== 'string') return { ok: false, error: 'cf_ai_no_response' };
  return { ok: true, text };
}

/**
 * Calls the provider pool in priority order, returns the first valid
 * structured JSON response. Falls back to NO_TRADE on all failures.
 *
 * @param {'live'|'history'} group
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {string[]} factorIds
 * @param {object} env
 * @returns {Promise<{data: AiDecisionRaw, providerId: string}|{data: null, error: string, attempts: object[]}>}
 */
export async function callProviderPool(group, systemPrompt, userPrompt, factorIds, env) {
  const providers = getProviders(group);
  const attempts = [];

  for (const provider of providers) {
    let callResult;
    if (provider.id === 'cf_workers_ai') {
      callResult = await callCfWorkersAi(provider, systemPrompt, userPrompt, env);
    } else {
      callResult = await callOpenAiCompatible(provider, systemPrompt, userPrompt, env);
    }

    if (!callResult.ok) {
      attempts.push({ providerId: provider.id, error: callResult.error, status: callResult.status });
      // 429 or no key → try next; other errors → try next too (defensive)
      continue;
    }

    let parsed;
    try {
      parsed = extractJson(callResult.text);
    } catch {
      attempts.push({ providerId: provider.id, error: 'json_parse_failed', raw: callResult.text?.slice(0, 200) });
      continue;
    }

    const validation = validateAiResponse(parsed, factorIds);
    if (!validation.ok) {
      attempts.push({ providerId: provider.id, error: `validation_failed: ${validation.error}` });
      continue;
    }

    return { data: validation.data, providerId: provider.id };
  }

  return { data: null, error: 'all_providers_failed', attempts };
}
