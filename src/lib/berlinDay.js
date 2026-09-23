// Client-side Europe/Berlin day helpers. Unlike worker/src/lib/berlinDay.js,
// this never computes UTC instant ranges itself — all date-range filtering
// happens server-side (see api/client.js's fetchTrades/fetchActivityLog and
// the worker's ?date= handling). The client only ever needs "what Berlin
// calendar day is it right now" (for the date-picker's max attribute) and a
// format check for the ?date= URL param it reads/writes.

const BERLIN_TZ = 'Europe/Berlin';

// 'YYYY-MM-DD' for the current instant in Europe/Berlin, via Intl (not a
// fixed UTC offset — correct across the CET/CEST DST transition).
export function todayBerlinDateStr(instant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BERLIN_TZ }).format(instant);
}

// {year, month, day} (month 1-12) for the current instant in Europe/Berlin —
// used by Dashboard.jsx's "today" KPI lookup into /api/pnl-calendar's
// (now Berlin-day-bucketed) `days`, replacing a UTC-based lookup that would
// otherwise disagree with the worker during the ~1-2h window around
// midnight Berlin time.
export function berlinDateParts(instant = new Date()) {
  const [year, month, day] = todayBerlinDateStr(instant).split('-').map(Number);
  return { year, month, day };
}

// 'YYYY-MM-DD' + basic calendar-validity check (rejects e.g. '2026-02-30').
// Mirrors worker/src/lib/berlinDay.js's isValidDateStr exactly — kept as a
// separate ~6-line copy rather than a shared import, since src/ and
// worker/ are separate deploy targets with no cross-imports anywhere in
// this codebase.
export function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}
