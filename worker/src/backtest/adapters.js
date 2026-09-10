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
import { ema, rsi } from './indicators.js';

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

export const ADAPTERS = {
  crypto_baseline: buildCryptoBaseline,
  crypto_baseline_sl: buildCryptoBaseline,
};

export function getAdapter(strategyId) {
  return ADAPTERS[strategyId] ?? null;
}
