// Signal ingestion for the 22 WAVESCOUT strategies ported into
// worker/src/strategies/. Mirrors spnni08/tradingview-bot's per-strategy
// /webhook/<slug> pattern (worker.js handleWebhookRequest + its
// forcedStrategy routing): the strategy is taken from the URL, not a field
// in the payload, so a misconfigured payload can never get silently routed
// to the wrong strategy's gate logic.
//
// No real TradingView alerts point at this yet — that wiring is a separate,
// later step. This just needs to be a working, testable endpoint: POST a
// signal payload (symbol, direction, price, and whatever indicator fields
// that strategy's factor checks read — rsi, ema200, etc.) to
// /webhook/<strategy-id> (any id from worker/schema.sql's strategies table,
// base or "(SL)" variant, e.g. /webhook/crypto_baseline or
// /webhook/crypto_baseline_sl) and get back the AND-gate result.
//
// Every call is recorded in activity_log (source/result), same as
// WAVESCOUT's webhook_log — so the Log page sees it live. A passing signal
// is stored in `signals` (status='converted') and immediately opens a
// `trades` row; a failing signal is still stored in `signals`
// (status='rejected', with the matched/failed factor list) but no trade is
// created — WAVESCOUT's skip/reject pattern, just using this schema's
// existing signals.status enum instead of a separate skip log.
import { evaluateSignal, getStrategy } from '../strategies/index.js';
import { DEFAULT_EXIT } from '../strategies/shared.js';

export async function handleWebhookRoute(request, url, env) {
  const match = url.pathname.match(/^\/webhook\/([a-zA-Z0-9_-]+)$/);
  if (!match) {
    return Response.json({ error: 'not_found', path: url.pathname }, { status: 404 });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  return processWebhook(request, env, match[1]);
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function logActivity(env, source, message) {
  await env.DB.prepare(
    `INSERT INTO activity_log (id, source, message, timestamp, related_trade_id) VALUES (?, ?, ?, ?, NULL)`
  )
    .bind(makeId('log'), source, message, nowSql())
    .run();
}

async function processWebhook(request, env, strategyKey) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const strategy = getStrategy(strategyKey);
  if (!strategy) {
    await logActivity(env, 'system', `Webhook /webhook/${strategyKey}: unbekannte Strategie`);
    return Response.json({ error: 'unknown_strategy', strategyKey }, { status: 404 });
  }

  const direction = String(payload?.direction ?? '').toLowerCase();
  if (direction !== 'long' && direction !== 'short') {
    await logActivity(env, 'system', `Webhook /webhook/${strategyKey}: fehlende oder ungültige direction`);
    return Response.json({ error: 'invalid_direction', message: 'expected direction: "long" or "short"' }, { status: 400 });
  }

  const symbol = String(payload?.symbol ?? '').toUpperCase();
  if (!symbol) {
    await logActivity(env, 'system', `Webhook /webhook/${strategyKey}: fehlendes symbol`);
    return Response.json({ error: 'missing_symbol' }, { status: 400 });
  }

  const result = evaluateSignal(strategyKey, payload);
  const matched = result.matched ?? [];
  const failed = result.failed ?? [];
  const score = matched.length + failed.length > 0 ? matched.length / (matched.length + failed.length) : 0;
  const factorState = JSON.stringify({ matched, failed });
  const signalId = makeId(`sig-${strategyKey}`);
  const ts = nowSql();

  await env.DB.prepare(
    `INSERT INTO signals (id, strategy_id, symbol, timestamp, score, factor_state, status, exit_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(signalId, strategyKey, symbol, ts, score, factorState, result.passed ? 'converted' : 'rejected', strategy.exit.mode, ts)
    .run();

  if (!result.passed) {
    await logActivity(
      env,
      'system',
      `Webhook /webhook/${strategyKey} ${symbol}: Signal abgelehnt (fehlgeschlagen: ${failed.join(', ') || 'unbekannt'})`
    );
    return Response.json({
      data: { passed: false, strategyKey, symbol, signalId, matched, failed },
    });
  }

  const entry = Number(payload.price ?? payload.close);
  if (!Number.isFinite(entry)) {
    await logActivity(
      env,
      'system',
      `Webhook /webhook/${strategyKey} ${symbol}: Signal bestätigt, aber kein gültiger Preis im Payload → kein Trade`
    );
    return Response.json({
      data: { passed: true, strategyKey, symbol, signalId, matched, failed, trade: null, reason: 'missing_price' },
    });
  }

  const volume = Number(payload.volume) > 0 ? Number(payload.volume) : 0.01;

  // Fixed-exit strategies carry their own slPct/tp2RMultiple. Trailing
  // ("(SL)") variants don't have a %SL — their SL is meant to trail a
  // per-strategy anchor (ATR/S&R/Bollinger/Kumo/swing point) instead, which
  // isn't computed here (that's the trailing-anchor engine, out of scope for
  // this endpoint). DEFAULT_EXIT.slPct is used as the initial bootstrap SL
  // so the trade still opens with a sane stop; a later trailing-update step
  // is expected to move it.
  const slPct = strategy.exit.mode === 'fixed' ? strategy.exit.slPct : DEFAULT_EXIT.slPct;
  const rMultiple = strategy.exit.tp2RMultiple ?? DEFAULT_EXIT.tp2RMultiple;
  const slDistance = entry * (slPct / 100);
  const sl = direction === 'long' ? entry - slDistance : entry + slDistance;
  const tp = direction === 'long' ? entry + slDistance * rMultiple : entry - slDistance * rMultiple;

  const tradeId = makeId(`trd-${strategyKey}`);
  await env.DB.prepare(
    `INSERT INTO trades (id, signal_id, symbol, direction, entry, sl, tp, volume, source, status, pnl, exit_mode, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'binance_testnet', 'open', NULL, ?, ?, NULL)`
  )
    .bind(tradeId, signalId, symbol, direction, entry, sl, tp, volume, strategy.exit.mode, ts)
    .run();

  await logActivity(
    env,
    'binance',
    `Webhook /webhook/${strategyKey} ${symbol} ${direction.toUpperCase()} ${volume} eröffnet @ ${entry}`
  );

  const trade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(tradeId).first();

  return Response.json({
    data: { passed: true, strategyKey, symbol, signalId, matched, failed, trade },
  });
}
