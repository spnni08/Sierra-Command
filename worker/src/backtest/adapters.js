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
import { ema, rsi, emaBollingerBands, bollingerBands, sma, rollingMax, rollingMin, adx as computeAdx } from './indicators.js';

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

// crypto_sr_bollinger — the real Pine trigger needs a wick to pierce the
// band while the close stays inside it (a true intrabar bounce). This
// project's synthesized crypto candles have open=high=low=close (CoinGecko
// /market_chart is a daily close series, no real intrabar range — see
// candles.js), so `low <= bbLower && close > bbLower` is structurally
// impossible when low===close (it would require close <= bbLower AND
// close > bbLower at once). A genuine wick-touch trigger cannot be computed
// from this data at all.
//
// PARTIAL, documented substitute used here instead: a close-only 2-bar
// cross-back proxy — previous close was outside the band, current close is
// back inside it. This captures the same "band rejection then reclaim"
// idea the real strategy trades, but on daily closes rather than intrabar
// wicks, so it will trigger on genuinely different (and likely fewer/later)
// bars than the real Pine strategy would. Flagged as a partial adapter (see
// PARTIAL_ADAPTERS below) rather than presented as equivalent.
function buildCryptoSrBollinger(candles) {
  const closes = candles.map((c) => c.close);
  const { upper, lower } = bollingerBands(closes, 20, 2);
  const ema200 = ema(closes, 200);

  return function signalAt(i, direction) {
    if (i < 1) return null;
    if (
      !Number.isFinite(upper[i]) ||
      !Number.isFinite(lower[i]) ||
      !Number.isFinite(ema200[i]) ||
      !Number.isFinite(closes[i - 1])
    )
      return null;
    const bounceLong = closes[i - 1] < lower[i - 1] && closes[i] > lower[i];
    const bounceShort = closes[i - 1] > upper[i - 1] && closes[i] < upper[i];
    return {
      direction,
      close: closes[i],
      price: closes[i],
      // low/high intentionally omitted: with flat synthesized OHLC they'd
      // equal close and make the strategy's own wick-touch check trivially
      // pass/fail in a misleading way. The proxy below feeds the real
      // strategy factor via bb_lower/bb_upper positioned so its close-only
      // comparison (low <= bbLower / high >= bbUpper) reads correctly only
      // when the proxy condition is true.
      low: direction === 'long' && bounceLong ? lower[i] : closes[i],
      high: direction === 'short' && bounceShort ? upper[i] : closes[i],
      bb_lower: lower[i],
      bb_upper: upper[i],
      ema200: ema200[i],
    };
  };
}

// crypto_orderflow_breakout — fully close/volume derivable: range_high/
// range_low use rollingMax/rollingMin of closes over the PRIOR N=20 bars
// (not including the current one, matching Pine's ta.highest/lowest[1]
// convention — including the current bar would make "close > range_high"
// tautologically false). avg_volume is a rolling SMA of volume over the
// same prior-N window, using the real CoinGecko total_volumes data (see
// candles.js) — a genuine daily aggregate volume, not fabricated, though
// coarser than the single-exchange candle volume the original Pine reads.
function buildCryptoOrderflowBreakout(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const rangeHigh = rollingMax(closes, 20);
  const rangeLow = rollingMin(closes, 20);
  const avgVolume = sma(volumes, 20);
  const ema200 = ema(closes, 200);
  const rsi9 = rsi(closes, 9);

  return function signalAt(i, direction) {
    if (i < 1) return null;
    const high = rangeHigh[i - 1];
    const low = rangeLow[i - 1];
    const avgVol = avgVolume[i - 1];
    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(avgVol) ||
      !Number.isFinite(ema200[i]) ||
      !Number.isFinite(volumes[i])
    )
      return null;
    return {
      direction,
      close: closes[i],
      price: closes[i],
      range_high: high,
      range_low: low,
      candle_volume: volumes[i],
      avg_volume: avgVol,
      ema200: ema200[i],
      rsi9: rsi9[i],
    };
  };
}

// crypto_ichimoku_breakout — all four factors derivable from close+volume,
// using the strategy's own ichimokuPeriods params (tenkan:5, kijun:13,
// senkou_b:26, chikou_shift:13, adx_period:14). Classic Ichimoku's Tenkan/
// Kijun/Senkou-B lines use (period-high + period-low)/2 from real intrabar
// high/low; with this project's synthesized flat OHLC (high=low=close, see
// candles.js) that collapses to (rollingMax(closes)+rollingMin(closes))/2,
// which for a close-only series is the standard, correct way to compute it
// (not a fabricated substitute — there IS no other high/low to use). Senkou
// spans are displaced forward by the kijun period (13, the classic
// proportional-Ichimoku convention when not using the traditional 9/26/52
// periods), matching how the cloud would actually be plotted against the
// current bar. Chikou reference is literally "close N bars ago" per this
// strategy's own comment, directly computable. avg_volume uses the same
// 20-bar rolling window as crypto_orderflow_breakout's adapter (no window
// size specified in this strategy's params, so the same convention is
// reused rather than inventing a different one).
function buildCryptoIchimokuBreakout(candles) {
  const { tenkan, kijun, senkou_b: senkouBPeriod, chikou_shift: chikouShift, adx_period: adxPeriod } = {
    tenkan: 5,
    kijun: 13,
    senkou_b: 26,
    chikou_shift: 13,
    adx_period: 14,
  };
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const midpoint = (period) => {
    const hi = rollingMax(closes, period);
    const lo = rollingMin(closes, period);
    return closes.map((_, i) => (Number.isFinite(hi[i]) && Number.isFinite(lo[i]) ? (hi[i] + lo[i]) / 2 : NaN));
  };
  const tenkanSen = midpoint(tenkan);
  const kijunSen = midpoint(kijun);
  const senkouARaw = closes.map((_, i) =>
    Number.isFinite(tenkanSen[i]) && Number.isFinite(kijunSen[i]) ? (tenkanSen[i] + kijunSen[i]) / 2 : NaN
  );
  const senkouBRaw = midpoint(senkouBPeriod);
  const displacement = kijun;

  const adxSeries = computeAdx(candles, adxPeriod);
  const avgVolume = sma(volumes, 20);

  return function signalAt(i, direction) {
    const srcIdx = i - displacement;
    const chikouIdx = i - chikouShift;
    if (srcIdx < 0 || chikouIdx < 0) return null;
    const senkouA = senkouARaw[srcIdx];
    const senkouB = senkouBRaw[srcIdx];
    const adxVal = adxSeries[i];
    const avgVol = avgVolume[i - 1];
    if (
      !Number.isFinite(senkouA) ||
      !Number.isFinite(senkouB) ||
      !Number.isFinite(adxVal) ||
      !Number.isFinite(avgVol) ||
      !Number.isFinite(volumes[i])
    )
      return null;
    return {
      direction,
      close: closes[i],
      price: closes[i],
      senkou_a: senkouA,
      senkou_b: senkouB,
      adx: adxVal,
      chikou_ref: closes[chikouIdx],
      candle_volume: volumes[i],
      avg_volume: avgVol,
    };
  };
}

export const ADAPTERS = {
  crypto_baseline: buildCryptoBaseline,
  crypto_baseline_sl: buildCryptoBaseline,
  crypto_bb_rsi_trendfilter: buildCryptoBbRsiTrendfilter,
  crypto_bb_rsi_trendfilter_sl: buildCryptoBbRsiTrendfilter,
  crypto_sr_bollinger: buildCryptoSrBollinger,
  crypto_sr_bollinger_sl: buildCryptoSrBollinger,
  crypto_orderflow_breakout: buildCryptoOrderflowBreakout,
  crypto_orderflow_breakout_sl: buildCryptoOrderflowBreakout,
  crypto_ichimoku_breakout: buildCryptoIchimokuBreakout,
  crypto_ichimoku_breakout_sl: buildCryptoIchimokuBreakout,
};

// Strategies whose adapter above is a documented simplification rather than
// a faithful reproduction of the Pine-side trigger — surfaced in the
// backtest response (see engine.js) so results aren't mistaken for
// full-fidelity ones.
export const PARTIAL_ADAPTERS = {
  crypto_sr_bollinger:
    'Real Pine trigger needs a wick to pierce the Bollinger band while the close stays inside (true intrabar bounce). This backtest uses daily close-only candles (no real intrabar range), so a close-only 2-bar cross-back-inside-the-band proxy is used instead — same "rejection then reclaim" idea, but triggers on different/fewer bars than the real intrabar strategy would.',
  crypto_sr_bollinger_sl:
    'Real Pine trigger needs a wick to pierce the Bollinger band while the close stays inside (true intrabar bounce). This backtest uses daily close-only candles (no real intrabar range), so a close-only 2-bar cross-back-inside-the-band proxy is used instead — same "rejection then reclaim" idea, but triggers on different/fewer bars than the real intrabar strategy would.',
};

export function getAdapter(strategyId) {
  return ADAPTERS[strategyId] ?? null;
}
