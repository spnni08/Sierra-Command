// Standard technical-indicator formulas computed from a plain OHLC candle
// series, for feeding the strategy evaluate() functions in
// worker/src/strategies/ during a backtest. Each function takes the array
// of {timestamp, open, high, low, close} candles (chronological order) and
// returns a same-length array aligned by index, with NaN for indices that
// don't yet have enough history (e.g. the first 199 bars of an EMA200).

export function ema(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with a simple average of the first `period` closes, same
  // convention most charting libraries use.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function stddev(closes, period, means) {
  const out = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const mean = means[i];
    if (!Number.isFinite(mean)) continue;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - mean;
      sumSq += d * d;
    }
    out[i] = Math.sqrt(sumSq / period);
  }
  return out;
}

/** Standard Wilder-smoothed RSI. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Bollinger Bands (SMA basis + N standard deviations). */
export function bollingerBands(closes, period = 20, mult = 2) {
  const basis = sma(closes, period);
  const dev = stddev(closes, period, basis);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (Number.isFinite(basis[i]) && Number.isFinite(dev[i])) {
      upper[i] = basis[i] + mult * dev[i];
      lower[i] = basis[i] - mult * dev[i];
    }
  }
  return { basis, upper, lower };
}

/** Bollinger Bands on an EMA basis (rather than SMA) — same stddev envelope
 * math as bollingerBands(), just centered on ema(closes, period) instead of
 * sma(closes, period). Needed by strategies whose Pine source explicitly
 * uses an EMA-based band (e.g. crypto_bb_rsi_trendfilter's tight 0.2-stddev
 * trend filter), distinct from the SMA(20,2) mean-reversion bands elsewhere. */
export function emaBollingerBands(closes, period, mult) {
  const basis = ema(closes, period);
  const dev = stddev(closes, period, basis);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (Number.isFinite(basis[i]) && Number.isFinite(dev[i])) {
      upper[i] = basis[i] + mult * dev[i];
      lower[i] = basis[i] - mult * dev[i];
    }
  }
  return { basis, upper, lower };
}

/** Average True Range (Wilder-smoothed), needs high/low/close. */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const tr = new Array(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr[i] = candles[i].high - candles[i].low;
      continue;
    }
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prevAtr = sum / period;
  out[period] = prevAtr;
  for (let i = period + 1; i < candles.length; i++) {
    prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

/** Rolling max of `values` over the trailing `period` bars (inclusive of the current one). */
export function rollingMax(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    let max = -Infinity;
    for (let j = i - period + 1; j <= i; j++) max = Math.max(max, values[j]);
    out[i] = max;
  }
  return out;
}

/** Rolling min of `values` over the trailing `period` bars (inclusive of the current one). */
export function rollingMin(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    let min = Infinity;
    for (let j = i - period + 1; j <= i; j++) min = Math.min(min, values[j]);
    out[i] = min;
  }
  return out;
}

/**
 * Money Flow Index — needs volume, so only meaningful for candles that
 * carry a real `volume` field (see candles.js: CoinGecko's /market_chart
 * total_volumes). Typical price = (high+low+close)/3, which for this
 * project's synthesized crypto OHLC (open=high=low=close) is just the
 * close — not an approximation introduced here, a direct consequence of
 * that upstream simplification.
 */
export function mfi(candles, period = 14) {
  const out = new Array(candles.length).fill(NaN);
  const typicalPrice = candles.map((c) => (c.high + c.low + c.close) / 3);
  const rawFlow = candles.map((c, i) => typicalPrice[i] * c.volume);

  for (let i = period; i < candles.length; i++) {
    let posFlow = 0;
    let negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (j === 0) continue;
      if (typicalPrice[j] > typicalPrice[j - 1]) posFlow += rawFlow[j];
      else if (typicalPrice[j] < typicalPrice[j - 1]) negFlow += rawFlow[j];
    }
    if (!Number.isFinite(posFlow) || !Number.isFinite(negFlow)) continue;
    out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return out;
}

/**
 * Average Directional Index (Wilder), the standard +DM/-DM/ATR formula.
 * For this project's synthesized crypto OHLC (open=high=low=close — see
 * candles.js), high/low deltas collapse to the same close-to-close delta
 * the formula would otherwise use real wick data for; the ADX value that
 * comes out the other end is a well-defined, deterministic trend-strength
 * reading, just derived from closes only rather than true intrabar range.
 * On real OHLC (Twelve Data's forex/index candles) this is the standard
 * indicator, no caveat.
 */
export function adx(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(NaN);
  if (n <= period * 2) return out;

  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
  }

  const smooth = (arr) => {
    const s = new Array(n).fill(NaN);
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += arr[i];
    s[period] = sum;
    for (let i = period + 1; i < n; i++) s[i] = s[i - 1] - s[i - 1] / period + arr[i];
    return s;
  };
  const smTr = smooth(tr);
  const smPlusDM = smooth(plusDM);
  const smMinusDM = smooth(minusDM);

  const dx = new Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (!Number.isFinite(smTr[i]) || smTr[i] === 0) continue;
    const plusDI = (100 * smPlusDM[i]) / smTr[i];
    const minusDI = (100 * smMinusDM[i]) / smTr[i];
    const sum = plusDI + minusDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
  }

  const dxStart = period * 2;
  let dxSum = 0;
  for (let i = period; i < dxStart; i++) dxSum += Number.isFinite(dx[i]) ? dx[i] : 0;
  let prevAdx = dxSum / period;
  out[dxStart] = prevAdx;
  for (let i = dxStart + 1; i < n; i++) {
    prevAdx = (prevAdx * (period - 1) + (Number.isFinite(dx[i]) ? dx[i] : 0)) / period;
    out[i] = prevAdx;
  }
  return out;
}
