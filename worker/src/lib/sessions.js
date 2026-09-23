// Trading-session classification for a single instant, in real local market
// time (not fixed UTC-hour windows) — reuses the same Intl.DateTimeFormat +
// timeZone pattern already proven in lib/berlinDay.js's berlinPartsOf,
// since D1/SQLite has no IANA timezone database and only JS can do the
// CET/CEST-style (here: GMT/BST and EST/EDT) conversion correctly. Overlap
// windows are deliberately NOT hardcoded as fixed UTC hours — they're
// derived live from the three independent open/closed checks below, so
// they automatically shift with London's/New York's own DST transitions
// (e.g. the Asia/London overlap is UTC 07:00–09:00 in BST but UTC
// 08:00–09:00 in GMT — both correct, no special-casing needed).
//
// Every trade gets EXACTLY ONE session (never a multi-membership tag list
// like the older, backtest-only worker/src/backtest/sessions.js used) so a
// per-session trade count can simply be summed without an inclusion-
// exclusion correction:
//   London/NY Overlap  — both London and New York open
//   Asia/London Overlap — both Asia and London open
//   otherwise the single open session (Asia / London / New York)
//   Außerhalb           — no session open
// A triple overlap is geometrically impossible (Asia closes by 09:00 UTC
// at the latest; New York never opens before 12:00 UTC), so the order of
// the two overlap checks below is for readability only, not a priority
// rule between cases that could otherwise both be true.

export const SESSION_KEYS = ['asia', 'london', 'new_york', 'london_ny_overlap', 'asia_london_overlap', 'outside'];

export const SESSION_LABELS = {
  asia: 'Asia',
  london: 'London',
  new_york: 'New York',
  london_ny_overlap: 'London/NY Overlap',
  asia_london_overlap: 'Asia/London Overlap',
  outside: 'Außerhalb',
};

const SESSION_TZ = {
  asia: 'Asia/Tokyo',
  london: 'Europe/London',
  new_york: 'America/New_York',
};

// [startMinute, endMinute) of the local market day, half-open — the start
// minute belongs to the session, the end minute does not (same convention
// the older backtest/sessions.js used, just now in minutes instead of
// whole hours since London's close at 16:30 needs half-hour precision).
const SESSION_WINDOWS_MIN = {
  asia: [9 * 60, 18 * 60], // 09:00–18:00 Asia/Tokyo (no DST in Japan)
  london: [8 * 60, 16 * 60 + 30], // 08:00–16:30 Europe/London
  new_york: [8 * 60, 17 * 60], // 08:00–17:00 America/New_York
};

// Accepts a Date, epoch-ms number, or this codebase's naive-UTC DB
// timestamp string ('YYYY-MM-DD HH:MM:SS', see berlinDay.js's header
// comment) — the same T/Z repair every other call site in this repo uses
// (fmtBerlinDateTime, berlinDayOfMonth) so plain `new Date(...)` doesn't
// silently misparse it as local time.
function toEpochMs(timestamp) {
  if (timestamp instanceof Date) return timestamp.getTime();
  if (typeof timestamp === 'number') return timestamp;
  if (typeof timestamp === 'string') {
    const iso = /[TZ]|[+-]\d\d:\d\d$/.test(timestamp) ? timestamp : timestamp.replace(' ', 'T') + 'Z';
    return new Date(iso).getTime();
  }
  return NaN;
}

function localMinutesOfDay(epochMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(new Date(epochMs))) {
    if (type !== 'literal') parts[type] = value;
  }
  // Intl formats midnight as "24" under hour12:false in some engines —
  // normalize, same fix berlinDay.js's berlinPartsOf already applies.
  const hour = parts.hour === '24' ? 0 : parseInt(parts.hour, 10);
  return hour * 60 + parseInt(parts.minute, 10);
}

function isOpen(marketKey, epochMs) {
  const mins = localMinutesOfDay(epochMs, SESSION_TZ[marketKey]);
  const [start, end] = SESSION_WINDOWS_MIN[marketKey];
  return mins >= start && mins < end;
}

// Returns { key, label, isWeekend } for a given instant. `key` is one of
// SESSION_KEYS (stable, ASCII — safe to store/filter/CHECK-constrain);
// `label` is the German display string. `isWeekend` is derived from the
// UTC calendar day (Sat/Sun) — a pure date property, independent of
// whether any session happens to be open, since every timestamp in this
// codebase is already a naive-UTC string/instant.
export function sessionOf(timestamp) {
  const ms = toEpochMs(timestamp);
  if (Number.isNaN(ms)) {
    return { key: 'outside', label: SESSION_LABELS.outside, isWeekend: false };
  }

  const asiaOpen = isOpen('asia', ms);
  const londonOpen = isOpen('london', ms);
  const nyOpen = isOpen('new_york', ms);

  let key;
  if (londonOpen && nyOpen) key = 'london_ny_overlap';
  else if (asiaOpen && londonOpen) key = 'asia_london_overlap';
  else if (asiaOpen) key = 'asia';
  else if (londonOpen) key = 'london';
  else if (nyOpen) key = 'new_york';
  else key = 'outside';

  const utcDay = new Date(ms).getUTCDay(); // 0 = Sunday, 6 = Saturday
  return { key, label: SESSION_LABELS[key], isWeekend: utcDay === 0 || utcDay === 6 };
}

// Standalone weekend check (Sat/Sun in UTC) — used wherever only the
// weekend flag is needed without the session classification, e.g.
// pure-date filters.
export function isWeekend(timestamp) {
  const ms = toEpochMs(timestamp);
  if (Number.isNaN(ms)) return false;
  const utcDay = new Date(ms).getUTCDay();
  return utcDay === 0 || utcDay === 6;
}
