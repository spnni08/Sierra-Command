// Per-run trading-session breakdown for a backtest — persisted into
// backtest_session_breakdown and surfaced by the Pro-Terminal's
// "Session-Auswertung" panel. Session classification itself lives centrally
// in lib/sessions.js's sessionOf() (real local-market-time windows,
// DST-aware, mutually exclusive) — this file only builds the per-run tally
// on top of it, so a trade counted here is classified exactly the same way
// as everywhere else in the app (the strategy-detail modal's "Nach
// Session" tab, the session_filter validator).
//
// Unlike the older fixed-UTC-hour version of this file, each trade lands
// in EXACTLY ONE bucket — so the buckets sum directly to the run's total
// trade count, with no inclusion-exclusion correction needed for Overlap.
import { sessionOf, SESSION_KEYS, SESSION_LABELS } from '../lib/sessions.js';

/**
 * Builds a per-session breakdown ({ trades, wins, winRate, netPnl } per
 * session key) from a list of closed simulated trades, each carrying an
 * `openedAt` timestamp (ms/Date/naive-UTC string — see lib/sessions.js) and
 * a `pnl` (number). Every session key always appears, even at zero trades,
 * so callers can always render all 6 rows.
 */
export function computeSessionBreakdown(trades) {
  const breakdown = {};
  for (const key of SESSION_KEYS) {
    breakdown[key] = { session: key, label: SESSION_LABELS[key], trades: 0, wins: 0, winRate: null, netPnl: 0 };
  }

  for (const trade of trades) {
    const { key } = sessionOf(trade.openedAt);
    const bucket = breakdown[key];
    bucket.trades += 1;
    if (trade.pnl > 0) bucket.wins += 1;
    bucket.netPnl += trade.pnl;
  }

  for (const key of SESSION_KEYS) {
    const bucket = breakdown[key];
    bucket.winRate = bucket.trades > 0 ? bucket.wins / bucket.trades : null;
  }

  return breakdown;
}

export { SESSION_KEYS };
