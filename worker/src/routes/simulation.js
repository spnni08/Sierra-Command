// Manual trigger for the simulated OANDA demo execution engine (see
// ../simulation/execution-engine.js). Intended to be called later by the
// strategy-signal ingestion path once that's wired up — for now this is a
// directly testable endpoint that takes an order and returns the simulated
// fill.

import { openSimulatedTrade, checkOpenSimulatedTrades } from '../simulation/execution-engine.js';

export async function handleSimulationRoute(request, url, env) {
  const path = url.pathname.replace(/^\/simulation/, '');

  if (path === '/oanda/execute' && request.method === 'POST') {
    return executeOrder(request, env);
  }

  if (path === '/oanda/check' && request.method === 'POST') {
    return checkOpenTrades(env);
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
