// Shared P/L number formatting + color used by every open/closed trades
// table (ProTerminal, LogPage). Green for profit, red for loss, neutral
// text color for exactly zero or "no value at all".
export function fmtPnlNum(v, dec = 2) {
  return (v >= 0 ? '+' : '−') + Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function pnlDisplay(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { text: '–', color: 'var(--txt2)' };
  }
  if (value === 0) return { text: fmtPnlNum(value) + ' €', color: 'var(--txt)' };
  return { text: fmtPnlNum(value) + ' €', color: value > 0 ? 'var(--pos)' : 'var(--neg)' };
}
