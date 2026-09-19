import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';
import { corsHeaders } from '../src/cors.js';

// Minimal stub DB: enough for getStrategies' single `.all()` call so a
// request that passes the auth gate reaches normal route handling and
// returns 200, without needing fakeD1.js's INSERT/SELECT parsing (that
// helper only covers webhook.js's simpler statement shapes).
function stubEnv(extra = {}) {
  return {
    API_ACCESS_TOKEN: 'test-token-123',
    ALLOWED_ORIGIN: 'https://sierra-command.web.app',
    DB: {
      prepare() {
        return {
          bind() { return this; },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({}),
        };
      },
    },
    ...extra,
  };
}

describe('bearer token gate (worker/src/index.js)', () => {
  it('rejects a protected route with no Authorization header', async () => {
    const env = stubEnv();
    const request = new Request('https://worker.test/api/strategies');
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a protected route with a wrong token', async () => {
    const env = stubEnv();
    const request = new Request('https://worker.test/api/strategies', {
      headers: { Authorization: 'Bearer nope' },
    });
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(401);
  });

  it('passes through to normal handling with the correct bearer token', async () => {
    const env = stubEnv();
    const request = new Request('https://worker.test/api/strategies', {
      headers: { Authorization: 'Bearer test-token-123' },
    });
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [] });
  });

  it('leaves /health, /coingecko, /twelvedata, /wavescout public with no token', async () => {
    const env = stubEnv();
    const health = await worker.fetch(new Request('https://worker.test/health'), env);
    expect(health.status).toBe(200);
  });

  it('401s consistently even when API_ACCESS_TOKEN is unset (fail closed)', async () => {
    const env = stubEnv({ API_ACCESS_TOKEN: undefined });
    const request = new Request('https://worker.test/api/strategies', {
      headers: { Authorization: 'Bearer anything' },
    });
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(401);
  });
});

describe('CORS allow-list (worker/src/cors.js)', () => {
  it('does not reflect a disallowed Origin back in Access-Control-Allow-Origin', () => {
    const env = { ALLOWED_ORIGIN: 'https://sierra-command.web.app' };
    const request = new Request('https://worker.test/api/strategies', {
      headers: { Origin: 'https://evil.example.com' },
    });
    const headers = corsHeaders(request, env);
    expect(headers['Access-Control-Allow-Origin']).not.toBe('https://evil.example.com');
  });

  it('reflects an allowed Origin', () => {
    const env = { ALLOWED_ORIGIN: 'https://sierra-command.web.app' };
    const request = new Request('https://worker.test/api/strategies', {
      headers: { Origin: 'https://sierra-command.web.app' },
    });
    const headers = corsHeaders(request, env);
    expect(headers['Access-Control-Allow-Origin']).toBe('https://sierra-command.web.app');
  });

  it('never allows a localhost Origin against a prod-shaped env (no ALLOWED_ORIGIN override)', () => {
    const env = {};
    const request = new Request('https://worker.test/api/strategies', {
      headers: { Origin: 'http://localhost:5173' },
    });
    const headers = corsHeaders(request, env);
    expect(headers['Access-Control-Allow-Origin']).not.toBe('http://localhost:5173');
  });
});
