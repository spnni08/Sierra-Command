import { describe, it, expect } from 'vitest';
import { buildIctSweepMss, DEFAULT_PARAMS } from '../src/backtest/ictSweepMssAdapter.js';
import { ADAPTERS, ADAPTER_WARMUP_BARS, PARTIAL_ADAPTERS } from '../src/backtest/adapters.js';
import { REAL_OHLC_STRATEGY_IDS, INTRADAY_FOREX_STRATEGY_IDS } from '../src/backtest/candles.js';

function c(open, high, low, close, ts) {
  return { open, high, low, close, volume: 1000, timestamp: ts };
}

// Monotonic-step filler bars: a strictly monotonic run never creates an
// interior swing pivot (a pivot needs a local extreme with strictly worse
// neighbors on both sides — impossible mid-run), so stitching several of
// these together builds a fully predictable swing structure with pivots
// forming ONLY at the explicit turning points between runs.
function fillerFrom(startClose, endClose, steps, tsStart, tsStep) {
  const out = [];
  const stepSize = (endClose - startClose) / steps;
  let prevClose = startClose;
  for (let i = 1; i <= steps; i++) {
    const close = startClose + stepSize * i;
    out.push(c(prevClose, Math.max(prevClose, close) + 0.4, Math.min(prevClose, close) - 0.4, close, tsStart + out.length * tsStep));
    prevClose = close;
  }
  return out;
}

// Builds a full long-side setup: a tall, isolated, never-touched peak (P1,
// the eventual TP target) -> descend to a base -> ascend to a moderate swing
// high (the MSS breakout level) -> descend into a swept swing low -> a
// hand-placed sweep/displacement/FVG/MSS/fill sequence.
//   idx 0-9   ramp up to P1 (close=150)
//   idx 10-23 descend from P1 to ~95 (confirms P1 as a swing high)
//   idx 24-31 ascend ~93 -> 115 (confirms the base-of-descent as a swing low, SSL)
//   idx 32-41 descend 113 -> 92 (confirms 115ish as a swing high, the MSS level)
//   idx 42    sweep: wicks below the SSL, reclaims same-bar
//   idx 43    displacement: large bullish body, still below the MSS level
//   idx 44    continuation bar
//   idx 45    FVG confirming bar (gap vs idx43) whose close breaks the MSS level
//   idx 46    pulls back into the FVG/entry zone -> fill
function buildLongFixture() {
  let ts = 1_700_000_000_000;
  const tsStep = 15 * 60_000;
  const candles = [];
  candles.push(...fillerFrom(100, 150, 10, ts, tsStep));
  ts = candles[candles.length - 1].timestamp + tsStep;
  candles.push(...fillerFrom(148, 95, 14, ts, tsStep));
  ts = candles[candles.length - 1].timestamp + tsStep;
  candles.push(...fillerFrom(93, 115, 8, ts, tsStep));
  ts = candles[candles.length - 1].timestamp + tsStep;
  candles.push(...fillerFrom(113, 92, 10, ts, tsStep));
  ts = candles[candles.length - 1].timestamp + tsStep;

  let prevClose = candles[candles.length - 1].close;
  function push(open, high, low, close) {
    candles.push(c(open, high, low, close, ts));
    ts += tsStep;
    prevClose = close;
  }
  push(prevClose, 93.2, 90.0, 93.0); // idx42 sweep
  push(prevClose, 108.3, 92.8, 108.0); // idx43 displacement
  push(prevClose, 110.0, 107.5, 109.5); // idx44 continuation
  push(prevClose, 118.0, 112.5, 117.5); // idx45 FVG + MSS
  push(prevClose, 118.0, 109.5, 112.0); // idx46 fill

  for (let k = 0; k < 10; k++) push(prevClose, prevClose + 1, prevClose - 1, prevClose + 0.2);
  return candles;
}

// Mirrors a full candle series around a fixed price (open/close negated,
// high/low swapped) so a validated long fixture becomes an equally valid
// short one — exercises the exact same code paths with direction flipped.
function mirror(candles, aroundPrice = 200) {
  return candles.map((cand) => ({
    ...cand,
    open: aroundPrice - cand.open,
    close: aroundPrice - cand.close,
    high: aroundPrice - cand.low,
    low: aroundPrice - cand.high,
  }));
}

describe('ict_sweep_mss adapter — full setup sequence', () => {
  it('fires a long signal on the bar price retraces into the FVG, with structure-derived entry/SL/TP', () => {
    const candles = buildLongFixture();
    const { signalAt } = buildIctSweepMss(candles);

    let fired = null;
    for (let i = 0; i < candles.length; i++) {
      const sig = signalAt(i, 'long');
      if (sig) {
        expect(fired).toBeNull(); // exactly one long signal in this fixture
        fired = { i, sig };
      }
    }

    expect(fired).not.toBeNull();
    expect(fired.i).toBe(46);
    const { sig } = fired;
    // Entry sits inside the FVG (bottom 108.3..top 112.5), at the 50% CE default.
    expect(sig.entryPrice).toBeCloseTo(110.4, 5);
    // SL sits below the swept swing low (92.60 — the natural descent itself
    // wicks under it a bar before the hand-placed idx42 "sweep" bar, so the
    // ATR buffer is applied to that earlier, slightly higher wick low, not
    // idx42's low(90) — still a valid same/next-bar-reclaim sweep per rule 2).
    // TP is the untouched isolated peak (150.4).
    expect(sig.slPrice).toBeLessThan(92.6);
    expect(sig.tpPrice).toBeCloseTo(150.4, 5);
    expect(sig.r_multiple).toBeGreaterThanOrEqual(DEFAULT_PARAMS.minRR);
    expect(signalAt(46, 'short')).toBeNull(); // no opposite-direction signal on the same bar
  });

  it('mirrors correctly for the short side (long fixture reflected around a fixed price)', () => {
    const candles = mirror(buildLongFixture());
    const { signalAt } = buildIctSweepMss(candles);

    let fired = null;
    for (let i = 0; i < candles.length; i++) {
      const sig = signalAt(i, 'short');
      if (sig) fired = { i, sig };
    }

    expect(fired).not.toBeNull();
    expect(fired.i).toBe(46);
    expect(fired.sig.entryPrice).toBeCloseTo(200 - 110.4, 5);
    expect(fired.sig.slPrice).toBeGreaterThan(200 - 92.6);
    expect(fired.sig.tpPrice).toBeCloseTo(200 - 150.4, 5);
    expect(fired.sig.r_multiple).toBeGreaterThanOrEqual(DEFAULT_PARAMS.minRR);
  });

  it('invalidates the setup if the sweep low is undercut before the FVG ever fills (rule 9)', () => {
    const candles = buildLongFixture().slice(0, 46); // through the MSS bar (idx45), drop the fill bar
    const lastClose = candles[candles.length - 1].close;
    let ts = candles[candles.length - 1].timestamp + 15 * 60_000;
    candles.push(c(lastClose, 118, 85, 86, ts)); // undercuts the sweep low (90) before ever touching the entry level
    ts += 15 * 60_000;
    for (let k = 0; k < 20; k++) {
      candles.push(c(86 + k * 0.1, 87 + k * 0.1, 85 + k * 0.1, 86.1 + k * 0.1, ts));
      ts += 15 * 60_000;
    }

    const { signalAt } = buildIctSweepMss(candles);
    for (let i = 0; i < candles.length; i++) {
      expect(signalAt(i, 'long')).toBeNull();
    }
  });

  it('never fires with no liquidity sweep at all (flat/trendless series)', () => {
    let ts = 1_700_000_000_000;
    const candles = Array.from({ length: 80 }, (_, i) => c(100, 100.5, 99.5, 100, ts + i * 15 * 60_000));
    const { signalAt } = buildIctSweepMss(candles);
    for (let i = 0; i < candles.length; i++) {
      expect(signalAt(i, 'long')).toBeNull();
      expect(signalAt(i, 'short')).toBeNull();
    }
  });

  it('trailAnchorAt returns the most recently confirmed swing low/high as of a given bar', () => {
    const candles = buildLongFixture();
    const { trailAnchorAt } = buildIctSweepMss(candles);
    // The sweep bar's own low (idx42, price 90) forms a fresh swing low in
    // its own right (confirmed 3 bars later at idx45) — newer and tighter
    // than the original SSL at ~92.60, so it's what trailAnchorAt returns
    // by bar 46. Either way it must be a real, positive, finite anchor.
    const anchor = trailAnchorAt(46, 'long');
    expect(anchor).not.toBeNull();
    expect(anchor).toBeCloseTo(90, 1);
  });

  it('respects a configurable minRR override (a stricter minRR discards the same setup)', () => {
    const candles = buildLongFixture();
    const { signalAt } = buildIctSweepMss(candles, { minRR: 100 }); // impossibly strict
    for (let i = 0; i < candles.length; i++) {
      expect(signalAt(i, 'long')).toBeNull();
    }
  });
});

describe('ict_sweep_mss registered in the backtest engine', () => {
  it('is registered in ADAPTERS for both the base and _sl variant', () => {
    expect(typeof ADAPTERS.ict_sweep_mss).toBe('function');
    expect(ADAPTERS.ict_sweep_mss_sl).toBe(ADAPTERS.ict_sweep_mss);
  });

  it('has a warmup override and a documented partial-adapter caveat', () => {
    expect(ADAPTER_WARMUP_BARS.ict_sweep_mss).toBeGreaterThan(0);
    expect(ADAPTER_WARMUP_BARS.ict_sweep_mss_sl).toBeGreaterThan(0);
    expect(typeof PARTIAL_ADAPTERS.ict_sweep_mss).toBe('string');
    expect(typeof PARTIAL_ADAPTERS.ict_sweep_mss_sl).toBe('string');
  });

  it('is registered as a real-OHLC crypto strategy and an intraday forex/index strategy', () => {
    expect(REAL_OHLC_STRATEGY_IDS.has('ict_sweep_mss')).toBe(true);
    expect(REAL_OHLC_STRATEGY_IDS.has('ict_sweep_mss_sl')).toBe(true);
    expect(INTRADAY_FOREX_STRATEGY_IDS.has('ict_sweep_mss')).toBe(true);
    expect(INTRADAY_FOREX_STRATEGY_IDS.has('ict_sweep_mss_sl')).toBe(true);
  });
});
