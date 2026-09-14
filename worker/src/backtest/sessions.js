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
// Asia and London tile the day with no gap and no overlap (Asia ends
// exactly where London begins, 08:00), but London and New York DO overlap
// each other directly (both individually already span 13:00–16:00) — that
// is the whole point of Overlap existing as a category. So a naive
// three-way sum double-counts every trade opened in 13:00–16:00 UTC:
//
//   asia.trades + london.trades + new_york.trades
//     === total trade count + overlap.trades
//
// Equivalently, to recover the true total trade count from the four
// buckets, SUBTRACT overlap once (it was counted in both london and
// new_york, so subtracting it once turns that double-count back into a
// single count — this is just inclusion-exclusion over the two-window
// union London ∪ New York):
//
//   total trade count === asia.trades + london.trades + new_york.trades - overlap.trades
//
// overlap.trades itself is never a term to just add on top of the other
// three — it exists to answer "how many trades happened specifically
// during the London/NY overlap window", and to let the formula above
// reconcile the double-count, not as a free-standing fourth quantity.
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
