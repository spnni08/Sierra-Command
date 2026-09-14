// crypto_sr_volume adapter — "Support & Resistance Dynamic" (LuxAlgo),
// implementing the same avg/hold_atr/os state machine validated in the
// companion tradingview-bot repo's backtest/indicators/core.py sr_dynamic()
// (itself ported 2026-07-24 from LuxAlgo's original Pine script to replace
// true Volume Profile there — see that repo's backtest/config.py comment
// dated 2026-07-24: Volume Profile needs intrabar volume-at-price
// distribution CoinGecko-style daily aggregate volume can't provide, while
// S&R Dynamic only needs price levels (close, plus real high/low for its
// ATR and wick-touch check) — no volume at all).
//
// This is an ORIGINAL JS implementation following the Python module's
// proven state machine/thresholds — not a line-by-line port, and no
// LuxAlgo/Pine source was consulted for it (the Python module is the
// reference spec).
//
// Data requirement: real per-bar high/low for ATR(50) and the wick-touch
// check (low <= upper_sup && close >= lower_sup, etc.) — this worker's flat
// /market_chart candles (open=high=low=close) make wick-touch structurally
// impossible, same issue documented for crypto_sr_bollinger's adapter. This
// strategy instead reads real O/H/L/C from CoinGecko's /ohlc endpoint (see
// candles.js's fetchCryptoRealOhlcCandles / REAL_OHLC_STRATEGY_IDS), which
// makes the wick-touch check genuinely computable — the same data source
// crypto_mfi_engulfing/crypto_holy_grail_adx_sma_bb already use.
import { atr as computeAtr, ema } from './indicators.js';

const SR_MULT = 8.0;
const SR_ATR_LEN = 50;

// Sequential state machine, mirroring core.py's _sr_dynamic_loop(): avg
// seeded to close[0], os seeded to 0. avg jumps to the current close
// whenever price has moved more than one ATR*mult ("breakout_atr") away
// from it; hold_atr freezes the breakout_atr value from the bar avg last
// jumped; os flips to 1 when avg just increased, 0 when it just decreased
// (unchanged on a tie or on bar 0, where there's no avg[-1] to compare).
function srDynamicSeries(candles, atrLen, mult) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const atrSeries = computeAtr(candles, atrLen);
  const breakoutAtr = atrSeries.map((a) => (Number.isFinite(a) ? a * mult : 0));

  const avg = new Array(n);
  const holdAtr = new Array(n);
  const os = new Array(n);

  let prevAvg = closes[0];
  let prevHoldAtr = 0;
  let prevOs = 0;

  for (let i = 0; i < n; i++) {
    const a = breakoutAtr[i];
    const c = closes[i];
    const curAvg = Math.abs(c - prevAvg) > a ? c : prevAvg;
    const curHoldAtr = curAvg === c ? a : prevHoldAtr;
    let curOs;
    if (i === 0) curOs = prevOs;
    else if (curAvg > prevAvg) curOs = 1;
    else if (curAvg < prevAvg) curOs = 0;
    else curOs = prevOs;

    avg[i] = curAvg;
    holdAtr[i] = curHoldAtr;
    os[i] = curOs;
    prevAvg = curAvg;
    prevHoldAtr = curHoldAtr;
    prevOs = curOs;
  }

  const upperRes = new Array(n).fill(NaN);
  const lowerRes = new Array(n).fill(NaN);
  const upperSup = new Array(n).fill(NaN);
  const lowerSup = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (os[i] === 0) {
      upperRes[i] = avg[i] + holdAtr[i] / mult;
      lowerRes[i] = avg[i] + holdAtr[i] / mult / 2;
    } else {
      upperSup[i] = avg[i] - holdAtr[i] / mult / 2;
      lowerSup[i] = avg[i] - holdAtr[i] / mult;
    }
  }
  return { os, upperRes, lowerRes, upperSup, lowerSup, atrSeries };
}

// EMA period for the trend filter: the strategy's own factor is
// direction-agnostic about what period fed `ema200` (it just compares
// close against whatever number is there), but a true EMA(200) never
// produces a single finite value on /ohlc's real-candle series (longest
// bucket is 92 four-day bars at days=365 — see candles.js). EMA(50) is
// used here instead so the trend filter can ever actually fire on this
// data; documented as a caveat in PARTIAL_ADAPTERS rather than silently
// relabeled as "ema200".
const TREND_EMA_PERIOD = 50;

export function buildCryptoSrVolume(candles) {
  const closes = candles.map((c) => c.close);
  const trendEma = ema(closes, TREND_EMA_PERIOD);
  const { os, upperRes, lowerRes, upperSup, lowerSup } = srDynamicSeries(candles, SR_ATR_LEN, SR_MULT);

  return function signalAt(i, direction) {
    if (!Number.isFinite(trendEma[i])) return null;
    const c = candles[i];

    // srZoneUp/srZoneDown, mirroring crypto_sr_volume.pine / core.py's
    // sr_dynamic(): wick reaches into the ATR zone, close holds at/within
    // it — the wick-touch that requires real (non-flat) high/low.
    const srZoneUp = os[i] === 1 && c.low <= upperSup[i] && c.close >= lowerSup[i];
    const srZoneDown = os[i] === 0 && c.high >= lowerRes[i] && c.close <= upperRes[i];

    const trigger = direction === 'long' ? (srZoneUp ? 'VAL_BOUNCE' : 'NONE') : srZoneDown ? 'VAH_REJECT' : 'NONE';

    return {
      direction,
      close: c.close,
      price: c.close,
      trigger,
      ema200: trendEma[i],
      sr_os: os[i],
      sr_upper_res: upperRes[i],
      sr_lower_res: lowerRes[i],
      sr_upper_sup: upperSup[i],
      sr_lower_sup: lowerSup[i],
    };
  };
}
