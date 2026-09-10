// Structural-data routes backed by D1: strategies, trades, activity log,
// backtest runs, and per-strategy settings. All GET routes return
// `{ data: [...] }`; the PUT route returns `{ data: {...} }`. No auth —
// consistent with the existing read-mostly /binance, /oanda, /coingecko, /twelvedata
// routes at this stage of the project.

export async function handleApiRoute(request, url, env) {
  const path = url.pathname.replace(/^\/api/, '');

  if (path === '/strategies' && request.method === 'GET') {
    return getStrategies(env);
  }

  if (path === '/trades' && request.method === 'GET') {
    return getTrades(url, env);
  }

  if (path === '/activity-log' && request.method === 'GET') {
    return getActivityLog(url, env);
  }

  if (path === '/backtest-runs' && request.method === 'GET') {
    return getBacktestRuns(url, env);
  }

  if (path === '/pnl-calendar' && request.method === 'GET') {
    return getPnlCalendar(url, env);
  }

  // Connection status only — never the encrypted secret/key itself. There is
  // no write endpoint yet (adding a credential means designing a secure
  // encrypt-on-write flow, which is separate, larger work); this exists so
  // the Settings page can show real "connected" state instead of fabricated
  // account data.
  if (path === '/credentials' && request.method === 'GET') {
    return getCredentials(env);
  }

  const settingsMatch = path.match(/^\/strategy-settings\/([^/]+)$/);
  if (settingsMatch && request.method === 'PUT') {
    return putStrategySettings(request, env, settingsMatch[1]);
  }

  const strategyMatch = path.match(/^\/strategies\/([^/]+)$/);
  if (strategyMatch && request.method === 'PATCH') {
    return patchStrategy(request, env, strategyMatch[1]);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function getStrategies(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT
         s.id, s.name, s.asset_classes, s.active, s.factor_definition,
         s.created_at, s.updated_at,
         ss.risk_per_trade_pct, ss.session_filter, ss.correlation_limit,
         ss.news_filter_threshold
       FROM strategies s
       LEFT JOIN strategy_settings ss ON ss.strategy_id = s.id
       ORDER BY s.created_at ASC`
    ).all();

    const data = results.map((row) => ({
      id: row.id,
      name: row.name,
      asset_classes: parseJsonColumn(row.asset_classes, []),
      active: !!row.active,
      factor_definition: parseJsonColumn(row.factor_definition, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
      settings: {
        risk_per_trade_pct: row.risk_per_trade_pct ?? null,
        session_filter: parseJsonColumn(row.session_filter, []),
        correlation_limit: row.correlation_limit ?? null,
        news_filter_threshold: row.news_filter_threshold ?? null,
      },
    }));

    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

async function getTrades(url, env) {
  try {
    const status = url.searchParams.get('status');
    let stmt;
    if (status === 'open' || status === 'closed') {
      stmt = env.DB.prepare('SELECT * FROM trades WHERE status = ? ORDER BY opened_at DESC').bind(status);
    } else {
      stmt = env.DB.prepare('SELECT * FROM trades ORDER BY opened_at DESC');
    }
    const { results } = await stmt.all();
    return Response.json({ data: results });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

async function getActivityLog(url, env) {
  try {
    const source = url.searchParams.get('source');
    const LIMIT = 200;
    let stmt;
    if (source === 'system' || source === 'binance' || source === 'oanda') {
      stmt = env.DB.prepare(
        'SELECT * FROM activity_log WHERE source = ? ORDER BY timestamp DESC LIMIT ?'
      ).bind(source, LIMIT);
    } else {
      stmt = env.DB.prepare('SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ?').bind(LIMIT);
    }
    const { results } = await stmt.all();
    return Response.json({ data: results });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

async function getBacktestRuns(url, env) {
  try {
    const strategyId = url.searchParams.get('strategy_id');
    let stmt;
    if (strategyId) {
      stmt = env.DB.prepare(
        'SELECT * FROM backtest_runs WHERE strategy_id = ? ORDER BY created_at DESC'
      ).bind(strategyId);
    } else {
      stmt = env.DB.prepare('SELECT * FROM backtest_runs ORDER BY created_at DESC');
    }
    const { results } = await stmt.all();
    return Response.json({ data: results });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

async function putStrategySettings(request, env, strategyId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { risk_per_trade_pct, session_filter, correlation_limit, news_filter_threshold } = body || {};

  if (
    typeof risk_per_trade_pct !== 'number' ||
    !Array.isArray(session_filter) ||
    typeof correlation_limit !== 'number' ||
    typeof news_filter_threshold !== 'number'
  ) {
    return Response.json(
      {
        error: 'invalid_body',
        message:
          'Expected { risk_per_trade_pct: number, session_filter: string[], correlation_limit: number, news_filter_threshold: number }',
      },
      { status: 400 }
    );
  }

  try {
    const strategy = await env.DB.prepare('SELECT id FROM strategies WHERE id = ?')
      .bind(strategyId)
      .first();
    if (!strategy) {
      return Response.json({ error: 'not_found', message: 'strategy does not exist' }, { status: 404 });
    }

    await env.DB.prepare(
      `INSERT INTO strategy_settings (strategy_id, risk_per_trade_pct, session_filter, correlation_limit, news_filter_threshold)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(strategy_id) DO UPDATE SET
         risk_per_trade_pct = excluded.risk_per_trade_pct,
         session_filter = excluded.session_filter,
         correlation_limit = excluded.correlation_limit,
         news_filter_threshold = excluded.news_filter_threshold`
    )
      .bind(strategyId, risk_per_trade_pct, JSON.stringify(session_filter), correlation_limit, news_filter_threshold)
      .run();

    const updated = await env.DB.prepare('SELECT * FROM strategy_settings WHERE strategy_id = ?')
      .bind(strategyId)
      .first();

    return Response.json({
      data: {
        ...updated,
        session_filter: parseJsonColumn(updated.session_filter, []),
      },
    });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

async function patchStrategy(request, env, strategyId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof body?.active !== 'boolean') {
    return Response.json({ error: 'invalid_body', message: 'Expected { active: boolean }' }, { status: 400 });
  }

  try {
    const strategy = await env.DB.prepare('SELECT id FROM strategies WHERE id = ?').bind(strategyId).first();
    if (!strategy) {
      return Response.json({ error: 'not_found', message: 'strategy does not exist' }, { status: 404 });
    }

    await env.DB.prepare(`UPDATE strategies SET active = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(body.active ? 1 : 0, strategyId)
      .run();

    const updated = await env.DB.prepare('SELECT id, active FROM strategies WHERE id = ?').bind(strategyId).first();
    return Response.json({ data: { id: updated.id, active: !!updated.active } });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

// Daily PnL grouped by source (mt5 = oanda_*, exchange = binance_*), for the
// Log page's calendar. `year`/`month` default to the current UTC month.
async function getPnlCalendar(url, env) {
  try {
    const now = new Date();
    const year = parseInt(url.searchParams.get('year'), 10) || now.getUTCFullYear();
    const month = parseInt(url.searchParams.get('month'), 10) || now.getUTCMonth() + 1;
    const yearMonth = `${year}-${String(month).padStart(2, '0')}`;

    const { results } = await env.DB.prepare(
      `SELECT
         CAST(strftime('%d', closed_at) AS INTEGER) as day,
         CASE WHEN source LIKE 'oanda%' THEN 'mt5' ELSE 'exchange' END as src_group,
         SUM(pnl) as total
       FROM trades
       WHERE status = 'closed' AND closed_at IS NOT NULL AND strftime('%Y-%m', closed_at) = ?
       GROUP BY day, src_group`
    )
      .bind(yearMonth)
      .all();

    const days = {};
    for (const row of results) {
      const day = days[row.day] ?? (days[row.day] = { mt5: 0, exch: 0 });
      if (row.src_group === 'mt5') day.mt5 = row.total;
      else day.exch = row.total;
    }
    for (const day of Object.values(days)) {
      day.total = day.mt5 + day.exch;
    }

    return Response.json({ data: { year, month, days } });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

// Connection status only (id, provider, env, created_at) — the
// encrypted_key/encrypted_secret columns are never returned here.
async function getCredentials(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, provider, env, created_at FROM api_credentials ORDER BY provider, env'
    ).all();
    return Response.json({ data: results });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}
