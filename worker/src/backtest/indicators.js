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
