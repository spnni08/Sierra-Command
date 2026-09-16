// Allowed frontend origins. These are the deployed prod frontend domains
// only — never localhost — so a deployed worker (which always has one of
// [vars]/[env.production].ALLOWED_ORIGIN set, see wrangler.toml) never
// accepts a localhost Origin no matter what. Local dev's origin comes solely
// from ALLOWED_ORIGIN via [env.dev.vars] below, so localhost is reachable
// only through `wrangler dev`, never through a deployed worker.
const PROD_ALLOWED_ORIGINS = [
  'https://sierra-command.web.app',
  'https://sierra-command.firebaseapp.com',
  'https://sierra-command-1.web.app',
  'https://sierra-command-1.firebaseapp.com',
  // Ground Delta's trade panel (GET /api/public/trades only) — a separate
  // project/Cloudflare account/D1 instance, read-only consumer.
  'https://ground-delta-journal.web.app',
  'https://ground-delta-journal.firebaseapp.com',
];

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN
    ? [env.ALLOWED_ORIGIN, ...PROD_ALLOWED_ORIGINS]
    : PROD_ALLOWED_ORIGINS;

  const isAllowed = allowed.includes(origin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

export function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request, env);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

export function handlePreflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}
