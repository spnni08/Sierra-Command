// crypto_ict_smc adapter — ICT / Smart Money Concepts swing-structure
// detection, implementing the same concepts validated by 40 passing tests
// in the companion tradingview-bot repo's backtest/ict_smc/concepts.py
// (fractal swing points, confirmed break-of-structure with BOS-vs-CHoCH
// classification, order blocks, and 3-candle fair value gaps), adapted here
// for this worker's data shape: single-timeframe, on the real per-bar
// O/H/L/C CoinGecko's /ohlc endpoint provides (see candles.js's
// fetchCryptoRealOhlcCandles — genuine intrabar-aggregated highs/lows at
// every supported days bucket, never flat, unlike /market_chart).
//
// This is an ORIGINAL JS implementation following the Python module's
// proven logic/thresholds — not a line-by-line port, and no LuxAlgo/Pine
// source was consulted for it (the Python module is the reference spec).
//
// Deliberately NOT reproduced here (documented in PARTIAL_ADAPTERS in
// adapters.js):
//   - HTF (4H/1H) key-level zones / htf_key_levels() and the London/NY
//     session gate — this worker fetches one series at one granularity
//     per backtest run, no separate HTF feed.
//   - SMT divergence — needs a second correlated symbol's swings aligned
//     bar-for-bar; out of scope for a single-symbol backtest adapter.
//   - Liquidity sweep — not read by strategies/cryptoIctSmc.js's factors
//     at all (only confirmations_count from {bos, ob} matters there).
//
// confirmations_count here is therefore counted over {bos, ob} only (max
// 2), matching strategy.py's confirmation_set default of ("bos","ob","smt")
// minus the "smt" leg this adapter can't compute — min_confirmations stays
// 2, so both must fire together, same AND-strength as the reference spec's
// default before SMT is considered.
import { atr as computeAtr } from './indicators.js';

const ICT_PARAMS = {
  swingLeft: 5,
  swingRight: 5,
  bosCloseConfirmation: true,
  fvgMinGapAtrMult: 0.3,
  fvgAtrLen: 14,
  obImpulseMinAtrMult: 1.5,
  obAtrLen: 14,
  obLookback: 1,
  zoneTolerancePct: 0.05,
};

// Fractal swing high/low — bar i is a swing high iff high[i] is the strict
// max over [i-left, i+right] (swing low: strict min on lows). Only
// knowable once bar i+right has closed, matching concepts.py's
// swing_points()/confirmed_idx contract.
function swingPoints(candles, left, right) {
  const n = candles.length;
  const swings = []; // { idx, confirmedIdx, type: 'high'|'low', price }
  for (let i = left; i < n - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) swings.push({ idx: i, confirmedIdx: i + right, type: 'high', price: candles[i].high });
    if (isLow) swings.push({ idx: i, confirmedIdx: i + right, type: 'low', price: candles[i].low });
  }
  swings.sort((a, b) => a.idx - b.idx);
  return swings;
}

// Break of structure / CHoCH — bar-by-bar state machine over the swing
// sequence, mirroring concepts.py's break_of_structure(): trend is "up"
// once the last two confirmed swings are HH+HL, "down" once LH+LL,
// otherwise carried forward unchanged. A bullish break of the latest
// confirmed swing high is a CHoCH iff trend was "down" (continuation BOS
// otherwise); symmetric for bearish breaks against swing lows. Only the
// first bar that breaks a given swing level counts.
function breakOfStructure(candles, swings, closeConfirmation) {
  const n = candles.length;
  const events = new Array(n); // events[i] = { bullish: 'BOS'|'CHoCH'|null, bearish: ... }
  for (let i = 0; i < n; i++) events[i] = { bullish: null, bearish: null };

  let trend = 'unknown';
  const highHistory = [];
  const lowHistory = [];
  const brokenHighIdxs = new Set();
  const brokenLowIdxs = new Set();
  let lastConfirmedHigh = null; // { idx, price }
  let lastConfirmedLow = null;

  for (let i = 0; i < n; i++) {
    for (const s of swings) {
      if (s.confirmedIdx !== i) continue;
      if (s.type === 'high') {
        highHistory.push(s.price);
        lastConfirmedHigh = { idx: s.idx, price: s.price };
      } else {
        lowHistory.push(s.price);
        lastConfirmedLow = { idx: s.idx, price: s.price };
      }
    }
    if (highHistory.length >= 2 && lowHistory.length >= 2) {
      const hh = highHistory[highHistory.length - 1] > highHistory[highHistory.length - 2];
      const lh = highHistory[highHistory.length - 1] < highHistory[highHistory.length - 2];
      const hl = lowHistory[lowHistory.length - 1] > lowHistory[lowHistory.length - 2];
      const ll = lowHistory[lowHistory.length - 1] < lowHistory[lowHistory.length - 2];
      if (hh && hl) trend = 'up';
      else if (lh && ll) trend = 'down';
      // mixed structure (HH+LL or LH+HL): trend carried forward unchanged.
    }

    if (lastConfirmedHigh && !brokenHighIdxs.has(lastConfirmedHigh.idx)) {
      const broken = closeConfirmation ? candles[i].close > lastConfirmedHigh.price : candles[i].high > lastConfirmedHigh.price;
      if (broken) {
        brokenHighIdxs.add(lastConfirmedHigh.idx);
        const isChoch = trend === 'down';
        events[i].bullish = isChoch ? 'CHoCH' : 'BOS';
        if (isChoch) trend = 'up';
      }
    }
    if (lastConfirmedLow && !brokenLowIdxs.has(lastConfirmedLow.idx)) {
      const broken = closeConfirmation ? candles[i].close < lastConfirmedLow.price : candles[i].low < lastConfirmedLow.price;
      if (broken) {
        brokenLowIdxs.add(lastConfirmedLow.idx);
        const isChoch = trend === 'up';
        events[i].bearish = isChoch ? 'CHoCH' : 'BOS';
        if (isChoch) trend = 'down';
      }
    }
  }
  return events;
}

// Order block — last opposite-color candle (within obLookback bars) before
// an impulsive move (range >= obImpulseMinAtrMult * ATR(obAtrLen)),
// mirroring concepts.py's order_block(). Returns, per bar i, the
// active (unmitigated, confirmed) bullish/bearish OB zone overlapping that
// bar's close, if any.
function orderBlockZonesAt(candles, atrSeries, params) {
  const n = candles.length;
  const obs = []; // { direction, top, bottom, confirmedIdx, mitigatedIdx }
  for (let i = 1; i < n; i++) {
    const a = atrSeries[i];
    if (!Number.isFinite(a)) continue;
    const range = candles[i].high - candles[i].low;
    if (!(range >= params.obImpulseMinAtrMult * a)) continue;

    const bullishImpulse = candles[i].close > candles[i].open;
    let obIdx = null;
    for (let j = i - 1; j >= Math.max(i - 1 - params.obLookback, 0); j--) {
      const bearishCandle = candles[j].close < candles[j].open;
      const bullishCandle = candles[j].close > candles[j].open;
      if (bullishImpulse && bearishCandle) { obIdx = j; break; }
      if (!bullishImpulse && bullishCandle) { obIdx = j; break; }
    }
    if (obIdx === null) continue;

    const top = candles[obIdx].high;
    const bottom = candles[obIdx].low;
    let mitigatedIdx = null;
    for (let j = i + 1; j < n; j++) {
      if (bullishImpulse && candles[j].low <= top) { mitigatedIdx = j; break; }
      if (!bullishImpulse && candles[j].high >= bottom) { mitigatedIdx = j; break; }
    }
    obs.push({ direction: bullishImpulse ? 'bullish' : 'bearish', top, bottom, confirmedIdx: i, mitigatedIdx });
  }

  // Per-bar lookup: which OBs are confirmed and not yet mitigated at bar i.
  // The mitigation bar itself is INCLUDED (mitigation is defined as "price
  // trades back into the zone" — that bar IS the zone-touch signal, not
  // one bar too late to see it), matching concepts.py's mitigated_idx
  // semantics used by strategy.py's entry_confirmations() overlap check.
  const activeAt = new Array(n).fill(null).map(() => []);
  for (const ob of obs) {
    const end = ob.mitigatedIdx ?? n - 1; // inclusive; still active through the last bar if never mitigated
    for (let i = ob.confirmedIdx; i <= end && i < n; i++) activeAt[i].push(ob);
  }
  return activeAt;
}

// 3-candle fair value gap, mirroring concepts.py's fair_value_gap(): for
// candles (i, i+1, i+2), bullish gap = high[i] < low[i+2], bearish gap =
// low[i] > high[i+2]; gap size gated on ATR(fvgAtrLen) at the confirming
// candle i+2. Returns per-bar active (unmitigated) FVGs the same way
// orderBlockZonesAt does for order blocks.
function fvgZonesAt(candles, atrSeries, params) {
  const n = candles.length;
  const gaps = [];
  for (let i = 0; i <= n - 3; i++) {
    const c3 = i + 2;
    const a = atrSeries[c3];
    if (!Number.isFinite(a)) continue;
    const minGap = params.fvgMinGapAtrMult * a;

    if (candles[i].high < candles[c3].low) {
      const bottom = candles[i].high;
      const top = candles[c3].low;
      if (top - bottom >= minGap) gaps.push({ direction: 'bullish', top, bottom, confirmedIdx: c3, mitigatedIdx: null });
    }
    if (candles[i].low > candles[c3].high) {
      const bottom = candles[c3].high;
      const top = candles[i].low;
      if (top - bottom >= minGap) gaps.push({ direction: 'bearish', top, bottom, confirmedIdx: c3, mitigatedIdx: null });
    }
  }
  for (const g of gaps) {
    for (let j = g.confirmedIdx + 1; j < n; j++) {
      if (g.direction === 'bullish' && candles[j].low <= g.top) { g.mitigatedIdx = j; break; }
      if (g.direction === 'bearish' && candles[j].high >= g.bottom) { g.mitigatedIdx = j; break; }
    }
  }
  const activeAt = new Array(n).fill(null).map(() => []);
  for (const g of gaps) {
    const end = g.mitigatedIdx ?? n - 1; // inclusive, same rationale as orderBlockZonesAt
    for (let i = g.confirmedIdx; i <= end && i < n; i++) activeAt[i].push(g);
  }
  return activeAt;
}

export function buildCryptoIctSmc(candles) {
  const params = ICT_PARAMS;
  const atrSeries = computeAtr(candles, params.fvgAtrLen); // same period reused for OB (both 14 per ICTParams defaults)
  const swings = swingPoints(candles, params.swingLeft, params.swingRight);
  const bosEvents = breakOfStructure(candles, swings, params.bosCloseConfirmation);
  const obActiveAt = orderBlockZonesAt(candles, atrSeries, params);
  const fvgActiveAt = fvgZonesAt(candles, atrSeries, params);

  return function signalAt(i, direction) {
    if (!Number.isFinite(atrSeries[i])) return null;
    const close = candles[i].close;
    const wantBullish = direction === 'long';
    const wantBearish = direction === 'short';
    if (!wantBullish && !wantBearish) return null;

    const bosKind = wantBullish ? bosEvents[i].bullish : bosEvents[i].bearish;
    const bosHit = !!bosKind;

    const wantDir = wantBullish ? 'bullish' : 'bearish';
    const obHit = obActiveAt[i].some((ob) => ob.direction === wantDir && ob.bottom <= close && close <= ob.top);
    // fvg_hit: does an active (unmitigated), same-direction FVG exist as of
    // this bar at all — NOT gated on price currently sitting inside it (a
    // freshly-confirmed gap is, by construction, just behind the impulsive
    // move that created it, not under the current price yet; mitigation —
    // price trading back into it — is a separate later event, tracked via
    // fvgActiveAt's own confirmedIdx..mitigatedIdx window).
    const fvgHit = fvgActiveAt[i].some((g) => g.direction === wantDir);

    // "HTF zone touch" has no separate HTF feed here (see header comment) —
    // approximated by the LTF's own active OB/FVG zone touch, i.e. a
    // smart-money zone of the requested direction is currently in play
    // (order block: price actually inside it; FVG: a same-direction gap is
    // still open/unmitigated). Documented as a simplification in
    // PARTIAL_ADAPTERS.
    const htfZoneTouch = obHit || fvgHit;
    const confirmationsCount = (bosHit ? 1 : 0) + (obHit ? 1 : 0);

    return {
      direction,
      close,
      price: close,
      htf_zone_touch: htfZoneTouch,
      confirmations_count: confirmationsCount,
      min_confirmations: 2,
      bos_kind: bosKind,
      order_block_hit: obHit,
      fvg_hit: fvgHit,
    };
  };
}
