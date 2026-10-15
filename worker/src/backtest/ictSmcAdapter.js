// crypto_ict_smc adapter — bar-by-bar port of the LIVE entry logic in
// tradingview-bot/pinescript/strategies/crypto_ict_smc.pine (the file that
// actually fires the production alerts), on the real O/H/L/C CoinGecko's
// /ohlc endpoint provides (see candles.js's fetchCryptoRealOhlcCandles).
//
// Rules reproduced from the Pine source, with its defaults (no parameter is
// invented here — every number below is a Pine input default):
//   - Swing high/low: fractal pivot, 5 left / 5 right, confirmed only once
//     the 5th right-hand bar has closed (ta.pivothigh/pivotlow semantics).
//   - Trend state machine: last two swing highs AND last two swing lows both
//     rising -> "up", both falling -> "down", mixed -> unchanged.
//   - BOS / CHoCH: a CLOSE beyond the last confirmed opposite swing; CHoCH
//     iff the trend was against the break, else continuation BOS. A swing
//     level is broken at most once (compared by price, like Pine). Any break
//     sets the trend to the break direction (Pine: structureTrend := ...).
//   - Fair value gap: 3-candle imbalance (bull: high[i-2] < low[i]; bear:
//     low[i-2] > high[i]) with size >= 0.3 * ATR(14). Pine keeps only the
//     most recent gap per direction; it is mitigated by the first LATER bar
//     trading back into it (low <= top / high >= bottom).
//   - Order block: impulse candle (range >= 1.5 * ATR(14), body direction by
//     close vs open) -> the opposite-colour candle within obLookback(1) bars
//     before it. Only the most recent block per direction is kept; mitigated
//     by the first bar trading back through it, except on its own impulse bar.
//   - Retest entry: a BOS/CHoCH "arms" the setup for retestWindowBars (20)
//     bars. The trigger is armed AND zone touch (active FVG touched, or
//     active OB touched with close back inside) AND confirmations >= 2, with
//     confirmations = {armed BOS/CHoCH, OB hit, SMT}. The setup is consumed
//     the bar it fires. Zone state is snapshotted BEFORE mitigation on each
//     bar, as the Pine does, so the touching bar can still count.
//
// NOT reproduced (see PARTIAL_ADAPTERS in adapters.js):
//   - SMT divergence: needs a second, bar-aligned symbol's swings (Pine pulls
//     ETHUSDT via request.security). Not available here, so smt is always
//     false and the min-2 rule effectively demands BOS/CHoCH *and* OB hit —
//     stricter than live, where BOS + SMT could also qualify.
//   - Liquidity sweep, HTF equilibrium, htf_zone_type: Pine computes them as
//     payload telemetry only; none of them gates the entry, so they are not
//     needed to reproduce the signal.
//   - Timeframe: Pine runs on a 15m chart; CoinGecko offers 4h at best for
//     windows <= 30 days (see ADAPTER_CONSTRAINTS in adapters.js).
//
// Everything lives inside buildCryptoIctSmc on purpose: the logic-
// invalidation hash (scripts/lib/logic-invalidation-sql.mjs) is computed
// from this function's source text only, so a rule change in a helper
// declared outside it would NOT invalidate stored backtest runs.
import { atr as computeAtr } from './indicators.js';

export function buildCryptoIctSmc(candles) {
  const P = {
    swingLeft: 5,
    swingRight: 5,
    fvgMinGapAtrMult: 0.3,
    fvgAtrLen: 14,
    obImpulseMinAtrMult: 1.5,
    obAtrLen: 14,
    obLookback: 1,
    retestWindowBars: 20,
    minConfirmations: 2,
  };
  const n = candles.length;
  const atrFvg = computeAtr(candles, P.fvgAtrLen);
  const atrOb = computeAtr(candles, P.obAtrLen);

  // Per-bar, per-side results of the forward pass below.
  const side = () => ({
    zoneTouch: new Array(n).fill(false),
    fvgTouch: new Array(n).fill(false),
    obHit: new Array(n).fill(false),
    armed: new Array(n).fill(false),
    confirmations: new Array(n).fill(0),
    fired: new Array(n).fill(false),
  });
  const bull = side();
  const bear = side();
  const breakKind = new Array(n).fill(null).map(() => ({ bull: null, bear: null }));

  let lastSH = NaN, prevSH = NaN, lastSL = NaN, prevSL = NaN;
  let trend = 'unknown';
  let brokenHigh = NaN, brokenLow = NaN;
  const fvg = { bull: { top: NaN, bottom: NaN, active: false }, bear: { top: NaN, bottom: NaN, active: false } };
  const ob = { bull: { top: NaN, bottom: NaN, active: false }, bear: { top: NaN, bottom: NaN, active: false } };
  let awaitingBull = false, awaitingBullBar = -1;
  let awaitingBear = false, awaitingBearBar = -1;

  for (let i = 0; i < n; i++) {
    const c = candles[i];

    // Swing pivots: the candidate is bar i - swingRight, only knowable now.
    const cand = i - P.swingRight;
    if (cand - P.swingLeft >= 0) {
      let isHigh = true;
      let isLow = true;
      for (let j = cand - P.swingLeft; j <= i; j++) {
        if (j === cand) continue;
        if (candles[j].high >= candles[cand].high) isHigh = false;
        if (candles[j].low <= candles[cand].low) isLow = false;
      }
      if (isHigh) { prevSH = lastSH; lastSH = candles[cand].high; }
      if (isLow) { prevSL = lastSL; lastSL = candles[cand].low; }
    }
    if (Number.isFinite(lastSH) && Number.isFinite(prevSH) && Number.isFinite(lastSL) && Number.isFinite(prevSL)) {
      if (lastSH > prevSH && lastSL > prevSL) trend = 'up';
      else if (lastSH < prevSH && lastSL < prevSL) trend = 'down';
    }

    // BOS / CHoCH on a close beyond the last confirmed opposite swing.
    const bullBreak = Number.isFinite(lastSH) && c.close > lastSH && (!Number.isFinite(brokenHigh) || lastSH !== brokenHigh);
    const bearBreak = Number.isFinite(lastSL) && c.close < lastSL && (!Number.isFinite(brokenLow) || lastSL !== brokenLow);
    if (bullBreak) {
      breakKind[i].bull = trend === 'down' ? 'CHoCH' : 'BOS';
      brokenHigh = lastSH;
      trend = 'up';
    }
    if (bearBreak) {
      breakKind[i].bear = trend === 'up' ? 'CHoCH' : 'BOS';
      brokenLow = lastSL;
      trend = 'down';
    }

    // Fair value gaps (candle3 = this bar, candle1 = two bars back).
    const aF = atrFvg[i];
    const bullFvgNow = i >= 2 && Number.isFinite(aF) && candles[i - 2].high < c.low && c.low - candles[i - 2].high >= P.fvgMinGapAtrMult * aF;
    const bearFvgNow = i >= 2 && Number.isFinite(aF) && candles[i - 2].low > c.high && candles[i - 2].low - c.high >= P.fvgMinGapAtrMult * aF;
    if (bullFvgNow) { fvg.bull.top = c.low; fvg.bull.bottom = candles[i - 2].high; fvg.bull.active = true; }
    if (bearFvgNow) { fvg.bear.top = candles[i - 2].low; fvg.bear.bottom = c.high; fvg.bear.active = true; }
    const fvgBullForEntry = fvg.bull.active;
    const fvgBearForEntry = fvg.bear.active;
    if (fvg.bull.active && c.low <= fvg.bull.top && !bullFvgNow) fvg.bull.active = false;
    if (fvg.bear.active && c.high >= fvg.bear.bottom && !bearFvgNow) fvg.bear.active = false;

    // Order blocks.
    const aO = atrOb[i];
    const impulse = Number.isFinite(aO) && c.high - c.low >= P.obImpulseMinAtrMult * aO;
    const bullishImpulse = impulse && c.close > c.open;
    const bearishImpulse = impulse && c.close < c.open;
    if (bullishImpulse) {
      for (let j = 1; j <= P.obLookback && i - j >= 0; j++) {
        const p = candles[i - j];
        if (p.close < p.open) { ob.bull.top = p.high; ob.bull.bottom = p.low; ob.bull.active = true; break; }
      }
    }
    if (bearishImpulse) {
      for (let j = 1; j <= P.obLookback && i - j >= 0; j++) {
        const p = candles[i - j];
        if (p.close > p.open) { ob.bear.top = p.high; ob.bear.bottom = p.low; ob.bear.active = true; break; }
      }
    }
    const obBullForEntry = ob.bull.active;
    const obBearForEntry = ob.bear.active;
    if (ob.bull.active && c.low <= ob.bull.top && !(bullishImpulse && c.low <= ob.bull.top)) ob.bull.active = false;
    if (ob.bear.active && c.high >= ob.bear.bottom && !(bearishImpulse && c.high >= ob.bear.bottom)) ob.bear.active = false;

    // Retest window: a break arms the setup, it expires after retestWindowBars.
    if (breakKind[i].bull) { awaitingBull = true; awaitingBullBar = i; }
    if (breakKind[i].bear) { awaitingBear = true; awaitingBearBar = i; }
    if (awaitingBull && i - awaitingBullBar > P.retestWindowBars) awaitingBull = false;
    if (awaitingBear && i - awaitingBearBar > P.retestWindowBars) awaitingBear = false;

    // Entry confirmations and trigger (SMT leg unavailable -> always 0).
    const obHitBull = obBullForEntry && c.low <= ob.bull.top && c.close >= ob.bull.bottom;
    const obHitBear = obBearForEntry && c.high >= ob.bear.bottom && c.close <= ob.bear.top;
    const fvgTouchBull = fvgBullForEntry && c.low <= fvg.bull.top;
    const fvgTouchBear = fvgBearForEntry && c.high >= fvg.bear.bottom;
    const confBull = (awaitingBull ? 1 : 0) + (obHitBull ? 1 : 0);
    const confBear = (awaitingBear ? 1 : 0) + (obHitBear ? 1 : 0);
    const touchBull = fvgTouchBull || obHitBull;
    const touchBear = fvgTouchBear || obHitBear;
    const longCondition = awaitingBull && touchBull && confBull >= P.minConfirmations;
    const shortCondition = awaitingBear && touchBear && confBear >= P.minConfirmations;

    bull.zoneTouch[i] = touchBull; bull.fvgTouch[i] = fvgTouchBull; bull.obHit[i] = obHitBull;
    bull.armed[i] = awaitingBull; bull.confirmations[i] = confBull; bull.fired[i] = longCondition;
    bear.zoneTouch[i] = touchBear; bear.fvgTouch[i] = fvgTouchBear; bear.obHit[i] = obHitBear;
    bear.armed[i] = awaitingBear; bear.confirmations[i] = confBear; bear.fired[i] = shortCondition;

    // Consume the setup once it fires so one retest alerts once.
    if (longCondition) awaitingBull = false;
    if (shortCondition) awaitingBear = false;
  }

  return function signalAt(i, direction) {
    if (!Number.isFinite(atrFvg[i])) return null;
    if (direction !== 'long' && direction !== 'short') return null;
    const s = direction === 'long' ? bull : bear;
    const close = candles[i].close;
    return {
      direction,
      close,
      price: close,
      htf_zone_touch: s.zoneTouch[i],
      confirmations_count: s.confirmations[i],
      min_confirmations: P.minConfirmations,
      bos_kind: direction === 'long' ? breakKind[i].bull : breakKind[i].bear,
      retest_armed: s.armed[i],
      order_block_hit: s.obHit[i],
      fvg_hit: s.fvgTouch[i],
    };
  };
}
