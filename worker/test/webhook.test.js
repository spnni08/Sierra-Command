import { describe, it, expect } from 'vitest';
import { handleWebhookRoute } from '../src/routes/webhook.js';
import { createFakeD1 } from './fakeD1.js';

function makeEnv() {
  return createFakeD1();
}

function postWebhook(strategyKey, body, env) {
  const url = new URL(`https://worker.test/webhook/${strategyKey}`);
  const request = new Request(url, { method: 'POST', body: JSON.stringify(body) });
  return handleWebhookRoute(request, url, { DB: env.DB });
}

// crypto_baseline factors: close > ema200, rsi < 35, |emaDist| in [0.5,1.3]%,
// rsi outside [55,65] — see src/strategies/cryptoBaseline.js.
const baselineLongPayload = {
  symbol: 'BTCUSDT',
  direction: 'long',
  price: 100.8,
  close: 100.8,
  ema200: 100,
  rsi: 30,
  volume: 0.02,
};

// crypto_flawless_victory (v1, signal-only exit — see signalOnlyExit in
// src/strategies/cryptoFlawlessVictory.js): no SL/TP bracket, no "_sl" pair.
const flawlessVictoryV1Payload = {
  symbol: 'ETHUSDT',
  direction: 'long',
  price: 2000,
  bb_buy_trigger: true,
  version: 'v1',
  htf_filter_active: false,
};

describe('webhook fan-out to paired _sl trade', () => {
  it('a fixed-variant hit (crypto_baseline) creates two signals and two trades', async () => {
    const env = makeEnv();
    // handleWebhookRoute takes (request, url, env) where env has env.DB —
    // reuse the same fake object shape as production (env = { DB }).
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline', {
        method: 'POST',
        body: JSON.stringify(baselineLongPayload),
      }),
      new URL('https://worker.test/webhook/crypto_baseline'),
      { DB: env.DB }
    );
    const body = await res.json();

    expect(body.data.passed).toBe(true);
    expect(body.data.trade).toBeTruthy();
    expect(body.data.pairedTrade).toBeTruthy();
    expect(body.data.pairedTrade.exit_mode).toBe('trailing');
    expect(body.data.trade.exit_mode).toBe('fixed');

    expect(env.tables.signals).toHaveLength(2);
    expect(env.tables.signals.map((s) => s.strategy_id).sort()).toEqual(
      ['crypto_baseline', 'crypto_baseline_sl'].sort()
    );
    expect(env.tables.trades).toHaveLength(2);
    expect(env.tables.trades.map((t) => t.exit_mode).sort()).toEqual(['fixed', 'trailing']);
  });

  it('a direct hit on the "_sl" key itself does not fan out (legacy path, single trade)', async () => {
    const env = makeEnv();
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline_sl', {
        method: 'POST',
        body: JSON.stringify(baselineLongPayload),
      }),
      new URL('https://worker.test/webhook/crypto_baseline_sl'),
      { DB: env.DB }
    );
    const body = await res.json();

    expect(body.data.passed).toBe(true);
    expect(body.data.trade).toBeTruthy();
    expect(body.data.pairedTrade ?? null).toBeNull();
    expect(env.tables.signals).toHaveLength(1);
    expect(env.tables.trades).toHaveLength(1);
    expect(env.tables.trades[0].exit_mode).toBe('trailing');
  });

  it('crypto_flawless_victory v1 (signal-only exit, no _sl pair) still produces exactly one trade', async () => {
    const env = makeEnv();
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_flawless_victory', {
        method: 'POST',
        body: JSON.stringify(flawlessVictoryV1Payload),
      }),
      new URL('https://worker.test/webhook/crypto_flawless_victory'),
      { DB: env.DB }
    );
    const body = await res.json();

    expect(body.data.passed).toBe(true);
    expect(body.data.pairedTrade ?? null).toBeNull();
    expect(env.tables.signals).toHaveLength(1);
    expect(env.tables.trades).toHaveLength(1);
    expect(env.tables.trades[0].strategy_id ?? env.tables.signals[0].strategy_id).toBe('crypto_flawless_victory');
  });

  it('crypto_flawless_victory_v2 (own key, no _sl pair) does not fan out', async () => {
    const env = makeEnv();
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_flawless_victory_v2', {
        method: 'POST',
        body: JSON.stringify({ ...flawlessVictoryV1Payload, version: 'v2' }),
      }),
      new URL('https://worker.test/webhook/crypto_flawless_victory_v2'),
      { DB: env.DB }
    );
    const body = await res.json();

    expect(body.data.passed).toBe(true);
    expect(body.data.pairedTrade ?? null).toBeNull();
    expect(env.tables.trades).toHaveLength(1);
  });

  it('reads payload.timeframe verbatim and stores it on both fan-out trades', async () => {
    const env = makeEnv();
    await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline', {
        method: 'POST',
        body: JSON.stringify({ ...baselineLongPayload, timeframe: '240' }),
      }),
      new URL('https://worker.test/webhook/crypto_baseline'),
      { DB: env.DB }
    );

    expect(env.tables.trades).toHaveLength(2);
    // Stored exactly as received ('240', not normalized to '4h' or anything
    // else here) — normalization only happens at query/grouping time.
    expect(env.tables.trades.every((t) => t.timeframe === '240')).toBe(true);
  });

  it('stores NULL (never a guessed value) when payload.timeframe is missing', async () => {
    const env = makeEnv();
    await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline_sl', {
        method: 'POST',
        body: JSON.stringify(baselineLongPayload), // no timeframe field
      }),
      new URL('https://worker.test/webhook/crypto_baseline_sl'),
      { DB: env.DB }
    );

    expect(env.tables.trades).toHaveLength(1);
    expect(env.tables.trades[0].timeframe).toBeNull();
  });

  it('a rejected fixed-variant signal does not fan out or create trades', async () => {
    const env = makeEnv();
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline', {
        method: 'POST',
        body: JSON.stringify({ ...baselineLongPayload, rsi: 50 }), // fails rsi_pullback_trigger
      }),
      new URL('https://worker.test/webhook/crypto_baseline'),
      { DB: env.DB }
    );
    const body = await res.json();

    expect(body.data.passed).toBe(false);
    expect(env.tables.signals).toHaveLength(1);
    expect(env.tables.signals[0].status).toBe('rejected');
    expect(env.tables.trades).toHaveLength(0);
  });
});
