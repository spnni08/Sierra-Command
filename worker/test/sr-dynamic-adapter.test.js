import { describe, it, expect } from 'vitest';
import { ADAPTERS, ADAPTER_WARMUP_BARS, PARTIAL_ADAPTERS } from '../src/backtest/adapters.js';
import { REAL_OHLC_STRATEGY_IDS } from '../src/backtest/candles.js';

function c(o, h, l, close, volume = 1000) {
  return { open: o, high: h, low: l, close, volume };
}

describe('crypto_sr_volume adapter (S&R Dynamic)', () => {
  it('returns null before ATR(50)/EMA(50) have enough bars', () => {
    const candles = Array.from({ length: 10 }, (_, i) => c(100, 101, 99, 100 + i));
    const signalAt = ADAPTERS.crypto_sr_volume(candles);
    expect(signalAt(5, 'long')).toBeNull();
  });

  it('produces a finite trend-filter EMA and a defined os/zone state once warmed up', () => {
    const candles = Array.from({ length: 80 }, (_, i) => {
      const drift = i * 0.3;
      return c(100 + drift, 100.6 + drift, 99.4 + drift, 100.2 + drift);
    });
    const signalAt = ADAPTERS.crypto_sr_volume(candles);
    const sig = signalAt(70, 'long');
    expect(sig).not.toBeNull();
    expect(Number.isFinite(sig.ema200)).toBe(true);
    expect([0, 1]).toContain(sig.sr_os);
  });

  it('fires a VAL_BOUNCE (long) trigger when avg jumps up (os flips to support mode) and the wick reaches into the support zone while the close holds above lower_sup', () => {
    // Steady low-volatility base (small ATR), then a breakout candle whose
    // close is far enough from the running avg to flip os to 1 (support
    // mode, per _sr_dynamic_loop's avg>avg[1] rule) — its own wide low-to-
    // close range simultaneously satisfies the same-bar sr_zone_up wick
    // check (low <= upper_sup && close >= lower_sup), same as core.py's
    // sequential state machine allows.
    const candles = [];
    for (let i = 0; i < 80; i++) candles.push(c(100, 100.4, 99.6, 100));
    candles.push(c(100, 111, 99.8, 110)); // idx 80: avg jumps to 110, os -> 1, wick reaches support zone
    for (let i = 0; i < 5; i++) candles.push(c(110, 110.3, 109.7, 110));

    const signalAt = ADAPTERS.crypto_sr_volume(candles);
    let sawLongTrigger = false;
    for (let i = 55; i < candles.length; i++) {
      const sig = signalAt(i, 'long');
      if (sig && sig.trigger === 'VAL_BOUNCE') sawLongTrigger = true;
    }
    expect(sawLongTrigger).toBe(true);
  });

  it('registers fixed and trailing-SL variants in ADAPTERS, ADAPTER_WARMUP_BARS, PARTIAL_ADAPTERS and REAL_OHLC_STRATEGY_IDS', () => {
    for (const id of ['crypto_sr_volume', 'crypto_sr_volume_sl']) {
      expect(typeof ADAPTERS[id]).toBe('function');
      expect(ADAPTER_WARMUP_BARS[id]).toBeGreaterThan(0);
      expect(ADAPTER_WARMUP_BARS[id]).toBeLessThan(200);
      expect(typeof PARTIAL_ADAPTERS[id]).toBe('string');
      expect(REAL_OHLC_STRATEGY_IDS.has(id)).toBe(true);
    }
  });
});
