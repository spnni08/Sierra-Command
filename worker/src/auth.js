// Single-user bearer-token gate for the Worker API, plus the short-lived
// signed session token used by the Settings PIN unlock flow (see
// routes/api.js's handleSettingsUnlock). This app has exactly one operator
// (Marvin), so there's no user table/session store — just one shared secret
// (API_ACCESS_TOKEN) that the frontend sends on every protected request, and
// a second secret (SETTINGS_PIN) gating the Settings UI specifically.

// Route prefixes that stay open with no Authorization header at all:
//  - /health: uptime checks, no sensitive data
//  - /coingecko, /twelvedata: read-only market-data proxies, no D1 access,
//    already effectively public (same data CoinGecko/TwelveData serve directly)
//  - /wavescout: read-only proxy to the separate WAVESCOUT worker's public
//    candle-check endpoint
//  - /api/public: dedicated public read surface for the separate Ground
//    Delta consumer (see routes/public.js) — already has its own optional
//    PUBLIC_TRADES_TOKEN query-param gate, deliberately separate from this
//    worker-wide bearer token since it's a different, external, read-only
//    caller. Left out of the bearer check so that gate stays in charge.
//  - /api/auth/login: the login endpoint itself has to be reachable with no
//    bearer token present — that's the whole point of it (frontend has no
//    API_ACCESS_TOKEN pasted in anymore, so there is no chicken-and-egg
//    token to send on first load). It verifies username+password itself
//    (see routes/api.js's handleLogin) and hands back a session token, so
//    leaving it out of the bearer gate doesn't skip authentication, it just
//    moves where that authentication happens.
// Everything else under /api, plus /binance, /oanda, /simulation, /backtest,
// requires the bearer token. /webhook has its own check — see
// routes/webhook.js's checkWebhookSecret and the comment in index.js.
const PUBLIC_PREFIXES = ['/health', '/coingecko', '/twelvedata', '/wavescout', '/api/public', '/api/auth/login'];

export function isPublicPath(pathname) {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(prefix));
}

// Full-string comparison (no prefix-truncation bugs) against the configured
// secret. Not constant-time — not worth the complexity for a single-user
// hobby app whose worst case is someone brute-forcing a 64-char hex token
// over HTTPS, which timing attacks don't meaningfully help with anyway.
//
// Two things satisfy this check:
//  1. The raw API_ACCESS_TOKEN, verbatim (legacy path, still supported so
//     nothing that already has that value stops working).
//  2. A short-lived HMAC-signed session token issued by either
//     /api/settings/unlock (signSettingsSession) or /api/auth/login
//     (signAppSession) — both use verifySignedSession below, just with
//     different signing secrets. This is what lets the login flow's token
//     actually authorize the rest of the app's API calls instead of needing
//     a second, parallel auth system.
export async function checkBearerToken(request, env) {
  if (!env.API_ACCESS_TOKEN) {
    // Misconfigured deploy (secret never set) — fail closed rather than
    // silently running unauthenticated.
    return false;
  }
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return false;
  const token = match[1];
  if (token === env.API_ACCESS_TOKEN) return true;
  // Not the raw token — check whether it's a valid signed session token from
  // either the PIN-unlock flow or the username/password login flow. Try both
  // secrets; a token only verifies against the one it was signed with.
  if (env.SETTINGS_PIN && (await verifySignedSession(token, env.SETTINGS_PIN))) return true;
  if (env.APP_PASSWORD_HASH && (await verifySignedSession(token, env.APP_PASSWORD_HASH))) return true;
  return false;
}

export function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

// --- Settings-unlock session token -----------------------------------
// On a correct PIN, /api/settings/unlock hands back a short-lived token
// binding an expiry timestamp, HMAC-signed with SETTINGS_PIN so no extra
// secret or storage is needed. Format: "<base64(payloadJson)>.<base64(hmac)>".
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function toBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(str) {
  const bin = atob(str);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// Generic signer/verifier underneath both signSettingsSession (keyed on
// SETTINGS_PIN) and signAppSession (keyed on APP_PASSWORD_HASH) — same
// token shape, same TTL, just a different HMAC secret per caller so a
// PIN-unlock token and a login token aren't interchangeable by accident
// (they don't need to be; both are separately accepted by checkBearerToken
// above).
async function signSession(secret) {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${toBase64(new TextEncoder().encode(payload))}.${toBase64(new Uint8Array(sig))}`;
}

async function verifySignedSession(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payloadB64, sigB64] = token.split('.');
  try {
    const payloadBytes = fromBase64(payloadB64);
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, fromBase64(sigB64), payloadBytes);
    if (!valid) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(payloadBytes));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

export async function signSettingsSession(env) {
  return signSession(env.SETTINGS_PIN);
}

export async function verifySettingsSession(token, env) {
  return verifySignedSession(token, env.SETTINGS_PIN);
}

// Login-issued session token (see routes/api.js's handleLogin), signed with
// APP_PASSWORD_HASH so it needs no secret beyond the two already required
// for login itself. checkBearerToken above accepts this as a valid bearer
// token for every protected route, not just a Settings-page soft gate.
export async function signAppSession(env) {
  return signSession(env.APP_PASSWORD_HASH);
}

export async function verifyAppSession(token, env) {
  return verifySignedSession(token, env.APP_PASSWORD_HASH);
}

// SHA-256 hash of the submitted password, hex-encoded — must match exactly
// how APP_PASSWORD_HASH is generated (see wrangler.toml's secrets comment
// for the matching `openssl`/node one-liner). Plain SHA-256, no per-user
// salt: this is a single fixed account, not a user table, so a salt would
// only protect against a precomputed rainbow table for this one exact
// secret, which isn't a meaningfully different threat model here.
export async function hashPassword(password) {
  const bytes = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
