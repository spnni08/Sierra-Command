import { handleBinanceRoute } from './routes/binance.js';
import { handleOandaRoute } from './routes/oanda.js';
import { handleAlphaVantageRoute } from './routes/alphavantage.js';
import { handleApiRoute } from './routes/api.js';
import { withCors, handlePreflight } from './cors.js';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return handlePreflight(request, env);
    }

    const url = new URL(request.url);
    let response;

    try {
      if (url.pathname === '/health') {
        response = Response.json({ status: 'ok', service: 'sierra-command-worker' });
      } else if (url.pathname.startsWith('/binance')) {
        response = await handleBinanceRoute(request, url, env);
      } else if (url.pathname.startsWith('/oanda')) {
        response = await handleOandaRoute(request, url, env);
      } else if (url.pathname.startsWith('/alphavantage')) {
        response = await handleAlphaVantageRoute(request, url, env);
      } else if (url.pathname.startsWith('/api')) {
        response = await handleApiRoute(request, url, env);
      } else {
        response = Response.json({ error: 'not_found' }, { status: 404 });
      }
    } catch (err) {
      response = Response.json({ error: 'internal_error', message: err.message }, { status: 500 });
    }

    return withCors(response, request, env);
  },
};
