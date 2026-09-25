// Global + per-strategy auto-trade risk gate, evaluated ONCE per webhook
// call (per the 2026-09-25 decision: Pine's signal is trusted — see
// routes/webhook.js's header comment — so this is now the only thing that
// can still stop a structurally-valid, accepted signal from opening a real
// trade). A base strategy and its paired "(SL)" trade share one decision:
// they come from the same signal, so checkRiskRules is called once per
// webhook call, before either trade is opened, and its result governs both
// legs of the fan-out (see webhook.js).
//
// Rules run in a fixed order and short-circuit on the first failure — the
// returned `reason` is always the single blocking rule, never a combined
// list, so routes/webhook.js's activity_log entry names exactly one cause:
//   1. Global auto-trading switch (app_settings.auto_trading_enabled)
//   2. Per-strategy active switch (strategies.active)
//   3. Max open positions (app_settings.max_open_positions) — a base trade
//      and its paired "(SL)" trade count as ONE position via
//      trades.position_group_id (see countOpenPositions below)
//   4. Daily loss limit (app_settings.daily_loss_limit_usd) — realized PnL
//      for the current Europe/Berlin calendar day
//   5. Trading hours (app_settings.trading_hours_start_utc/_end_utc)
//   6. Per-strategy session filter (strategy_settings.session_filter, via
//      lib/sessions.js's sessionOf() — the same session definition used
//      everywhere else in this app, never a separate one)
//
// Deliberately NOT built here (per the 2026-09-25 decision): a correlation
// limit and a news filter — strategy_settings.correlation_limit/
// news_filter_threshold stay stored but unused; the Settings/AutoTrade UI
// shows them greyed out "noch nicht aktiv" instead of pretending they work.
import { sessionOf } from '../lib/sessions.js';
import { berlinDayRangeUtc, berlinDateParts } from '../lib/berlinDay.js';

async function getAppSetting(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first();
  return row?.value ?? fallback;
}

// A base trade and its paired "(SL)" trade share position_group_id (set by
// webhook.js at open time) — COUNT DISTINCT that, falling back to a trade's
// own id when the column is NULL (trades opened before this column existed,
// or any future trade opened outside the fan-out path), so an ungrouped
// trade still counts as exactly one position rather than being silently
// dropped from the count.
export async function countOpenPositions(env) {
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(position_group_id, id) AS pos_key FROM trades WHERE status = 'open'`
  ).all();
  return new Set(results.map((r) => r.pos_key)).size;
}

export async function getRealizedPnlToday(env) {
  const today = berlinDateParts();
  const dateStr = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
  const { startUtc, endUtc } = berlinDayRangeUtc(dateStr);
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(pnl), 0) AS total FROM trades WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?`
  )
    .bind(startUtc, endUtc)
    .first();
  return Number(row?.total ?? 0);
}

function currentUtcHour() {
  return new Date().getUTCHours();
}

// [start, end) hour-of-day window, UTC. Handles a window that wraps past
// midnight (start > end, e.g. 22-06) the same way, though today's default
// (6-22) doesn't need it — kept general since it's one extra comparison.
function isWithinTradingHours(hour, start, end) {
  if (start === end) return true; // 24h window (degenerate config, not an error)
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * Evaluates the global + per-strategy-active risk rules in order for one
 * accepted signal. Returns { ok: true } or { ok: false, reason: string,
 * detail? } — `reason` is a short, stable machine-readable code;
 * describeRiskRejection() below turns it into the German activity_log
 * sentence. Session-filter is checked separately (checkSessionFilter) since
 * it needs the caller's already-fetched strategy_settings row.
 */
export async function checkRiskRules(env, { strategyActive }) {
  const autoTradingEnabled = (await getAppSetting(env, 'auto_trading_enabled', 'true')) === 'true';
  if (!autoTradingEnabled) {
    return { ok: false, reason: 'auto_trading_disabled' };
  }

  if (!strategyActive) {
    return { ok: false, reason: 'strategy_inactive' };
  }

  const maxOpenPositions = Number(await getAppSetting(env, 'max_open_positions', '5'));
  if (Number.isFinite(maxOpenPositions)) {
    const openPositions = await countOpenPositions(env);
    if (openPositions >= maxOpenPositions) {
      return { ok: false, reason: 'max_open_positions', detail: { openPositions, maxOpenPositions } };
    }
  }

  const dailyLossLimit = Number(await getAppSetting(env, 'daily_loss_limit_usd', '500'));
  if (Number.isFinite(dailyLossLimit) && dailyLossLimit > 0) {
    const realizedPnlToday = await getRealizedPnlToday(env);
    if (realizedPnlToday <= -dailyLossLimit) {
      return { ok: false, reason: 'daily_loss_limit', detail: { realizedPnlToday, dailyLossLimit } };
    }
  }

  const startHour = Number(await getAppSetting(env, 'trading_hours_start_utc', '6'));
  const endHour = Number(await getAppSetting(env, 'trading_hours_end_utc', '22'));
  if (Number.isFinite(startHour) && Number.isFinite(endHour)) {
    const hour = currentUtcHour();
    if (!isWithinTradingHours(hour, startHour, endHour)) {
      return { ok: false, reason: 'trading_hours', detail: { hour, startHour, endHour } };
    }
  }

  // Session filter is checked separately (checkSessionFilter below) — it
  // needs strategy_settings.session_filter, which the caller already has.
  return { ok: true };
}

// Separate from checkRiskRules because it needs strategy_settings.
// session_filter, which routes/webhook.js already fetches for other
// reasons — avoids a second DB round-trip for the same row. `sessionFilter`
// is the JSON-parsed array from strategy_settings (SESSION_KEYS values, or
// [] for "no restriction" — same convention as api.js's PUT validation and
// AutoTrade.jsx's session presets).
export function checkSessionFilter(sessionFilter) {
  if (!Array.isArray(sessionFilter) || sessionFilter.length === 0) {
    return { ok: true };
  }
  const current = sessionOf(new Date()).key;
  if (!sessionFilter.includes(current)) {
    return { ok: false, reason: 'session_filter', detail: { currentSession: current, allowed: sessionFilter } };
  }
  return { ok: true };
}

// Human-readable (German) rejection sentence per reason code — used by
// routes/webhook.js's activity_log entry. Kept here (not in webhook.js) so
// the wording stays next to the rule that produces the reason code.
export function describeRiskRejection(result) {
  switch (result.reason) {
    case 'auto_trading_disabled':
      return 'Automatischer Handel ist global deaktiviert';
    case 'strategy_inactive':
      return 'Strategie ist deaktiviert';
    case 'max_open_positions':
      return `Max. gleichzeitige Positionen erreicht (${result.detail.openPositions}/${result.detail.maxOpenPositions})`;
    case 'daily_loss_limit':
      return `Tages-Verlustlimit erreicht (realisiert ${result.detail.realizedPnlToday.toFixed(2)} von -${result.detail.dailyLossLimit})`;
    case 'trading_hours':
      return `Außerhalb der Handelszeiten (${result.detail.hour}:00 UTC, Fenster ${result.detail.startHour}-${result.detail.endHour} UTC)`;
    case 'session_filter':
      return `Session "${result.detail.currentSession}" nicht in Strategie-Session-Filter (${result.detail.allowed.join(', ')})`;
    default:
      return `Risiko-Regel abgelehnt (${result.reason})`;
  }
}
