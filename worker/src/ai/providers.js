// AI provider pool configuration for the ICT MTF discretionary strategy.
//
// Two groups:
//   LIVE  — racing pattern, first valid JSON response wins, latency priority.
//           Groq, Cerebras, Google AI Studio (Gemini Flash).
//           NEVER Mistral (free tier = training with user data).
//
//   HISTORY — batch/backtest use with cache priority.
//             Mistral (public market data only!), Cerebras, Google AI Studio,
//             Cloudflare Workers AI, OpenRouter (last resort).
//
// Rate limits are config, not code — change here when provider limits change.
// live_reserve: fraction of perDay the HISTORY group must never consume.
//   e.g. 0.3 = HISTORY stops at 70% usage, reserving 30% for LIVE calls.
//   LIVE always has access to the full perDay limit.
//
// Keys are Sierra-specific secrets — NEVER share with other projects:
//   SIERRA_AI_KEY_<PROVIDER_ID_UPPER>   — deployed CF Workers secret
//   SIERRA_AI_BYOK_<PROVIDER_ID_UPPER>  — user-supplied BYOK key (takes precedence)
//   Cloudflare Workers AI uses a Binding (env.AI), no key needed.

/** @typedef {{ id: string, label: string, group: 'live'|'history', priority: number, model: string, baseUrl: string|null, envKey: string|null, rateLimit: { perMinute: number, perDay: number }, live_reserve: number }} Provider */

/** @type {Provider[]} */
export const PROVIDERS = [
  // --- LIVE group (latency priority, racing) ---
  {
    id: 'groq',
    label: 'Groq',
    group: 'live',
    priority: 1,
    model: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'SIERRA_AI_KEY_GROQ',
    rateLimit: { perMinute: 30, perDay: 14400 },
    live_reserve: 0.3,
  },
  {
    id: 'cerebras_live',
    label: 'Cerebras (Live)',
    group: 'live',
    priority: 2,
    model: 'llama3.3-70b',
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'SIERRA_AI_KEY_CEREBRAS',
    rateLimit: { perMinute: 30, perDay: 14400 },
    live_reserve: 0.3,
  },
  {
    id: 'gemini_flash_live',
    label: 'Google AI Studio – Gemini Flash (Live)',
    group: 'live',
    priority: 3,
    model: 'gemini-2.0-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'SIERRA_AI_KEY_GEMINI',
    rateLimit: { perMinute: 15, perDay: 1500 },
    live_reserve: 0.3,
  },

  // --- HISTORY group (batch/cache priority) ---
  {
    id: 'mistral_history',
    label: 'Mistral (History only – public data)',
    group: 'history',
    priority: 1,
    // WARNING: Mistral free tier = training with user data. Only for
    // history/backtest with public market data. NEVER for live decisions.
    model: 'mistral-small-latest',
    baseUrl: 'https://api.mistral.ai/v1',
    envKey: 'SIERRA_AI_KEY_MISTRAL',
    rateLimit: { perMinute: 5, perDay: 500 },
    live_reserve: 0.3,
  },
  {
    id: 'cerebras_history',
    label: 'Cerebras (History)',
    group: 'history',
    priority: 2,
    model: 'llama3.3-70b',
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'SIERRA_AI_KEY_CEREBRAS',
    rateLimit: { perMinute: 30, perDay: 14400 },
    live_reserve: 0.3,
  },
  {
    id: 'gemini_flash_history',
    label: 'Google AI Studio – Gemini Flash (History)',
    group: 'history',
    priority: 3,
    model: 'gemini-2.0-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'SIERRA_AI_KEY_GEMINI',
    rateLimit: { perMinute: 15, perDay: 1500 },
    live_reserve: 0.3,
  },
  {
    id: 'cf_workers_ai',
    label: 'Cloudflare Workers AI',
    group: 'history',
    priority: 4,
    // CF Workers AI uses env.AI binding (no API key) — special handling in client.js
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    baseUrl: null,
    envKey: null, // CF binding: env.AI.run(model, messages)
    rateLimit: { perMinute: 50, perDay: 10000 },
    live_reserve: 0.3,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (Notnagel)',
    group: 'history',
    priority: 5,
    model: 'meta-llama/llama-3.3-70b-instruct',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'SIERRA_AI_KEY_OPENROUTER',
    rateLimit: { perMinute: 10, perDay: 200 },
    live_reserve: 0.3,
  },
];

/**
 * Returns providers for a given group, sorted by priority ascending.
 * @param {'live'|'history'} group
 * @returns {Provider[]}
 */
export function getProviders(group) {
  return PROVIDERS.filter((p) => p.group === group).sort((a, b) => a.priority - b.priority);
}

/**
 * Returns the API key for a provider from env secrets or BYOK.
 * Sierra-specific naming: SIERRA_AI_BYOK_<PROVIDER_ID_UPPER> takes precedence
 * over SIERRA_AI_KEY_<PROVIDER_ID_UPPER>.
 * @param {Provider} provider
 * @param {object} env Cloudflare Worker env
 * @returns {string|null}
 */
export function getApiKey(provider, env) {
  if (!provider.envKey) return null; // CF Workers AI binding
  const byokKey = `SIERRA_AI_BYOK_${provider.id.toUpperCase()}`;
  return env[byokKey] || env[provider.envKey] || null;
}
