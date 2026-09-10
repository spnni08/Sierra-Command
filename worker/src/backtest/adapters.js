// Per-strategy "indicator adapters": given a candle series and an index,
// build the `signal` object shape that strategy.evaluate() expects (the
// same shape a real webhook payload carries — see routes/webhook.js).
//
// Only strategies whose factors read plain, well-defined technical
// indicators computable from a close/high/low/open series are implemented
// here. The other WAVESCOUT strategies gate on semantic Pine-side flags
// that were never numeric indicators to begin with — S&R volume-profile
// zone touches, Ichimoku Kumo/Chikou confirmation, ICT/SMC swing-structure
// break-of-structure counts, candlestick pattern flags, orderflow volume
// ratios (CoinGecko's free OHLC endpoint has no volume field at all). Faking
// those as random/placeholder booleans would produce backtest numbers that
// look real but aren't derived from anything — worse than not running them.
// So only `crypto_baseline` has a real adapter for now; engine.js reports
// "no_indicator_adapter" for any other strategy rather than pretending.
import { ema, rsi, emaBollingerBands } from './indicators.js';

function buildCryptoBaseline(candles) {
  const closes = candles.map((c) => c.close);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);

  return function signalAt(i, direction) {
    if (!Number.isFinite(ema200[i]) || !Number.isFinite(rsi14[i])) return null;
    return {
      direction,
      close: closes[i],
      price: closes[i],
      ema200: ema200[i],
      rsi: rsi14[i],
    };
  };
}

// crypto_bb_rsi_trendfilter — fully close-only derivable: EMA(200)-based
// Bollinger(0.2 stddev) as a trend filter + RSI(3) 20/80 cross. The strategy
// file itself already degrades rsi3_cross to a level check if the cross
// booleans are absent, but real cross detection (previous bar was on the far
// side of the level, current bar crossed through it) is straightforward from
// closes alone, so it's computed properly here rather than relying on that
// degrade path.
function buildCryptoBbRsiTrendfilter(candles) {
  const closes = candles.map((c) => c.close);
  const { upper, lower } = emaBollingerBands(closes, 200, 0.2);
  const rsi3 = rsi(closes, 3);

  return function signalAt(i, direction) {
    if (i < 1) return null;
    if (!Number.isFinite(upper[i]) || !Number.isFinite(lower[i]) || !Number.isFinite(rsi3[i]) || !Number.isFinite(rsi3[i - 1]))
      return null;
    const rsi3CrossUp = rsi3[i - 1] < 20 && rsi3[i] >= 20;
    const rsi3CrossDown = rsi3[i - 1] > 80 && rsi3[i] <= 80;
    return {
      direction,
      close: closes[i],
      price: closes[i],
      bb_upper: upper[i],
      bb_lower: lower[i],
      rsi3: rsi3[i],
      rsi3_cross_up: rsi3CrossUp,
      rsi3_cross_down: rsi3CrossDown,
    };
  };
}

export const ADAPTERS = {
  crypto_baseline: buildCryptoBaseline,
  crypto_baseline_sl: buildCryptoBaseline,
  crypto_bb_rsi_trendfilter: buildCryptoBbRsiTrendfilter,
  crypto_bb_rsi_trendfilter_sl: buildCryptoBbRsiTrendfilter,
};

export function getAdapter(strategyId) {
  return ADAPTERS[strategyId] ?? null;
}
