import { handleBinanceRoute } from './routes/binance.js';
import { handleOandaRoute } from './routes/oanda.js';
import { handleCoinGeckoRoute } from './routes/coingecko.js';
import { handleTwelveDataRoute } from './routes/twelvedata.js';
import { handleApiRoute } from './routes/api.js';
import { handlePublicRoute } from './routes/public.js';
import { handleSimulationRoute } from './routes/simulation.js';
import { handleWebhookRoute } from './routes/webhook.js';
import { handleBacktestRoute } from './routes/backtest.js';
import { handleStatsRoute } from './routes/stats.js';
import { handleWavescoutPriceRoute } from './routes/wavescout-price.js';
import { withCors, handlePreflight } from './cors.js';
import { checkOpenTrades } from './cron/checkOpenTrades.js';
import { isPublicPath, checkBearerToken, unauthorized } from './auth.js';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return handlePreflight(request, env);
    }

    const url = new URL(request.url);
    let response;

    // Single-user bearer-token gate: everything except the explicitly public
    // prefixes (see auth.js's PUBLIC_PREFIXES) requires
    // `Authorization: Bearer <API_ACCESS_TOKEN>`. /webhook is inbound from an
    // external signal source (TradingView), not the frontend, so it checks
    // its own separate secret instead — see routes/webhook.js's
    // checkWebhookSecret and its comment for why. Checked before any route
    // handler runs, so an unauthenticated request never reaches D1 or an
    // upstream call.
    if (!isPublicPath(url.pathname) && !url.pathname.startsWith('/webhook')) {
      if (!(await checkBearerToken(request, env))) {
        return withCors(unauthorized(), request, env);
      }
    }

    // /webhook/<strategy> is called by an external signal source (TradingView
    // alerts), never by the frontend, so it can't carry the frontend's
    // Authorization bearer token — TradingView alert bodies only support a
    // fixed text payload, no custom headers. If WEBHOOK_SECRET is configured
    // (`wrangler secret put WEBHOOK_SECRET`), require it as a `?secret=`
    // query param, matching how TradingView alert URLs are configured
    // (URL + static JSON body, no headers). Left unauthenticated when unset,
    // same as today — see routes/webhook.js's top comment: no real
    // TradingView alerts point at this yet, so there's nothing this would
    // protect against before that wiring exists, and hardening it further can
    // wait until it does.
    if (url.pathname.startsWith('/webhook') && env.WEBHOOK_SECRET) {
      if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
        return withCors(unauthorized(), request, env);
      }
    }

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
      } else if (url.pathname.startsWith('/stats')) {
        response = await handleStatsRoute(request, url, env);
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
