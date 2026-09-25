// Signal ingestion for the 26 Sierra Command strategies in
// worker/src/strategies/. Mirrors spnni08/tradingview-bot's per-strategy
// /webhook/<slug> pattern: the strategy is taken from the URL, not a field
// in the payload, so a misconfigured payload can never get silently routed
// to the wrong strategy's gate logic.
//
// --- 2026-09-25 decision: Pine's signal is the source of truth ---
// A field-mapping audit against the *current* tradingview-bot Pine scripts
// (not the versions Sierra Command's JS was originally ported from) found
// most strategies' factor checks permanently failing on renamed/missing
// payload fields — Pine already gates the signal hard before it ever calls
// alert(), and Sierra Command was silently re-rejecting real signals against
// a stale copy of that gate. So: `evaluateSignal()`'s matched/failed/missing
// result is now informational only, stored per signal/trade for later
// analysis (see strategies/shared.js's header comment) — it never blocks a
// trade. The only thing that can still reject a payload outright is
// `checkStructuralValidity` below (known strategy, symbol, direction,
// price > 0, not a test signal) — everything past that point is either
// opened or blocked by the risk engine (../risk/riskEngine.js), never by
// re-deriving the strategy's own entry logic.
//
// Every call is recorded in activity_log (source/result, plus the caller's
// User-Agent/CF-Connecting-IP — see logActivity below) — so the Log page
// sees it live. A structurally invalid payload gets no `signals` row at all
// (it never became a real signal); a structurally valid one always gets a
// `signals` row with status='converted' (accepted) — whether a `trades` row
// also exists depends only on the risk engine, see below.
import { evaluateSignal, getStrategy } from '../strategies/index.js';
import { DEFAULT_EXIT } from '../strategies/shared.js';
import { checkRiskRules, checkSessionFilter, describeRiskRejection } from '../risk/riskEngine.js';
import { berlinDateParts, berlinDayRangeUtc } from '../lib/berlinDay.js';

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

// A signal is "structurally valid" — the only bar that can still reject a
// payload outright, per the 2026-09-25 decision above — when: the strategy
// id in the URL is known, direction is long/short, symbol is non-empty,
// price is a finite number > 0, and it isn't explicitly flagged as a test
// signal. Everything else (the strategy's own entry logic) is Pine's call,
// not re-checked here.
function isTestSignal(payload) {
  const v = payload?.is_test;
  return v === true || v === 1 || v === '1' || v === 'true';
}

function checkStructuralValidity(strategyKey, payload) {
  const strategy = getStrategy(strategyKey);
  if (!strategy) return { ok: false, reason: 'unknown_strategy' };

  const direction = String(payload?.direction ?? '').toLowerCase();
  if (direction !== 'long' && direction !== 'short') return { ok: false, reason: 'invalid_direction' };

  const symbol = String(payload?.symbol ?? '').toUpperCase();
  if (!symbol) return { ok: false, reason: 'missing_symbol' };

  const price = Number(payload?.price ?? payload?.close);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'invalid_price' };

  if (isTestSignal(payload)) return { ok: false, reason: 'test_signal' };

  return { ok: true, strategy, direction, symbol, price };
}

const STRUCTURAL_REJECTION_MESSAGES = {
  unknown_strategy: (strategyKey) => `Webhook /webhook/${strategyKey}: unbekannte Strategie`,
  invalid_direction: (strategyKey) => `Webhook /webhook/${strategyKey}: fehlende oder ungültige direction`,
  missing_symbol: (strategyKey) => `Webhook /webhook/${strategyKey}: fehlendes symbol`,
  invalid_price: (strategyKey) => `Webhook /webhook/${strategyKey}: kein gültiger Preis (> 0) im Payload`,
  test_signal: (strategyKey) => `Webhook /webhook/${strategyKey}: is_test-Signal ignoriert`,
};

const STRUCTURAL_REJECTION_STATUS = {
  unknown_strategy: 404,
  invalid_direction: 400,
  missing_symbol: 400,
  invalid_price: 400,
  test_signal: 200, // a real request, deliberately not processed — not an error
};

// Prefers the payload's own stop_loss/sl/tp (or the 'levels'-mode slPrice/
// tpPrice) over the generic %/ATR bracket, per field, independently — a
// strategy that sends `sl` but not `tp` gets its SL from the payload and
// its TP computed, not all-or-nothing. `null` in the payload (e.g.
// crypto_sr_bollinger's stop_loss when its adaptive-stop toggle is off)
// counts as "not sent", falling through to the computed value. See this
// module's header for the per-strategy "where does SL/TP come from" table
// (also in the PR description).
function firstFiniteNumber(...values) {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function resolveBracket(exit, direction, entry, payload) {
  const payloadSl = firstFiniteNumber(payload?.stop_loss, payload?.sl, payload?.slPrice);
  const payloadTp = firstFiniteNumber(payload?.tp, payload?.tpPrice);

  const slPct = exit.mode === 'fixed' ? exit.slPct : DEFAULT_EXIT.slPct;
  const rMultiple = exit.tp2RMultiple ?? DEFAULT_EXIT.tp2RMultiple;
  const slDistance = entry * (slPct / 100);
  const computedSl = direction === 'long' ? entry - slDistance : entry + slDistance;
  const computedTp = direction === 'long' ? entry + slDistance * rMultiple : entry - slDistance * rMultiple;

  return {
    sl: payloadSl ?? computedSl,
    tp: payloadTp ?? computedTp,
    slSource: payloadSl != null ? 'payload' : 'computed',
    tpSource: payloadTp != null ? 'payload' : 'computed',
  };
}

// signals.exit_mode/trades.exit_mode are CHECK-constrained to
// ('fixed','trailing') only (schema.sql) — a narrower set than the real
// exit.mode values the strategy registry actually uses. Every mode maps
// onto the semantic bucket the rest of the app already expects: 'trailing'
// for anything whose SL is meant to move, 'fixed' for everything else. See
// checkOpenTrades.js's evaluateExit, which only ever reads this bucket.
function dbExitMode(mode) {
  return mode === 'trailing' || mode === 'levels_trailing' ? 'trailing' : 'fixed';
}

function todayBerlinRange() {
  const today = berlinDateParts();
  const dateStr = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
  return berlinDayRangeUtc(dateStr);
}

// Logs "Payload-Feld X fehlt" once per (strategy, field) per Europe/Berlin
// calendar day — so a future re-drift between a Pine script and this
// strategy's `fields` declarations (strategies/shared.js) surfaces on its
// own instead of silently sitting in `missing` telemetry nobody looks at.
// Checked via an exact-message lookup against today's activity_log rows
// (deterministic message string, no LIKE/injection concerns) rather than a
// separate "already warned" table — activity_log is already the audit trail
// for everything webhook-related.
async function warnMissingFieldsOncePerDay(env, strategyKey, missing) {
  if (!missing || missing.length === 0) return;
  const fields = [...new Set(missing.flatMap((m) => m.fields))];
  if (fields.length === 0) return;

  const { startUtc, endUtc } = todayBerlinRange();
  for (const field of fields) {
    const message = `Payload-Feld "${field}" fehlt für ${strategyKey} (Faktor-Telemetrie unvollständig, Pine/Sierra ausgetauscht?)`;
    const existing = await env.DB.prepare(
      `SELECT 1 FROM activity_log WHERE source = 'system' AND message = ? AND timestamp >= ? AND timestamp < ? LIMIT 1`
    )
      .bind(message, startUtc, endUtc)
      .first();
    if (!existing) {
      await logActivity(env, 'system', message);
    }
  }
}

async function getStrategyRiskContext(env, strategyKey) {
  const row = await env.DB.prepare(
    `SELECT s.active AS active, ss.session_filter AS session_filter
     FROM strategies s
     LEFT JOIN strategy_settings ss ON ss.strategy_id = s.id
     WHERE s.id = ?`
  )
    .bind(strategyKey)
    .first();
  let sessionFilter = [];
  try {
    sessionFilter = row?.session_filter ? JSON.parse(row.session_filter) : [];
  } catch {
    sessionFilter = [];
  }
  return { active: !!(row?.active ?? 1), sessionFilter };
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
  // processing continue — see wrangler.toml's rollout comment.
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

  const structural = checkStructuralValidity(strategyKey, payload);
  if (!structural.ok) {
    await logActivity(env, 'system', STRUCTURAL_REJECTION_MESSAGES[structural.reason](strategyKey), request);
    return Response.json(
      { error: structural.reason, strategyKey },
      { status: STRUCTURAL_REJECTION_STATUS[structural.reason] }
    );
  }
  const { strategy, direction, symbol, price: entry } = structural;

  // Fan-out: a hit on a fixed-variant key (exit.mode === 'fixed') also opens
  // the paired trailing-SL ("_sl") trade, mirroring WAVESCOUT's "one alert,
  // both variants" behavior — see strategies/index.js's buildRegistry().
  // crypto_flawless_victory v1 is naturally excluded (base exit.mode is
  // 'signal'); v2/v3 have no "_sl" pair at all. A direct hit on a "_sl" key
  // itself never fans out.
  const slKey = `${strategyKey}_sl`;
  const slStrategy = strategy.exit.mode === 'fixed' ? getStrategy(slKey) : null;

  // Read verbatim, never inferred — see schema.sql's trades.timeframe
  // comment.
  const timeframe = typeof payload?.timeframe === 'string' && payload.timeframe.trim() ? payload.timeframe.trim() : null;

  // Factor telemetry — informational only as of 2026-09-25 (see this file's
  // header comment and strategies/shared.js). Computed once, shared by both
  // legs of the fan-out (same entry condition, same payload).
  const result = evaluateSignal(strategyKey, payload);
  const matched = result.matched ?? [];
  const failed = result.failed ?? [];
  const missing = result.missing ?? [];
  const legacyPassed = result.legacyPassed ?? false;
  const factorState = JSON.stringify({ matched, failed, missing, legacyPassed });
  await warnMissingFieldsOncePerDay(env, strategyKey, missing);

  const signalId = makeId(`sig-${strategyKey}`);
  const ts = nowSql();

  // A structurally valid signal is always accepted (status='converted') —
  // there is no more "rejected" outcome past this point; whether a trade
  // also opens depends only on the risk engine below.
  await env.DB.prepare(
    `INSERT INTO signals (id, strategy_id, symbol, timestamp, score, factor_state, status, exit_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'converted', ?, ?)`
  )
    .bind(signalId, strategyKey, symbol, ts, legacyPassed ? 1 : 0, factorState, dbExitMode(strategy.exit.mode), ts)
    .run();

  // Risk gate — evaluated once for the whole signal (base + paired "(SL)"
  // trade share this one decision, per the 2026-09-25 "count as one
  // position" rule). Uses the hit strategy's own active flag/session filter
  // (base or "_sl", whichever the URL targeted) — see riskEngine.js's header.
  const riskContext = await getStrategyRiskContext(env, strategyKey);
  let risk = await checkRiskRules(env, { strategyActive: riskContext.active });
  if (risk.ok) {
    risk = checkSessionFilter(riskContext.sessionFilter);
  }

  if (!risk.ok) {
    const reasonText = describeRiskRejection(risk);
    await logActivity(
      env,
      'system',
      `Webhook /webhook/${strategyKey} ${symbol}: Signal angenommen, aber kein Trade — ${reasonText}`,
      request
    );
    return Response.json({
      data: {
        accepted: true,
        strategyKey,
        symbol,
        signalId,
        matched,
        failed,
        missing,
        legacyPassed,
        trade: null,
        pairedTrade: null,
        riskBlocked: true,
        riskReason: risk.reason,
      },
    });
  }

  const volume = Number(payload.volume) > 0 ? Number(payload.volume) : 0.01;
  const positionGroupId = makeId('pos');

  const { sl, tp, slSource, tpSource } = resolveBracket(strategy.exit, direction, entry, payload);

  const tradeId = makeId(`trd-${strategyKey}`);
  await env.DB.prepare(
    `INSERT INTO trades (id, signal_id, symbol, direction, entry, sl, tp, volume, source, status, pnl, exit_mode, timeframe, factor_state, position_group_id, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'binance_testnet', 'open', NULL, ?, ?, ?, ?, ?, NULL)`
  )
    .bind(tradeId, signalId, symbol, direction, entry, sl, tp, volume, dbExitMode(strategy.exit.mode), timeframe, factorState, positionGroupId, ts)
    .run();

  await logActivity(
    env,
    'binance',
    `Webhook /webhook/${strategyKey} ${symbol} ${direction.toUpperCase()} ${volume} eröffnet @ ${entry} (SL ${slSource}, TP ${tpSource})`,
    request
  );

  let pairedSignalId = null;
  let pairedTrade = null;
  if (slStrategy) {
    pairedSignalId = makeId(`sig-${slKey}`);
    await env.DB.prepare(
      `INSERT INTO signals (id, strategy_id, symbol, timestamp, score, factor_state, status, exit_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'converted', ?, ?)`
    )
      .bind(pairedSignalId, slKey, symbol, ts, legacyPassed ? 1 : 0, factorState, dbExitMode(slStrategy.exit.mode), ts)
      .run();

    const paired = resolveBracket(slStrategy.exit, direction, entry, payload);
    const pairedTradeId = makeId(`trd-${slKey}`);
    await env.DB.prepare(
      `INSERT INTO trades (id, signal_id, symbol, direction, entry, sl, tp, volume, source, status, pnl, exit_mode, timeframe, factor_state, position_group_id, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'binance_testnet', 'open', NULL, ?, ?, ?, ?, ?, NULL)`
    )
      .bind(pairedTradeId, pairedSignalId, symbol, direction, entry, paired.sl, paired.tp, volume, dbExitMode(slStrategy.exit.mode), timeframe, factorState, positionGroupId, ts)
      .run();

    await logActivity(
      env,
      'binance',
      `Webhook /webhook/${strategyKey} ${symbol} ${direction.toUpperCase()} ${volume} eröffnet @ ${entry} (paired ${slKey}, trailing, SL ${paired.slSource}, TP ${paired.tpSource})`,
      request
    );

    pairedTrade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(pairedTradeId).first();
  }

  const trade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(tradeId).first();

  return Response.json({
    data: {
      accepted: true,
      strategyKey,
      symbol,
      signalId,
      matched,
      failed,
      missing,
      legacyPassed,
      trade,
      pairedTrade,
      riskBlocked: false,
    },
  });
}
