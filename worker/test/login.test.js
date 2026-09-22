import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';
import { hashPassword } from '../src/auth.js';

// Minimal stub DB — same shape as auth.test.js's stubEnv, needed so a
// request that passes login and then hits /api/strategies with the issued
// token reaches normal route handling and returns 200.
function stubEnv(extra = {}) {
  return {
    API_ACCESS_TOKEN: 'test-token-123',
    APP_USERNAME: 'WaveWatch',
    APP_PASSWORD_HASH: null, // filled in per-test below with the real hash
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

const TEST_PASSWORD = 'super-secret-pw';

async function envWithHash(extra = {}) {
  const APP_PASSWORD_HASH = await hashPassword(TEST_PASSWORD);
  return stubEnv({ APP_PASSWORD_HASH, ...extra });
}

function loginRequest(body) {
  return new Request('https://worker.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/login', () => {
  it('reaches the route with no Authorization header (public path)', async () => {
    const env = await envWithHash();
    const res = await worker.fetch(loginRequest({ username: 'WaveWatch', password: TEST_PASSWORD }), env);
    expect(res.status).toBe(200);
  });

  it('returns a signed session token on correct credentials', async () => {
    const env = await envWithHash();
    const res = await worker.fetch(loginRequest({ username: 'WaveWatch', password: TEST_PASSWORD }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.token).toBe('string');
    expect(body.data.token).toContain('.');
    expect(typeof body.data.expires_at).toBe('number');
  });

  it('rejects a wrong username with a generic 401', async () => {
    const env = await envWithHash();
    const res = await worker.fetch(loginRequest({ username: 'nope', password: TEST_PASSWORD }), env);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong password with a generic 401', async () => {
    const env = await envWithHash();
    const res = await worker.fetch(loginRequest({ username: 'WaveWatch', password: 'wrong' }), env);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('rejects missing fields with 401 (treated as an empty/wrong credential, not a separate validation error)', async () => {
    const env = await envWithHash();
    const res = await worker.fetch(loginRequest({}), env);
    expect(res.status).toBe(401);
  });

  it('fails closed when APP_USERNAME/APP_PASSWORD_HASH are unset (misconfigured deploy)', async () => {
    const env = stubEnv({ APP_USERNAME: undefined, APP_PASSWORD_HASH: undefined });
    const res = await worker.fetch(loginRequest({ username: 'WaveWatch', password: TEST_PASSWORD }), env);
    expect(res.status).toBe(401);
  });

  it('the issued token then authorizes a protected route (/api/strategies)', async () => {
    const env = await envWithHash();
    const loginRes = await worker.fetch(loginRequest({ username: 'WaveWatch', password: TEST_PASSWORD }), env);
    const { data } = await loginRes.json();

    const protectedRes = await worker.fetch(
      new Request('https://worker.test/api/strategies', {
        headers: { Authorization: `Bearer ${data.token}` },
      }),
      env
    );
    expect(protectedRes.status).toBe(200);
    const body = await protectedRes.json();
    expect(body).toEqual({ data: [] });
  });

  it('an invalid token still gets rejected on a protected route', async () => {
    const env = await envWithHash();
    const res = await worker.fetch(
      new Request('https://worker.test/api/strategies', {
        headers: { Authorization: 'Bearer garbage.notarealtoken' },
      }),
      env
    );
    expect(res.status).toBe(401);
  });

  it('the issued token still authorizes a protected route when API_ACCESS_TOKEN is unset (login-only deploy)', async () => {
    const env = await envWithHash({ API_ACCESS_TOKEN: undefined });
    const loginRes = await worker.fetch(loginRequest({ username: 'WaveWatch', password: TEST_PASSWORD }), env);
    expect(loginRes.status).toBe(200);
    const { data } = await loginRes.json();

    const protectedRes = await worker.fetch(
      new Request('https://worker.test/api/strategies', {
        headers: { Authorization: `Bearer ${data.token}` },
      }),
      env
    );
    expect(protectedRes.status).toBe(200);
  });
});
