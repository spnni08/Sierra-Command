import { describe, it, expect } from 'vitest';
import { normalizeSymbol, normalizeTimeframe, groupStrategyStats, sessionGroupLabel } from '../src/stats/computeStats.js';
import { handleStatsRoute } from '../src/routes/stats.js';

describe('normalizeSymbol', () => {
  it('collapses known forex/index alias spellings to the canonical form', () => {
    expect(normalizeSymbol('EUR_USD')).toBe('EURUSD');
    expect(normalizeSymbol('EUR/USD')).toBe('EURUSD');
    expect(normalizeSymbol('eur_usd')).toBe('EURUSD');
    expect(normalizeSymbol('SPX')).toBe('SPX500');
    expect(normalizeSymbol('SP500')).toBe('SPX500');
    expect(normalizeSymbol('US500')).toBe('SPX500');
    expect(normalizeSymbol('NASDAQ')).toBe('NAS100');
    expect(normalizeSymbol('NDX')).toBe('NAS100');
    expect(normalizeSymbol('US100')).toBe('NAS100');
  });

  it('passes an unrecognized symbol through unchanged (uppercased)', () => {
    expect(normalizeSymbol('BTCUSDT')).toBe('BTCUSDT');
    expect(normalizeSymbol('btcusdt')).toBe('BTCUSDT');
  });

  it('maps missing/empty to "unbekannt"', () => {
    expect(normalizeSymbol(null)).toBe('unbekannt');
    expect(normalizeSymbol(undefined)).toBe('unbekannt');
    expect(normalizeSymbol('')).toBe('unbekannt');
    expect(normalizeSymbol('  ')).toBe('unbekannt');
  });
});

describe('normalizeTimeframe', () => {
  it('maps TradingView raw {{interval}} codes to human-readable labels', () => {
    expect(normalizeTimeframe('1')).toBe('1m');
    expect(normalizeTimeframe('5')).toBe('5m');
    expect(normalizeTimeframe('15')).toBe('15m');
    expect(normalizeTimeframe('30')).toBe('30m');
    expect(normalizeTimeframe('60')).toBe('1h');
    expect(normalizeTimeframe('240')).toBe('4h');
    expect(normalizeTimeframe('D')).toBe('1d');
    expect(normalizeTimeframe('W')).toBe('1w');
  });

  it('passes the backtest engine\'s own labels through unchanged', () => {
    expect(normalizeTimeframe('15m')).toBe('15m');
    expect(normalizeTimeframe('4h')).toBe('4h');
    expect(normalizeTimeframe('1d')).toBe('1d');
    expect(normalizeTimeframe('4d')).toBe('4d');
  });

  it('keeps an unrecognized-but-present value as its own distinct label, not folded into "unbekannt"', () => {
    expect(normalizeTimeframe('45')).toBe('45');
    expect(normalizeTimeframe('2H')).toBe('2H');
  });

  it('maps missing/empty to "unbekannt"', () => {
    expect(normalizeTimeframe(null)).toBe('unbekannt');
    expect(normalizeTimeframe(undefined)).toBe('unbekannt');
    expect(normalizeTimeframe('')).toBe('unbekannt');
  });
});

describe('sessionGroupLabel', () => {
  it('returns "–" for a 1d-timeframe trade instead of a real session, regardless of opened_at', () => {
    // Even an opened_at that would otherwise land squarely in a real
    // session window must not be classified — a daily candle has no
    // genuine intraday entry time.
    expect(sessionGroupLabel({ timeframe: '1d', openedAt: '2026-06-02 13:00:00' })).toBe('–');
    expect(sessionGroupLabel({ timeframe: 'D', openedAt: '2026-06-02 13:00:00' })).toBe('–'); // raw TradingView code also normalizes to 1d
  });

  it('returns a real session label for any other timeframe, including missing/unknown', () => {
    expect(sessionGroupLabel({ timeframe: '4h', openedAt: '2026-06-02 13:00:00' })).toBe('London/NY Overlap');
    expect(sessionGroupLabel({ timeframe: null, openedAt: '2026-06-02 00:00:00' })).toBe('Asia');
  });
});

describe('groupStrategyStats', () => {
  it('groups trades by key and computes the same stats computeStrategyStatsRow would, per group', () => {
    const trades = [
      { pnl: 10, entry: 100, sl: 90, tp: null, diff: 10, closedAt: '2026-01-01 00:00:00', symbol: 'BTCUSDT' },
      { pnl: -5, entry: 100, sl: 90, tp: null, diff: -5, closedAt: '2026-01-02 00:00:00', symbol: 'BTCUSDT' },
      { pnl: 20, entry: 100, sl: 90, tp: null, diff: 20, closedAt: '2026-01-03 00:00:00', symbol: 'ETHUSDT' },
    ];
    const rows = groupStrategyStats(trades, (t) => t.symbol);
    expect(rows).toHaveLength(2);
    const btc = rows.find((r) => r.key === 'BTCUSDT');
    const eth = rows.find((r) => r.key === 'ETHUSDT');
    expect(btc.tradeCount).toBe(2);
    expect(btc.pnlTotalUsd).toBeCloseTo(5, 10);
    expect(eth.tradeCount).toBe(1);
    expect(eth.pnlTotalUsd).toBeCloseTo(20, 10);
  });

  it('returns an empty array for an empty trade list', () => {
    expect(groupStrategyStats([], (t) => t.symbol)).toEqual([]);
  });
});

// Fake DB scoped to strategyDetailRoute's actual query shapes.
function createFakeDb({ strategy, tradeRows = [], openRows = [] }) {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (/FROM strategies WHERE id/.test(sql)) return strategy ?? null;
          throw new Error(`fake DB: unsupported first() SQL: ${sql}`);
        },
        async all() {
          if (/FROM backtest_trades/.test(sql)) return { results: tradeRows };
          if (/status = 'open'/.test(sql)) return { results: openRows };
          if (/FROM trades t/.test(sql)) return { results: tradeRows };
          throw new Error(`fake DB: unsupported all() SQL: ${sql}`);
        },
      };
    },
  };
}

const STRATEGY = { id: 'strat-a', name: 'Strategy A', active: 1 };

function callDetail(env, strategyId, query) {
  const url = new URL(`https://worker.example/stats/strategy/${strategyId}${query ? `?${query}` : ''}`);
  return handleStatsRoute(new Request(url), url, env);
}

describe('GET /stats/strategy/:id', () => {
  it('404s for an unknown strategy id', async () => {
    const env = { DB: createFakeDb({ strategy: null }) };
    const res = await callDetail(env, 'nope', 'source=backtest');
    expect(res.status).toBe(404);
  });

  it('400s when ?source is missing or invalid', async () => {
    const env = { DB: createFakeDb({ strategy: STRATEGY }) };
    const res = await callDetail(env, 'strat-a', '');
    expect(res.status).toBe(400);
  });

  it('groups backtest trades by asset, session, and the asset x session combination', async () => {
    const tradeRows = [
      // 13:00 UTC on a June day -> London/NY Overlap (verified in sessions.test.js).
      { id: 't1', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '15m', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 110, pnl: 10, reason: 'tp', opened_at: '2026-06-02 13:00:00', closed_at: '2026-06-02 14:00:00' },
      { id: 't2', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '15m', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 90, pnl: -10, reason: 'sl', opened_at: '2026-06-02 13:30:00', closed_at: '2026-06-02 14:30:00' },
      // 00:00 UTC -> Asia.
      { id: 't3', strategy_id: 'strat-a', symbol: 'ETHUSDT', timeframe: '1h', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 110, pnl: 10, reason: 'tp', opened_at: '2026-06-02 00:00:00', closed_at: '2026-06-02 01:00:00' },
    ];
    const env = { DB: createFakeDb({ strategy: STRATEGY, tradeRows }) };
    const res = await callDetail(env, 'strat-a', 'source=backtest&range=all');
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.overall.tradeCount).toBe(3);
    expect(data.byAsset.map((r) => r.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(data.byAsset.find((r) => r.symbol === 'BTCUSDT').tradeCount).toBe(2);
    expect(data.bySession.map((r) => r.session).sort()).toEqual(['Asia', 'London/NY Overlap']);
    expect(data.byAssetSession).toHaveLength(2);
    const btcOverlap = data.byAssetSession.find((r) => r.symbol === 'BTCUSDT' && r.session === 'London/NY Overlap');
    expect(btcOverlap.tradeCount).toBe(2);
  });

  it('normalizes symbol spellings when grouping (does not fragment byAsset)', async () => {
    const tradeRows = [
      { id: 't1', strategy_id: 'strat-a', symbol: 'EUR_USD', timeframe: '4h', direction: 'long', entry: 1, sl: 0.99, tp: 1.02, exit_price: 1.01, pnl: 10, opened_at: '2026-06-02 13:00:00', closed_at: '2026-01-01 01:00:00' },
      { id: 't2', strategy_id: 'strat-a', symbol: 'EUR/USD', timeframe: '4h', direction: 'long', entry: 1, sl: 0.99, tp: 1.02, exit_price: 1.01, pnl: 5, opened_at: '2026-06-02 13:15:00', closed_at: '2026-01-02 01:00:00' },
    ];
    const env = { DB: createFakeDb({ strategy: STRATEGY, tradeRows }) };
    const res = await callDetail(env, 'strat-a', 'source=backtest');
    const { data } = await res.json();

    // Both rows are the same asset (EURUSD) once normalized, despite
    // arriving with different raw spellings — and land in the same session
    // (both opened_at within the same London/NY Overlap window).
    expect(data.byAsset).toHaveLength(1);
    expect(data.byAsset[0].symbol).toBe('EURUSD');
    expect(data.bySession).toHaveLength(1);
    expect(data.bySession[0].session).toBe('London/NY Overlap');
    expect(data.bySession[0].tradeCount).toBe(2);
  });

  it('groups a 1d-timeframe backtest trade under "–", never a real session', async () => {
    const tradeRows = [
      { id: 't1', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '1d', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 110, pnl: 10, reason: 'tp', opened_at: '2026-06-02 13:00:00', closed_at: '2026-06-03 00:00:00' },
    ];
    const env = { DB: createFakeDb({ strategy: STRATEGY, tradeRows }) };
    const res = await callDetail(env, 'strat-a', 'source=backtest&tradesLimit=10');
    const { data } = await res.json();

    expect(data.bySession).toHaveLength(1);
    expect(data.bySession[0].session).toBe('–');
    expect(data.byAssetSession[0].session).toBe('–');
    expect(data.trades.rows[0].session).toBe('–');
  });

  it('bestCombo requires at least 10 trades and ranks by expectancyR', async () => {
    // 9 trades on BTCUSDT (London/NY Overlap, below threshold) vs 10 trades
    // on ETHUSDT (Asia, qualifies).
    const belowThreshold = Array.from({ length: 9 }, (_, i) => ({
      id: `b${i}`, strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '15m', direction: 'long',
      entry: 100, sl: 90, tp: 120, exit_price: 120, pnl: 20,
      opened_at: `2026-06-${String(i + 1).padStart(2, '0')} 13:00:00`, closed_at: `2026-06-${String(i + 1).padStart(2, '0')} 14:00:00`,
    }));
    const atThreshold = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`, strategy_id: 'strat-a', symbol: 'ETHUSDT', timeframe: '1h', direction: 'long',
      entry: 100, sl: 90, tp: 120, exit_price: 105, pnl: 5,
      opened_at: `2026-07-${String(i + 1).padStart(2, '0')} 00:00:00`, closed_at: `2026-07-${String(i + 1).padStart(2, '0')} 01:00:00`,
    }));
    const env = { DB: createFakeDb({ strategy: STRATEGY, tradeRows: [...belowThreshold, ...atThreshold] }) };
    const res = await callDetail(env, 'strat-a', 'source=backtest');
    const { data } = await res.json();

    expect(data.bestCombo).not.toBeNull();
    expect(data.bestCombo.symbol).toBe('ETHUSDT');
    expect(data.bestCombo.session).toBe('Asia');
    expect(data.bestCombo.tradeCount).toBe(10);
  });

  it('bestCombo is null when no combination reaches the 10-trade threshold', async () => {
    const tradeRows = [
      { id: 't1', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '15m', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 110, pnl: 10, opened_at: '2026-06-02 13:00:00', closed_at: '2026-01-01 01:00:00' },
    ];
    const env = { DB: createFakeDb({ strategy: STRATEGY, tradeRows }) };
    const res = await callDetail(env, 'strat-a', 'source=backtest');
    const { data } = await res.json();
    expect(data.bestCombo).toBeNull();
  });

  it('paginates and filters the trades sub-list by normalized asset/session without touching the groupings', async () => {
    const tradeRows = [
      { id: 't1', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '15m', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 110, pnl: 10, opened_at: '2026-06-02 13:00:00', closed_at: '2026-01-03 00:00:00' },
      { id: 't2', strategy_id: 'strat-a', symbol: 'ETHUSDT', timeframe: '1h', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 110, pnl: 10, opened_at: '2026-06-02 00:00:00', closed_at: '2026-01-02 00:00:00' },
      { id: 't3', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '15m', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 90, pnl: -10, opened_at: '2026-06-02 13:15:00', closed_at: '2026-01-01 00:00:00' },
    ];
    const env = { DB: createFakeDb({ strategy: STRATEGY, tradeRows }) };
    const query = `source=backtest&tradeSymbol=BTCUSDT&tradeSession=${encodeURIComponent('London/NY Overlap')}&tradesLimit=1&tradesOffset=0&tradesSort=closedAt&tradesDir=asc`;
    const res = await callDetail(env, 'strat-a', query);
    const { data } = await res.json();

    // Groupings still reflect ALL 3 trades, not just the filtered slice.
    expect(data.overall.tradeCount).toBe(3);
    // But the trades sub-list is filtered to BTCUSDT/London-NY-Overlap (2 of 3) and paginated to 1.
    expect(data.trades.total).toBe(2);
    expect(data.trades.rows).toHaveLength(1);
    expect(data.trades.rows[0].id).toBe('t3'); // earlier closedAt, ascending sort
    expect(data.trades.rows[0].realizedR).toBeCloseTo(-1, 10); // diff=-10, |entry-sl|=10
  });

  it('filters the trades sub-list by tradeWeekend', async () => {
    const tradeRows = [
      // 2026-03-28 is a Saturday.
      { id: 'weekend', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '15m', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 110, pnl: 10, opened_at: '2026-03-28 12:00:00', closed_at: '2026-03-28 13:00:00' },
      // 2026-06-02 is a Tuesday.
      { id: 'weekday', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '15m', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 110, pnl: 10, opened_at: '2026-06-02 12:00:00', closed_at: '2026-06-02 13:00:00' },
    ];
    const env = { DB: createFakeDb({ strategy: STRATEGY, tradeRows }) };
    const res = await callDetail(env, 'strat-a', 'source=backtest&tradeWeekend=true&tradesLimit=10');
    const { data } = await res.json();

    expect(data.trades.total).toBe(1);
    expect(data.trades.rows[0].id).toBe('weekend');
    expect(data.trades.rows[0].isWeekend).toBe(true);
  });

  it('every trade row also carries isWeekend even without the filter applied', async () => {
    const tradeRows = [
      { id: 'weekday', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: '15m', direction: 'long', entry: 100, sl: 90, tp: 120, exit_price: 110, pnl: 10, opened_at: '2026-06-02 12:00:00', closed_at: '2026-06-02 13:00:00' },
    ];
    const env = { DB: createFakeDb({ strategy: STRATEGY, tradeRows }) };
    const res = await callDetail(env, 'strat-a', 'source=backtest&tradesLimit=10');
    const { data } = await res.json();
    expect(data.trades.rows[0].isWeekend).toBe(false);
  });

  it('reason stays null (never guessed) for live/demo trades, and a missing (non-1d) timeframe still gets a real session', async () => {
    const tradeRows = [
      { id: 't1', strategy_id: 'strat-a', symbol: 'BTCUSDT', timeframe: null, direction: 'long', entry: 100, sl: 90, tp: 120, pnl: 10, volume: 1, opened_at: '2026-06-02 00:00:00', closed_at: '2026-06-02 01:00:00' },
    ];
    const env = { DB: createFakeDb({ strategy: STRATEGY, tradeRows, openRows: [] }) };
    const res = await callDetail(env, 'strat-a', 'source=live&tradesLimit=10');
    const { data } = await res.json();
    expect(data.trades.rows[0].reason).toBeNull();
    // Missing timeframe is 'unbekannt', not '1d' -> sessionOf() still runs.
    expect(data.bySession.find((r) => r.session === 'Asia')).toBeTruthy();
    expect(data.trades.rows[0].session).toBe('Asia');
  });
});
