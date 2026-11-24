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
// Keys come from env secrets or BYOK (user-supplied via /api/ai-key route).
// Cloudflare Workers AI uses a Binding (env.AI), no key needed.
//
// On 429 or exhausted daily limit: skip to next provider in priority order.

/** @typedef {{ id: string, label: string, group: 'live'|'history', priority: number, model: string, baseUrl: string, envKey: string|null, rateLimit: { perMinute: number, perDay: number } }} Provider */

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
    envKey: 'AI_KEY_GROQ',
    rateLimit: { perMinute: 30, perDay: 14400 },
  },
  {
    id: 'cerebras_live',
    label: 'Cerebras (Live)',
    group: 'live',
    priority: 2,
    model: 'llama3.3-70b',
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'AI_KEY_CEREBRAS',
    rateLimit: { perMinute: 30, perDay: 14400 },
  },
  {
    id: 'gemini_flash_live',
    label: 'Google AI Studio – Gemini Flash (Live)',
    group: 'live',
    priority: 3,
    model: 'gemini-2.0-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'AI_KEY_GEMINI',
    rateLimit: { perMinute: 15, perDay: 1500 },
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
    envKey: 'AI_KEY_MISTRAL',
    rateLimit: { perMinute: 5, perDay: 500 },
  },
  {
    id: 'cerebras_history',
    label: 'Cerebras (History)',
    group: 'history',
    priority: 2,
    model: 'llama3.3-70b',
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'AI_KEY_CEREBRAS',
    rateLimit: { perMinute: 30, perDay: 14400 },
  },
  {
    id: 'gemini_flash_history',
    label: 'Google AI Studio – Gemini Flash (History)',
    group: 'history',
    priority: 3,
    model: 'gemini-2.0-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'AI_KEY_GEMINI',
    rateLimit: { perMinute: 15, perDay: 1500 },
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
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (Notnagel)',
    group: 'history',
    priority: 5,
    model: 'meta-llama/llama-3.3-70b-instruct',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'AI_KEY_OPENROUTER',
    rateLimit: { perMinute: 10, perDay: 200 },
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
 * BYOK keys are stored as env.AI_BYOK_<PROVIDER_ID_UPPER>.
 * @param {Provider} provider
 * @param {object} env Cloudflare Worker env
 * @returns {string|null}
 */
export function getApiKey(provider, env) {
  if (!provider.envKey) return null; // CF Workers AI binding
  // BYOK takes precedence over deployed secret
  const byokKey = `AI_BYOK_${provider.id.toUpperCase()}`;
  return env[byokKey] || env[provider.envKey] || null;
}
