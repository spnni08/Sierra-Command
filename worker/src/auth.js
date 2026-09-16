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
// Everything else under /api, plus /binance, /oanda, /simulation, /backtest,
// requires the bearer token. /webhook has its own check — see
// routes/webhook.js's checkWebhookSecret and the comment in index.js.
const PUBLIC_PREFIXES = ['/health', '/coingecko', '/twelvedata', '/wavescout', '/api/public'];

export function isPublicPath(pathname) {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(prefix));
}

// Full-string comparison (no prefix-truncation bugs) against the configured
// secret. Not constant-time — not worth the complexity for a single-user
// hobby app whose worst case is someone brute-forcing a 64-char hex token
// over HTTPS, which timing attacks don't meaningfully help with anyway.
export function checkBearerToken(request, env) {
  if (!env.API_ACCESS_TOKEN) {
    // Misconfigured deploy (secret never set) — fail closed rather than
    // silently running unauthenticated.
    return false;
  }
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return false;
  return match[1] === env.API_ACCESS_TOKEN;
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

export async function signSettingsSession(env) {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const key = await hmacKey(env.SETTINGS_PIN);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${toBase64(new TextEncoder().encode(payload))}.${toBase64(new Uint8Array(sig))}`;
}

export async function verifySettingsSession(token, env) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payloadB64, sigB64] = token.split('.');
  try {
    const payloadBytes = fromBase64(payloadB64);
    const key = await hmacKey(env.SETTINGS_PIN);
    const valid = await crypto.subtle.verify('HMAC', key, fromBase64(sigB64), payloadBytes);
    if (!valid) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(payloadBytes));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}
