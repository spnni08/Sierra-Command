// Europe/Berlin calendar-day boundaries, computed against real UTC instants
// via Intl.DateTimeFormat rather than a fixed +1/+2 hour offset — D1/SQLite
// has no IANA timezone database and can't do CET/CEST-aware conversion
// itself (only fixed-offset modifiers, which would silently be wrong for
// half the year). Every timestamp this worker stores (trades.opened_at/
// closed_at, activity_log.timestamp, signals.timestamp/created_at) is a
// naive UTC string in the exact 'YYYY-MM-DD HH:MM:SS' shape nowSql()
// produces (see routes/webhook.js, simulation/execution-engine.js,
// cron/checkOpenTrades.js) — every function here both takes and returns
// that same shape, so callers can compare/bind them directly in SQL with
// plain >=/< string comparisons.

const BERLIN_TZ = 'Europe/Berlin';

function toSqlString(epochMs) {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

// Reads the Europe/Berlin wall-clock date/time components of a UTC instant.
function berlinPartsOf(epochMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: BERLIN_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(new Date(epochMs))) {
    if (type !== 'literal') parts[type] = value;
  }
  // Intl formats midnight as "24" under hour12:false in some engines — normalize.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(hour, 10),
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
  };
}

// Finds the UTC epoch ms whose Europe/Berlin wall-clock reads exactly
// (y, m, d, hh, mm, ss). Converges in at most 2 passes: Berlin's offset
// from UTC is always exactly +1h (CET) or +2h (CEST), never anything else,
// so one correction pass always lands exactly on target.
function findUtcForBerlinLocal(y, m, d, hh, mm, ss) {
  let guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  for (let i = 0; i < 3; i++) {
    const got = berlinPartsOf(guess);
    const gotAsUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    const wantAsUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
    const diff = wantAsUtc - gotAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

// 'YYYY-MM-DD' + basic calendar-validity check (rejects e.g. '2026-02-30').
// Used to sanitize the ?date= query param before it ever reaches SQL.
export function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

// The [startUtc, endUtc) instant range (as 'YYYY-MM-DD HH:MM:SS' UTC
// strings) covering one Europe/Berlin calendar day.
export function berlinDayRangeUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Date.UTC normalizes an out-of-range day (e.g. day 31 of a 30-day month)
  // by rolling into the next month, which is exactly the "day after d" we
  // want here — no separate month-length lookup needed.
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const startMs = findUtcForBerlinLocal(y, m, d, 0, 0, 0);
  const endMs = findUtcForBerlinLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0);
  return { startUtc: toSqlString(startMs), endUtc: toSqlString(endMs) };
}

// Same idea for a whole Europe/Berlin calendar month (month is 1-12).
export function berlinMonthRangeUtc(year, month) {
  const next = new Date(Date.UTC(year, month, 1)); // month (already the "next" 0-indexed month vs. our 1-indexed input)
  const startMs = findUtcForBerlinLocal(year, month, 1, 0, 0, 0);
  const endMs = findUtcForBerlinLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, 1, 0, 0, 0);
  return { startUtc: toSqlString(startMs), endUtc: toSqlString(endMs) };
}

// "What is today, in Berlin, right now" — {year, month, day} (month 1-12).
export function berlinDateParts(instant = new Date()) {
  const p = berlinPartsOf(instant.getTime());
  return { year: p.year, month: p.month, day: p.day };
}

// Given a naive-UTC DB timestamp string ('YYYY-MM-DD HH:MM:SS'), returns
// its Europe/Berlin calendar day-of-month (int).
export function berlinDayOfMonth(dbTimestamp) {
  const ms = Date.parse(dbTimestamp.replace(' ', 'T') + 'Z');
  return berlinPartsOf(ms).day;
}
