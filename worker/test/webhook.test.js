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

describe('webhook secret check', () => {
  it('with WEBHOOK_SECRET set but WEBHOOK_SECRET_ENFORCED unset, a missing secret only logs a warning and still processes the webhook', async () => {
    const env = makeEnv();
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline', {
        method: 'POST',
        body: JSON.stringify(baselineLongPayload), // no "secret" field
      }),
      new URL('https://worker.test/webhook/crypto_baseline'),
      { DB: env.DB, WEBHOOK_SECRET: 'correct-secret' }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.passed).toBe(true);
    expect(env.tables.trades).toHaveLength(2); // fan-out still ran, no signal lost
    expect(env.tables.activity_log[0].message).toContain('Warnung');
    expect(env.tables.activity_log[0].message).toContain('Secret fehlt');
  });

  it('with WEBHOOK_SECRET_ENFORCED=true, a missing secret is rejected with 401 and no signal/trade is written', async () => {
    const env = makeEnv();
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline', {
        method: 'POST',
        body: JSON.stringify(baselineLongPayload),
      }),
      new URL('https://worker.test/webhook/crypto_baseline'),
      { DB: env.DB, WEBHOOK_SECRET: 'correct-secret', WEBHOOK_SECRET_ENFORCED: 'true' }
    );

    expect(res.status).toBe(401);
    expect(env.tables.signals).toHaveLength(0);
    expect(env.tables.trades).toHaveLength(0);
    expect(env.tables.activity_log).toHaveLength(1);
    expect(env.tables.activity_log[0].message).toContain('abgelehnt');
  });

  it('with WEBHOOK_SECRET_ENFORCED=true, a wrong secret is rejected with 401', async () => {
    const env = makeEnv();
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline', {
        method: 'POST',
        body: JSON.stringify({ ...baselineLongPayload, secret: 'wrong-value' }),
      }),
      new URL('https://worker.test/webhook/crypto_baseline'),
      { DB: env.DB, WEBHOOK_SECRET: 'correct-secret', WEBHOOK_SECRET_ENFORCED: 'true' }
    );

    expect(res.status).toBe(401);
    expect(env.tables.trades).toHaveLength(0);
    // The submitted (wrong) secret value itself must never be logged.
    expect(env.tables.activity_log[0].message).not.toContain('wrong-value');
    expect(env.tables.activity_log[0].message).toContain('falsches Secret');
  });

  it('with WEBHOOK_SECRET_ENFORCED=true, the correct secret is accepted and the webhook processes normally', async () => {
    const env = makeEnv();
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline', {
        method: 'POST',
        body: JSON.stringify({ ...baselineLongPayload, secret: 'correct-secret' }),
      }),
      new URL('https://worker.test/webhook/crypto_baseline'),
      { DB: env.DB, WEBHOOK_SECRET: 'correct-secret', WEBHOOK_SECRET_ENFORCED: 'true' }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.passed).toBe(true);
    expect(env.tables.trades).toHaveLength(2);
    expect(env.tables.activity_log.some((r) => /abgelehnt|Warnung/.test(r.message))).toBe(false);
  });

  it('with no WEBHOOK_SECRET configured, requests are accepted exactly as before (no secret concept at all)', async () => {
    const env = makeEnv();
    const res = await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline', {
        method: 'POST',
        body: JSON.stringify(baselineLongPayload),
      }),
      new URL('https://worker.test/webhook/crypto_baseline'),
      { DB: env.DB }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.passed).toBe(true);
    expect(env.tables.activity_log.some((r) => /abgelehnt|Warnung/.test(r.message))).toBe(false);
  });

  it('records the caller\'s User-Agent and CF-Connecting-IP on every webhook-triggered log row', async () => {
    const env = makeEnv();
    await handleWebhookRoute(
      new Request('https://worker.test/webhook/crypto_baseline', {
        method: 'POST',
        headers: { 'User-Agent': 'TradingView-Webhook', 'CF-Connecting-IP': '203.0.113.42' },
        body: JSON.stringify(baselineLongPayload),
      }),
      new URL('https://worker.test/webhook/crypto_baseline'),
      { DB: env.DB }
    );

    expect(env.tables.activity_log.length).toBeGreaterThan(0);
    expect(env.tables.activity_log[0].user_agent).toBe('TradingView-Webhook');
    expect(env.tables.activity_log[0].source_ip).toBe('203.0.113.42');
  });
});

// sc_keylevel_sweep factors — see src/strategies/scKeylevelSweep.js. All
// booleans are Pine-computed (this app never recomputes sweep/CHoCH/zone
// thresholds), so a "full valid" payload just sets every gating field true
// and supplies the structural slPrice/tpPrice exit.mode:'levels' needs.
const keylevelSweepLongPayload = {
  symbol: 'BTCUSDT',
  direction: 'long',
  price: 65000,
  close: 65000,
  liquidity_sweep: true,
  choch_confirmed: true,
  entry_close_in_zone: true,
  confluence_min_ok: true,
  min_rr_ok: true,
  not_invalidated: true,
  confluence_count: 2,
  confluence_factors: ['fvg_choch_impulse', 'order_block'],
  slPrice: 64500,
  tpPrice: 66500,
};

describe('sc_keylevel_sweep — exit.mode:\'levels\' uses the payload\'s structural SL/TP, not a generic bracket', () => {
  it('opens a trade with the exact slPrice/tpPrice the payload provides', async () => {
    const env = makeEnv();
    const res = await postWebhook('sc_keylevel_sweep', keylevelSweepLongPayload, env);
    const body = await res.json();

    expect(body.data.passed).toBe(true);
    expect(body.data.trade).toBeTruthy();
    expect(body.data.trade.sl).toBe(64500);
    expect(body.data.trade.tp).toBe(66500);
    // No "(SL)" twin — sc_keylevel_sweep has no _sl variant (single fixed
    // SL/TP scheme, see the strategy module's header comment).
    expect(body.data.pairedTrade ?? null).toBeNull();
    expect(env.tables.trades).toHaveLength(1);
  });

  it('falls back to the generic %-bracket when the payload omits slPrice/tpPrice, rather than rejecting the trade', async () => {
    const env = makeEnv();
    const { slPrice, tpPrice, ...payloadWithoutLevels } = keylevelSweepLongPayload;
    const res = await postWebhook('sc_keylevel_sweep', payloadWithoutLevels, env);
    const body = await res.json();

    expect(body.data.passed).toBe(true);
    expect(body.data.trade).toBeTruthy();
    // Generic bracket: 1% SL / 1.5R TP around entry 65000 (DEFAULT_EXIT).
    expect(body.data.trade.sl).toBeCloseTo(65000 - 65000 * 0.01, 5);
    expect(body.data.trade.tp).toBeCloseTo(65000 + 65000 * 0.01 * 1.5, 5);
  });

  it('rejects the signal (no trade) when any single factor is false', async () => {
    const env = makeEnv();
    const res = await postWebhook('sc_keylevel_sweep', { ...keylevelSweepLongPayload, choch_confirmed: false }, env);
    const body = await res.json();

    expect(body.data.passed).toBe(false);
    expect(body.data.failed).toContain('choch_confirmed');
    expect(env.tables.trades).toHaveLength(0);
  });
});

describe('exit_mode CHECK-constraint bucketing (dbExitMode) — a latent bug affecting every non-fixed/trailing exit mode', () => {
  // Before this fix, binding strategy.exit.mode straight into signals/trades'
  // CHECK(exit_mode IN ('fixed','trailing')) column crashed with a
  // SQLITE_CONSTRAINT error on every webhook call to any strategy whose
  // exit.mode isn't literally 'fixed' or 'trailing' — ict_sweep_mss
  // ('levels') included, not just the new sc_keylevel_sweep. fakeD1 doesn't
  // itself enforce CHECK constraints, so this test asserts the *mapped*
  // value that gets bound (what would satisfy the real D1 constraint),
  // which is what actually matters here.
  it('sc_keylevel_sweep (exit.mode:\'levels\') persists exit_mode \'fixed\', a CHECK-satisfying value', async () => {
    const env = makeEnv();
    await postWebhook('sc_keylevel_sweep', keylevelSweepLongPayload, env);
    expect(env.tables.trades).toHaveLength(1);
    expect(env.tables.trades[0].exit_mode).toBe('fixed');
    expect(env.tables.signals[0].exit_mode).toBe('fixed');
  });

  it('ict_sweep_mss (exit.mode:\'levels\', a pre-existing strategy) also persists a CHECK-satisfying exit_mode', async () => {
    const env = makeEnv();
    const res = await postWebhook(
      'ict_sweep_mss',
      {
        symbol: 'BTCUSDT',
        direction: 'long',
        price: 65000,
        close: 65000,
        liquidity_sweep: true,
        displacement: true,
        mss: true,
        fvg_present: true,
        min_rr_ok: true,
        htf_bias_ok: true,
        slPrice: 64500,
        tpPrice: 66500,
      },
      env
    );
    const body = await res.json();

    expect(body.data.passed).toBe(true);
    expect(body.data.trade).toBeTruthy();
    expect(body.data.trade.sl).toBe(64500); // computeBracket's 'levels' fix applies here too
    expect(body.data.trade.tp).toBe(66500);
    expect(env.tables.trades[0].exit_mode).toBe('fixed');
    // ict_sweep_mss's exit.mode is 'levels', not 'fixed' -> no automatic
    // "_sl" fan-out (only a literal 'fixed' exit.mode fans out).
    expect(body.data.pairedTrade ?? null).toBeNull();
  });
});
