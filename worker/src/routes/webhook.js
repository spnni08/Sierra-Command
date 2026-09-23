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

// Builds the {id, sl, tp} bracket for one strategy variant's exit config,
// given an already-validated entry price and direction. Shared by the fixed
// leg and the trailing-SL fan-out leg below — see the slPct/rMultiple
// comment further down for why trailing variants bootstrap off
// DEFAULT_EXIT.slPct.
function computeBracket(exit, direction, entry) {
  const slPct = exit.mode === 'fixed' ? exit.slPct : DEFAULT_EXIT.slPct;
  const rMultiple = exit.tp2RMultiple ?? DEFAULT_EXIT.tp2RMultiple;
  const slDistance = entry * (slPct / 100);
  const sl = direction === 'long' ? entry - slDistance : entry + slDistance;
  const tp = direction === 'long' ? entry + slDistance * rMultiple : entry - slDistance * rMultiple;
  return { sl, tp };
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

  // Fan-out: a hit on a fixed-variant key (exit.mode === 'fixed') also opens
  // the paired trailing-SL ("_sl") trade, mirroring WAVESCOUT's "one alert,
  // both variants" behavior — see worker/src/strategies/index.js's
  // buildRegistry() for how `<key>` and `<key>_sl` share the same evaluate()
  // and only differ in exit config. crypto_flawless_victory v1 is naturally
  // excluded here since its base exit.mode is 'signal', not 'fixed' (see
  // cryptoFlawlessVictory.js's signalOnlyExit); v2/v3 are excluded because
  // they're registered as their own standalone keys with no "_sl" pair at
  // all. A direct hit on a "_sl" key itself (exit.mode === 'trailing') never
  // fans out — that's the legacy/manual path, kept working unchanged for
  // backwards compatibility with any alert still pointed straight at it.
  const slKey = `${strategyKey}_sl`;
  const slStrategy = strategy.exit.mode === 'fixed' ? getStrategy(slKey) : null;

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

  // Read verbatim, never inferred — see schema.sql's trades.timeframe
  // comment. TradingView's {{interval}} macro sends raw codes ('15','240',
  // 'D',...); stored exactly as received, normalized only at query time
  // (stats/computeStats.js's normalizeTimeframe), not here.
  const timeframe = typeof payload?.timeframe === 'string' && payload.timeframe.trim() ? payload.timeframe.trim() : null;

  // The entry condition (the AND-gated factor chain) is identical between a
  // base strategy and its "_sl" variant — only the exit config differs (see
  // index.js's buildRegistry comment) — so one evaluate() call covers both
  // legs of the fan-out; there's no separate "_sl" evaluation to run.
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

  // A passing fixed-variant signal also opens the paired "_sl" trade: same
  // matched/failed factor result (same entry condition), a second `signals`
  // row keyed by the "_sl" strategy id (status/exit_mode reflect that leg),
  // and — if a price is available — a second `trades` row. No new schema
  // column is needed to link the pair: each leg is its own normal
  // signal+trade row, distinguishable by strategy_id/exit_mode and created
  // in the same webhook call (same symbol/timestamp).
  let pairedSignalId = null;
  if (slStrategy) {
    pairedSignalId = makeId(`sig-${slKey}`);
    await env.DB.prepare(
      `INSERT INTO signals (id, strategy_id, symbol, timestamp, score, factor_state, status, exit_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'converted', ?, ?)`
    )
      .bind(pairedSignalId, slKey, symbol, ts, score, factorState, slStrategy.exit.mode, ts)
      .run();
  }

  const entry = Number(payload.price ?? payload.close);
  if (!Number.isFinite(entry)) {
    await logActivity(
      env,
      'system',
      `Webhook /webhook/${strategyKey} ${symbol}: Signal bestätigt, aber kein gültiger Preis im Payload → kein Trade`
    );
    return Response.json({
      data: {
        passed: true,
        strategyKey,
        symbol,
        signalId,
        matched,
        failed,
        trade: null,
        pairedTrade: null,
        reason: 'missing_price',
      },
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
  const { sl, tp } = computeBracket(strategy.exit, direction, entry);

  const tradeId = makeId(`trd-${strategyKey}`);
  await env.DB.prepare(
    `INSERT INTO trades (id, signal_id, symbol, direction, entry, sl, tp, volume, source, status, pnl, exit_mode, timeframe, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'binance_testnet', 'open', NULL, ?, ?, ?, NULL)`
  )
    .bind(tradeId, signalId, symbol, direction, entry, sl, tp, volume, strategy.exit.mode, timeframe, ts)
    .run();

  await logActivity(
    env,
    'binance',
    `Webhook /webhook/${strategyKey} ${symbol} ${direction.toUpperCase()} ${volume} eröffnet @ ${entry} (fixed)`
  );

  let pairedTrade = null;
  if (slStrategy && pairedSignalId) {
    const { sl: pairedSl, tp: pairedTp } = computeBracket(slStrategy.exit, direction, entry);
    const pairedTradeId = makeId(`trd-${slKey}`);
    await env.DB.prepare(
      `INSERT INTO trades (id, signal_id, symbol, direction, entry, sl, tp, volume, source, status, pnl, exit_mode, timeframe, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'binance_testnet', 'open', NULL, ?, ?, ?, NULL)`
    )
      .bind(pairedTradeId, pairedSignalId, symbol, direction, entry, pairedSl, pairedTp, volume, slStrategy.exit.mode, timeframe, ts)
      .run();

    await logActivity(
      env,
      'binance',
      `Webhook /webhook/${strategyKey} ${symbol} ${direction.toUpperCase()} ${volume} eröffnet @ ${entry} (paired ${slKey}, trailing)`
    );

    pairedTrade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(pairedTradeId).first();
  }

  const trade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(tradeId).first();

  return Response.json({
    data: { passed: true, strategyKey, symbol, signalId, matched, failed, trade, pairedTrade },
  });
}
