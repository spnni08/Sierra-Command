import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ADAPTERS,
  ADAPTER_WARMUP_BARS,
  PARTIAL_ADAPTERS,
  ADAPTER_CONSTRAINTS,
  checkAdapterConstraint,
  getAdapterStatus,
} from '../src/backtest/adapters.js';
import { REAL_OHLC_STRATEGY_IDS, cryptoOhlcTimeframeForRange } from '../src/backtest/candles.js';
import { runBacktest } from '../src/backtest/engine.js';
import { getStrategy } from '../src/strategies/index.js';
import { hashAdapterSource, generateInvalidationSql } from '../scripts/lib/logic-invalidation-sql.mjs';

// Hand-built candle sequences. The rules under test are those of
// tradingview-bot/pinescript/strategies/crypto_ict_smc.pine (see
// src/backtest/ictSmcAdapter.js for the full list).
function c(o, h, l, close) {
  return { open: o, high: h, low: l, close, volume: 1000 };
}
// Piecewise-linear close path, 1 price unit per bar, between anchor prices.
function path(start, anchors) {
  const out = [start];
  let p = start;
  for (const a of anchors) {
    while (p !== a) {
      p += a > p ? 1 : -1;
      out.push(p);
    }
  }
  return out;
}
// open == close (no candle colour -> no order blocks), range 1 around the path
// price, so every turning point is a strict 5/5 fractal swing.
const fromPath = (pts) => pts.map((p) => c(p, p + 0.5, p - 0.5, p));
const flatWarmup = (n = 20) => Array.from({ length: n }, () => c(100, 100.5, 99.5, 100));
const flatPath = (n = 16) => Array(n).fill(100);

function breakEvents(candles) {
  const signalAt = ADAPTERS.crypto_ict_smc(candles);
  const events = [];
  for (let i = 0; i < candles.length; i++) {
    const l = signalAt(i, 'long');
    const s = signalAt(i, 'short');
    if (l?.bos_kind) events.push({ i, dir: 'bullish', kind: l.bos_kind });
    if (s?.bos_kind) events.push({ i, dir: 'bearish', kind: s.bos_kind });
  }
  return events;
}

function firedIndices(candles, direction = 'long') {
  const signalAt = ADAPTERS.crypto_ict_smc(candles);
  const strategy = getStrategy('crypto_ict_smc');
  const fired = [];
  for (let i = 0; i < candles.length; i++) {
    const sig = signalAt(i, direction);
    if (sig && strategy.evaluate(sig).legacyPassed) fired.push(i);
  }
  return fired;
}

describe('crypto_ict_smc adapter — BOS / CHoCH', () => {
  it('uptrend (HH + HL): breaks of the last swing high are continuation BOS, a later break of a swing low is a bearish CHoCH', () => {
    // 100 -> 94 (swing low) -> 106 (swing high) -> 98 (HL) -> 110 (HH) -> 102 -> 114 -> 90
    const candles = fromPath([...flatPath(), ...path(100, [94, 106, 98, 110, 102, 114, 90]).slice(1)]);
    const events = breakEvents(candles);

    // Close 107 first exceeds swing high 106.5 (only one swing high known, trend unknown -> BOS).
    expect(events[0]).toEqual({ i: 50, dir: 'bullish', kind: 'BOS' });
    expect(candles[50].close).toBe(107);
    // Close 111 exceeds swing high 110.5 while trend is "up" (HH+HL) -> continuation BOS.
    expect(events[1]).toEqual({ i: 70, dir: 'bullish', kind: 'BOS' });
    // Close 101 < swing low 101.5 against an "up" trend -> CHoCH.
    expect(events[2]).toEqual({ i: 86, dir: 'bearish', kind: 'CHoCH' });
    expect(events).toHaveLength(3);
  });

  it('downtrend (LH + LL): the first break back above the last swing high is a bullish CHoCH', () => {
    // 100 -> 108 (swing high) -> 96 (swing low) -> 100 (LH) -> 90 (LL) -> 104
    const candles = fromPath([...flatPath(), ...path(100, [108, 102, 96, 100, 90, 104]).slice(1)]);
    const events = breakEvents(candles);

    expect(events[0]).toEqual({ i: 44, dir: 'bearish', kind: 'BOS' });
    expect(events[1]).toEqual({ i: 60, dir: 'bullish', kind: 'CHoCH' });
    expect(candles[60].close).toBe(101); // > lower-high 100.5
  });

  it('breaks on a wick without a close beyond the level do not count', () => {
    // Climb back to 105, still below the 106.5 swing high (confirmed long before).
    const base = fromPath([...flatPath(), ...path(100, [94, 106, 98, 105]).slice(1)]);
    expect(breakEvents(base).filter((e) => e.dir === 'bullish')).toHaveLength(0);
    // Last bar: wick far above the swing high but the close stays below it -> no break.
    const withWick = [...base.slice(0, -1), c(105, 112, 104, 105.5)];
    expect(breakEvents(withWick).filter((e) => e.dir === 'bullish')).toHaveLength(0);
    // Same bar closing above the level is a break (control).
    const withClose = [...base.slice(0, -1), c(105, 112, 104, 111)];
    expect(breakEvents(withClose).filter((e) => e.dir === 'bullish')).toHaveLength(1);
  });

  it('a swing level is only broken once', () => {
    const candles = fromPath([...flatPath(), ...path(100, [94, 106, 98, 112, 108, 113]).slice(1)]);
    const bullish = breakEvents(candles).filter((e) => e.dir === 'bullish');
    // 112/113 are beyond swing high 106.5 on several bars, but only the first fires for that level.
    expect(bullish.filter((e) => e.i < 60)).toHaveLength(1);
  });

  it('uses no swing before it is confirmed by 5 right-hand bars (no look-ahead)', () => {
    const candles = fromPath([...flatPath(), ...path(100, [94, 106, 98]).slice(1)]);
    // Truncating after the swing-high peak (idx 33) but before its 5th right bar must give no break signal
    // yet, and the same prefix must produce identical signals as the full series (causality).
    const full = ADAPTERS.crypto_ict_smc(candles);
    const prefix = ADAPTERS.crypto_ict_smc(candles.slice(0, 36));
    for (let i = 0; i < 36; i++) {
      expect(prefix(i, 'long')).toEqual(full(i, 'long'));
      expect(prefix(i, 'short')).toEqual(full(i, 'short'));
    }
  });
});

describe('crypto_ict_smc adapter — fair value gap', () => {
  const fvgSeq = () => [
    ...flatWarmup(),
    c(100, 100.5, 99.5, 100), // 20: candle1, high 100.5
    c(100.5, 103, 100.4, 102.8), // 21: impulse
    c(102.8, 104, 102, 103.5), // 22: candle3, low 102 > 100.5 -> bullish FVG [100.5, 102]
    c(103.5, 104, 103, 103.8), // 23: stays above the gap, no retest
    c(103.8, 104, 101.5, 102.5), // 24: low 101.5 <= 102 -> retest into the gap
    c(102.5, 103, 101.8, 102.6), // 25: gap was mitigated on 24
  ];

  it('detects a bullish 3-candle FVG and its retest, then treats it as mitigated', () => {
    const f = ADAPTERS.crypto_ict_smc(fvgSeq());
    expect(f(21, 'long').fvg_hit).toBe(false); // gap not complete yet
    expect(f(22, 'long').fvg_hit).toBe(true); // forms (Pine counts the forming bar as touching)
    expect(f(22, 'long').htf_zone_touch).toBe(true);
    expect(f(23, 'long').fvg_hit).toBe(false); // price above the gap, no retest
    expect(f(24, 'long').fvg_hit).toBe(true); // retest
    expect(f(25, 'long').fvg_hit).toBe(false); // mitigated, no longer a zone
    expect(f(22, 'short').fvg_hit).toBe(false);
  });

  it('detects a bearish 3-candle FVG and its retest', () => {
    const candles = [
      ...flatWarmup(),
      c(100, 100.5, 99.5, 100), // 20: candle1, low 99.5
      c(99.5, 99.6, 97, 97.2), // 21: impulse down
      c(97.2, 98, 96, 96.5), // 22: candle3, high 98 < 99.5 -> bearish FVG [98, 99.5]
      c(96.5, 97, 96, 96.2), // 23: below the gap
      c(96.2, 98.5, 96, 97), // 24: high 98.5 >= 98 -> retest
    ];
    const f = ADAPTERS.crypto_ict_smc(candles);
    expect(f(22, 'short').fvg_hit).toBe(true);
    expect(f(23, 'short').fvg_hit).toBe(false);
    expect(f(24, 'short').fvg_hit).toBe(true);
    expect(f(22, 'long').fvg_hit).toBe(false);
  });

  it('ignores a gap smaller than 0.3 x ATR(14)', () => {
    const candles = [
      ...flatWarmup(),
      c(100, 100.5, 99.5, 100),
      c(100.2, 101, 100, 100.8),
      c(100.8, 101.2, 100.55, 101), // low 100.55 > 100.5 by only 0.05 (< 0.3 x ~1.0)
    ];
    const f = ADAPTERS.crypto_ict_smc(candles);
    expect(f(22, 'long').fvg_hit).toBe(false);
  });

  it('returns null while ATR(14) is not yet defined', () => {
    const candles = Array.from({ length: 5 }, (_, i) => c(100, 101, 99, 100 + i));
    expect(ADAPTERS.crypto_ict_smc(candles)(2, 'long')).toBeNull();
  });
});

describe('crypto_ict_smc adapter — BOS -> zone retest entry', () => {
  const brkPath = [...flatPath(), ...path(100, [94, 106, 98, 110, 102, 111]).slice(1)];
  const base = fromPath(brkPath);
  const breakIdx = base.length - 1; // close 111 > swing high 110.5 -> BOS, setup armed
  const drift = (n) => Array.from({ length: n }, () => c(111.2, 111.7, 110.7, 111.2));
  // bearish candle (the order block), then a bullish impulse that trades back into it.
  const orderBlockStep = [c(111.4, 111.5, 110.6, 110.8), c(110.8, 118, 110.7, 117.5)];

  it('fires when an order block is hit inside the 20-bar window after the BOS', () => {
    const candles = [...base, ...drift(3), ...orderBlockStep];
    expect(breakEvents(candles).some((e) => e.i === breakIdx && e.dir === 'bullish' && e.kind === 'BOS')).toBe(true);
    expect(firedIndices(candles)).toEqual([candles.length - 1]);
    const sig = ADAPTERS.crypto_ict_smc(candles)(candles.length - 1, 'long');
    expect(sig).toMatchObject({ confirmations_count: 2, min_confirmations: 2, order_block_hit: true, retest_armed: true, htf_zone_touch: true });
  });

  it('does not fire once the retest window (20 bars) has expired', () => {
    const candles = [...base, ...drift(25), ...orderBlockStep];
    expect(firedIndices(candles)).toEqual([]);
    expect(ADAPTERS.crypto_ict_smc(candles)(candles.length - 1, 'long').retest_armed).toBe(false);
  });

  it('does not fire on an FVG retest alone: without the SMT leg the second confirmation must be an order-block hit', () => {
    const candles = [
      ...base,
      ...drift(3),
      c(111.2, 115, 111.1, 114.8), // impulse, previous candle is a doji -> no order block
      c(114.8, 116, 113, 115.5), // low 113 > 111.7 -> bullish FVG [111.7, 113]
      c(115.5, 115.8, 111.5, 112), // retest: low 111.5 <= 113
    ];
    const sig = ADAPTERS.crypto_ict_smc(candles)(candles.length - 1, 'long');
    expect(sig.fvg_hit).toBe(true);
    expect(sig.htf_zone_touch).toBe(true);
    expect(sig.retest_armed).toBe(true);
    expect(sig.confirmations_count).toBe(1);
    expect(firedIndices(candles)).toEqual([]);
  });

  it('consumes the setup when it fires: the same armed break cannot fire twice', () => {
    const second = [c(111.4, 118.1, 110.6, 110.8), c(110.8, 125, 110.7, 124)]; // another OB + impulse right after
    const candles = [...base, ...drift(3), ...orderBlockStep, ...drift(1), ...second];
    expect(firedIndices(candles)).toHaveLength(1);
  });

  it('mirrors for shorts: bearish CHoCH/BOS followed by a supply order block', () => {
    const down = fromPath([...flatPath(), ...path(100, [108, 102, 96, 100, 90, 89]).slice(1)]);
    const drift2 = Array.from({ length: 3 }, () => c(89.8, 90.3, 89.3, 89.8));
    const step = [c(89.6, 90.4, 89.5, 90.2), c(90.2, 90.3, 82, 82.5)]; // bullish candle, then bearish impulse
    const candles = [...down, ...drift2, ...step];
    expect(firedIndices(candles, 'short')).toEqual([candles.length - 1]);
    expect(firedIndices(candles, 'long')).toEqual([]);
  });
});

describe('crypto_ict_smc adapter — registration, status and content hash', () => {
  it('registers fixed and trailing-SL variants everywhere the engine reads them', () => {
    for (const id of ['crypto_ict_smc', 'crypto_ict_smc_sl']) {
      expect(typeof ADAPTERS[id]).toBe('function');
      expect(ADAPTER_WARMUP_BARS[id]).toBeGreaterThan(0);
      expect(typeof PARTIAL_ADAPTERS[id]).toBe('string');
      expect(REAL_OHLC_STRATEGY_IDS.has(id)).toBe(true);
      expect(ADAPTER_CONSTRAINTS[id]).toBeTruthy();
    }
  });

  it('is never reported as a full adapter; the _sl variant discloses the non-faithful trailing exit', () => {
    expect(getAdapterStatus('crypto_ict_smc')).toBe('partial');
    expect(getAdapterStatus('crypto_ict_smc_sl')).toBe('partial');
    expect(PARTIAL_ADAPTERS.crypto_ict_smc).toMatch(/SMT/);
    expect(PARTIAL_ADAPTERS.crypto_ict_smc).toMatch(/15m/);
    expect(PARTIAL_ADAPTERS.crypto_ict_smc_sl).toMatch(/TRAILING SL NOT FAITHFUL/);
    expect(PARTIAL_ADAPTERS.crypto_ict_smc).not.toMatch(/TRAILING SL NOT FAITHFUL/);
  });

  it('the trailing-SL exit really is the generic ATR trail (documents the known gap the status relies on)', () => {
    const exit = getStrategy('crypto_ict_smc_sl').exit;
    expect(exit.mode).toBe('trailing');
    expect(exit.trailing.anchor).toBe('swing_point'); // declared...
    // ...but engine.js's 'trailing' branch has no anchor lookup — only levels_trailing reads trailAnchorAt.
  });

  it('the content hash covers the whole rule set, so a rule change invalidates stored runs', () => {
    const src = ADAPTERS.crypto_ict_smc.toString();
    for (const needle of ['retestWindowBars', 'fvgMinGapAtrMult', 'obImpulseMinAtrMult', 'swingLeft', 'brokenHigh']) {
      expect(src).toContain(needle);
    }
    expect(hashAdapterSource(ADAPTERS.crypto_ict_smc)).toBe(hashAdapterSource(ADAPTERS.crypto_ict_smc_sl));
    expect(hashAdapterSource(ADAPTERS.crypto_ict_smc)).not.toBe(hashAdapterSource(ADAPTERS.ict_sweep_mss));
    const sql = generateInvalidationSql({ crypto_ict_smc: ADAPTERS.crypto_ict_smc, crypto_ict_smc_sl: ADAPTERS.crypto_ict_smc_sl });
    expect(sql).toContain("WHERE strategy_id = 'crypto_ict_smc'");
    expect(sql).toContain("WHERE strategy_id = 'crypto_ict_smc_sl'");
    expect(sql).toContain(hashAdapterSource(ADAPTERS.crypto_ict_smc));
  });
});

describe('crypto_ict_smc — resolution / asset locks', () => {
  afterEach(() => vi.unstubAllGlobals());

  const DAY = 86_400_000;
  it('predicts the CoinGecko /ohlc interval from the fetch range (verified against the live API: days=30 -> 4h, days=90 -> 4d)', () => {
    const end = new Date('2026-10-15T00:00:00Z');
    const start = (days) => new Date(end.getTime() - days * DAY);
    expect(cryptoOhlcTimeframeForRange(start(1), end)).toBe('30m');
    expect(cryptoOhlcTimeframeForRange(start(7), end)).toBe('4h');
    expect(cryptoOhlcTimeframeForRange(start(30), end)).toBe('4h');
    expect(cryptoOhlcTimeframeForRange(start(31), end)).toBe('4d');
    expect(cryptoOhlcTimeframeForRange(start(365), end)).toBe('4d');
  });

  it('allows 30m/4h on crypto and refuses 4d bars and non-crypto symbols', () => {
    expect(checkAdapterConstraint('crypto_ict_smc', 'crypto', '4h')).toBeNull();
    expect(checkAdapterConstraint('crypto_ict_smc', 'crypto', '30m')).toBeNull();
    expect(checkAdapterConstraint('crypto_ict_smc_sl', 'crypto', '4d')).toMatchObject({ error: 'resolution_too_coarse' });
    expect(checkAdapterConstraint('crypto_ict_smc', 'forex_index', null)).toMatchObject({ error: 'unsupported_asset_class' });
    expect(checkAdapterConstraint('crypto_baseline', 'forex_index', '1d')).toBeNull(); // unconstrained strategies untouched
  });

  it('engine refuses a >30-day window before any candle fetch (no data is interpolated or faked)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch must not be called');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const start = new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10);
    const res = await runBacktest({ strategyId: 'crypto_ict_smc', symbol: 'BTCUSDT', start }, {});
    expect(res.error).toBe('resolution_too_coarse');
    expect(res.timeframe).toBe('4d');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('engine refuses forex/index symbols for ICT/SMC', async () => {
    const res = await runBacktest({ strategyId: 'crypto_ict_smc_sl', symbol: 'EURUSD' }, {});
    expect(res.error).toBe('unsupported_asset_class');
  });

  it('engine lets a <=30-day window through to the candle fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('stop after gate'))));
    const start = new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10);
    const res = await runBacktest({ strategyId: 'crypto_ict_smc', symbol: 'BTCUSDT', start }, {});
    expect(res.error).toBe('candle_fetch_failed');
  });
});
