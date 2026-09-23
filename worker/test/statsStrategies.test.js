import { describe, it, expect } from 'vitest';
import { computeStrategyStatsRow } from '../src/stats/computeStats.js';
import { handleStatsRoute } from '../src/routes/stats.js';

describe('computeStrategyStatsRow', () => {
  it('returns all-null/zero shape for an empty trade list', () => {
    const row = computeStrategyStatsRow([]);
    expect(row).toEqual({
      tradeCount: 0, wins: 0, losses: 0, breakeven: 0,
      pnlTotalUsd: null, pnlTotalR: null, winRate: null,
      expectancyUsd: null, expectancyR: null, avgPnlUsd: null,
      avgRealizedRR: null, avgPlannedRR: null, lastTradeAt: null,
      lowData: true, pnlSeries: [],
    });
  });

  it('excludes breakeven trades from the winrate denominator', () => {
    const row = computeStrategyStatsRow([
      { pnl: 10, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-01 00:00:00' },
      { pnl: -5, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-02 00:00:00' },
      { pnl: 0, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-03 00:00:00' },
    ]);
    expect(row.tradeCount).toBe(3);
    expect(row.wins).toBe(1);
    expect(row.losses).toBe(1);
    expect(row.breakeven).toBe(1);
    // 1 win / (1 win + 1 loss) = 0.5, NOT 1/3.
    expect(row.winRate).toBe(0.5);
  });

  it('computes signed realized RR correctly for long and short trades', () => {
    const row = computeStrategyStatsRow([
      // Long, favorable move of +200 over a 100-wide SL distance -> R = 2.
      { pnl: 200, entry: 100, sl: 0, tp: null, diff: 200, closedAt: '2026-01-01 00:00:00' },
      // Short, unfavorable move (diff negative) over a 50-wide SL distance -> R = -1.
      { pnl: -50, entry: 100, sl: 150, tp: null, diff: -50, closedAt: '2026-01-02 00:00:00' },
    ]);
    expect(row.avgRealizedRR).toBeCloseTo((2 + -1) / 2, 10);
    expect(row.pnlTotalR).toBeCloseTo(2 + -1, 10);
  });

  it('excludes trades with no stored SL from RR/expectancy-R, with a "-" (null) result if none have one', () => {
    const row = computeStrategyStatsRow([
      { pnl: 100, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-01 00:00:00' },
      { pnl: -50, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-02 00:00:00' },
    ]);
    expect(row.avgRealizedRR).toBeNull();
    expect(row.avgPlannedRR).toBeNull();
    expect(row.pnlTotalR).toBeNull();
    expect(row.expectancyR).toBeNull();
    // USD-side is unaffected by missing SL data.
    expect(row.expectancyUsd).not.toBeNull();
  });

  it('computes planned RR (|tp-entry|/|entry-sl|) independently of realized RR', () => {
    const row = computeStrategyStatsRow([
      { pnl: 50, entry: 100, sl: 90, tp: 130, diff: 50, closedAt: '2026-01-01 00:00:00' },
    ]);
    // Realized: diff 50 / |100-90| = 5. Planned: |130-100| / |100-90| = 3.
    expect(row.avgRealizedRR).toBeCloseTo(5, 10);
    expect(row.avgPlannedRR).toBeCloseTo(3, 10);
  });

  it('computes expectancy as winRate*avgWin - lossRate*avgLoss, in both USD and R', () => {
    const row = computeStrategyStatsRow([
      { pnl: 100, entry: 100, sl: 90, tp: null, diff: 100, closedAt: '2026-01-01 00:00:00' }, // win, R=10
      { pnl: 100, entry: 100, sl: 90, tp: null, diff: 100, closedAt: '2026-01-02 00:00:00' }, // win, R=10
      { pnl: -50, entry: 100, sl: 90, tp: null, diff: -50, closedAt: '2026-01-03 00:00:00' }, // loss, R=-5 -> |R|=5
    ]);
    // winRate=2/3, lossRate=1/3, avgWinUsd=100, avgLossUsd=50.
    expect(row.expectancyUsd).toBeCloseTo((2 / 3) * 100 - (1 / 3) * 50, 10);
    // avgWinR=10, avgLossR=5.
    expect(row.expectancyR).toBeCloseTo((2 / 3) * 10 - (1 / 3) * 5, 10);
  });

  it('treats a zero-rate side (e.g. no losses at all) as a real zero, not a missing value', () => {
    const row = computeStrategyStatsRow([
      { pnl: 100, entry: 100, sl: 90, tp: null, diff: 100, closedAt: '2026-01-01 00:00:00' },
      { pnl: 50, entry: 100, sl: 90, tp: null, diff: 50, closedAt: '2026-01-02 00:00:00' },
    ]);
    expect(row.losses).toBe(0);
    // lossRate=0, so the missing avgLoss contributes exactly 0 - expectancy
    // is fully computable, not null.
    expect(row.expectancyUsd).toBeCloseTo(1 * 75, 10); // winRate=1, avgWin=75
    expect(row.expectancyUsd).not.toBeNull();
  });

  it('returns null expectancy-R when a nonzero-rate side has no RR-bearing trades at all', () => {
    const row = computeStrategyStatsRow([
      { pnl: 100, entry: 100, sl: 90, tp: null, diff: 100, closedAt: '2026-01-01 00:00:00' }, // win, has SL
      { pnl: -50, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-02 00:00:00' }, // loss, NO SL
    ]);
    // Losses exist (lossRate>0) but none carry RR data -> can't compute, not "assume 0".
    expect(row.expectancyR).toBeNull();
    // USD side is fully computable regardless.
    expect(row.expectancyUsd).not.toBeNull();
  });

  it('flags lowData below 20 trades, not at or above it', () => {
    const nineteen = Array.from({ length: 19 }, (_, i) => ({
      pnl: 1, entry: 100, sl: null, tp: null, diff: null, closedAt: `2026-01-${String(i + 1).padStart(2, '0')} 00:00:00`,
    }));
    const twenty = [...nineteen, { pnl: 1, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-20 00:00:00' }];
    expect(computeStrategyStatsRow(nineteen).lowData).toBe(true);
    expect(computeStrategyStatsRow(twenty).lowData).toBe(false);
  });

  it('tracks the chronologically last closed_at as lastTradeAt regardless of input order', () => {
    const row = computeStrategyStatsRow([
      { pnl: 1, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-05 00:00:00' },
      { pnl: 1, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-20 00:00:00' },
      { pnl: 1, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-10 00:00:00' },
    ]);
    expect(row.lastTradeAt).toBe('2026-01-20 00:00:00');
  });

  it('collects pnlSeries in input order for the sparkline, without pre-summing it', () => {
    const row = computeStrategyStatsRow([
      { pnl: 10, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-01 00:00:00' },
      { pnl: -3, entry: 100, sl: null, tp: null, diff: null, closedAt: '2026-01-02 00:00:00' },
    ]);
    expect(row.pnlSeries).toEqual([10, -3]);
  });
});

// Fake DB scoped to this route's actual query shapes: it inspects the SQL
// text to decide which canned result set to hand back, mirroring the
// pattern already established in test/public.test.js.
function createFakeDb({ strategies, tradeRows = [], openRows = [] }) {
  return {
    prepare(sql) {
      const bound = [];
      return {
        bind(...args) {
          bound.push(...args);
          return this;
        },
        async all() {
          if (/FROM strategies/.test(sql)) return { results: strategies };
          if (/FROM backtest_trades/.test(sql)) return { results: tradeRows };
          if (/status = 'open'/.test(sql)) return { results: openRows };
          if (/FROM trades t/.test(sql)) return { results: tradeRows };
          throw new Error(`fake DB: unsupported SQL: ${sql}`);
        },
      };
    },
  };
}

describe('handleStatsRoute GET /stats/strategies', () => {
  const STRATEGIES = [{ id: 'strat-a', name: 'Strategy A', active: 1 }];

  it('400s when ?source is missing or unknown', async () => {
    const env = { DB: createFakeDb({ strategies: STRATEGIES }) };
    const res = await handleStatsRoute(
      new Request('https://worker.example/stats/strategies'),
      new URL('https://worker.example/stats/strategies'),
      env
    );
    expect(res.status).toBe(400);

    const resBad = await handleStatsRoute(
      new Request('https://worker.example/stats/strategies?source=nope'),
      new URL('https://worker.example/stats/strategies?source=nope'),
      env
    );
    expect(resBad.status).toBe(400);
  });

  it('400s on an incomplete custom range', async () => {
    const env = { DB: createFakeDb({ strategies: STRATEGIES }) };
    const url = new URL('https://worker.example/stats/strategies?source=live&range=custom&from=2026-01-01');
    const res = await handleStatsRoute(new Request(url), url, env);
    expect(res.status).toBe(400);
  });

  it('returns one row per strategy (including strategies with zero trades) for a valid source', async () => {
    const env = { DB: createFakeDb({ strategies: STRATEGIES, tradeRows: [], openRows: [] }) };
    const url = new URL('https://worker.example/stats/strategies?source=live');
    const res = await handleStatsRoute(new Request(url), url, env);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ strategyId: 'strat-a', name: 'Strategy A', tradeCount: 0, openCount: 0 });
  });

  it('groups trades by strategy_id and computes per-strategy stats', async () => {
    const tradeRows = [
      { strategy_id: 'strat-a', direction: 'long', entry: 100, sl: 90, tp: 120, pnl: 50, volume: 5, closed_at: '2026-01-01 00:00:00' },
      { strategy_id: 'strat-a', direction: 'long', entry: 100, sl: 90, tp: 120, pnl: -30, volume: 3, closed_at: '2026-01-02 00:00:00' },
      { strategy_id: null, direction: 'long', entry: 100, sl: 90, tp: 120, pnl: 999, volume: 1, closed_at: '2026-01-03 00:00:00' },
    ];
    const env = { DB: createFakeDb({ strategies: STRATEGIES, tradeRows, openRows: [] }) };
    const url = new URL('https://worker.example/stats/strategies?source=live');
    const res = await handleStatsRoute(new Request(url), url, env);
    const { data } = await res.json();
    // The unattributed (strategy_id: null) row must never be counted.
    expect(data.rows[0].tradeCount).toBe(2);
    expect(data.rows[0].pnlTotalUsd).toBeCloseTo(20, 10);
  });

  it('404s on an unknown /stats path', async () => {
    const env = { DB: createFakeDb({ strategies: STRATEGIES }) };
    const url = new URL('https://worker.example/stats/nope');
    const res = await handleStatsRoute(new Request(url), url, env);
    expect(res.status).toBe(404);
  });
});
