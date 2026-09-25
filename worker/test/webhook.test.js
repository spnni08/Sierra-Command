import { describe, it, expect } from 'vitest';
import { handleWebhookRoute } from '../src/routes/webhook.js';
import { createFakeD1 } from './fakeD1.js';

function makeEnv(overrides) {
  return createFakeD1(overrides);
}

function postWebhook(strategyKey, body, env, envExtra) {
  const url = new URL(`https://worker.test/webhook/${strategyKey}`);
  const request = new Request(url, { method: 'POST', body: JSON.stringify(body) });
  return handleWebhookRoute(request, url, { DB: env.DB, ...envExtra });
}

// crypto_baseline factors: close > ema200, rsi < 35, |emaDist| in [0.5,1.3]%,
// rsi outside [55,65] — see src/strategies/cryptoBaseline.js. All fields
// this factor set reads are actually present here, so it both passes
// structurally AND matches every factor (legacyPassed true) — used where a
// test wants a "clean" baseline, not to prove anything about the new
// non-blocking behavior itself (see the dedicated describe block below).
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
    const res = await postWebhook('crypto_baseline', baselineLongPayload, env);
    const body = await res.json();

    expect(body.data.accepted).toBe(true);
    expect(body.data.trade).toBeTruthy();
    expect(body.data.pairedTrade).toBeTruthy();
    expect(body.data.pairedTrade.exit_mode).toBe('trailing');
    expect(body.data.trade.exit_mode).toBe('fixed');
    // Both legs of one signal share one position_group_id (2026-09-25 risk
    // rule: base + "(SL)" count as ONE open position).
    expect(body.data.trade.position_group_id).toBe(body.data.pairedTrade.position_group_id);

    expect(env.tables.signals).toHaveLength(2);
    expect(env.tables.signals.map((s) => s.strategy_id).sort()).toEqual(
      ['crypto_baseline', 'crypto_baseline_sl'].sort()
    );
    expect(env.tables.signals.every((s) => s.status === 'converted')).toBe(true);
    expect(env.tables.trades).toHaveLength(2);
    expect(env.tables.trades.map((t) => t.exit_mode).sort()).toEqual(['fixed', 'trailing']);
  });

  it('a direct hit on the "_sl" key itself does not fan out (legacy path, single trade)', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_baseline_sl', baselineLongPayload, env);
    const body = await res.json();

    expect(body.data.accepted).toBe(true);
    expect(body.data.trade).toBeTruthy();
    expect(body.data.pairedTrade ?? null).toBeNull();
    expect(env.tables.signals).toHaveLength(1);
    expect(env.tables.trades).toHaveLength(1);
    expect(env.tables.trades[0].exit_mode).toBe('trailing');
  });

  it('crypto_flawless_victory v1 (signal-only exit, no _sl pair) still produces exactly one trade', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_flawless_victory', flawlessVictoryV1Payload, env);
    const body = await res.json();

    expect(body.data.accepted).toBe(true);
    expect(body.data.pairedTrade ?? null).toBeNull();
    expect(env.tables.signals).toHaveLength(1);
    expect(env.tables.trades).toHaveLength(1);
    expect(env.tables.trades[0].strategy_id ?? env.tables.signals[0].strategy_id).toBe('crypto_flawless_victory');
  });

  it('crypto_flawless_victory_v2 (own key, no _sl pair) does not fan out', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_flawless_victory_v2', { ...flawlessVictoryV1Payload, version: 'v2' }, env);
    const body = await res.json();

    expect(body.data.accepted).toBe(true);
    expect(body.data.pairedTrade ?? null).toBeNull();
    expect(env.tables.trades).toHaveLength(1);
  });

  it('reads payload.timeframe verbatim and stores it on both fan-out trades', async () => {
    const env = makeEnv();
    await postWebhook('crypto_baseline', { ...baselineLongPayload, timeframe: '240' }, env);

    expect(env.tables.trades).toHaveLength(2);
    // Stored exactly as received ('240', not normalized to '4h' or anything
    // else here) — normalization only happens at query/grouping time.
    expect(env.tables.trades.every((t) => t.timeframe === '240')).toBe(true);
  });

  it('stores NULL (never a guessed value) when payload.timeframe is missing', async () => {
    const env = makeEnv();
    await postWebhook('crypto_baseline_sl', baselineLongPayload, env); // no timeframe field

    expect(env.tables.trades).toHaveLength(1);
    expect(env.tables.trades[0].timeframe).toBeNull();
  });
});

// --- 2026-09-25: Pine's signal is trusted; factors are informational only ---
describe('factor evaluation no longer blocks a trade (2026-09-25 decision)', () => {
  it('a structurally valid signal still opens a trade even when a factor fails', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_baseline', { ...baselineLongPayload, rsi: 50 }, env); // fails rsi_pullback_trigger
    const body = await res.json();

    expect(body.data.accepted).toBe(true);
    expect(body.data.failed).toContain('rsi_pullback_trigger');
    expect(body.data.legacyPassed).toBe(false); // the OLD hard-AND result would have rejected this
    expect(body.data.trade).toBeTruthy(); // but a trade opens anyway — Pine already gated it
    expect(env.tables.trades.length).toBeGreaterThan(0);
    expect(env.tables.signals[0].status).toBe('converted'); // never 'rejected' for a structurally valid signal
  });

  it('a factor whose declared fields are absent from the payload lands in `missing`, not `failed`', async () => {
    const env = makeEnv();
    // crypto_sr_bollinger's band_bounce_trigger needs low/high, which this
    // payload never sends (matches the real tradingview-bot Pine payload
    // shape — see worker/src/contracts/crypto_sr_bollinger.schema.json).
    const res = await postWebhook(
      'crypto_sr_bollinger',
      { symbol: 'BTCUSDT', direction: 'long', price: 110600, ema200: 109800, bb_lower: 110500, bb_upper: 112000 },
      env
    );
    const body = await res.json();

    expect(body.data.accepted).toBe(true);
    expect(body.data.failed).not.toContain('band_bounce_trigger');
    expect(body.data.missing.map((m) => m.name)).toContain('band_bounce_trigger');
    expect(body.data.trade).toBeTruthy(); // still opens — missing telemetry, not a block
  });

  it('logs a "Payload-Feld ... fehlt" warning once per (strategy, field) per day, not on every call', async () => {
    const env = makeEnv();
    const payload = { symbol: 'BTCUSDT', direction: 'long', price: 110600, ema200: 109800, bb_lower: 110500, bb_upper: 112000 };
    await postWebhook('crypto_sr_bollinger', payload, env);
    await postWebhook('crypto_sr_bollinger', payload, env);

    const warnings = env.tables.activity_log.filter((r) => r.message.includes('Payload-Feld "low" fehlt'));
    expect(warnings).toHaveLength(1);
  });

  it('structural invalidity (missing symbol) is still rejected outright — no signal, no trade', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_baseline', { ...baselineLongPayload, symbol: undefined }, env);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('missing_symbol');
    expect(env.tables.signals).toHaveLength(0);
    expect(env.tables.trades).toHaveLength(0);
  });

  it('structural invalidity (price <= 0) is rejected outright', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_baseline', { ...baselineLongPayload, price: 0, close: 0 }, env);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_price');
    expect(env.tables.signals).toHaveLength(0);
  });

  it('is_test payloads are accepted-but-ignored (no signal, no trade, HTTP 200)', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_baseline', { ...baselineLongPayload, is_test: 1 }, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBe('test_signal');
    expect(env.tables.signals).toHaveLength(0);
    expect(env.tables.trades).toHaveLength(0);
  });

  it('is_test: 0 (the live-signal convention every Pine script uses) is processed normally', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_baseline', { ...baselineLongPayload, is_test: 0 }, env);
    const body = await res.json();
    expect(body.data.accepted).toBe(true);
    expect(env.tables.trades.length).toBeGreaterThan(0);
  });
});

// --- SL/TP: payload value wins when present and non-null ---
describe('SL/TP resolution prefers the payload over the computed bracket', () => {
  it('uses payload.sl/payload.tp when present', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_ict_smc', {
      symbol: 'BTCUSDT', direction: 'long', price: 110600,
      htf_zone_touch: true, confirmations_count: 3,
      sl: 109500, tp: 112800,
    }, env);
    const body = await res.json();
    expect(body.data.trade.sl).toBe(109500);
    expect(body.data.trade.tp).toBe(112800);
  });

  it('uses payload.stop_loss when present and non-null (crypto_sr_bollinger\'s adaptive-stop field)', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_sr_bollinger', {
      symbol: 'BTCUSDT', direction: 'long', price: 110600, ema200: 109800,
      stop_loss: 109900,
    }, env);
    const body = await res.json();
    expect(body.data.trade.sl).toBe(109900);
  });

  it('falls back to the computed bracket when the payload\'s stop_loss is explicitly null', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_sr_bollinger', {
      symbol: 'BTCUSDT', direction: 'long', price: 110600, ema200: 109800,
      stop_loss: null,
    }, env);
    const body = await res.json();
    // Generic 1% SL bracket around entry 110600 (DEFAULT_EXIT.slPct).
    expect(body.data.trade.sl).toBeCloseTo(110600 - 110600 * 0.01, 5);
  });

  it('falls back to the computed bracket when the strategy sends no SL/TP field at all', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_orderflow_breakout', {
      symbol: 'BTCUSDT', direction: 'long', price: 111500,
      range_high: 111300, candle_volume: 2200, avg_volume: 1000, ema200: 109800,
    }, env);
    const body = await res.json();
    expect(body.data.trade.sl).toBeCloseTo(111500 - 111500 * 0.01, 5);
  });
});

describe('webhook secret check', () => {
  it('with WEBHOOK_SECRET set but WEBHOOK_SECRET_ENFORCED unset, a missing secret only logs a warning and still processes the webhook', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_baseline', baselineLongPayload, env, { WEBHOOK_SECRET: 'correct-secret' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.accepted).toBe(true);
    expect(env.tables.trades).toHaveLength(2); // fan-out still ran, no signal lost
    expect(env.tables.activity_log[0].message).toContain('Warnung');
    expect(env.tables.activity_log[0].message).toContain('Secret fehlt');
  });

  it('with WEBHOOK_SECRET_ENFORCED=true, a missing secret is rejected with 401 and no signal/trade is written', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_baseline', baselineLongPayload, env, {
      WEBHOOK_SECRET: 'correct-secret',
      WEBHOOK_SECRET_ENFORCED: 'true',
    });

    expect(res.status).toBe(401);
    expect(env.tables.signals).toHaveLength(0);
    expect(env.tables.trades).toHaveLength(0);
    expect(env.tables.activity_log).toHaveLength(1);
    expect(env.tables.activity_log[0].message).toContain('abgelehnt');
  });

  it('with WEBHOOK_SECRET_ENFORCED=true, a wrong secret is rejected with 401', async () => {
    const env = makeEnv();
    const res = await postWebhook(
      'crypto_baseline',
      { ...baselineLongPayload, secret: 'wrong-value' },
      env,
      { WEBHOOK_SECRET: 'correct-secret', WEBHOOK_SECRET_ENFORCED: 'true' }
    );

    expect(res.status).toBe(401);
    expect(env.tables.trades).toHaveLength(0);
    // The submitted (wrong) secret value itself must never be logged.
    expect(env.tables.activity_log[0].message).not.toContain('wrong-value');
    expect(env.tables.activity_log[0].message).toContain('falsches Secret');
  });

  it('with WEBHOOK_SECRET_ENFORCED=true, the correct secret is accepted and the webhook processes normally', async () => {
    const env = makeEnv();
    const res = await postWebhook(
      'crypto_baseline',
      { ...baselineLongPayload, secret: 'correct-secret' },
      env,
      { WEBHOOK_SECRET: 'correct-secret', WEBHOOK_SECRET_ENFORCED: 'true' }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.accepted).toBe(true);
    expect(env.tables.trades).toHaveLength(2);
    expect(env.tables.activity_log.some((r) => /abgelehnt|Warnung/.test(r.message))).toBe(false);
  });

  it('with no WEBHOOK_SECRET configured, requests are accepted exactly as before (no secret concept at all)', async () => {
    const env = makeEnv();
    const res = await postWebhook('crypto_baseline', baselineLongPayload, env);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.accepted).toBe(true);
    expect(env.tables.activity_log.some((r) => /abgelehnt|Warnung/.test(r.message))).toBe(false);
  });

  it('records the caller\'s User-Agent and CF-Connecting-IP on every webhook-triggered log row', async () => {
    const env = makeEnv();
    const url = new URL('https://worker.test/webhook/crypto_baseline');
    await handleWebhookRoute(
      new Request(url, {
        method: 'POST',
        headers: { 'User-Agent': 'TradingView-Webhook', 'CF-Connecting-IP': '203.0.113.42' },
        body: JSON.stringify(baselineLongPayload),
      }),
      url,
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

    expect(body.data.accepted).toBe(true);
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

    expect(body.data.accepted).toBe(true);
    expect(body.data.trade).toBeTruthy();
    // Generic bracket: 1% SL / 1.5R TP around entry 65000 (DEFAULT_EXIT).
    expect(body.data.trade.sl).toBeCloseTo(65000 - 65000 * 0.01, 5);
    expect(body.data.trade.tp).toBeCloseTo(65000 + 65000 * 0.01 * 1.5, 5);
  });

  it('still opens a trade when a factor is false (2026-09-25: Pine is trusted, not re-checked)', async () => {
    const env = makeEnv();
    const res = await postWebhook('sc_keylevel_sweep', { ...keylevelSweepLongPayload, choch_confirmed: false }, env);
    const body = await res.json();

    expect(body.data.accepted).toBe(true);
    expect(body.data.failed).toContain('choch_confirmed');
    expect(body.data.legacyPassed).toBe(false);
    expect(body.data.trade).toBeTruthy();
    expect(env.tables.trades).toHaveLength(1);
  });
});

describe('exit_mode CHECK-constraint bucketing (dbExitMode) — a latent bug affecting every non-fixed/trailing exit mode', () => {
  // fakeD1 doesn't itself enforce CHECK constraints, so this test asserts
  // the *mapped* value that gets bound (what would satisfy the real D1
  // constraint), which is what actually matters here.
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

    expect(body.data.accepted).toBe(true);
    expect(body.data.trade).toBeTruthy();
    expect(body.data.trade.sl).toBe(64500);
    expect(body.data.trade.tp).toBe(66500);
    expect(env.tables.trades[0].exit_mode).toBe('fixed');
    // ict_sweep_mss's exit.mode is 'levels', not 'fixed' -> no automatic
    // "_sl" fan-out (only a literal 'fixed' exit.mode fans out).
    expect(body.data.pairedTrade ?? null).toBeNull();
  });
});

// --- Risk engine wiring (rule logic itself is unit-tested in
// risk/riskEngine.test.js — this just proves webhook.js actually calls it) ---
describe('risk engine blocks a trade but keeps the signal accepted', () => {
  it('global auto-trading switch off: signal accepted, no trade, clear activity_log reason', async () => {
    const env = makeEnv({ app_settings: [{ key: 'auto_trading_enabled', value: 'false' }] });
    const res = await postWebhook('crypto_baseline', baselineLongPayload, env);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.accepted).toBe(true);
    expect(body.data.riskBlocked).toBe(true);
    expect(body.data.riskReason).toBe('auto_trading_disabled');
    expect(body.data.trade).toBeNull();
    expect(env.tables.signals).toHaveLength(1);
    expect(env.tables.signals[0].status).toBe('converted');
    expect(env.tables.trades).toHaveLength(0);
    expect(env.tables.activity_log.some((r) => r.message.includes('Automatischer Handel ist global deaktiviert'))).toBe(true);
  });

  it('per-strategy inactive flag blocks only that strategy', async () => {
    const env = makeEnv();
    env.tables.strategies.find((s) => s.id === 'crypto_baseline').active = 0;
    const res = await postWebhook('crypto_baseline', baselineLongPayload, env);
    const body = await res.json();

    expect(body.data.riskBlocked).toBe(true);
    expect(body.data.riskReason).toBe('strategy_inactive');
    expect(env.tables.trades).toHaveLength(0);
  });

  it('max open positions: a base+"(SL)" pair counts as ONE position', async () => {
    const env = makeEnv({ app_settings: [{ key: 'max_open_positions', value: '1' }] });
    // First call opens the pair (1 position) and fills the limit.
    await postWebhook('crypto_baseline', baselineLongPayload, env);
    expect(env.tables.trades).toHaveLength(2);

    // Second call should now be blocked — the pair already counts as 1/1.
    const res = await postWebhook('crypto_orderflow_breakout', {
      symbol: 'ETHUSDT', direction: 'long', price: 3000,
      range_high: 2990, candle_volume: 2000, avg_volume: 1000, ema200: 2900,
    }, env);
    const body = await res.json();

    expect(body.data.riskBlocked).toBe(true);
    expect(body.data.riskReason).toBe('max_open_positions');
    expect(env.tables.trades).toHaveLength(2); // unchanged
  });

  it('daily loss limit: realized PnL at/below -limit blocks new trades', async () => {
    const env = makeEnv({ app_settings: [{ key: 'daily_loss_limit_usd', value: '100' }] });
    const nowSql = new Date().toISOString().replace('T', ' ').slice(0, 19);
    env.tables.trades.push({ id: 'trd-prior', status: 'closed', pnl: -150, closed_at: nowSql, symbol: 'BTCUSDT' });

    const res = await postWebhook('crypto_baseline', baselineLongPayload, env);
    const body = await res.json();

    expect(body.data.riskBlocked).toBe(true);
    expect(body.data.riskReason).toBe('daily_loss_limit');
  });

  it('trading hours window blocks outside its configured range', async () => {
    const currentHour = new Date().getUTCHours();
    const closedWindowStart = (currentHour + 1) % 24;
    const closedWindowEnd = currentHour; // [start, end) excludes currentHour when start===end+1 wrap
    const env = makeEnv({
      app_settings: [
        { key: 'trading_hours_start_utc', value: String(closedWindowStart) },
        { key: 'trading_hours_end_utc', value: String(closedWindowEnd) },
      ],
    });
    const res = await postWebhook('crypto_baseline', baselineLongPayload, env);
    const body = await res.json();

    expect(body.data.riskBlocked).toBe(true);
    expect(body.data.riskReason).toBe('trading_hours');
  });

  it('per-strategy session filter blocks a session not in the allow-list', async () => {
    const env = makeEnv();
    // A session guaranteed not to be the current one — sessionOf() never
    // returns 'outside' and a real session simultaneously, so restricting
    // to a single, deliberately-wrong key always blocks.
    env.tables.strategy_settings.find((s) => s.strategy_id === 'crypto_baseline').session_filter =
      JSON.stringify(['__never_current__']);
    const res = await postWebhook('crypto_baseline', baselineLongPayload, env);
    const body = await res.json();

    expect(body.data.riskBlocked).toBe(true);
    expect(body.data.riskReason).toBe('session_filter');
  });
});
