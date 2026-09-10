// Per-asset backtest window configuration: a default lookback (used when the
// caller doesn't specify a start date) and a minimum start date (data before
// this isn't meaningful — e.g. SOL had negligible liquidity/relevance before
// 2021). Deliberately per-symbol, not one global constant, since crypto vs.
// forex/index history depth and typical review windows differ a lot.
export const ASSET_WINDOW = {
  BTCUSDT: { defaultWindowDays: 30, minStartDate: '2013-04-28' }, // CoinGecko's earliest BTC data
  ETHUSDT: { defaultWindowDays: 30, minStartDate: '2015-08-07' }, // ETH genesis
  SOLUSDT: { defaultWindowDays: 30, minStartDate: '2021-01-01' }, // pre-2021 SOL had negligible liquidity/relevance
  EURUSD: { defaultWindowDays: 90, minStartDate: '2000-01-01' },
  SPX500: { defaultWindowDays: 90, minStartDate: '2005-01-01' }, // SPY ETF proxy trading history
  NAS100: { defaultWindowDays: 90, minStartDate: '2005-01-01' }, // QQQ ETF proxy trading history
};

/**
 * Resolves the actual [start, end] Date range for a backtest request:
 * defaults `end` to now and `start` to `end - defaultWindowDays` when not
 * given, then clamps `start` up to the asset's minStartDate instead of
 * erroring — the caller gets a runnable (if shorter) backtest and a flag
 * saying the window was clamped, rather than a hard failure.
 */
export function resolveWindow(symbol, requestedStart, requestedEnd) {
  const config = ASSET_WINDOW[String(symbol ?? '').toUpperCase()];
  if (!config) return { error: `unsupported_symbol:${symbol}` };

  const end = requestedEnd ? new Date(requestedEnd) : new Date();
  const start = requestedStart
    ? new Date(requestedStart)
    : new Date(end.getTime() - config.defaultWindowDays * 86_400_000);

  const minStart = new Date(config.minStartDate);
  let clamped = false;
  let effectiveStart = start;
  if (start < minStart) {
    effectiveStart = minStart;
    clamped = true;
  }

  if (effectiveStart >= end) {
    return { error: 'invalid_window: resolved start is not before end' };
  }

  return {
    start: effectiveStart,
    end,
    clamped,
    minStartDate: config.minStartDate,
    requestedStart: requestedStart ?? null,
  };
}
