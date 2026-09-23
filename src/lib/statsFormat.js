// Shared formatting/sorting helpers for the Auswertung page and
// StrategyDetailModal — split out (rather than exported from Auswertung.jsx
// directly) so the modal can import them without a circular dependency
// (Auswertung.jsx renders StrategyDetailModal, so the reverse import would
// cycle back).

// PnL/expectancy in USD — deliberately never colored green/red anywhere
// these are used: sign is conveyed by the +/− prefix alone, per the
// explicit "Winrate und PnL nicht grün/rot" design rule.
export function fmtUsd(v, dec = 2) {
  if (v === null || v === undefined) return '–';
  const s = Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (v >= 0 ? '+' : '−') + s + ' $';
}
export function fmtPct(v, dec = 1) {
  if (v === null || v === undefined) return '–';
  return (v * 100).toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' %';
}
// Signed R-multiple (realized RR, PnL-in-R, expectancy-in-R).
export function fmtR(v, dec = 2) {
  if (v === null || v === undefined) return '–';
  const s = Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (v >= 0 ? '+' : '−') + s + 'R';
}
// Unsigned ratio (planned RR — always a positive |TP-distance|/|SL-distance|).
export function fmtRatio(v, dec = 2) {
  if (v === null || v === undefined) return '–';
  return v.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + 'R';
}
export function fmtInt(v) {
  if (v === null || v === undefined) return '–';
  return String(v);
}
// Raw price (entry/sl/tp/exit) — magnitude-based decimal count, same
// convention LogPage.jsx's toRowTrade already uses (Number(t.entry) < 50 ?
// 5 : 2), so a forex price like 1.08543 and a crypto price like 65123.45
// both read sensibly.
export function fmtPrice(v, dec) {
  if (v === null || v === undefined) return '–';
  const decimals = dec ?? (Math.abs(v) < 50 ? 5 : 2);
  return v.toLocaleString('de-DE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export function fmtBerlinDateTime(dbTimestamp) {
  if (!dbTimestamp) return '–';
  const d = new Date(dbTimestamp.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '–';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

// Fixed explanations for a "–" value (why a metric can't be computed —
// never estimated).
export const REASON = {
  winRate: 'Keine Gewinn- oder Verlust-Trades vorhanden (Breakeven zählt nicht mit).',
  rr: 'Kein SL hinterlegt — ohne SL nicht berechenbar (wird nicht geschätzt).',
  expectancyR: 'Nicht berechenbar: Gewinn- oder Verlust-Seite hat keine Trades mit hinterlegtem SL.',
  lastTrade: 'Noch kein abgeschlossener Trade in diesem Zeitraum.',
  noTrades: 'Keine geschlossenen Trades in diesem Zeitraum.',
};

// Generic row comparator by field name — works for any stats row shape
// (main table rows, byAsset/byTimeframe rows), since every sortable field
// is a direct property (row.tradeCount, row.pnlTotalUsd, ...) with no
// per-field transform needed. Nulls always sort last, regardless of
// direction — a "–" value has no rank, so it should never masquerade as
// "biggest"/"smallest".
export function compareByField(a, b, key, dir) {
  const va = a[key];
  const vb = b[key];
  const aNull = va === null || va === undefined;
  const bNull = vb === null || vb === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  return dir === 'asc' ? va - vb : vb - va;
}

// Segmented-control button style, matching LogPage.jsx's segBtn() —
// duplicated there rather than imported (different page, established
// non-abstraction convention), but shared here between Auswertung.jsx and
// StrategyDetailModal since both are this same feature.
export function segBtn(active, first) {
  return {
    padding: '4px 10px', borderLeft: first ? undefined : 0, cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${active ? 'var(--acc)' : 'var(--line2)'}`,
    background: active ? 'var(--acc)' : 'transparent',
    color: active ? '#fff' : 'var(--txt2)',
  };
}
