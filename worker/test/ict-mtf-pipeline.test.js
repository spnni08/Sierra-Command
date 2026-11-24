import { describe, it, expect } from 'vitest';
import { validateAiResponse } from '../src/ai/client.js';
import { applyGuardrails } from '../src/ai/ictMtfPipeline.js';
import { CHECKLIST } from '../src/strategies/ictMtfDiscretionary.js';
import { createFakeD1 } from './fakeD1.js';
import { runIctMtfPipeline } from '../src/ai/ictMtfPipeline.js';

const FACTOR_IDS = CHECKLIST.map((c) => c.id);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validAiResponse(overrides = {}) {
  return {
    decision: 'LONG',
    factors: FACTOR_IDS.map((id) => ({ id, met: true, evidence: `${id}: bestätigt bei 95000` })),
    entry: 95000,
    stop_loss: 94500,
    exit_rule: 'gegen_bos_ms_15m',
    confidence: 0.85,
    reason: 'Alle Faktoren erfüllt.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Checklist factor coverage — all combinations of required factors
// ---------------------------------------------------------------------------

describe('validateAiResponse — required factor combinations', () => {
  it('accepts a valid LONG response with all factors met', () => {
    const result = validateAiResponse(validAiResponse(), FACTOR_IDS);
    expect(result.ok).toBe(true);
    expect(result.data.decision).toBe('LONG');
    expect(result.data.factors).toHaveLength(FACTOR_IDS.length);
  });

  it('accepts NO_TRADE with all factors unmet', () => {
    const r = validAiResponse({
      decision: 'NO_TRADE',
      factors: FACTOR_IDS.map((id) => ({ id, met: false, evidence: `${id}: nicht bestätigt` })),
      entry: null,
      stop_loss: null,
    });
    const result = validateAiResponse(r, FACTOR_IDS);
    expect(result.ok).toBe(true);
    expect(result.data.decision).toBe('NO_TRADE');
  });

  it('rejects response with a missing factor', () => {
    const factors = FACTOR_IDS.slice(0, -1).map((id) => ({ id, met: true, evidence: 'ok' }));
    const r = validAiResponse({ factors });
    const result = validateAiResponse(r, FACTOR_IDS);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing_factor/);
  });

  it('rejects when a factor has no evidence string', () => {
    const factors = FACTOR_IDS.map((id) => ({ id, met: true, evidence: '' }));
    const r = validAiResponse({ factors });
    const result = validateAiResponse(r, FACTOR_IDS);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/factor_evidence_empty/);
  });

  it('rejects when a factor.met is not a boolean', () => {
    const factors = FACTOR_IDS.map((id, i) => ({ id, met: i === 0 ? 'yes' : true, evidence: 'ok' }));
    const r = validAiResponse({ factors });
    const result = validateAiResponse(r, FACTOR_IDS);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/factor_met_not_boolean/);
  });
});

// ---------------------------------------------------------------------------
// 2. JSON validation — broken JSON → NO_TRADE
// ---------------------------------------------------------------------------

describe('validateAiResponse — invalid JSON / schema', () => {
  it('rejects null', () => {
    expect(validateAiResponse(null, FACTOR_IDS).ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(validateAiResponse('LONG', FACTOR_IDS).ok).toBe(false);
  });

  it('rejects an invalid decision value', () => {
    const r = validAiResponse({ decision: 'BUY' });
    expect(validateAiResponse(r, FACTOR_IDS).ok).toBe(false);
    expect(validateAiResponse(r, FACTOR_IDS).error).toMatch(/invalid_decision/);
  });

  it('rejects wrong exit_rule', () => {
    const r = validAiResponse({ exit_rule: 'tp_1r' });
    expect(validateAiResponse(r, FACTOR_IDS).ok).toBe(false);
    expect(validateAiResponse(r, FACTOR_IDS).error).toMatch(/wrong_exit_rule/);
  });

  it('rejects confidence out of range', () => {
    expect(validateAiResponse(validAiResponse({ confidence: 1.5 }), FACTOR_IDS).ok).toBe(false);
    expect(validateAiResponse(validAiResponse({ confidence: -0.1 }), FACTOR_IDS).ok).toBe(false);
  });

  it('rejects empty reason', () => {
    const r = validAiResponse({ reason: '' });
    expect(validateAiResponse(r, FACTOR_IDS).ok).toBe(false);
    expect(validateAiResponse(r, FACTOR_IDS).error).toMatch(/reason_empty/);
  });

  it('rejects factors not an array', () => {
    const r = validAiResponse({ factors: 'all good' });
    expect(validateAiResponse(r, FACTOR_IDS).ok).toBe(false);
    expect(validateAiResponse(r, FACTOR_IDS).error).toMatch(/factors_not_array/);
  });
});

// ---------------------------------------------------------------------------
// 3. Deterministic guardrails
// ---------------------------------------------------------------------------

describe('applyGuardrails', () => {
  function aiData(overrides = {}) {
    return {
      decision: 'LONG',
      factors: FACTOR_IDS.map((id) => ({ id, met: true, evidence: 'ok' })),
      entry: 95000,
      stop_loss: 94500,
      confidence: 0.9,
      reason: 'alles ok',
      exit_rule: 'gegen_bos_ms_15m',
      ...overrides,
    };
  }

  it('passes when all required factors met and direction matches', () => {
    const result = applyGuardrails(aiData(), 'long');
    expect(result.decision).toBe('LONG');
    expect(result.overrideReason).toBeNull();
  });

  it('forces NO_TRADE when any required factor is not met', () => {
    const factors = FACTOR_IDS.map((id, i) => ({ id, met: i !== 0, evidence: 'ok' }));
    const result = applyGuardrails(aiData({ factors }), 'long');
    expect(result.decision).toBe('NO_TRADE');
    expect(result.overrideReason).toMatch(/required_factor_not_met/);
  });

  it('forces NO_TRADE when AI direction mismatches signal direction', () => {
    const result = applyGuardrails(aiData({ decision: 'SHORT' }), 'long');
    expect(result.decision).toBe('NO_TRADE');
    expect(result.overrideReason).toMatch(/direction_mismatch/);
  });

  it('forces NO_TRADE when long SL is above entry', () => {
    const result = applyGuardrails(aiData({ entry: 95000, stop_loss: 95500 }), 'long');
    expect(result.decision).toBe('NO_TRADE');
    expect(result.overrideReason).toMatch(/sl_wrong_side/);
  });

  it('forces NO_TRADE when short SL is below entry', () => {
    const result = applyGuardrails(
      aiData({ decision: 'SHORT', entry: 95000, stop_loss: 94000 }),
      'short'
    );
    expect(result.decision).toBe('NO_TRADE');
    expect(result.overrideReason).toMatch(/sl_wrong_side/);
  });

  it('passes when long SL is below entry', () => {
    const result = applyGuardrails(aiData({ entry: 95000, stop_loss: 94000 }), 'long');
    expect(result.decision).toBe('LONG');
    expect(result.overrideReason).toBeNull();
  });

  it('passes when short SL is above entry', () => {
    const result = applyGuardrails(
      aiData({ decision: 'SHORT', entry: 95000, stop_loss: 95500 }),
      'short'
    );
    expect(result.decision).toBe('SHORT');
    expect(result.overrideReason).toBeNull();
  });

  it('allows NO_TRADE from AI without direction mismatch check', () => {
    const result = applyGuardrails(aiData({ decision: 'NO_TRADE' }), 'long');
    expect(result.decision).toBe('NO_TRADE');
    expect(result.overrideReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Pipeline guardrail: max one open decision per asset
// ---------------------------------------------------------------------------

describe('runIctMtfPipeline — max-one-open guardrail', () => {
  it('returns NO_TRADE when an open LONG decision already exists for the symbol', async () => {
    const env = createFakeD1();
    // Pre-seed an open decision for BTCUSDT
    env.tables.ai_decisions.push({
      id: 'aidec-existing',
      symbol: 'BTCUSDT',
      decision: 'LONG',
      exited_at: null,
    });

    // Stub fetch so no real HTTP call is made
    global.fetch = async () => ({ ok: false, status: 503 });

    const result = await runIctMtfPipeline(
      { symbol: 'BTCUSDT', direction: 'long', price: 95000, signalId: 'sig-test-1' },
      env
    );

    expect(result.decision).toBe('NO_TRADE');
    expect(result.guardrailOverride).toBe('max_one_open_per_asset');
  });

  it('proceeds (no guardrail block) when no open decision exists for the symbol', async () => {
    const env = createFakeD1();

    // All providers fail → pipeline returns NO_TRADE(all_ai_providers_failed)
    // but does NOT return max_one_open_per_asset
    global.fetch = async () => ({ ok: false, status: 503 });

    const result = await runIctMtfPipeline(
      { symbol: 'ETHUSDT', direction: 'long', price: 3000, signalId: 'sig-test-2' },
      env
    );

    expect(result.guardrailOverride).not.toBe('max_one_open_per_asset');
  });
});

// ---------------------------------------------------------------------------
// 5. Pipeline: all providers fail → NO_TRADE (stubbed AI)
// ---------------------------------------------------------------------------

describe('runIctMtfPipeline — provider failure → NO_TRADE', () => {
  it('returns NO_TRADE with error when all providers fail', async () => {
    const env = createFakeD1();
    global.fetch = async () => ({ ok: false, status: 503 });

    const result = await runIctMtfPipeline(
      { symbol: 'SOLUSDT', direction: 'long', price: 200, signalId: 'sig-test-3' },
      env
    );

    expect(result.decision).toBe('NO_TRADE');
    expect(result.error).toBeTruthy();
    expect(result.decisionId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 6. Pipeline: valid AI response → LONG saved
// ---------------------------------------------------------------------------

describe('runIctMtfPipeline — valid AI response (stubbed)', () => {
  it('returns LONG with no guardrail override when AI produces valid response', async () => {
    const env = createFakeD1();

    const aiResponse = {
      decision: 'LONG',
      factors: FACTOR_IDS.map((id) => ({ id, met: true, evidence: `${id} bestätigt` })),
      entry: 95000,
      stop_loss: 94500,
      exit_rule: 'gegen_bos_ms_15m',
      confidence: 0.9,
      reason: 'Setup perfekt.',
    };

    // Stub: candle fetch fails (503), AI call succeeds for groq
    let callCount = 0;
    global.fetch = async (url) => {
      if (url.includes('binancefuture')) {
        return { ok: false, status: 503 };
      }
      callCount++;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(aiResponse) } }],
        }),
      };
    };

    // Provide fake keys so provider's getApiKey doesn't return null
    env.AI_KEY_GROQ = 'fake-groq-key';

    const result = await runIctMtfPipeline(
      { symbol: 'BTCUSDT', direction: 'long', price: 95000, signalId: 'sig-test-4' },
      env
    );

    expect(result.decision).toBe('LONG');
    expect(result.guardrailOverride).toBeNull();
    expect(result.providerId).toBe('groq');
    expect(callCount).toBe(1); // only groq called (racing: first valid wins)

    // Decision row saved to DB
    const saved = env.tables.ai_decisions.find((r) => r.symbol === 'BTCUSDT');
    expect(saved).toBeTruthy();
    expect(saved.decision).toBe('LONG');
  });
});
