// sc_keylevel_sweep — Session-Key-Level Sweep -> CHoCH/BOS -> Multi-Factor
// Entry Zone -> Entry/SL/TP with a minimum reward:risk filter.
//
// This is the authoritative specification (no separate design doc exists —
// this comment IS the spec, for both the future Pine alert script and the
// future backtest adapter, see the "not yet backtestable" note below):
//
// 1. Key Levels
//    Sessions (Europe/Berlin, DST-correct — NOT the same window definition
//    as lib/sessions.js's sessionOf(), which uses each market's own local
//    time (Asia/Tokyo, Europe/London, America/New_York) rather than a
//    single Berlin-clock partition; do not conflate the two):
//      Asia      01:00–09:00 Europe/Berlin
//      London    09:00–14:30 Europe/Berlin
//      New York  14:30–22:00 Europe/Berlin
//    Applies identically to every asset (BTC, ETH, SOL, EURUSD, S&P500,
//    NASDAQ) — crypto uses these as artificial sessions (no real market
//    open/close).
//    Key Levels = the High and Low of every completed session (at least the
//    last 3 sessions) plus 1h swing highs/lows (pivot with 2 candles
//    left/right, last 24h). A level is "consumed" the moment it has been
//    swept or broken through once.
//
// 2. Liquidity Sweep (5-minute candles)
//    Sweep of a high: candle high > level AND close < level -> SHORT.
//    Sweep of a low: candle low < level AND close > level -> LONG.
//    A close beyond the level is a breakout, not a sweep.
//    The sweep extreme (highest high / lowest low up to the CHoCH) is
//    remembered for the SL.
//
// 3. CHoCH/BOS (5-minute)
//    Swing pivots with 2 candles left/right.
//    SHORT: close below the last swing low before/after the sweep.
//    LONG: close above the last swing high.
//    No CHoCH within 2 hours of the sweep -> discard the setup.
//
// 4. Entry zones (from the impulse leg spanning the sweep extreme to the
//    CHoCH), each its own contributing factor:
//      - IFVG: an FVG inside the pre-sweep impulse that was broken through
//        and now acts as a counter-zone
//      - FVG in the CHoCH impulse
//      - Order Block: the last counter-candle before the impulse
//      - Breaker Block: a broken OB on the sweep side
//      - Fibonacci 50% (equilibrium) and 79% of the impulse
//    A zone is the region where at least 1 factor is present. The count of
//    factors overlapping at the entry price is "confluence_count", together
//    with a list of the contributing factor names ("confluence_factors").
//
// 5. Entry
//    Price returns into the zone, then a 5-minute candle closes inside the
//    zone in trade direction (LONG: close > open, SHORT: close < open) ->
//    entry at that close. Setup invalidated if price reaches the TP level or
//    fully passes through the zone (close beyond the zone, against trade
//    direction) before entry.
//
// 6. SL / TP
//    SL: behind the sweep extreme + a small configurable buffer (default
//    0.1 x ATR(14) on 5-minute candles).
//    TP: the next not-yet-consumed key level in trade direction.
//    Minimum RR 1:1: if (TP - entry) < (entry - SL), no trade.
//
// Parameters (configurable per asset, defaults as above): session times,
// pivot length, CHoCH timeout (120 min), SL buffer, minimum RR (1.0),
// minimum confluence (1). See `params` below — not yet read by any adapter
// (see the note below), kept here as the reference defaults for the
// Settings UI / strategy_settings.params_json.
//
// --- Why this file is purely declarative (no sweep/CHoCH/zone code here) ---
// Exactly like ict_sweep_mss.js: this strategy's entry/exit gating (sweep,
// CHoCH, zone confluence, minimum RR, invalidation) is computed entirely by
// the TradingView Pine alert script and sent as already-resolved
// boolean/number fields in the webhook payload — this file only re-checks
// those booleans for evaluate()'s matched/failed telemetry
// (signals.factor_state), never recomputes a threshold itself.
//
// The 5 entry-zone factor types (IFVG/FVG/OB/Breaker/Fibonacci) are
// deliberately NOT each their own hard AND-gate factor below — evaluateFactors
// is a hard AND over the whole factor list, so gating on all 5 simultaneously
// would contradict "confluence >= 1 is enough". Instead they're data: Pine
// computes confluence_count/confluence_factors and a single already-decided
// confluence_min_ok boolean (compared against its own configured minimum
// confluence), which is what actually gates here — same pattern
// ict_sweep_mss.js already uses for min_rr_ok/htf_bias_ok.
//
// --- Not yet backtestable ---
// No entry exists yet in worker/src/backtest/adapters.js's ADAPTERS for this
// strategy — POST /backtest/run for sc_keylevel_sweep returns the standard
// no_indicator_adapter error. This is deliberate: this strategy's entry
// logic (5-minute sweep detection, a 2-hour CHoCH timeout) is only
// meaningful on real 5-minute candles, and no 5-minute crypto candle source
// exists in this worker today (CoinGecko, the only integrated crypto OHLC
// source, tops out at 30-minute bars for 1-day windows, else 4h/4d — see
// candles.js). Building that data source is tracked separately, for every
// crypto strategy that wants intraday candles, not as part of this change.
// `requiredBacktestTimeframe` below documents what a future adapter must
// fetch for a backtest here to mean anything — see ict_sweep_mss's own
// PARTIAL_ADAPTERS caveat for the same situation on 15m.
import { evaluateFactors, isLong, isShort } from './shared.js';

export const key = 'sc_keylevel_sweep';
export const label = 'SC Key-Level Sweep';
export const assetClass = 'crypto'; // also usable on forex/index (EURUSD, SPX500, NAS100) — see schema.sql's asset_classes

export const params = {
  SESSION_ASIA: '01:00-09:00',
  SESSION_LONDON: '09:00-14:30',
  SESSION_NEWYORK: '14:30-22:00',
  SESSION_TZ: 'Europe/Berlin',
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  CHOCH_TIMEOUT_MIN: 120,
  SL_ATR_BUFFER_MULT: 0.1,
  SL_ATR_LEN: 14,
  MIN_RR: 1.0,
  MIN_CONFLUENCE: 1,
};

export const requiredBacktestTimeframe = '5m';

// No trailingStop/"(SL)" variant — the specification above describes a
// single fixed SL/TP scheme (sweep-extreme-based SL, next-key-level TP),
// not a trailing-management scheme, so only the base key is registered
// (see strategies/index.js) — unlike ict_sweep_mss, which has an explicit
// separate breakeven+trail design for its "_sl" twin.
export const exit = { mode: 'levels' }; // structural SL/TP straight off the signal, same as ict_sweep_mss — see index.js's manual registration and routes/webhook.js's computeBracket()

const factors = [
  { name: 'liquidity_sweep', check: (s) => !!s.liquidity_sweep },
  { name: 'choch_confirmed', check: (s) => !!s.choch_confirmed },
  { name: 'entry_close_in_zone', check: (s) => !!s.entry_close_in_zone },
  { name: 'confluence_min_ok', check: (s) => !!s.confluence_min_ok },
  { name: 'min_rr_ok', check: (s) => !!s.min_rr_ok },
  { name: 'not_invalidated', check: (s) => !!s.not_invalidated },
  { name: 'direction_present', check: (s) => isLong(s) || isShort(s) },
];

export function evaluate(signal) {
  return evaluateFactors(signal, factors);
}
