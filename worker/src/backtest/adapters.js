// Per-strategy "indicator adapters": given a candle series and an index,
// build the `signal` object shape that strategy.evaluate() expects (the
// same shape a real webhook payload carries — see routes/webhook.js).
//
// Only strategies whose factors read plain, well-defined technical
// indicators computable from close/volume data are implemented here (see
// candles.js: crypto candles are CoinGecko /market_chart daily closes with
// real total_volumes attached, but open=high=low=close — no true intrabar
// range). A strategy with a real adapter below may still be listed in
// PARTIAL_ADAPTERS if one of its factors needed a documented close-only
// simplification instead of the faithful Pine-side geometry.
//
// Strategies WITHOUT an adapter (engine.js reports "no_indicator_adapter"),
// and why:
//   - crypto_mfi_engulfing, crypto_holy_grail_adx_sma_bb used to be listed
//     here too: both need real candlestick body/wick pattern detection
//     (engulfing, hammer, doji, wick-touch-then-close-inside), undetectable
//     on flat synthesized /market_chart OHLC where open=high=low=close.
//     Verified empirically (with COINGECKO_API_KEY set) that CoinGecko's
//     /ohlc endpoint gives genuine, non-flat O/H/L/C at every supported
//     `days` bucket — granularity gets coarser for longer windows (4h bars
//     up to 30 days, 4-day bars out to the free tier's 365-day cap) but
//     never flat, so both are now implemented below
//     (buildCryptoMfiEngulfing/buildCryptoHolyGrailAdxSmaBb) using
//     candles.js's fetchCryptoRealOhlcCandles instead of the usual
//     fetchCryptoCandles. See that function's comment for the full
//     picture, including why MFI needs a second (volume) fetch merged in —
//     /ohlc alone has no volume field at all.
//   - crypto_sr_volume: needs true Volume Profile (VAL/VAH/POC from
//     intrabar volume-at-price distribution) — CoinGecko's daily aggregate
//     volume is one number per day, no price distribution to build that
//     from.
//   - crypto_ict_smc: BOS/CHoCH/order-block/FVG swing-structure detection —
//     by the strategy module's own comment, this logic lives exclusively in
//     Pine/backtest/ict_smc as the reference spec; not re-derivable from
//     close-only candles.
//   - crypto_flawless_victory used to be listed here too (long-only,
//     signal-closed position — no engine support for that). engine.js now
//     has an opt-in exit.mode:'signal' path (see its header comment) and
//     this file implements the adapter below for v1, the strategy's default
//     active variant. v2 (BB2/17, RSI-only guards, registered as
//     crypto_flawless_victory_v2) and v3 (BB1/20, MFI-entry + RSI-AND-MFI
//     exit, registered as crypto_flawless_victory_v3) are also implemented
//     below (buildCryptoFlawlessVictoryV2/V3) — both close via a signal AND
//     a parallel fixed SL/TP bracket, whichever hits first, using
//     engine.js's exit.mode:'signal_or_sltp' path.
import { ema, rsi, emaBollingerBands, bollingerBands, sma, rollingMax, rollingMin, adx as computeAdx, atr as computeAtr, mfi as computeMfi } from './indicators.js';

// Edge-triggered ta.crossunder(close, lowerBand) / ta.crossover(close,
// upperBand), same convention buildCryptoFlawlessVictoryV1 already uses:
// fires only on the bar the cross happens (needs the previous bar's
// close/band relationship), not on every bar price stays beyond the band.
function crossBands(closes, lower, upper) {
  const crossUnder = new Array(closes.length).fill(false);
  const crossOver = new Array(closes.length).fill(false);
  for (let i = 1; i < closes.length; i++) {
    if (!Number.isFinite(lower[i]) || !Number.isFinite(lower[i - 1]) || !Number.isFinite(upper[i]) || !Number.isFinite(upper[i - 1]))
      continue;
    crossUnder[i] = closes[i - 1] >= lower[i - 1] && closes[i] < lower[i];
    crossOver[i] = closes[i - 1] <= upper[i - 1] && closes[i] > upper[i];
  }
  return { crossUnder, crossOver };
}

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

// Confirmed pivot high/low on a plain value series, ta.pivothigh/pivotlow
// style: a bar is a pivot if it's the strict extreme within [i-left, i+right]
// — only knowable once `right` bars later (matches Pine's own causality, not
// an extra simplification). Returns a forward-filled series (the pivot value
// persists as the active support/resistance level until a newer pivot
// supersedes it), matching the "var float resistance/support" carry-forward
// in the Pine source.
function pivotLevels(values, left, right, mode) {
  const n = values.length;
  const confirmedAt = new Array(n).fill(NaN);
  for (let i = left; i < n - right; i++) {
    let isPivot = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (mode === 'high' ? values[j] >= values[i] : values[j] <= values[i]) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) confirmedAt[i + right] = values[i];
  }
  const out = new Array(n).fill(NaN);
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(confirmedAt[i])) last = confirmedAt[i];
    out[i] = last;
  }
  return out;
}

// crypto_sr_volume needs true Volume Profile (VAL/VAH/POC from intrabar
// volume-at-price) — CoinGecko's daily aggregate volume has no
// price-distribution to build that from, so it stays no_indicator_adapter
// (see engine.js). crypto_sr_exclusion's S&R, by contrast, is explicitly
// classic pivot-based (no volume profile — see this strategy's own header
// comment and its Pine source), which IS derivable from a close series.
// Params match the Pine source (tradingview-bot/pinescript/strategies/
// crypto_sr_exclusion.pine) exactly: pivotLeft/Right=5, zoneTolPct=0.25,
// atrLen=14, atrSpikeMult=1.8, volLen=20, thinVolMult=0.5. Pine's real
// pivothigh/pivotlow use high/low; with this project's flat synthesized OHLC
// (high=low=close) they collapse to pivots on the close series itself — the
// correct computation given the data, not a fabricated substitute.
//
// cooldown_active is the one field with no Pine equivalent at all (Pine's
// own comment: "rein Worker-seitig, DB-Blick auf `signals`" — a live DB
// lookback of the last actual trade, not a chart indicator). Approximated
// here as elapsed time since the precondition (zone-touch + RSI direction)
// last edge-triggered for the same direction, using COOLDOWN_MINUTES=10
// from the strategy's own params — on this backtest's daily candles that
// window is far shorter than one bar, so in practice it reads "elapsed"
// almost always, which is an honest consequence of the daily timeframe, not
// a smoothed-over gap.
function buildCryptoSrExclusion(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const timestamps = candles.map((c) => c.timestamp);
  const PIVOT_LEFT = 5;
  const PIVOT_RIGHT = 5;
  const ZONE_TOL_PCT = 0.25;
  const ATR_LEN = 14;
  const ATR_SPIKE_MULT = 1.8;
  const VOL_LEN = 20;
  const THIN_VOL_MULT = 0.5;
  const COOLDOWN_MS = 10 * 60_000;

  const resistance = pivotLevels(closes, PIVOT_LEFT, PIVOT_RIGHT, 'high');
  const support = pivotLevels(closes, PIVOT_LEFT, PIVOT_RIGHT, 'low');
  const rsi14 = rsi(closes, 14);
  const atrSeries = computeAtr(candles, ATR_LEN);
  const atrAvg = sma(atrSeries, ATR_LEN);
  const volAvg = sma(volumes, VOL_LEN);

  const longSig = new Array(closes.length).fill(false);
  const shortSig = new Array(closes.length).fill(false);
  const lastFireTsLong = new Array(closes.length).fill(NaN);
  const lastFireTsShort = new Array(closes.length).fill(NaN);
  let lastLong = NaN;
  let lastShort = NaN;
  for (let i = 0; i < closes.length; i++) {
    const zoneTol = closes[i] * (ZONE_TOL_PCT / 100);
    const nearSupport = Number.isFinite(support[i]) && Math.abs(closes[i] - support[i]) <= zoneTol;
    const nearResistance = Number.isFinite(resistance[i]) && Math.abs(closes[i] - resistance[i]) <= zoneTol;
    const zoneTouchLong = nearSupport && closes[i] > support[i];
    const zoneTouchShort = nearResistance && closes[i] < resistance[i];
    const rsiOkLong = Number.isFinite(rsi14[i]) && rsi14[i] > 40;
    const rsiOkShort = Number.isFinite(rsi14[i]) && rsi14[i] < 60;
    longSig[i] = zoneTouchLong && rsiOkLong;
    shortSig[i] = zoneTouchShort && rsiOkShort;
    const longFire = longSig[i] && !(i > 0 && longSig[i - 1]);
    const shortFire = shortSig[i] && !(i > 0 && shortSig[i - 1]);
    if (longFire) lastLong = timestamps[i];
    if (shortFire) lastShort = timestamps[i];
    lastFireTsLong[i] = lastLong;
    lastFireTsShort[i] = lastShort;
  }

  return function signalAt(i, direction) {
    if (!Number.isFinite(rsi14[i]) || !Number.isFinite(atrAvg[i]) || !Number.isFinite(volAvg[i])) return null;
    const trigger = direction === 'long' ? (longSig[i] ? 'SUPPORT_TOUCH' : 'NONE') : shortSig[i] ? 'RESISTANCE_TOUCH' : 'NONE';
    const atrSpike = atrAvg[i] > 0 && atrSeries[i] > atrAvg[i] * ATR_SPIKE_MULT;
    const thinVolume = volAvg[i] > 0 && Number.isFinite(volumes[i]) && volumes[i] < volAvg[i] * THIN_VOL_MULT;
    const lastFireTs = direction === 'long' ? lastFireTsLong[i] : lastFireTsShort[i];
    const cooldownActive = Number.isFinite(lastFireTs) && timestamps[i] - lastFireTs < COOLDOWN_MS;
    return {
      direction,
      close: closes[i],
      price: closes[i],
      trigger,
      rsi: rsi14[i],
      atr_spike: atrSpike,
      thin_volume: thinVolume,
      cooldown_active: cooldownActive,
    };
  };
}

// crypto_flawless_victory v1 — the strategy's default-active variant (Pine
// inputs: v1=true, v2=false, v3=false). Long-only, edge-triggered BB1(20,1.0)
// cross + RSI(14, Wilder RMA) guard entry, closed ONLY by the mirror-image
// Sell_1 cross signal — genuinely no SL/TP in the Pine source (pyramiding=0,
// no strategy.exit() call at all under `if v1`). Returns the
// {signalAt, closeSignalAt} shape engine.js's exit.mode:'signal' path
// expects, rather than the legacy bare-function shape every other adapter
// here returns.
//
// v2/v3 are NOT implemented: unlike v1, they close via BOTH a signal
// (strategy.close, same crossover pattern but different RSI/MFI guards) AND
// a parallel strategy.exit() with a fixed stop/limit — whichever of
// {signal-close, SL hit, TP hit} happens first on a bar is the real exit.
// That is a different exit-mode combination (signal-OR-SL/TP) than v1's
// signal-only mode, and out of scope for this pass; see the Pine source's
// own header comment for the exact v2 (3.5%/5.0%) and v3 (4.0%/5.5%)
// parameters if this is picked up later.
function buildCryptoFlawlessVictoryV1(candles) {
  const closes = candles.map((c) => c.close);
  const rsi14 = rsi(closes, 14);
  const { upper: upper1, lower: lower1 } = bollingerBands(closes, 20, 1.0);

  const RSI_LOWER_1 = 42;
  const RSI_UPPER_1 = 70;

  // Edge-triggered crosses (ta.crossunder/ta.crossover): must fire ONLY on
  // the bar where the cross happens, not on every bar price stays beyond the
  // band — needs the previous bar's close/band relationship, hence i>=1.
  const crossUnder = new Array(closes.length).fill(false); // close crosses from >= lower1 to < lower1
  const crossOver = new Array(closes.length).fill(false); // close crosses from <= upper1 to > upper1
  for (let i = 1; i < closes.length; i++) {
    if (!Number.isFinite(lower1[i]) || !Number.isFinite(lower1[i - 1]) || !Number.isFinite(upper1[i]) || !Number.isFinite(upper1[i - 1]))
      continue;
    crossUnder[i] = closes[i - 1] >= lower1[i - 1] && closes[i] < lower1[i];
    crossOver[i] = closes[i - 1] <= upper1[i - 1] && closes[i] > upper1[i];
  }

  const buy1 = closes.map((_, i) => crossUnder[i] && Number.isFinite(rsi14[i]) && rsi14[i] > RSI_LOWER_1);
  const sell1 = closes.map((_, i) => crossOver[i] && Number.isFinite(rsi14[i]) && rsi14[i] > RSI_UPPER_1);

  function signalAt(i, direction) {
    // Long-only: the Pine source never opens a short (Sell_1 closes the
    // existing long via strategy.close, it's not a short entry) — so no
    // short signal is ever emitted here.
    if (direction !== 'long') return null;
    if (i < 1 || !Number.isFinite(rsi14[i]) || !Number.isFinite(upper1[i]) || !Number.isFinite(lower1[i])) return null;
    return {
      direction,
      close: closes[i],
      price: closes[i],
      version: 'v1',
      bb_buy_trigger: buy1[i],
      bb_sell_trigger: false,
      rsi: rsi14[i],
    };
  }

  function closeSignalAt(i) {
    return !!sell1[i];
  }

  return { signalAt, closeSignalAt };
}

// crypto_flawless_victory v2 — BB2(17, 1.0) (NOT BB1/20 — see the Pine
// source), RSI-only guards on both entry AND exit (single condition each,
// unlike v3's two-guard exit): Buy_2 = crossunder(close,lower2) && rsi>42,
// Sell_2 = crossover(close,upper2) && rsi>76. Long-only, same as v1. Closes
// via BOTH Sell_2 (closeSignalAt below) AND a parallel fixed 3.5%SL/5.0%TP
// bracket built by engine.js's initialSignalOrSltpExit — see
// cryptoFlawlessVictory.js's V2_EXIT and engine.js's exit.mode:
// 'signal_or_sltp' race logic.
function buildCryptoFlawlessVictoryV2(candles) {
  const closes = candles.map((c) => c.close);
  const rsi14 = rsi(closes, 14);
  const { upper: upper2, lower: lower2 } = bollingerBands(closes, 17, 1.0);
  const { crossUnder, crossOver } = crossBands(closes, lower2, upper2);

  const RSI_LOWER_2 = 42;
  const RSI_UPPER_2 = 76;

  const buy2 = closes.map((_, i) => crossUnder[i] && Number.isFinite(rsi14[i]) && rsi14[i] > RSI_LOWER_2);
  const sell2 = closes.map((_, i) => crossOver[i] && Number.isFinite(rsi14[i]) && rsi14[i] > RSI_UPPER_2);

  function signalAt(i, direction) {
    if (direction !== 'long') return null;
    if (i < 1 || !Number.isFinite(rsi14[i]) || !Number.isFinite(upper2[i]) || !Number.isFinite(lower2[i])) return null;
    return {
      direction,
      close: closes[i],
      price: closes[i],
      version: 'v2',
      bb_buy_trigger: buy2[i],
      bb_sell_trigger: false,
      rsi: rsi14[i],
    };
  }

  function closeSignalAt(i) {
    return !!sell2[i];
  }

  return { signalAt, closeSignalAt };
}

// crypto_flawless_victory v3 — BB1(20, 1.0), same bands as v1 (NOT BB2 —
// this is the version-3-specific nuance). Entry gates on MFI (not RSI, unlike
// v1/v2): Buy_3 = crossunder(close,lower1) && mfi<60. Exit needs BOTH RSI AND
// MFI to confirm (two-guard AND, unlike v1/v2's single guard): Sell_3 =
// crossover(close,upper1) && rsi>65 && mfi>64. Long-only. Closes via BOTH
// Sell_3 AND a parallel fixed 4.0%SL/5.5%TP bracket (V3_EXIT +
// 'signal_or_sltp', same race logic as v2).
function buildCryptoFlawlessVictoryV3(candles) {
  const closes = candles.map((c) => c.close);
  const rsi14 = rsi(closes, 14);
  const mfi14 = computeMfi(candles, 14);
  const { upper: upper1, lower: lower1 } = bollingerBands(closes, 20, 1.0);
  const { crossUnder, crossOver } = crossBands(closes, lower1, upper1);

  const MFI_LOWER_3 = 60;
  const RSI_UPPER_3 = 65;
  const MFI_UPPER_3 = 64;

  const buy3 = closes.map((_, i) => crossUnder[i] && Number.isFinite(mfi14[i]) && mfi14[i] < MFI_LOWER_3);
  const sell3 = closes.map(
    (_, i) =>
      crossOver[i] &&
      Number.isFinite(rsi14[i]) &&
      rsi14[i] > RSI_UPPER_3 &&
      Number.isFinite(mfi14[i]) &&
      mfi14[i] > MFI_UPPER_3
  );

  function signalAt(i, direction) {
    if (direction !== 'long') return null;
    if (i < 1 || !Number.isFinite(mfi14[i]) || !Number.isFinite(rsi14[i]) || !Number.isFinite(upper1[i]) || !Number.isFinite(lower1[i]))
      return null;
    return {
      direction,
      close: closes[i],
      price: closes[i],
      version: 'v3',
      bb_buy_trigger: buy3[i],
      bb_sell_trigger: false,
      rsi: rsi14[i],
      mfi: mfi14[i],
    };
  }

  function closeSignalAt(i) {
    return !!sell3[i];
  }

  return { signalAt, closeSignalAt };
}

// crypto_mfi_engulfing and crypto_holy_grail_adx_sma_bb — unlike every
// adapter above, these two read candles.js's fetchCryptoRealOhlcCandles()
// (CoinGecko's /ohlc — genuine per-bucket O/H/L/C, confirmed empirically
// with COINGECKO_API_KEY set: granularity depends only on the `days`
// parameter, not the plan tier — 4h bars up to a 30-day window, 4-day bars
// out to CoinGecko's free-tier 365-day cap, never flat) instead of
// /market_chart's flat daily closes, specifically so their candle-body/wick
// factors are computable at all — see candles.js's fetchCryptoRealOhlcCandles
// comment for the full picture, including why MFI needs a second (volume)
// fetch merged in by calendar day.
//
// Candlestick pattern geometry (engulfing/hammer/doji below) uses standard,
// widely-documented technical-analysis definitions — this project has no
// access to the original tradingview-bot Pine source's exact geometry (a
// different, private repo), so these are this backtest's own compromise,
// same as buildCryptoSrBollinger's documented proxy below. Flagged in
// PARTIAL_ADAPTERS.
function candleBody(c) {
  return Math.abs(c.close - c.open);
}
function candleRange(c) {
  return c.high - c.low;
}
function upperWick(c) {
  return c.high - Math.max(c.open, c.close);
}
function lowerWick(c) {
  return Math.min(c.open, c.close) - c.low;
}
function isBullish(c) {
  return c.close > c.open;
}
function isBearish(c) {
  return c.close < c.open;
}

// Standard 2-candle engulfing: prior candle's body fully contained within
// (engulfed by) the current candle's body, with the current candle the
// opposite color.
function detectEngulfing(candles) {
  const bullish = new Array(candles.length).fill(false);
  const bearish = new Array(candles.length).fill(false);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    if (isBearish(prev) && isBullish(curr) && curr.open <= prev.close && curr.close >= prev.open) {
      bullish[i] = true;
    }
    if (isBullish(prev) && isBearish(curr) && curr.open >= prev.close && curr.close <= prev.open) {
      bearish[i] = true;
    }
  }
  return { bullish, bearish };
}

// Standard single-candle patterns: hammer (small body in the upper part of
// the range, a lower wick at least 2x the body, little/no upper wick) and
// doji (body negligible relative to the full range). Direction-agnostic —
// callers combine with their own directional gates (e.g. MFI extreme zone).
function detectHammer(candles) {
  return candles.map((c) => {
    const body = candleBody(c);
    const range = candleRange(c);
    if (!(range > 0)) return false;
    return lowerWick(c) >= 2 * body && upperWick(c) <= body;
  });
}
function detectDoji(candles) {
  const DOJI_BODY_RATIO = 0.1;
  return candles.map((c) => {
    const range = candleRange(c);
    if (!(range > 0)) return false;
    return candleBody(c) <= DOJI_BODY_RATIO * range;
  });
}

// MFI(14) extreme zone + filtered engulfing — see
// strategies/cryptoMfiEngulfing.js's factors (mfi_extreme_zone,
// filtered_engulfing_pattern). No trend filter/exit logic of its own here;
// engine.js's trailing-SL (ATR-anchored) handles exits, same as every other
// trailing-SL strategy.
function buildCryptoMfiEngulfing(candles) {
  const mfi14 = computeMfi(candles, 14);
  const { bullish, bearish } = detectEngulfing(candles);

  return function signalAt(i, direction) {
    if (!Number.isFinite(mfi14[i])) return null;
    return {
      direction,
      close: candles[i].close,
      price: candles[i].close,
      mfi: mfi14[i],
      engulfing_bullish: bullish[i],
      engulfing_bearish: bearish[i],
    };
  };
}

// ADX(14) trend regime + SMA(20)/BB(20, 0.25) wick-touch pullback + candle
// pattern confirmation — see strategies/cryptoHolyGrailAdxSmaBb.js's
// factors (adx_trending, sma_bb_pullback_zone, candle_pattern_confirm). The
// wick-touch criterion (low/high touches the band, close stays inside) is
// exactly what was structurally impossible on /market_chart's flat OHLC
// (low===close there) — real /ohlc data is what makes this adapter possible
// at all.
function buildCryptoHolyGrailAdxSmaBb(candles) {
  const closes = candles.map((c) => c.close);
  const adx14 = computeAdx(candles, 14);
  const { upper: bbUpper, lower: bbLower } = bollingerBands(closes, 20, 0.25);
  const { bullish: engulfingBullish, bearish: engulfingBearish } = detectEngulfing(candles);
  const hammer = detectHammer(candles);
  const doji = detectDoji(candles);

  return function signalAt(i, direction) {
    if (!Number.isFinite(adx14[i]) || !Number.isFinite(bbUpper[i]) || !Number.isFinite(bbLower[i])) return null;
    return {
      direction,
      close: closes[i],
      price: closes[i],
      low: candles[i].low,
      high: candles[i].high,
      adx: adx14[i],
      bb_upper: bbUpper[i],
      bb_lower: bbLower[i],
      candle_pattern_hammer: hammer[i],
      candle_pattern_engulfing: engulfingBullish[i] || engulfingBearish[i],
      candle_pattern_doji: doji[i],
    };
  };
}

// Per-strategy warmup override for engine.js's default WARMUP_BARS=200 (an
// EMA200-sized constant that fits every other adapter's long /market_chart
// history but would make these two — sourced from /ohlc's much shorter
// real-candle series, see above — permanently fail with
// insufficient_candle_history however long a window is requested; ADX(14)'s
// own Wilder smoothing needs ~3x its period before the first finite value
// (see indicators.js's adx()), MFI(14)/a 2-candle engulfing check need far
// less. Buffered above each strategy's actual minimum.
export const ADAPTER_WARMUP_BARS = {
  crypto_mfi_engulfing: 20,
  crypto_mfi_engulfing_sl: 20,
  crypto_holy_grail_adx_sma_bb: 50,
  crypto_holy_grail_adx_sma_bb_sl: 50,
};

// Informational only (see candles.js's OHLC_DAYS_BUCKETS/pickOhlcDaysBucket
// for the actual mechanism this describes) — not yet enforced by the engine
// or read by the frontend. Documents empirically-verified behavior per
// strategy: crypto_mfi_engulfing's low warmup (20 bars) clears even at the
// thinnest bucket CoinGecko's /ohlc offers (days=90 -> 23 four-day bars),
// so it's usable across the entire 1-365 day range /ohlc supports.
// crypto_holy_grail_adx_sma_bb's ADX warmup (~42 bars, see
// ADAPTER_WARMUP_BARS above) does NOT clear the days=90 (23 bars) or
// days=180 (45 bars) buckets — only a window that resolves to the days=30
// bucket (180 four-hour bars) or the days=365 bucket (92 four-day bars)
// leaves any bars for actual signal evaluation. A request landing in the
// 31-180 day range fails with the engine's existing insufficient_candle_
// history error — an honest failure, not a silent bad result, so no
// special-casing was added beyond documenting it here.
export const ADAPTER_METADATA = {
  crypto_mfi_engulfing: { maxWindowDays: 365 },
  crypto_mfi_engulfing_sl: { maxWindowDays: 365 },
  crypto_holy_grail_adx_sma_bb: { maxWindowDays: 365, note: 'requested windows resolving to CoinGecko /ohlc days=90 or days=180 buckets fail warmup — see ADAPTER_WARMUP_BARS comment' },
  crypto_holy_grail_adx_sma_bb_sl: { maxWindowDays: 365, note: 'requested windows resolving to CoinGecko /ohlc days=90 or days=180 buckets fail warmup — see ADAPTER_WARMUP_BARS comment' },
};

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
  crypto_sr_exclusion: buildCryptoSrExclusion,
  crypto_sr_exclusion_sl: buildCryptoSrExclusion,
  crypto_flawless_victory: buildCryptoFlawlessVictoryV1,
  // crypto_flawless_victory_sl (the trailing-SL "(SL)" registry variant) is
  // intentionally NOT registered here: v1 genuinely has no SL/TP in the Pine
  // source, and bolting a synthetic ATR trailing stop onto it would be
  // exactly the "invent an SL/TP that isn't in the source" this port must
  // not do. It stays no_indicator_adapter.
  crypto_flawless_victory_v2: buildCryptoFlawlessVictoryV2,
  crypto_flawless_victory_v3: buildCryptoFlawlessVictoryV3,
  crypto_mfi_engulfing: buildCryptoMfiEngulfing,
  crypto_mfi_engulfing_sl: buildCryptoMfiEngulfing,
  crypto_holy_grail_adx_sma_bb: buildCryptoHolyGrailAdxSmaBb,
  crypto_holy_grail_adx_sma_bb_sl: buildCryptoHolyGrailAdxSmaBb,
};

// Strategies whose adapter above is a documented simplification rather than
// a faithful reproduction of the Pine-side trigger — surfaced in the
// backtest response (see engine.js) so results aren't mistaken for
// full-fidelity ones.
const ENGULFING_PATTERN_CAVEAT =
  'Uses this backtest\'s own standard engulfing-pattern definition (2-bar body containment) — the original Pine source (a different, private repo) is not available to this project to match its exact geometry against.';
const HOLY_GRAIL_PATTERN_CAVEAT =
  'Wick-touch-inside-band criterion uses real O/H/L/C (CoinGecko /ohlc), faithful to the Pine intent. Hammer/doji/engulfing pattern detection uses this backtest\'s own standard technical-analysis definitions — the original Pine source (a different, private repo) is not available to this project to match its exact geometry against.';
export const PARTIAL_ADAPTERS = {
  crypto_sr_bollinger:
    'Real Pine trigger needs a wick to pierce the Bollinger band while the close stays inside (true intrabar bounce). This backtest uses daily close-only candles (no real intrabar range), so a close-only 2-bar cross-back-inside-the-band proxy is used instead — same "rejection then reclaim" idea, but triggers on different/fewer bars than the real intrabar strategy would.',
  crypto_sr_bollinger_sl:
    'Real Pine trigger needs a wick to pierce the Bollinger band while the close stays inside (true intrabar bounce). This backtest uses daily close-only candles (no real intrabar range), so a close-only 2-bar cross-back-inside-the-band proxy is used instead — same "rejection then reclaim" idea, but triggers on different/fewer bars than the real intrabar strategy would.',
  crypto_mfi_engulfing: ENGULFING_PATTERN_CAVEAT,
  crypto_mfi_engulfing_sl: ENGULFING_PATTERN_CAVEAT,
  crypto_holy_grail_adx_sma_bb: HOLY_GRAIL_PATTERN_CAVEAT,
  crypto_holy_grail_adx_sma_bb_sl: HOLY_GRAIL_PATTERN_CAVEAT,
};

export function getAdapter(strategyId) {
  return ADAPTERS[strategyId] ?? null;
}
