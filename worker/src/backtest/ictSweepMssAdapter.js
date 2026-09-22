// ict_sweep_mss / ict_sweep_mss_sl adapter — Liquidity Sweep -> Displacement
// -> Market Structure Shift (MSS) -> Fair Value Gap (FVG) -> Entry -> Target,
// the specific sequential ICT model requested for this strategy (distinct
// from crypto_ict_smc's BOS/CHoCH + order-block + FVG-existence model, which
// never reads a liquidity sweep at all — see that adapter's header comment).
// Long and short are exact mirrors of each other throughout.
//
// Unlike every other adapter in this directory, this one needs to place a
// LIMIT order at a specific structure-derived price (the FVG retracement
// level) and hold specific structure-derived SL/TP levels (sweep-low minus
// an ATR buffer; the next untouched opposing swing point) rather than a
// fixed %/ATR-multiple bracket computed at market-order entry. engine.js's
// exit.mode:'levels'/'levels_trailing' paths (added alongside this adapter,
// additive to every existing mode) read entryPrice/slPrice/tpPrice straight
// off the signal object this file returns, instead of computing them.
//
// Because the whole setup (sweep -> displacement -> MSS -> FVG -> fill ->
// invalidation) spans many bars, this is precomputed ONCE per full candle
// series (detectSetups below) rather than evaluated bar-by-bar like every
// other adapter here — the backtest has the whole series available upfront,
// so this is just as causal (every check only ever looks at bar <= the bar
// being evaluated) as a true streaming implementation, just computed in one
// forward pass instead of being re-derived from scratch on every call.
//
// All thresholds are parameterized (see DEFAULT_PARAMS) and overridable via
// strategy_settings.params_json (see worker/src/routes/api.js's
// putStrategySettings and worker/src/backtest/engine.js, which fetches and
// passes them through) — "alle Schwellen als strategy_settings
// konfigurierbar" per the task this was built for.
import { atr as computeAtr, ema as computeEma } from './indicators.js';

export const DEFAULT_PARAMS = {
  swingLeft: 3, // rule 1: pivot high/low, 3 candles left/right
  swingRight: 3,
  atrLen: 14,
  displacementAtrMult: 1.5, // rule 3: body >= 1.5x ATR(14)
  displacementBodyRatioMin: 0.6, // rule 3: body >= 60% of candle range
  displacementMaxBars: 5, // rule 3: within max 5 candles after the sweep
  mssMaxBars: 10, // rule 4: within max 10 candles after the sweep
  fvgMinAtrMult: 0.2, // rule 5: min FVG size 0.2x ATR
  entryMode: 'ce', // rule 6: 'ce' = 50% consequent-encroachment (default), 'edge' = FVG's near edge
  slAtrBuffer: 0.1, // rule 7: sweep low/high +/- 0.1x ATR buffer
  minRR: 1.5, // rule 8: discard setup if reward:risk < 1.5R
  fillMaxBars: 20, // rule 9: invalidate if no fill within 20 candles of MSS
  htfBiasFilter: false, // optional HTF bias filter, OFF by default
  htfTimeframeMinutes: 240, // "4h" bias window when htfBiasFilter is on
};

function candleBody(c) {
  return c.close - c.open;
}
function candleRange(c) {
  return c.high - c.low;
}

// Fractal pivot swing high/low, `left`/`right` candles on each side —
// confirmedIdx is when the pivot becomes knowable (i + right), matching this
// engine's existing causality convention (see ictSmcAdapter.js's
// swingPoints(), same algorithm, independently reimplemented here since it's
// not exported from that file and this strategy's default left/right (3) is
// its own rule, not crypto_ict_smc's).
function swingPoints(candles, left, right) {
  const n = candles.length;
  const highs = [];
  const lows = [];
  for (let i = left; i < n - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, confirmedIdx: i + right, price: candles[i].high });
    if (isLow) lows.push({ idx: i, confirmedIdx: i + right, price: candles[i].low });
  }
  return { highs, lows };
}

// Most recently confirmed swing (confirmedIdx <= atOrBeforeIdx) in a
// confirmedIdx-sorted list — linear scan is fine at this engine's candle
// counts (low thousands at most, see routes/backtest.js's own comment).
function lastConfirmedAtOrBefore(sortedSwings, atOrBeforeIdx) {
  let result = null;
  for (const s of sortedSwings) {
    if (s.confirmedIdx > atOrBeforeIdx) break;
    result = s;
  }
  return result;
}

// Simple in-memory HTF bias, resampled from this same candle series (no
// second fetch — the backtest engine only ever pulls one series at one
// granularity per run, same limitation documented in ictSmcAdapter.js).
// Groups consecutive bars into ~htfTimeframeMinutes buckets using the
// series' own median bar spacing, takes each bucket's close, and reads
// EMA(10)-over-EMA(10)-one-bucket-ago slope as the bias. When the series'
// own bars are already coarser than the configured HTF window (e.g. this
// strategy's crypto backtests, which run on 4h/4-day real candles — see
// candles.js's fetchCryptoRealOhlcCandles), resampling would be meaningless
// (group size would round to 1, i.e. no resampling at all), so bias is
// degenerate-neutral (never blocks a setup) in that case — documented, not
// silently wrong.
function computeHtfBiasAt(candles, htfTimeframeMinutes) {
  const n = candles.length;
  if (n < 4) return new Array(n).fill('neutral');

  const deltas = [];
  for (let i = 1; i < n; i++) deltas.push(candles[i].timestamp - candles[i - 1].timestamp);
  deltas.sort((a, b) => a - b);
  const medianMs = deltas[Math.floor(deltas.length / 2)] || 60_000;
  const htfMs = htfTimeframeMinutes * 60_000;
  const groupSize = Math.max(1, Math.round(htfMs / medianMs));

  if (groupSize < 2) return new Array(n).fill('neutral'); // series already at/coarser than the HTF window

  const groupCloseAt = new Array(n).fill(NaN);
  const groupIdxAt = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const g = Math.floor(i / groupSize);
    groupIdxAt[i] = g;
  }
  const numGroups = groupIdxAt[n - 1] + 1;
  const groupCloses = new Array(numGroups).fill(NaN);
  for (let g = 0; g < numGroups; g++) {
    const lastBarOfGroup = Math.min((g + 1) * groupSize - 1, n - 1);
    groupCloses[g] = candles[lastBarOfGroup].close;
  }
  const groupEma = computeEma(groupCloses, 10);

  const biasByGroup = new Array(numGroups).fill('neutral');
  for (let g = 1; g < numGroups; g++) {
    if (!Number.isFinite(groupEma[g]) || !Number.isFinite(groupEma[g - 1])) continue;
    if (groupEma[g] > groupEma[g - 1]) biasByGroup[g] = 'bullish';
    else if (groupEma[g] < groupEma[g - 1]) biasByGroup[g] = 'bearish';
  }

  const out = new Array(n).fill('neutral');
  for (let i = 0; i < n; i++) out[i] = biasByGroup[groupIdxAt[i]];
  return out;
}

// Builds a single candidate setup starting from a confirmed liquidity sweep
// at `sweepIdx`, or null if any required stage (displacement, MSS, FVG, a
// valid >=minRR target) never materializes — "ohne MSS kein Setup" (rule 4)
// generalizes to every required stage here, not just MSS specifically.
function buildSetup(candles, atrSeries, oppositeSwings, sweptLevel, sweepIdx, direction, params, htfBiasAt) {
  const n = candles.length;
  const isLong = direction === 'long';
  const sweepExtreme = isLong ? candles[sweepIdx].low : candles[sweepIdx].high;

  // The swing extreme (high for long/MSS, i.e. the level a bullish MSS must
  // close above; low for short) most recently confirmed before the sweep —
  // "der letzten Swing-Hoch/-Tief VOR dem Sweep" (rule 4).
  const priorStructureLevel = lastConfirmedAtOrBefore(oppositeSwings, sweepIdx);
  if (!priorStructureLevel) return null;

  // Displacement: window [sweepIdx, sweepIdx + displacementMaxBars] — the
  // sweep bar itself is included since a strong reversal candle can BE the
  // sweep candle (documented design choice, not an oversight).
  let displacementIdx = null;
  const displacementEnd = Math.min(sweepIdx + params.displacementMaxBars, n - 1);
  for (let k = sweepIdx; k <= displacementEnd; k++) {
    const a = atrSeries[k];
    if (!Number.isFinite(a)) continue;
    const body = candleBody(candles[k]);
    const range = candleRange(candles[k]);
    if (range <= 0) continue;
    const bullishBody = isLong ? body : -body;
    if (bullishBody <= 0) continue;
    if (bullishBody >= params.displacementAtrMult * a && bullishBody >= params.displacementBodyRatioMin * range) {
      displacementIdx = k;
      break;
    }
  }
  if (displacementIdx === null) return null;

  // MSS: first close beyond priorStructureLevel, scanning from the
  // displacement bar up to sweepIdx + mssMaxBars (rule 4's "max 10 Kerzen
  // nach dem Sweep" — anchored at the sweep, same anchor displacement uses).
  let mssIdx = null;
  const mssEnd = Math.min(sweepIdx + params.mssMaxBars, n - 1);
  for (let k = displacementIdx; k <= mssEnd; k++) {
    const brokeThrough = isLong ? candles[k].close > priorStructureLevel.price : candles[k].close < priorStructureLevel.price;
    if (brokeThrough) {
      mssIdx = k;
      break;
    }
  }
  if (mssIdx === null) return null; // rule 4: no MSS, no setup

  if (params.htfBiasFilter) {
    const bias = htfBiasAt[mssIdx];
    if ((isLong && bias === 'bearish') || (!isLong && bias === 'bullish')) return null;
  }

  // FVG: most recent (highest idx) qualifying 3-candle gap formed within the
  // displacement leg [displacementIdx, mssIdx] (rule 5).
  let fvg = null;
  for (let k = displacementIdx + 2; k <= mssIdx; k++) {
    const a = atrSeries[k];
    if (!Number.isFinite(a)) continue;
    if (isLong) {
      if (candles[k - 2].high < candles[k].low) {
        const bottom = candles[k - 2].high;
        const top = candles[k].low;
        if (top - bottom >= params.fvgMinAtrMult * a) fvg = { bottom, top, idx: k };
      }
    } else if (candles[k - 2].low > candles[k].high) {
      const top = candles[k - 2].low;
      const bottom = candles[k].high;
      if (top - bottom >= params.fvgMinAtrMult * a) fvg = { bottom, top, idx: k };
    }
  }
  if (!fvg) return null; // rule 5/6: no FVG, no entry level, no setup

  const midpoint = fvg.bottom + 0.5 * (fvg.top - fvg.bottom);
  const entryLevel = params.entryMode === 'edge' ? (isLong ? fvg.top : fvg.bottom) : midpoint;

  const atrAtSweep = atrSeries[sweepIdx];
  if (!Number.isFinite(atrAtSweep)) return null;
  const slPrice = isLong ? sweepExtreme - params.slAtrBuffer * atrAtSweep : sweepExtreme + params.slAtrBuffer * atrAtSweep;

  // TP: nearest untouched opposing swing point above (long) / below (short)
  // the entry level, confirmed by mssIdx and not yet exceeded by any bar
  // between its own confirmation and mssIdx (rule 8's "unberührt").
  let tp = null;
  for (const sw of oppositeSwings) {
    if (sw.confirmedIdx > mssIdx) continue;
    if (isLong ? !(sw.price > entryLevel) : !(sw.price < entryLevel)) continue;
    let touched = false;
    for (let j = sw.confirmedIdx + 1; j <= mssIdx; j++) {
      if (isLong ? candles[j].high >= sw.price : candles[j].low <= sw.price) {
        touched = true;
        break;
      }
    }
    if (touched) continue;
    if (tp === null || (isLong ? sw.price < tp : sw.price > tp)) tp = sw.price;
  }
  if (tp === null) return null;

  const risk = isLong ? entryLevel - slPrice : slPrice - entryLevel;
  const reward = isLong ? tp - entryLevel : entryLevel - tp;
  if (!(risk > 0) || !(reward / risk >= params.minRR)) return null; // rule 8: discard if < minRR

  // Fill + invalidation scan, mssIdx+1 .. mssIdx+fillMaxBars (rule 9).
  // Invalidation is checked before the fill touch on the same bar — undercutting
  // the sweep extreme or closing through the FVG's far side kills the setup
  // even if that same bar's wick also happened to tag the entry level.
  let fillIdx = null;
  const fillEnd = Math.min(mssIdx + params.fillMaxBars, n - 1);
  for (let j = mssIdx + 1; j <= fillEnd; j++) {
    const bar = candles[j];
    const sweepBroken = isLong ? bar.low < sweepExtreme : bar.high > sweepExtreme;
    const fvgBroken = isLong ? bar.close < fvg.bottom : bar.close > fvg.top;
    if (sweepBroken || fvgBroken) return null; // rule 9: invalidated before fill
    const touchedEntry = bar.low <= entryLevel && entryLevel <= bar.high;
    if (touchedEntry) {
      fillIdx = j;
      break;
    }
  }
  if (fillIdx === null) return null; // rule 9: no fill within fillMaxBars

  return {
    direction,
    sweepIdx,
    sweepExtreme,
    displacementIdx,
    mssIdx,
    fvg,
    entryLevel,
    slPrice,
    tp,
    fillIdx,
    rMultiple: reward / risk,
  };
}

function detectSetups(candles, atrSeries, swings, params, htfBiasAt) {
  const n = candles.length;
  const highsSorted = [...swings.highs].sort((a, b) => a.confirmedIdx - b.confirmedIdx);
  const lowsSorted = [...swings.lows].sort((a, b) => a.confirmedIdx - b.confirmedIdx);

  const setups = [];
  for (let i = 1; i < n; i++) {
    // Long candidate: this bar's wick sweeps below the most recently
    // confirmed swing low (SSL), and closes back above it either this bar
    // or the next (rule 2).
    const activeSsl = lastConfirmedAtOrBefore(lowsSorted, i - 1);
    if (activeSsl && candles[i].low < activeSsl.price) {
      const sameBarReclaim = candles[i].close > activeSsl.price;
      const nextBarReclaim = i + 1 < n && candles[i + 1].close > activeSsl.price;
      if (sameBarReclaim || nextBarReclaim) {
        const setup = buildSetup(candles, atrSeries, highsSorted, activeSsl, i, 'long', params, htfBiasAt);
        if (setup) setups.push(setup);
      }
    }

    // Short candidate: mirrored — sweeps above the most recently confirmed
    // swing high (SBL/BSL), closes back below it this bar or next.
    const activeSbl = lastConfirmedAtOrBefore(highsSorted, i - 1);
    if (activeSbl && candles[i].high > activeSbl.price) {
      const sameBarReclaim = candles[i].close < activeSbl.price;
      const nextBarReclaim = i + 1 < n && candles[i + 1].close < activeSbl.price;
      if (sameBarReclaim || nextBarReclaim) {
        const setup = buildSetup(candles, atrSeries, lowsSorted, activeSbl, i, 'short', params, htfBiasAt);
        if (setup) setups.push(setup);
      }
    }
  }
  return { setups, highsSorted, lowsSorted };
}

export function buildIctSweepMss(candles, settings = {}) {
  const params = { ...DEFAULT_PARAMS, ...settings };
  const atrSeries = computeAtr(candles, params.atrLen);
  const swings = swingPoints(candles, params.swingLeft, params.swingRight);
  const htfBiasAt = params.htfBiasFilter ? computeHtfBiasAt(candles, params.htfTimeframeMinutes) : null;
  const { setups, highsSorted, lowsSorted } = detectSetups(candles, atrSeries, swings, params, htfBiasAt);

  // Index setups by their fill bar — the bar the engine will actually see a
  // signal on. Ties (two setups filling the same direction on the same bar)
  // keep the first one found; a genuinely rare edge case given each setup
  // needs its own distinct sweep/MSS/FVG chain.
  const byFillIdx = new Map();
  for (const s of setups) {
    const k = `${s.fillIdx}:${s.direction}`;
    if (!byFillIdx.has(k)) byFillIdx.set(k, s);
  }

  function signalAt(i, direction) {
    const s = byFillIdx.get(`${i}:${direction}`);
    if (!s) return null;
    return {
      direction,
      close: candles[i].close,
      price: candles[i].close,
      entryPrice: s.entryLevel,
      slPrice: s.slPrice,
      tpPrice: s.tp,
      r_multiple: s.rMultiple,
      liquidity_sweep: true,
      displacement: true,
      mss: true,
      fvg_present: true,
      min_rr_ok: true,
      htf_bias_ok: true, // buildSetup already discarded any setup that failed the (optional) HTF gate
    };
  }

  // Trailing anchor for the _sl variant (engine.js's exit.mode:'levels_trailing'):
  // the most recently confirmed swing low (long) / swing high (short) as of
  // bar i — rule 10's "unter jedes neue bestätigte Swing-Tief nachziehen".
  function trailAnchorAt(i, direction) {
    const sw = direction === 'long' ? lastConfirmedAtOrBefore(lowsSorted, i) : lastConfirmedAtOrBefore(highsSorted, i);
    return sw ? sw.price : null;
  }

  return { signalAt, closeSignalAt: null, trailAnchorAt };
}
