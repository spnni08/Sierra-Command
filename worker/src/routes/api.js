// Structural-data routes backed by D1: strategies, trades, activity log,
// backtest runs, and per-strategy settings. All GET routes return
// `{ data: [...] }`; the PUT route returns `{ data: {...} }`. Every route in
// this file (including /settings/unlock below) sits behind the worker-wide
// API_ACCESS_TOKEN bearer check in index.js — the frontend already needs
// that token just to load the app (see src/components/TokenGate.jsx), so by
// the time Settings mounts and calls /settings/unlock it's already present;
// there's no chicken-and-egg problem to route around by leaving this one
// route open.

import { signSettingsSession, signAppSession, hashPassword } from '../auth.js';
import { berlinDayRangeUtc, berlinMonthRangeUtc, berlinDateParts, berlinDayOfMonth, isValidDateStr } from '../lib/berlinDay.js';

export async function handleApiRoute(request, url, env) {
  const path = url.pathname.replace(/^\/api/, '');

  // Username/password login (fixed single account — see auth.js's
  // PUBLIC_PREFIXES comment for why this route has to stay unauthenticated).
  // Replaces the old raw-API_ACCESS_TOKEN paste flow (TokenGate.jsx) with a
  // real login form; the token it hands back is a signed session token that
  // checkBearerToken (auth.js) accepts everywhere else, same as a PIN-unlock
  // token.
  if (path === '/auth/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }

  // PIN unlock for the Settings page. The PIN itself (SETTINGS_PIN) never
  // leaves the worker — a correct guess gets back a short-lived HMAC-signed
  // session token (see auth.js's signSettingsSession) that the frontend
  // stores client-side and treats as a soft gate for the Settings UI. There
  // are no settings-mutating endpoints yet (credential add/rotate is still
  // unimplemented — see getCredentials below), so there's nothing server-side
  // left to check this token against beyond the unlock call itself.
  if (path === '/settings/unlock' && request.method === 'POST') {
    return handleSettingsUnlock(request, env);
  }

  if (path === '/strategies' && request.method === 'GET') {
    return getStrategies(env);
  }

  if (path === '/trades' && request.method === 'GET') {
    return getTrades(url, env);
  }

  if (path === '/activity-log' && request.method === 'GET') {
    return getActivityLog(url, env);
  }

  if (path === '/backtest-runs' && request.method === 'GET') {
    return getBacktestRuns(url, env);
  }

  if (path === '/strategy-logic-versions' && request.method === 'GET') {
    return getStrategyLogicVersions(env);
  }

  if (path === '/pnl-calendar' && request.method === 'GET') {
    return getPnlCalendar(url, env);
  }

  // Connection status only — never the encrypted secret/key itself. There is
  // no write endpoint yet (adding a credential means designing a secure
  // encrypt-on-write flow, which is separate, larger work); this exists so
  // the Settings page can show real "connected" state instead of fabricated
  // account data.
  if (path === '/credentials' && request.method === 'GET') {
    return getCredentials(env);
  }

  const settingsMatch = path.match(/^\/strategy-settings\/([^/]+)$/);
  if (settingsMatch && request.method === 'PUT') {
    return putStrategySettings(request, env, settingsMatch[1]);
  }

  const strategyMatch = path.match(/^\/strategies\/([^/]+)$/);
  if (strategyMatch && request.method === 'PATCH') {
    return patchStrategy(request, env, strategyMatch[1]);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!env.APP_USERNAME || !env.APP_PASSWORD_HASH) {
    // Misconfigured deploy (secrets never set) — fail closed.
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Hash the submitted password unconditionally, even on a missing/blank
  // field or an already-wrong username, before comparing anything — so a
  // bad username doesn't short-circuit the response before the (roughly
  // constant-cost) hashing work below, which would otherwise make username
  // correctness observable from response timing alone.
  const submittedHash = await hashPassword(password);

  const usernameOk = username === env.APP_USERNAME;
  const passwordOk = submittedHash === env.APP_PASSWORD_HASH;

  if (!usernameOk || !passwordOk) {
    // Deliberately generic — never reveal which of the two was wrong.
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = await signAppSession(env);
  const expires_at = Date.now() + 30 * 60 * 1000; // matches auth.js's SESSION_TTL_MS
  return Response.json({ data: { token, expires_at } });
}

async function handleSettingsUnlock(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!env.SETTINGS_PIN) {
    // Misconfigured deploy (secret never set) — fail closed.
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (typeof body?.pin !== 'string' || body.pin !== env.SETTINGS_PIN) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = await signSettingsSession(env);
  return Response.json({ data: { token } });
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function getStrategies(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT
         s.id, s.name, s.asset_classes, s.active, s.factor_definition,
         s.created_at, s.updated_at,
         ss.risk_per_trade_pct, ss.session_filter, ss.correlation_limit,
         ss.news_filter_threshold, ss.params_json
       FROM strategies s
       LEFT JOIN strategy_settings ss ON ss.strategy_id = s.id
       ORDER BY s.created_at ASC`
    ).all();

    const data = results.map((row) => ({
      id: row.id,
      name: row.name,
      asset_classes: parseJsonColumn(row.asset_classes, []),
      active: !!row.active,
      factor_definition: parseJsonColumn(row.factor_definition, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
      settings: {
        risk_per_trade_pct: row.risk_per_trade_pct ?? null,
        session_filter: parseJsonColumn(row.session_filter, []),
        correlation_limit: row.correlation_limit ?? null,
        news_filter_threshold: row.news_filter_threshold ?? null,
        // Per-strategy logic-threshold overrides — see schema.sql's
        // strategy_settings.params_json comment. '{}' (or no row at all,
        // pre-migration) means "use the adapter's own built-in defaults".
        params: parseJsonColumn(row.params_json, {}),
      },
    }));

    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

// trades.signal_id -> signals.strategy_id -> strategies.name — the join
// that was never wired up (see the "strategy: '—'" comments this replaces
// in ProTerminal.jsx/LogPage.jsx/Dashboard.jsx). LEFT JOINs throughout: a
// trade with no signal_id (or a signal whose strategy was since removed)
// still comes back, just with strategy_id/strategy_name null rather than
// dropping the row.
// ?status= and ?date= are independent, AND-combined filters. ?date= (a
// Europe/Berlin calendar date, 'YYYY-MM-DD') matches a trade that was
// opened OR closed on that day — not "was open at some point during that
// day" (which would resurface a days-old still-open trade on every
// intervening day's log). A trade opened on day N and closed on day N+1
// deliberately shows up under both days: both are real events belonging to
// their respective day's log.
async function getTrades(url, env) {
  try {
    const status = url.searchParams.get('status');
    const date = url.searchParams.get('date');
    const base = `SELECT t.*, s.strategy_id as strategy_id, st.name as strategy_name
       FROM trades t
       LEFT JOIN signals s ON s.id = t.signal_id
       LEFT JOIN strategies st ON st.id = s.strategy_id`;

    const clauses = [];
    const params = [];
    if (status === 'open' || status === 'closed') {
      clauses.push('t.status = ?');
      params.push(status);
    }
    if (date && isValidDateStr(date)) {
      const { startUtc, endUtc } = berlinDayRangeUtc(date);
      clauses.push(
        '((t.opened_at >= ? AND t.opened_at < ?) OR (t.closed_at IS NOT NULL AND t.closed_at >= ? AND t.closed_at < ?))'
      );
      params.push(startUtc, endUtc, startUtc, endUtc);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const stmt = params.length
      ? env.DB.prepare(`${base} ${where} ORDER BY t.opened_at DESC`).bind(...params)
      : env.DB.prepare(`${base} ORDER BY t.opened_at DESC`);
    const { results } = await stmt.all();
    return Response.json({ data: results });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

// ?source= and ?date= are independent, AND-combined filters, same
// convention as getTrades. The 200-row LIMIT only applies to the
// unfiltered/no-date case (its original purpose — a sane cap on the
// "everything" view); a single Europe/Berlin day's worth of activity is
// never realistically going to hit that, and the day-filtered view is
// meant to show ALL of that day's entries, not a truncated slice.
async function getActivityLog(url, env) {
  try {
    const source = url.searchParams.get('source');
    const date = url.searchParams.get('date');
    const LIMIT = 200;
    // Same strategy join as getTrades, via activity_log.related_trade_id.
    // System-source rows (no related trade) come back with strategy_name
    // null, same as an unattributed trade.
    const base = `SELECT a.*, st.name as strategy_name
       FROM activity_log a
       LEFT JOIN trades t ON t.id = a.related_trade_id
       LEFT JOIN signals s ON s.id = t.signal_id
       LEFT JOIN strategies st ON st.id = s.strategy_id`;

    const clauses = [];
    const params = [];
    if (source === 'system' || source === 'binance' || source === 'oanda') {
      clauses.push('a.source = ?');
      params.push(source);
    }
    const hasDateFilter = !!(date && isValidDateStr(date));
    if (hasDateFilter) {
      const { startUtc, endUtc } = berlinDayRangeUtc(date);
      clauses.push('a.timestamp >= ? AND a.timestamp < ?');
      params.push(startUtc, endUtc);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitClause = hasDateFilter ? '' : 'LIMIT ?';
    if (!hasDateFilter) params.push(LIMIT);
    const stmt = env.DB.prepare(`${base} ${where} ORDER BY a.timestamp DESC ${limitClause}`).bind(...params);
    const { results } = await stmt.all();
    return Response.json({ data: results });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

async function getBacktestRuns(url, env) {
  try {
    const strategyId = url.searchParams.get('strategy_id');
    let stmt;
    if (strategyId) {
      stmt = env.DB.prepare(
        'SELECT * FROM backtest_runs WHERE strategy_id = ? ORDER BY created_at DESC'
      ).bind(strategyId);
    } else {
      stmt = env.DB.prepare('SELECT * FROM backtest_runs ORDER BY created_at DESC');
    }
    const { results } = await stmt.all();
    return Response.json({ data: results });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

// Exposes strategy_logic_versions as-is: strategy_id, logic_hash,
// updated_at, last_invalidated_at. The frontend uses last_invalidated_at to
// tell "logic changed since the last backtest — please re-run" apart from
// "never backtested" when a strategy has zero backtest_runs — see
// schema.sql's comment on this table and
// worker/scripts/generate-logic-invalidation-sql.mjs, which is what
// actually populates it on every deploy.
async function getStrategyLogicVersions(env) {
  try {
    const { results } = await env.DB.prepare('SELECT * FROM strategy_logic_versions').all();
    return Response.json({ data: results });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

async function putStrategySettings(request, env, strategyId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { risk_per_trade_pct, session_filter, correlation_limit, news_filter_threshold, params } = body || {};

  if (
    typeof risk_per_trade_pct !== 'number' ||
    !Array.isArray(session_filter) ||
    typeof correlation_limit !== 'number' ||
    typeof news_filter_threshold !== 'number' ||
    (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params)))
  ) {
    return Response.json(
      {
        error: 'invalid_body',
        message:
          'Expected { risk_per_trade_pct: number, session_filter: string[], correlation_limit: number, news_filter_threshold: number, params?: object }',
      },
      { status: 400 }
    );
  }

  try {
    const strategy = await env.DB.prepare('SELECT id FROM strategies WHERE id = ?')
      .bind(strategyId)
      .first();
    if (!strategy) {
      return Response.json({ error: 'not_found', message: 'strategy does not exist' }, { status: 404 });
    }

    // `params` (the strategy's own logic-threshold overrides, see
    // schema.sql's strategy_settings.params_json comment) is optional on
    // this route — a caller that only wants to update the risk/session/
    // correlation/news knobs (every caller before ict_sweep_mss) shouldn't
    // have to also resend params_json, so an omitted `params` keeps
    // whatever the row already has instead of being reset to '{}'.
    const paramsJson = params !== undefined ? JSON.stringify(params) : null;

    await env.DB.prepare(
      `INSERT INTO strategy_settings (strategy_id, risk_per_trade_pct, session_filter, correlation_limit, news_filter_threshold, params_json)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, '{}'))
       ON CONFLICT(strategy_id) DO UPDATE SET
         risk_per_trade_pct = excluded.risk_per_trade_pct,
         session_filter = excluded.session_filter,
         correlation_limit = excluded.correlation_limit,
         news_filter_threshold = excluded.news_filter_threshold,
         params_json = COALESCE(?, strategy_settings.params_json)`
    )
      .bind(strategyId, risk_per_trade_pct, JSON.stringify(session_filter), correlation_limit, news_filter_threshold, paramsJson, paramsJson)
      .run();

    const updated = await env.DB.prepare('SELECT * FROM strategy_settings WHERE strategy_id = ?')
      .bind(strategyId)
      .first();

    return Response.json({
      data: {
        ...updated,
        session_filter: parseJsonColumn(updated.session_filter, []),
        params: parseJsonColumn(updated.params_json, {}),
      },
    });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

async function patchStrategy(request, env, strategyId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof body?.active !== 'boolean') {
    return Response.json({ error: 'invalid_body', message: 'Expected { active: boolean }' }, { status: 400 });
  }

  try {
    const strategy = await env.DB.prepare('SELECT id FROM strategies WHERE id = ?').bind(strategyId).first();
    if (!strategy) {
      return Response.json({ error: 'not_found', message: 'strategy does not exist' }, { status: 404 });
    }

    await env.DB.prepare(`UPDATE strategies SET active = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(body.active ? 1 : 0, strategyId)
      .run();

    const updated = await env.DB.prepare('SELECT id, active FROM strategies WHERE id = ?').bind(strategyId).first();
    return Response.json({ data: { id: updated.id, active: !!updated.active } });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

// Daily PnL grouped by source (mt5 = oanda_*, exchange = binance_*), for the
// Log page's calendar. `year`/`month` default to the current Europe/Berlin
// month. Bucketing is done in JS (berlinDayOfMonth), not SQL strftime —
// SQLite has no IANA timezone database and can't correctly account for the
// CET/CEST DST transition, only fixed offsets (which would be wrong half
// the year). This MUST bucket the same way getTrades'/getActivityLog's
// ?date= filter does, or a day's calendar total and its filtered trade list
// (via LogPage's day click) would disagree.
async function getPnlCalendar(url, env) {
  try {
    const todayBerlin = berlinDateParts();
    const year = parseInt(url.searchParams.get('year'), 10) || todayBerlin.year;
    const month = parseInt(url.searchParams.get('month'), 10) || todayBerlin.month;
    const { startUtc, endUtc } = berlinMonthRangeUtc(year, month);

    const { results } = await env.DB.prepare(
      `SELECT closed_at, source, pnl
       FROM trades
       WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at >= ? AND closed_at < ?`
    )
      .bind(startUtc, endUtc)
      .all();

    const days = {};
    for (const row of results) {
      const day = berlinDayOfMonth(row.closed_at);
      const bucket = days[day] ?? (days[day] = { mt5: 0, exch: 0 });
      const group = String(row.source ?? '').startsWith('oanda') ? 'mt5' : 'exchange';
      if (group === 'mt5') bucket.mt5 += row.pnl ?? 0;
      else bucket.exch += row.pnl ?? 0;
    }
    for (const day of Object.values(days)) {
      day.total = day.mt5 + day.exch;
    }

    return Response.json({ data: { year, month, days } });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

// Connection status only (id, provider, env, created_at) — the
// encrypted_key/encrypted_secret columns are never returned here.
async function getCredentials(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, provider, env, created_at FROM api_credentials ORDER BY provider, env'
    ).all();
    return Response.json({ data: results });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}
