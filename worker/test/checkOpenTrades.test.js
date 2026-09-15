import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkOpenTrades, evaluateExit } from '../src/cron/checkOpenTrades.js';

// Minimal in-memory D1 fake tailored to this module's SQL (SELECT ... WHERE
// status = 'open' AND source IN (...), UPDATE trades SET ..., INSERT INTO
// activity_log ...). Separate from test/fakeD1.js, which is explicitly
// scoped to webhook.js's simpler INSERT/SELECT-by-id SQL only.
function createFakeDb(trades) {
  const tables = { trades: [...trades], activity_log: [] };

  return {
    tables,
    prepare(sql) {
      return {
        _args: [],
        bind(...args) {
          this._args = args;
          return this;
        },
        async all() {
          if (/SELECT \* FROM trades WHERE status = 'open' AND source IN/i.test(sql)) {
            const sources = this._args;
            return {
              results: tables.trades.filter(
                (t) => t.status === 'open' && sources.includes(t.source)
              ),
            };
          }
          throw new Error(`fake DB: unsupported .all() SQL: ${sql}`);
        },
        async run() {
          if (/^\s*UPDATE trades SET status/i.test(sql)) {
            const [pnl, closedAt, id] = this._args;
            const row = tables.trades.find((t) => t.id === id);
            if (row) {
              row.status = 'closed';
              row.pnl = pnl;
              row.closed_at = closedAt;
            }
            return {};
          }
          if (/^\s*INSERT INTO activity_log/i.test(sql)) {
            const [id, source, message, timestamp, relatedTradeId] = this._args;
            tables.activity_log.push({ id, source, message, timestamp, related_trade_id: relatedTradeId });
            return {};
          }
          throw new Error(`fake DB: unsupported .run() SQL: ${sql}`);
        },
      };
    },
  };
}

function baseTrade(overrides) {
  return {
    id: 'trd-1',
    signal_id: null,
    symbol: 'BTC',
    direction: 'long',
    entry: 100,
    sl: 90,
    tp: 120,
    volume: 1,
    source: 'binance_testnet',
    status: 'open',
    pnl: null,
    exit_mode: 'fixed',
    opened_at: '2026-09-15 00:00:00',
    closed_at: null,
    ...overrides,
  };
}

describe('evaluateExit', () => {
  it('long trade: SL hit', () => {
    const trade = baseTrade({ direction: 'long', sl: 90, tp: 120 });
    expect(evaluateExit(trade, 89)).toEqual({ reason: 'sl', fillPrice: 90 });
  });

  it('long trade: TP hit', () => {
    const trade = baseTrade({ direction: 'long', sl: 90, tp: 120 });
    expect(evaluateExit(trade, 121)).toEqual({ reason: 'tp', fillPrice: 120 });
  });

  it('short trade: SL hit (price rises above SL)', () => {
    const trade = baseTrade({ direction: 'short', entry: 100, sl: 110, tp: 80 });
    expect(evaluateExit(trade, 111)).toEqual({ reason: 'sl', fillPrice: 110 });
  });

  it('short trade: TP hit (price falls to/below TP)', () => {
    const trade = baseTrade({ direction: 'short', entry: 100, sl: 110, tp: 80 });
    expect(evaluateExit(trade, 79)).toEqual({ reason: 'tp', fillPrice: 80 });
  });

  it('trailing-SL trade: trailing stop hit reports reason=trailing_stop', () => {
    const trade = baseTrade({ direction: 'long', exit_mode: 'trailing', sl: 95, tp: 130 });
    expect(evaluateExit(trade, 94)).toEqual({ reason: 'trailing_stop', fillPrice: 95 });
  });

  it('neither SL nor TP hit: stays open (returns null)', () => {
    const trade = baseTrade({ direction: 'long', sl: 90, tp: 120 });
    expect(evaluateExit(trade, 105)).toBeNull();
  });
});

describe('checkOpenTrades', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('closes a long trade on SL hit with negative pnl and logs activity', async () => {
    const trade = baseTrade({ id: 'trd-long-sl', symbol: 'BTC', direction: 'long', entry: 100, sl: 90, tp: 120, volume: 2 });
    const db = createFakeDb([trade]);
    const env = { DB: db, WAVESCOUT_API_URL: 'https://example.test' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candles: [{ close: 85 }] }),
    });

    const result = await checkOpenTrades(env);

    expect(result.checked).toBe(1);
    expect(result.closed).toEqual([{ id: 'trd-long-sl', symbol: 'BTC', reason: 'sl', fillPrice: 90, pnl: -20 }]);
    const row = db.tables.trades.find((t) => t.id === 'trd-long-sl');
    expect(row.status).toBe('closed');
    expect(row.pnl).toBe(-20);
    expect(db.tables.activity_log).toHaveLength(1);
    expect(db.tables.activity_log[0].message).toMatch(/SL hit/);
  });

  it('closes a long trade on TP hit with positive pnl', async () => {
    const trade = baseTrade({ id: 'trd-long-tp', symbol: 'BTC', direction: 'long', entry: 100, sl: 90, tp: 120, volume: 1 });
    const db = createFakeDb([trade]);
    const env = { DB: db, WAVESCOUT_API_URL: 'https://example.test' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candles: [{ close: 125 }] }),
    });

    const result = await checkOpenTrades(env);
    expect(result.closed).toEqual([{ id: 'trd-long-tp', symbol: 'BTC', reason: 'tp', fillPrice: 120, pnl: 20 }]);
  });

  it('closes a short trade on SL hit with negative pnl', async () => {
    const trade = baseTrade({ id: 'trd-short-sl', symbol: 'ETH', direction: 'short', entry: 100, sl: 110, tp: 80, volume: 1 });
    const db = createFakeDb([trade]);
    const env = { DB: db, WAVESCOUT_API_URL: 'https://example.test' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candles: [{ close: 115 }] }),
    });

    const result = await checkOpenTrades(env);
    expect(result.closed).toEqual([{ id: 'trd-short-sl', symbol: 'ETH', reason: 'sl', fillPrice: 110, pnl: -10 }]);
  });

  it('closes a short trade on TP hit with positive pnl', async () => {
    const trade = baseTrade({ id: 'trd-short-tp', symbol: 'ETH', direction: 'short', entry: 100, sl: 110, tp: 80, volume: 1 });
    const db = createFakeDb([trade]);
    const env = { DB: db, WAVESCOUT_API_URL: 'https://example.test' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candles: [{ close: 75 }] }),
    });

    const result = await checkOpenTrades(env);
    expect(result.closed).toEqual([{ id: 'trd-short-tp', symbol: 'ETH', reason: 'tp', fillPrice: 80, pnl: 20 }]);
  });

  it('closes a trailing-SL trade whose trailing stop was hit', async () => {
    const trade = baseTrade({
      id: 'trd-trail',
      symbol: 'SOL',
      direction: 'long',
      exit_mode: 'trailing',
      entry: 100,
      sl: 95,
      tp: 130,
      volume: 3,
    });
    const db = createFakeDb([trade]);
    const env = { DB: db, WAVESCOUT_API_URL: 'https://example.test' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candles: [{ close: 94 }] }),
    });

    const result = await checkOpenTrades(env);
    expect(result.closed).toEqual([{ id: 'trd-trail', symbol: 'SOL', reason: 'trailing_stop', fillPrice: 95, pnl: -15 }]);
    expect(db.tables.activity_log[0].message).toMatch(/Trailing-SL hit/);
  });

  it('leaves a trade open when price has not reached SL or TP', async () => {
    const trade = baseTrade({ id: 'trd-open', symbol: 'BTC', direction: 'long', entry: 100, sl: 90, tp: 120, volume: 1 });
    const db = createFakeDb([trade]);
    const env = { DB: db, WAVESCOUT_API_URL: 'https://example.test' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candles: [{ close: 105 }] }),
    });

    const result = await checkOpenTrades(env);
    expect(result.closed).toEqual([]);
    const row = db.tables.trades.find((t) => t.id === 'trd-open');
    expect(row.status).toBe('open');
    expect(db.tables.activity_log).toHaveLength(0);
  });

  it('never touches oanda_demo_simulated trades (avoids double-processing)', async () => {
    const cryptoTrade = baseTrade({ id: 'trd-crypto', symbol: 'BTC', sl: 90, tp: 120 });
    const oandaSimTrade = baseTrade({
      id: 'trd-oanda-sim',
      symbol: 'EURUSD',
      source: 'oanda_demo_simulated',
      sl: 90,
      tp: 120,
    });
    const db = createFakeDb([cryptoTrade, oandaSimTrade]);
    const env = { DB: db, WAVESCOUT_API_URL: 'https://example.test' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candles: [{ close: 85 }] }),
    });

    const result = await checkOpenTrades(env);
    expect(result.checked).toBe(1); // only the crypto trade is even loaded
    expect(result.closed.map((c) => c.id)).toEqual(['trd-crypto']);
    const oandaRow = db.tables.trades.find((t) => t.id === 'trd-oanda-sim');
    expect(oandaRow.status).toBe('open'); // untouched
  });
});
