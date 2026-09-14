// Trading-session classification for backtest trades.
//
// Fixed UTC windows (deliberately simple, no DST handling — matches how the
// rest of this backtest engine already treats all timestamps as UTC, see
// candles.js / window.js):
//   Asia              00:00–08:00 UTC
//   London            08:00–16:00 UTC
//   New York          13:00–21:00 UTC
//   London/NY Overlap 13:00–16:00 UTC
//
// IMPORTANT counting rule: Overlap is NOT a fourth mutually-exclusive
// bucket alongside Asia/London/New York. A trade opened at, say, 14:00 UTC
// falls inside both the London window (08:00–16:00) and the New York
// window (13:00–21:00) — it is tagged with ALL matching sessions:
// ['london', 'new_york', 'overlap']. Overlap is an informational subset
// already counted inside both London and New York, not a fourth partition.
//
// Consequence for anyone summing trade counts across sessions:
//   asia.trades + london.trades + new_york.trades === total trade count
//   (Asia/London/NY windows tile the 24h day with no gaps and no overlap
//   with each other: Asia ends where London begins, London ends where NY
//   ends; the only overlap is London∩NY, both of which individually already
//   span the 13:00–16:00 block).
//   overlap.trades is NOT additive — it is already included in both
//   london.trades and new_york.trades, so adding it to the three-way sum
//   would double count those trades. Use overlap.trades only to answer
//   "how many trades happened specifically during the London/NY overlap
//   window", never as a fourth term in a total.
export const SESSION_WINDOWS = {
  asia: { label: 'Asia', startHourUtc: 0, endHourUtc: 8 },
  london: { label: 'London', startHourUtc: 8, endHourUtc: 16 },
  new_york: { label: 'New York', startHourUtc: 13, endHourUtc: 21 },
  overlap: { label: 'London/NY Overlap', startHourUtc: 13, endHourUtc: 16 },
};

// Order matters only for readability of returned arrays — not for
// correctness of the sum documented above.
const SESSION_KEYS = ['asia', 'london', 'new_york', 'overlap'];

/**
 * Returns which session(s) a given timestamp (ms since epoch, or a Date)
 * belongs to, as an array of session keys (subset of SESSION_KEYS). A
 * timestamp in the 13:00–16:00 UTC window returns ['london', 'new_york',
 * 'overlap'] — see the module header for why that's correct, not a bug.
 */
export function sessionsForTimestamp(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const hour = date.getUTCHours();

  const matches = [];
  for (const key of SESSION_KEYS) {
    const { startHourUtc, endHourUtc } = SESSION_WINDOWS[key];
    // Half-open [start, end) so the boundary hour belongs to the session
    // that starts there, not the one that just ended.
    if (hour >= startHourUtc && hour < endHourUtc) matches.push(key);
  }
  return matches;
}

/**
 * Builds a per-session breakdown ({ trades, wins, winRate, netPnl } per
 * session key) from a list of closed simulated trades, each carrying an
 * `openedAt` timestamp (ms) and a `pnl` (number). Sessions with zero trades
 * still appear with trades: 0 / winRate: null / netPnl: 0, so callers can
 * always render all 4 rows.
 */
export function computeSessionBreakdown(trades) {
  const breakdown = {};
  for (const key of SESSION_KEYS) {
    breakdown[key] = { session: key, label: SESSION_WINDOWS[key].label, trades: 0, wins: 0, winRate: null, netPnl: 0 };
  }

  for (const trade of trades) {
    const sessions = sessionsForTimestamp(trade.openedAt);
    for (const key of sessions) {
      const bucket = breakdown[key];
      bucket.trades += 1;
      if (trade.pnl > 0) bucket.wins += 1;
      bucket.netPnl += trade.pnl;
    }
  }

  for (const key of SESSION_KEYS) {
    const bucket = breakdown[key];
    bucket.winRate = bucket.trades > 0 ? bucket.wins / bucket.trades : null;
  }

  return breakdown;
}

export { SESSION_KEYS };
