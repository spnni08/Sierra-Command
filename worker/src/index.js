import { handleBinanceRoute } from './routes/binance.js';
import { handleOandaRoute } from './routes/oanda.js';
import { handleCoinGeckoRoute } from './routes/coingecko.js';
import { handleTwelveDataRoute } from './routes/twelvedata.js';
import { handleApiRoute } from './routes/api.js';
import { handlePublicRoute } from './routes/public.js';
import { handleSimulationRoute } from './routes/simulation.js';
import { handleWebhookRoute } from './routes/webhook.js';
import { handleBacktestRoute } from './routes/backtest.js';
import { handleWavescoutPriceRoute } from './routes/wavescout-price.js';
import { withCors, handlePreflight } from './cors.js';
import { checkOpenTrades } from './cron/checkOpenTrades.js';

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
      } else if (url.pathname.startsWith('/coingecko')) {
        response = await handleCoinGeckoRoute(request, url, env);
      } else if (url.pathname.startsWith('/twelvedata')) {
        response = await handleTwelveDataRoute(request, url, env);
      } else if (url.pathname.startsWith('/api/public')) {
        response = await handlePublicRoute(url, env);
      } else if (url.pathname.startsWith('/api')) {
        response = await handleApiRoute(request, url, env);
      } else if (url.pathname.startsWith('/simulation')) {
        response = await handleSimulationRoute(request, url, env);
      } else if (url.pathname.startsWith('/webhook')) {
        response = await handleWebhookRoute(request, url, env);
      } else if (url.pathname.startsWith('/backtest')) {
        response = await handleBacktestRoute(request, url, env);
      } else if (url.pathname.startsWith('/wavescout')) {
        response = await handleWavescoutPriceRoute(request, url, env);
      } else {
        response = Response.json({ error: 'not_found' }, { status: 404 });
      }
    } catch (err) {
      response = Response.json({ error: 'internal_error', message: err.message }, { status: 500 });
    }

    return withCors(response, request, env);
  },

  // Scheduled via wrangler.toml [triggers].crons — auto-closes open crypto
  // (Binance) trades whose SL/TP has been hit. See src/cron/checkOpenTrades.js
  // for why this is separate from checkOpenSimulatedTrades (OANDA-sim trades
  // have their own manual/scheduled check and are never touched here).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      checkOpenTrades(env).catch((err) => {
        console.error('checkOpenTrades cron failed:', err);
      })
    );
  },
};
