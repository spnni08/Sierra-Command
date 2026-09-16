import { describe, it, expect } from 'vitest';
import { handlePublicRoute } from '../src/routes/public.js';

// Fake DB scoped to this module's single SELECT (trades LEFT JOIN signals
// LEFT JOIN strategies) — returns a fixed row set regardless of the actual
// WHERE clause, since the auth-gating and field-shape behavior under test
// don't depend on real filtering.
function createFakeDb(rows) {
  return {
    prepare(sql) {
      return {
        async all() {
          if (/SELECT .* FROM trades t/is.test(sql)) return { results: rows };
          throw new Error(`fake DB: unsupported SQL: ${sql}`);
        },
      };
    },
  };
}

const SAMPLE_ROWS = [
  {
    id: 'trade-1', signal_id: 'sig-1', symbol: 'BTCUSDT', direction: 'long',
    entry: 60000, sl: 59000, tp: 62000, volume: 0.1, source: 'binance_testnet',
    status: 'open', pnl: null, opened_at: '2026-09-16 08:00:00', closed_at: null,
    strategy_name: 'Holy Grail',
  },
];

describe('handlePublicRoute GET /api/public/trades', () => {
  it('returns only the documented fields, never id/signal_id/source/volume', async () => {
    const env = { DB: createFakeDb(SAMPLE_ROWS) };
    const url = new URL('https://worker.example/api/public/trades');
    const res = await handlePublicRoute(url, env);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toEqual([
      {
        symbol: 'BTCUSDT', direction: 'long', entry: 60000, sl: 59000, tp: 62000,
        status: 'open', pnl: null, strategy_name: 'Holy Grail',
        opened_at: '2026-09-16 08:00:00', closed_at: null,
      },
    ]);
    for (const row of data) {
      expect(row).not.toHaveProperty('id');
      expect(row).not.toHaveProperty('signal_id');
      expect(row).not.toHaveProperty('source');
      expect(row).not.toHaveProperty('volume');
    }
  });

  it('is open when PUBLIC_TRADES_TOKEN is not configured', async () => {
    const env = { DB: createFakeDb(SAMPLE_ROWS) };
    const url = new URL('https://worker.example/api/public/trades');
    const res = await handlePublicRoute(url, env);
    expect(res.status).toBe(200);
  });

  it('rejects a missing/wrong token when PUBLIC_TRADES_TOKEN is configured', async () => {
    const env = { DB: createFakeDb(SAMPLE_ROWS), PUBLIC_TRADES_TOKEN: 'secret123' };

    const noToken = await handlePublicRoute(new URL('https://worker.example/api/public/trades'), env);
    expect(noToken.status).toBe(401);

    const wrongToken = await handlePublicRoute(
      new URL('https://worker.example/api/public/trades?token=nope'), env
    );
    expect(wrongToken.status).toBe(401);
  });

  it('accepts the correct token when PUBLIC_TRADES_TOKEN is configured', async () => {
    const env = { DB: createFakeDb(SAMPLE_ROWS), PUBLIC_TRADES_TOKEN: 'secret123' };
    const url = new URL('https://worker.example/api/public/trades?token=secret123');
    const res = await handlePublicRoute(url, env);
    expect(res.status).toBe(200);
  });

  it('404s on an unknown /api/public path', async () => {
    const env = { DB: createFakeDb(SAMPLE_ROWS) };
    const url = new URL('https://worker.example/api/public/nope');
    const res = await handlePublicRoute(url, env);
    expect(res.status).toBe(404);
  });
});
