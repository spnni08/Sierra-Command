// Signal ingestion for the 22 WAVESCOUT strategies ported into
// worker/src/strategies/. Mirrors spnni08/tradingview-bot's per-strategy
// /webhook/<slug> pattern (worker.js handleWebhookRequest + its
// forcedStrategy routing): the strategy is taken from the URL, not a field
// in the payload, so a misconfigured payload can never get silently routed
// to the wrong strategy's gate logic.
//
// Real production traffic now hits this endpoint (confirmed via activity_log/
// trades — organic 5-minute-aligned timestamps, this worker's own
// /webhook/<strategy_id> URL scheme). POST a signal payload (symbol,
// direction, price, and whatever indicator fields that strategy's factor
// checks read — rsi, ema200, etc.) to /webhook/<strategy-id> (any id from
// worker/schema.sql's strategies table, base or "(SL)" variant, e.g.
// /webhook/crypto_baseline or /webhook/crypto_baseline_sl) and get back the
// AND-gate result.
//
// Every call is recorded in activity_log (source/result, plus the caller's
// User-Agent/CF-Connecting-IP — see logActivity below), same as WAVESCOUT's
// webhook_log — so the Log page sees it live. A passing signal is stored in
// `signals` (status='converted') and immediately opens a `trades` row; a
// failing signal is still stored in `signals` (status='rejected', with the
// matched/failed factor list) but no trade is created — WAVESCOUT's
// skip/reject pattern, just using this schema's existing signals.status enum
// instead of a separate skip log.
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

// `request` is optional (callers outside webhook.js that still use the old
// 3-arg form keep working) but every webhook call site below now passes it,
// so User-Agent/CF-Connecting-IP land on every webhook-triggered log row —
// "damit die Herkunft nachvollziehbar ist", not just on secret rejections.
async function logActivity(env, source, message, request) {
  const userAgent = request?.headers.get('User-Agent') ?? null;
  const sourceIp = request?.headers.get('CF-Connecting-IP') ?? null;
  await env.DB.prepare(
    `INSERT INTO activity_log (id, source, message, timestamp, related_trade_id, user_agent, source_ip) VALUES (?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(makeId('log'), source, message, nowSql(), userAgent, sourceIp)
    .run();
}

// Constant-time byte comparison — Workers' crypto.subtle has no built-in
// timingSafeEqual (unlike Node's crypto module, which isn't available here
// either), so this is hand-rolled: XOR-accumulate every byte pair rather
// than short-circuiting on the first mismatch, so a wrong secret's
// rejection takes the same time regardless of how many leading bytes
// happened to match. A length mismatch returns false immediately — leaking
// the secret's length isn't a meaningful risk (it's a fixed, documented
// format, e.g. `openssl rand -hex 32`), and comparing byte-by-byte against
// a wrong-length buffer would need padding logic that adds complexity for
// no real timing-safety benefit.
function timingSafeEqual(a, b) {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

// Payload-field secret check (TradingView alert bodies can't carry custom
// headers, only a fixed JSON body — see index.js's old ?secret= comment,
// replaced by this). No WEBHOOK_SECRET configured -> nothing to check,
// always ok (matches today's unauthenticated behavior). Never logs the
// submitted value itself, only whether one was present.
function checkWebhookSecret(payload, env) {
  if (!env.WEBHOOK_SECRET) return { ok: true };
  const submitted = payload?.secret;
  if (typeof submitted !== 'string' || !submitted) return { ok: false, reason: 'Secret fehlt' };
  if (!timingSafeEqual(submitted, env.WEBHOOK_SECRET)) return { ok: false, reason: 'falsches Secret' };
  return { ok: true };
}

// Builds the {sl, tp} bracket for one strategy variant's exit config, given
// an already-validated entry price and direction. Shared by the fixed leg
// and the trailing-SL fan-out leg below — see the slPct/rMultiple comment
// further down for why trailing variants bootstrap off DEFAULT_EXIT.slPct.
//
// exit.mode === 'levels' (ict_sweep_mss, sc_keylevel_sweep) means SL/TP are
// structure-derived, not a %/ATR bracket — the strategy's own adapter/Pine
// script already computed them and sent them as payload.slPrice/tpPrice.
// Previously this branch fell straight through to the generic %-bracket
// below, silently discarding those payload values on every live trade for
// any 'levels'-mode strategy — a real fidelity bug (caught while wiring
// sc_keylevel_sweep, which genuinely needs its SL behind the sweep extreme
// and its TP at the next key level, not a generic 1%/1.5R guess). Falls
// back to the generic bracket only if the payload is missing/invalid
// numbers, so a Pine script that forgets to send them still opens a trade
// with a sane stop instead of being rejected outright.
function computeBracket(exit, direction, entry, payload) {
  // 'levels_trailing' (the "_sl" twin of a 'levels'-mode strategy, e.g.
  // ict_sweep_mss_sl) starts from the exact same structural levels — its
  // trailing management only changes how the stop moves AFTER entry, never
  // the initial SL/TP (see index.js's registration comment for that pair).
  if (exit.mode === 'levels' || exit.mode === 'levels_trailing') {
    const sl = Number(payload?.slPrice);
    const tp = Number(payload?.tpPrice);
    if (Number.isFinite(sl) && Number.isFinite(tp)) return { sl, tp };
  }
  const slPct = exit.mode === 'fixed' ? exit.slPct : DEFAULT_EXIT.slPct;
  const rMultiple = exit.tp2RMultiple ?? DEFAULT_EXIT.tp2RMultiple;
  const slDistance = entry * (slPct / 100);
  const sl = direction === 'long' ? entry - slDistance : entry + slDistance;
  const tp = direction === 'long' ? entry + slDistance * rMultiple : entry - slDistance * rMultiple;
  return { sl, tp };
}

// signals.exit_mode/trades.exit_mode are CHECK-constrained to
// ('fixed','trailing') only (schema.sql) — a narrower set than the real
// exit.mode values the strategy registry actually uses (also 'signal',
// 'signal_or_sltp', 'levels', 'levels_trailing' — see strategies/index.js's
// crypto_flawless_victory_v2/v3 and ict_sweep_mss/_sl registrations, and now
// sc_keylevel_sweep). Binding the raw mode string here would violate that
// CHECK on every webhook call to any of those strategies (caught while
// wiring sc_keylevel_sweep — this affects ict_sweep_mss and
// crypto_flawless_victory just as much, they just never received a real
// webhook call yet). Rather than widen the CHECK (a same-day rebuild of two
// FK-linked tables, signals <- trades <- activity_log, for a column that
// nothing downstream reads at finer granularity than this), every mode maps
// onto the semantic bucket the rest of the app already expects: 'trailing'
// for anything whose SL is meant to move (checkOpenTrades.js's evaluateExit
// only ever checks `exit_mode === 'trailing'` to pick the close-reason
// label, 'trailing_stop' vs 'sl' — never a finer-grained mode), 'fixed' for
// everything else (a static bracket, whether %-based or structure-derived).
// The full-detail mode ('levels', 'signal', ...) never needs to survive
// past this function — every other consumer of a strategy's exit config
// reads it straight from the registry (strategy.exit.mode), never from this
// persisted column.
function dbExitMode(mode) {
  return mode === 'trailing' || mode === 'levels_trailing' ? 'trailing' : 'fixed';
}

async function processWebhook(request, env, strategyKey) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Secret check runs before any DB write — a rejected/unrecognized request
  // still gets exactly one log row (below) documenting why, but never opens
  // a signal or trade. WEBHOOK_SECRET_ENFORCED gates whether a bad/missing
  // secret actually blocks the request (401) or only logs a warning and lets
  // processing continue — see wrangler.toml's rollout comment: this lets
  // every existing TradingView alert keep firing while they're migrated to
  // include "secret", instead of losing signals the moment WEBHOOK_SECRET is
  // set.
  const secretCheck = checkWebhookSecret(payload, env);
  if (!secretCheck.ok) {
    const enforced = env.WEBHOOK_SECRET_ENFORCED === 'true';
    await logActivity(
      env,
      'system',
      `Webhook /webhook/${strategyKey}: ${enforced ? 'abgelehnt' : 'Warnung'} — ${secretCheck.reason}`,
      request
    );
    if (enforced) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const strategy = getStrategy(strategyKey);
  if (!strategy) {
    await logActivity(env, 'system', `Webhook /webhook/${strategyKey}: unbekannte Strategie`, request);
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
    await logActivity(env, 'system', `Webhook /webhook/${strategyKey}: fehlende oder ungültige direction`, request);
    return Response.json({ error: 'invalid_direction', message: 'expected direction: "long" or "short"' }, { status: 400 });
  }

  const symbol = String(payload?.symbol ?? '').toUpperCase();
  if (!symbol) {
    await logActivity(env, 'system', `Webhook /webhook/${strategyKey}: fehlendes symbol`, request);
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
    .bind(signalId, strategyKey, symbol, ts, score, factorState, result.passed ? 'converted' : 'rejected', dbExitMode(strategy.exit.mode), ts)
    .run();

  if (!result.passed) {
    await logActivity(
      env,
      'system',
      `Webhook /webhook/${strategyKey} ${symbol}: Signal abgelehnt (fehlgeschlagen: ${failed.join(', ') || 'unbekannt'})`,
      request
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
      .bind(pairedSignalId, slKey, symbol, ts, score, factorState, dbExitMode(slStrategy.exit.mode), ts)
      .run();
  }

  const entry = Number(payload.price ?? payload.close);
  if (!Number.isFinite(entry)) {
    await logActivity(
      env,
      'system',
      `Webhook /webhook/${strategyKey} ${symbol}: Signal bestätigt, aber kein gültiger Preis im Payload → kein Trade`,
      request
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
  const { sl, tp } = computeBracket(strategy.exit, direction, entry, payload);

  const tradeId = makeId(`trd-${strategyKey}`);
  await env.DB.prepare(
    `INSERT INTO trades (id, signal_id, symbol, direction, entry, sl, tp, volume, source, status, pnl, exit_mode, timeframe, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'binance_testnet', 'open', NULL, ?, ?, ?, NULL)`
  )
    .bind(tradeId, signalId, symbol, direction, entry, sl, tp, volume, dbExitMode(strategy.exit.mode), timeframe, ts)
    .run();

  await logActivity(
    env,
    'binance',
    `Webhook /webhook/${strategyKey} ${symbol} ${direction.toUpperCase()} ${volume} eröffnet @ ${entry} (fixed)`,
    request
  );

  let pairedTrade = null;
  if (slStrategy && pairedSignalId) {
    const { sl: pairedSl, tp: pairedTp } = computeBracket(slStrategy.exit, direction, entry, payload);
    const pairedTradeId = makeId(`trd-${slKey}`);
    await env.DB.prepare(
      `INSERT INTO trades (id, signal_id, symbol, direction, entry, sl, tp, volume, source, status, pnl, exit_mode, timeframe, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'binance_testnet', 'open', NULL, ?, ?, ?, NULL)`
    )
      .bind(pairedTradeId, pairedSignalId, symbol, direction, entry, pairedSl, pairedTp, volume, dbExitMode(slStrategy.exit.mode), timeframe, ts)
      .run();

    await logActivity(
      env,
      'binance',
      `Webhook /webhook/${strategyKey} ${symbol} ${direction.toUpperCase()} ${volume} eröffnet @ ${entry} (paired ${slKey}, trailing)`,
      request
    );

    pairedTrade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(pairedTradeId).first();
  }

  const trade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(tradeId).first();

  return Response.json({
    data: { passed: true, strategyKey, symbol, signalId, matched, failed, trade, pairedTrade },
  });
}
