// Allowed frontend origins. ALLOWED_ORIGIN is set per-environment in wrangler.toml
// (or as a secret for prod); this list covers local dev + the Firebase-hosted domain.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://sierra-command.web.app',
  'https://sierra-command.firebaseapp.com',
  'https://sierra-command-1.web.app',
  'https://sierra-command-1.firebaseapp.com',
];

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN
    ? [env.ALLOWED_ORIGIN, ...DEFAULT_ALLOWED_ORIGINS]
    : DEFAULT_ALLOWED_ORIGINS;

  const isAllowed = allowed.includes(origin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
