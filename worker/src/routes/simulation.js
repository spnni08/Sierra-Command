// Manual trigger for the simulated OANDA demo execution engine (see
// ../simulation/execution-engine.js). Intended to be called later by the
// strategy-signal ingestion path once that's wired up — for now this is a
// directly testable endpoint that takes an order and returns the simulated
// fill.

import { openSimulatedTrade, checkOpenSimulatedTrades } from '../simulation/execution-engine.js';
import { checkOpenTrades as checkOpenCryptoTrades } from '../cron/checkOpenTrades.js';

export async function handleSimulationRoute(request, url, env) {
  const path = url.pathname.replace(/^\/simulation/, '');

  if (path === '/oanda/execute' && request.method === 'POST') {
    return executeOrder(request, env);
  }

  if (path === '/oanda/check' && request.method === 'POST') {
    return checkOpenTrades(env);
  }

  // Manual trigger for the crypto (Binance) SL/TP auto-close job — same job
  // the scheduled handler (wrangler.toml [triggers]) runs on a timer, exposed
  // here for on-demand / ops use. See ../cron/checkOpenTrades.js.
  if (path === '/crypto/check' && request.method === 'POST') {
    return checkOpenCrypto(env);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function executeOrder(request, env) {
  let order;
  try {
    order = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const { trade, rawPrice, spreadApplied } = await openSimulatedTrade(order, env);
    return Response.json({ data: { trade, raw_price: rawPrice, spread_applied: spreadApplied } });
  } catch (err) {
    return Response.json({ error: 'simulation_error', message: err.message }, { status: 400 });
  }
}

async function checkOpenTrades(env) {
  try {
    const result = await checkOpenSimulatedTrades(env);
    return Response.json({ data: result });
  } catch (err) {
    return Response.json({ error: 'simulation_error', message: err.message }, { status: 500 });
  }
}

async function checkOpenCrypto(env) {
  try {
    const result = await checkOpenCryptoTrades(env);
    return Response.json({ data: result });
  } catch (err) {
    return Response.json({ error: 'crypto_check_error', message: err.message }, { status: 500 });
  }
}
