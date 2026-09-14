import { describe, it, expect } from 'vitest';
import { ADAPTERS, ADAPTER_WARMUP_BARS, PARTIAL_ADAPTERS } from '../src/backtest/adapters.js';
import { REAL_OHLC_STRATEGY_IDS } from '../src/backtest/candles.js';

// Synthetic OHLC fixtures engineered to trigger each ICT/SMC concept,
// mirroring the scenarios covered by tradingview-bot/backtest/ict_smc's own
// test suite (bullish/bearish FVG, order block detection, BOS vs CHoCH).
function c(o, h, l, close, volume = 1000) {
  return { open: o, high: h, low: l, close, volume };
}

describe('crypto_ict_smc adapter — fair value gap', () => {
  it('detects a bullish 3-candle FVG (candle1 high < candle3 low)', () => {
    // Build a run of small alternating candles first so ATR(14) has a
    // finite, small value, then a clean 3-candle gap-up.
    const candles = [];
    for (let i = 0; i < 20; i++) {
      const w = i % 2 === 0 ? 0.2 : -0.2;
      candles.push(c(100 + w, 100.5 + w, 99.5 + w, 100 + w));
    }
    // candle1 (idx 20): high=100.5. candle2 (idx 21): impulsive up move.
    // candle3 (idx 22): low=110 > candle1's high=100.5 -> bullish FVG.
    candles.push(c(100, 100.5, 99.5, 100.3)); // idx 20
    candles.push(c(100.5, 111, 100, 110.5)); // idx 21
    candles.push(c(110.5, 112, 110, 111)); // idx 22

    const signalAt = ADAPTERS.crypto_ict_smc(candles);
    const sig = signalAt(22, 'long');
    expect(sig).not.toBeNull();
    expect(sig.fvg_hit).toBe(true);
  });

  it('detects a bearish 3-candle FVG (candle1 low > candle3 high)', () => {
    const candles = [];
    for (let i = 0; i < 20; i++) {
      const w = i % 2 === 0 ? 0.2 : -0.2;
      candles.push(c(100 + w, 100.5 + w, 99.5 + w, 100 + w));
    }
    candles.push(c(100, 100.5, 99.5, 99.7)); // idx 20: low=99.5
    candles.push(c(99.5, 100, 89, 90)); // idx 21: impulsive down move
    candles.push(c(90, 90.5, 88, 89)); // idx 22: high=90.5 < candle1 low 99.5 -> bearish FVG

    const signalAt = ADAPTERS.crypto_ict_smc(candles);
    const sig = signalAt(22, 'short');
    expect(sig).not.toBeNull();
    expect(sig.fvg_hit).toBe(true);
  });
});

describe('crypto_ict_smc adapter — order block', () => {
  it('flags the last opposite-color candle before an impulsive move as an order block', () => {
    const candles = [];
    for (let i = 0; i < 20; i++) {
      const w = i % 2 === 0 ? 0.2 : -0.2;
      candles.push(c(100 + w, 100.5 + w, 99.5 + w, 100 + w));
    }
    // idx 20: bearish candle (the order block itself), range [99.4, 100.4].
    candles.push(c(100.3, 100.4, 99.4, 99.5));
    // idx 21: bullish impulsive move, range far exceeding ATR*1.5.
    candles.push(c(99.5, 112, 99.4, 111));
    // idx 22: price pulls back down into the OB zone [99.4, 100.4].
    candles.push(c(111, 111, 100, 100.1));

    const signalAt = ADAPTERS.crypto_ict_smc(candles);
    const sig = signalAt(22, 'long');
    expect(sig).not.toBeNull();
    expect(sig.order_block_hit).toBe(true);
  });
});

describe('crypto_ict_smc adapter — BOS vs CHoCH', () => {
  it('classifies a break in the prevailing trend direction as a continuation BOS, and a break against it as a CHoCH', () => {
    // Build a clean uptrend of higher-highs/higher-lows fractal swings
    // (swingLeft=swingRight=5), then break the most recent swing high
    // upward (continuation BOS, since trend is already "up"), then break
    // a swing low downward (CHoCH, since trend was "up").
    const candles = [];
    const push = (o, h, l, cl) => candles.push(c(o, h, l, cl));
    // Warmup so ATR(14) is finite.
    for (let i = 0; i < 15; i++) push(100, 100.5, 99.5, 100);

    // Swing low #1 at a local dip.
    for (let i = 0; i < 5; i++) push(101 - i, 101.2 - i, 100.8 - i, 101 - i); // descending into the low
    push(96, 96.2, 95.5, 96); // idx: swing low candidate (lowest low)
    for (let i = 0; i < 5; i++) push(96.5 + i, 96.8 + i, 96.3 + i, 96.5 + i); // ascending out

    // Swing high #1 at a local peak.
    for (let i = 0; i < 5; i++) push(102 + i, 102.2 + i, 101.8 + i, 102 + i);
    push(108, 108.5, 107.5, 108); // swing high candidate
    for (let i = 0; i < 5; i++) push(107.5 - i, 107.8 - i, 107.2 - i, 107.5 - i);

    // Swing low #2, higher than swing low #1 (higher low).
    for (let i = 0; i < 5; i++) push(103 - i, 103.2 - i, 102.8 - i, 103 - i);
    push(99, 99.2, 98.5, 99); // swing low #2 candidate (> 96)
    for (let i = 0; i < 5; i++) push(99.5 + i, 99.8 + i, 99.3 + i, 99.5 + i);

    // Swing high #2, higher than swing high #1 (higher high) -> once both
    // confirm, trend flips to "up".
    for (let i = 0; i < 5; i++) push(104 + i, 104.2 + i, 103.8 + i, 104 + i);
    push(112, 112.5, 111.5, 112); // swing high #2 candidate (> 108)
    for (let i = 0; i < 5; i++) push(111.5 - i, 111.8 - i, 111.2 - i, 111.5 - i);

    // Now break the just-confirmed swing high (112) upward -> continuation BOS.
    for (let i = 0; i < 3; i++) push(106 - i, 106.2 - i, 105.8 - i, 106 - i);
    push(113, 114, 112.5, 113.5); // breaks 112 -> bullish BOS (trend already "up")

    // ...then break the last confirmed swing low (99) downward -> CHoCH.
    for (let i = 0; i < 8; i++) push(105 - i * 0.5, 105.2 - i * 0.5, 104.5 - i * 0.5, 105 - i * 0.5);
    push(98, 98.5, 90, 91); // breaks below 99 -> bearish CHoCH (trend was "up")

    const signalAt = ADAPTERS.crypto_ict_smc(candles);
    const bosKinds = [];
    for (let i = 0; i < candles.length; i++) {
      const longSig = signalAt(i, 'long');
      const shortSig = signalAt(i, 'short');
      if (longSig?.bos_kind) bosKinds.push({ i, dir: 'bullish', kind: longSig.bos_kind });
      if (shortSig?.bos_kind) bosKinds.push({ i, dir: 'bearish', kind: shortSig.bos_kind });
    }
    expect(bosKinds.some((e) => e.dir === 'bullish' && e.kind === 'BOS')).toBe(true);
    expect(bosKinds.some((e) => e.dir === 'bearish' && e.kind === 'CHoCH')).toBe(true);
  });
});

describe('crypto_ict_smc adapter — registration', () => {
  it('registers fixed and trailing-SL variants in ADAPTERS, ADAPTER_WARMUP_BARS, PARTIAL_ADAPTERS and REAL_OHLC_STRATEGY_IDS', () => {
    for (const id of ['crypto_ict_smc', 'crypto_ict_smc_sl']) {
      expect(typeof ADAPTERS[id]).toBe('function');
      expect(ADAPTER_WARMUP_BARS[id]).toBeGreaterThan(0);
      expect(ADAPTER_WARMUP_BARS[id]).toBeLessThan(200);
      expect(typeof PARTIAL_ADAPTERS[id]).toBe('string');
      expect(REAL_OHLC_STRATEGY_IDS.has(id)).toBe(true);
    }
  });

  it('returns null before ATR(14) has enough bars', () => {
    const candles = Array.from({ length: 5 }, (_, i) => c(100, 101, 99, 100 + i));
    const signalAt = ADAPTERS.crypto_ict_smc(candles);
    expect(signalAt(2, 'long')).toBeNull();
  });
});
