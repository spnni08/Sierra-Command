import { describe, it, expect } from 'vitest';
import { ADAPTERS, ADAPTER_WARMUP_BARS, PARTIAL_ADAPTERS } from '../src/backtest/adapters.js';
import { REAL_OHLC_STRATEGY_IDS } from '../src/backtest/candles.js';

// Synthetic candles, not live CoinGecko data — the live-data round trip
// (real engulfing pattern + real MFI extreme, real wick-touch-inside-band)
// was verified manually during development against BTCUSDT via a local
// `wrangler dev` + real network calls to CoinGecko's /ohlc and
// /market_chart; see this feature's PR description for the exact captured
// signals. These tests pin the pure pattern-detection/gating logic with
// deterministic input so a future change can't silently break it.
function makeCandle(o, h, l, c, volume = 1000) {
  return { open: o, high: h, low: l, close: c, volume };
}

describe('crypto_mfi_engulfing adapter', () => {
  it('flags a genuine bullish engulfing candle and not the bars around it', () => {
    // 20 flat-ish candles (volume present, no pattern) then one clean
    // bullish engulfing at index 15: prior bar bearish (100->95), current
    // bar's body (95->105) fully contains it.
    const candles = Array.from({ length: 15 }, (_, i) => makeCandle(100 + i, 101 + i, 99 + i, 100 + i));
    candles.push(makeCandle(100, 100.5, 94, 95)); // index 15: bearish
    candles.push(makeCandle(95, 106, 94, 105)); // index 16: bullish, engulfs index 15's body
    candles.push(makeCandle(105, 106, 104, 105)); // index 17: flat, no pattern

    const signalAt = ADAPTERS.crypto_mfi_engulfing(candles);
    const at16Long = signalAt(16, 'long');
    const at17Long = signalAt(17, 'long');

    expect(at16Long.engulfing_bullish).toBe(true);
    expect(at16Long.engulfing_bearish).toBe(false);
    expect(at17Long.engulfing_bullish).toBe(false);
    expect(at17Long.engulfing_bearish).toBe(false);
  });

  it('returns null before MFI(14) has enough bars to compute', () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(100, 101, 99, 100 + i));
    const signalAt = ADAPTERS.crypto_mfi_engulfing(candles);
    expect(signalAt(2, 'long')).toBeNull();
  });
});

describe('crypto_holy_grail_adx_sma_bb adapter', () => {
  it('flags a genuine wick-touch-inside-band candle (the case impossible on flat OHLC)', () => {
    // 60 candles trending up (real O/H/L/C, not flat) so ADX has enough
    // history, then one candle whose high pierces the upper Bollinger band
    // while its close stays inside — the exact "low<=bbLower &&
    // close>bbLower can't both hold when low===close" impossibility
    // adapters.js's header comment describes for /market_chart's flat OHLC.
    const candles = [];
    for (let i = 0; i < 60; i++) {
      // Small alternating wiggle around 100, not a directional trend — keeps
      // the Bollinger basis/band close to a tight, stable range so the
      // spike candle below can cleanly pierce the upper band with its wick
      // while its close stays back inside it.
      const wiggle = i % 2 === 0 ? 0.3 : -0.3;
      candles.push(makeCandle(100 + wiggle, 100.5 + wiggle, 99.5 + wiggle, 100 + wiggle));
    }
    // Wick-touch candle: high spikes well above the tight recent range
    // (pierces the upper band), close pulled back inside it.
    candles.push(makeCandle(100, 108, 99.5, 100.05));

    const signalAt = ADAPTERS.crypto_holy_grail_adx_sma_bb(candles);
    const i = candles.length - 1;
    const signal = signalAt(i, 'short');
    expect(signal).not.toBeNull();
    expect(signal.high).toBeGreaterThanOrEqual(signal.bb_upper);
    expect(signal.close).toBeLessThan(signal.bb_upper);
  });
});

describe('real-OHLC strategy wiring', () => {
  it('registers fixed and trailing-SL variants for both new strategies, each in ADAPTERS, ADAPTER_WARMUP_BARS, PARTIAL_ADAPTERS and REAL_OHLC_STRATEGY_IDS', () => {
    for (const id of ['crypto_mfi_engulfing', 'crypto_mfi_engulfing_sl', 'crypto_holy_grail_adx_sma_bb', 'crypto_holy_grail_adx_sma_bb_sl']) {
      expect(typeof ADAPTERS[id]).toBe('function');
      expect(ADAPTER_WARMUP_BARS[id]).toBeGreaterThan(0);
      expect(ADAPTER_WARMUP_BARS[id]).toBeLessThan(200); // must be well under the EMA200-sized default, or these strategies could never clear warmup on /ohlc's much shorter series
      expect(typeof PARTIAL_ADAPTERS[id]).toBe('string');
      expect(REAL_OHLC_STRATEGY_IDS.has(id)).toBe(true);
    }
  });
});
