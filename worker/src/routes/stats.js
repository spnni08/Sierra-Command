// GET /stats/strategies — exact per-strategy metrics (winrate excluding
// breakeven, expectancy, realized/planned RR, PnL, last trade) computed
// server-side from real closed trades, never from backtest_runs' aggregate
// columns alone. Bearer-gated automatically (not in auth.js's
// PUBLIC_PREFIXES), same as /backtest.
import { berlinRangeUtc, isValidDateStr } from '../lib/berlinDay.js';
import { computeStrategyStatsRow, groupStrategyStats, normalizeSymbol, normalizeTimeframe } from '../stats/computeStats.js';

// 'demo'/'live' are UI-facing groupings over trades.source's finer-grained
// values (see schema.sql's CHECK constraint) — 'source' is a filter that
// selects exactly one of backtest/demo/live, never a blend of them.
const SOURCE_GROUPS = {
  demo: ['binance_testnet', 'oanda_demo', 'oanda_demo_simulated'],
  live: ['binance_live', 'oanda_live'],
};

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function daysAgoSql(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// { ok:false } on a bad/incomplete ?range=; { ok:true, fromUtc, toUtc } with
// either bound possibly null (no lower/upper cutoff) otherwise. 7d/30d/90d
// are relative to now (not Berlin-calendar-aligned — "trailing N days", not
// "N calendar days"); 'custom' reuses berlinRangeUtc so ?from=&to= behave
// exactly like every other Berlin-calendar-date filter in this app.
function resolveRange(url) {
  const range = url.searchParams.get('range') || 'all';
  if (range === '7d' || range === '30d' || range === '90d') {
    return { ok: true, fromUtc: daysAgoSql(parseInt(range, 10)), toUtc: null };
  }
  if (range === 'all') {
    return { ok: true, fromUtc: null, toUtc: null };
  }
  if (range === 'custom') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isValidDateStr(from) || !isValidDateStr(to) || from > to) return { ok: false };
    const { startUtc, endUtc } = berlinRangeUtc(from, to);
    return { ok: true, fromUtc: startUtc, toUtc: endUtc };
  }
  return { ok: false };
}

export async function handleStatsRoute(request, url, env) {
  const path = url.pathname.replace(/^\/stats/, '');

  if (path === '/strategies' && request.method === 'GET') {
    return strategiesRoute(url, env);
  }

  const strategyMatch = path.match(/^\/strategy\/([^/]+)$/);
  if (strategyMatch && request.method === 'GET') {
    return strategyDetailRoute(url, env, strategyMatch[1]);
  }

  return Response.json({ error: 'not_found', path }, { status: 404 });
}

async function strategiesRoute(url, env) {
  const source = url.searchParams.get('source');
  if (source !== 'backtest' && source !== 'demo' && source !== 'live') {
    return Response.json(
      { error: 'invalid_source', message: 'Expected ?source=backtest|demo|live' },
      { status: 400 }
    );
  }

  const range = resolveRange(url);
  if (!range.ok) {
    return Response.json(
      { error: 'invalid_range', message: 'Expected ?range=7d|30d|90d|all|custom (custom needs ?from=&to=YYYY-MM-DD, from<=to)' },
      { status: 400 }
    );
  }

  const symbol = url.searchParams.get('symbol') || null;

  try {
    const { results: strategies } = await env.DB.prepare(
      'SELECT id, name, active FROM strategies ORDER BY created_at ASC'
    ).all();

    let tradeRows;
    let openCounts = new Map();
    if (source === 'backtest') {
      tradeRows = await fetchBacktestTrades(env, { symbol, ...range });
    } else {
      const sources = SOURCE_GROUPS[source];
      tradeRows = await fetchLiveTrades(env, { sources, symbol, ...range });
      openCounts = await fetchOpenCounts(env, { sources, symbol });
    }

    const byStrategy = new Map();
    for (const row of tradeRows) {
      // Unattributed trades (no signal_id, or an orphaned signal — see
      // routes/api.js's getTrades comment on the same LEFT JOIN) can't be
      // credited to any strategy; excluded rather than guessed.
      if (!row.strategyId) continue;
      const list = byStrategy.get(row.strategyId);
      if (list) list.push(row);
      else byStrategy.set(row.strategyId, [row]);
    }

    const rows = strategies.map((s) => {
      const stats = computeStrategyStatsRow(byStrategy.get(s.id) ?? []);
      return {
        strategyId: s.id,
        name: s.name,
        active: !!s.active,
        openCount: openCounts.get(s.id) ?? 0,
        ...stats,
      };
    });

    return Response.json({ data: { rows, generatedAt: nowSql() } });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

// Trade-sort accessors for the "Alle Trades" tab's pagination — a small,
// fixed set (not every column is sortable server-side, only these).
const TRADE_SORT_ACCESSORS = {
  closedAt: (t) => t.closedAt,
  openedAt: (t) => t.openedAt,
  pnl: (t) => t.pnl,
  symbol: (t) => t.symbol,
  timeframe: (t) => t.timeframe,
};

function sortTrades(trades, sortKey, dir) {
  const accessor = TRADE_SORT_ACCESSORS[sortKey] ?? TRADE_SORT_ACCESSORS.closedAt;
  return [...trades].sort((a, b) => {
    const va = accessor(a);
    const vb = accessor(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return dir === 'asc' ? va - vb : vb - va;
  });
}

// Picks the single best (symbol, timeframe) combination among the
// byAssetTimeframe groups that meet the minimum-trades threshold — ranked
// by expectancyR when at least one qualifying combo has one, falling back
// to expectancyUsd only when none do (never mixing the two within one
// ranking). null (plus the caller showing an explicit "no combination
// reached the threshold" message) when nothing qualifies at all.
const BEST_COMBO_MIN_TRADES = 10;

function pickBestCombo(byAssetTimeframe) {
  const qualifying = byAssetTimeframe.filter((c) => c.tradeCount >= BEST_COMBO_MIN_TRADES);
  if (qualifying.length === 0) return null;

  const withR = qualifying.filter((c) => c.expectancyR != null);
  const metric = withR.length > 0 ? 'expectancyR' : 'expectancyUsd';
  const pool = withR.length > 0 ? withR : qualifying.filter((c) => c.expectancyUsd != null);
  if (pool.length === 0) return null;

  const best = pool.reduce((a, b) => (b[metric] > a[metric] ? b : a));
  return { symbol: best.symbol, timeframe: best.timeframe, metric, value: best[metric], tradeCount: best.tradeCount };
}

async function strategyDetailRoute(url, env, strategyId) {
  const source = url.searchParams.get('source');
  if (source !== 'backtest' && source !== 'demo' && source !== 'live') {
    return Response.json(
      { error: 'invalid_source', message: 'Expected ?source=backtest|demo|live' },
      { status: 400 }
    );
  }

  const range = resolveRange(url);
  if (!range.ok) {
    return Response.json(
      { error: 'invalid_range', message: 'Expected ?range=7d|30d|90d|all|custom (custom needs ?from=&to=YYYY-MM-DD, from<=to)' },
      { status: 400 }
    );
  }

  try {
    const strategy = await env.DB.prepare('SELECT id, name, active FROM strategies WHERE id = ?').bind(strategyId).first();
    if (!strategy) {
      return Response.json({ error: 'not_found', message: 'strategy does not exist' }, { status: 404 });
    }

    let trades;
    let openCount = 0;
    if (source === 'backtest') {
      trades = await fetchBacktestTrades(env, { strategyId, ...range });
    } else {
      const sources = SOURCE_GROUPS[source];
      trades = await fetchLiveTrades(env, { sources, strategyId, ...range });
      const openCounts = await fetchOpenCounts(env, { sources, strategyId });
      openCount = openCounts.get(strategyId) ?? 0;
    }

    const overall = computeStrategyStatsRow(trades);

    const byAsset = groupStrategyStats(trades, (t) => normalizeSymbol(t.symbol)).map(({ key, ...stats }) => ({
      symbol: key,
      ...stats,
    }));
    const byTimeframe = groupStrategyStats(trades, (t) => normalizeTimeframe(t.timeframe)).map(({ key, ...stats }) => ({
      timeframe: key,
      ...stats,
    }));
    const byAssetTimeframe = groupStrategyStats(
      trades,
      (t) => `${normalizeSymbol(t.symbol)}::${normalizeTimeframe(t.timeframe)}`
    ).map(({ key, ...stats }) => {
      const [symbol, timeframe] = key.split('::');
      return { symbol, timeframe, ...stats };
    });
    const bestCombo = pickBestCombo(byAssetTimeframe);

    const tradeSymbol = url.searchParams.get('tradeSymbol') || null;
    const tradeTimeframe = url.searchParams.get('tradeTimeframe') || null;
    const tradesLimit = Math.min(Math.max(parseInt(url.searchParams.get('tradesLimit'), 10) || 50, 1), 500);
    const tradesOffset = Math.max(parseInt(url.searchParams.get('tradesOffset'), 10) || 0, 0);
    const tradesSort = url.searchParams.get('tradesSort') || 'closedAt';
    const tradesDir = url.searchParams.get('tradesDir') === 'asc' ? 'asc' : 'desc';

    let filteredTrades = trades;
    if (tradeSymbol) filteredTrades = filteredTrades.filter((t) => normalizeSymbol(t.symbol) === tradeSymbol);
    if (tradeTimeframe) filteredTrades = filteredTrades.filter((t) => normalizeTimeframe(t.timeframe) === tradeTimeframe);
    const sortedTrades = sortTrades(filteredTrades, tradesSort, tradesDir);
    const total = sortedTrades.length;
    const rows = sortedTrades.slice(tradesOffset, tradesOffset + tradesLimit).map((t) => ({
      id: t.id,
      symbol: t.symbol,
      timeframe: t.timeframe,
      direction: t.direction,
      entry: t.entry,
      sl: t.sl,
      tp: t.tp,
      exit: t.exit,
      pnl: t.pnl,
      realizedR: t.sl != null && t.entry !== t.sl && t.diff != null ? t.diff / Math.abs(t.entry - t.sl) : null,
      reason: t.reason,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
    }));

    return Response.json({
      data: {
        strategyId: strategy.id,
        name: strategy.name,
        active: !!strategy.active,
        openCount,
        overall,
        byAsset,
        byTimeframe,
        byAssetTimeframe,
        bestCombo,
        trades: { rows, total, limit: tradesLimit, offset: tradesOffset },
      },
    });
  } catch (err) {
    return Response.json({ error: 'db_error', message: err.message }, { status: 500 });
  }
}

// Only the latest backtest_runs row per (strategy_id, symbol) contributes —
// a strategy re-run after this feature shipped (or after a logic change)
// must not double-count trades from a superseded run. If a strategy has
// been backtested on multiple symbols and no ?symbol= filter narrows it,
// each symbol's own latest run is included (never an arbitrary single pick).
async function fetchBacktestTrades(env, { symbol, fromUtc, toUtc, strategyId }) {
  const clauses = [];
  const params = [];
  if (strategyId) {
    clauses.push('bt.strategy_id = ?');
    params.push(strategyId);
  }
  if (symbol) {
    clauses.push('bt.symbol = ?');
    params.push(symbol);
  }
  if (fromUtc) {
    clauses.push('bt.closed_at >= ?');
    params.push(fromUtc);
  }
  if (toUtc) {
    clauses.push('bt.closed_at < ?');
    params.push(toUtc);
  }
  const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  const sql = `
    WITH latest_runs AS (
      SELECT id, strategy_id, symbol,
        ROW_NUMBER() OVER (PARTITION BY strategy_id, symbol ORDER BY created_at DESC) AS rn
      FROM backtest_runs
    )
    SELECT bt.id, bt.strategy_id, bt.symbol, bt.timeframe, bt.direction, bt.entry, bt.sl, bt.tp,
           bt.exit_price, bt.pnl, bt.reason, bt.opened_at, bt.closed_at
    FROM backtest_trades bt
    JOIN latest_runs lr ON lr.id = bt.backtest_run_id AND lr.rn = 1
    WHERE 1=1 ${where}
  `;
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const { results } = await stmt.all();

  // exit_price is stored explicitly on backtest_trades (see schema.sql), so
  // diff is exact, no derivation needed — direction decides which side of
  // entry/exit counts as favorable.
  return results.map((r) => ({
    id: r.id,
    strategyId: r.strategy_id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    direction: r.direction,
    pnl: r.pnl,
    entry: r.entry,
    sl: r.sl,
    tp: r.tp,
    exit: r.exit_price,
    reason: r.reason,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    diff: r.direction === 'long' ? r.exit_price - r.entry : r.entry - r.exit_price,
  }));
}

// Same JOIN shape as routes/api.js's getTrades. `trades` has no fill-price
// column (only pnl) — but pnlFor() (checkOpenTrades.js/execution-engine.js)
// has no fee/spread deduction, so diff = pnl/volume recovers the exact same
// signed price distance backtest_trades' exit_price gives directly, with no
// estimation.
async function fetchLiveTrades(env, { sources, symbol, fromUtc, toUtc, strategyId }) {
  const clauses = [
    `t.status = 'closed'`,
    `t.pnl IS NOT NULL`,
    `t.source IN (${sources.map(() => '?').join(',')})`,
  ];
  const params = [...sources];
  if (strategyId) {
    clauses.push('s.strategy_id = ?');
    params.push(strategyId);
  }
  if (symbol) {
    clauses.push('t.symbol = ?');
    params.push(symbol);
  }
  if (fromUtc) {
    clauses.push('t.closed_at >= ?');
    params.push(fromUtc);
  }
  if (toUtc) {
    clauses.push('t.closed_at < ?');
    params.push(toUtc);
  }

  const sql = `SELECT t.id, s.strategy_id, t.symbol, t.timeframe, t.direction, t.entry, t.sl, t.tp,
                      t.pnl, t.volume, t.opened_at, t.closed_at
    FROM trades t
    LEFT JOIN signals s ON s.id = t.signal_id
    WHERE ${clauses.join(' AND ')}`;
  const { results } = await env.DB.prepare(sql).bind(...params).all();

  return results.map((r) => {
    const diff = r.volume ? r.pnl / r.volume : null;
    // Exact, not estimated: pnlFor() (checkOpenTrades.js/execution-engine.js)
    // has no fee/spread deduction, so entry ± diff recovers the real fill
    // price exactly — same reasoning as `diff` itself, see this file's top
    // comment. `reason` (sl/tp/manual) has no equivalent here: `trades` has
    // no close-reason column at all (only status), so it's never guessed —
    // stays null/'unbekannt', unlike backtest_trades' stored `reason`.
    const exit = diff == null ? null : r.direction === 'long' ? r.entry + diff : r.entry - diff;
    return {
      id: r.id,
      strategyId: r.strategy_id,
      symbol: r.symbol,
      timeframe: r.timeframe,
      direction: r.direction,
      pnl: r.pnl,
      entry: r.entry,
      sl: r.sl,
      tp: r.tp,
      exit,
      reason: null,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      diff,
    };
  });
}

// Open trades never enter the stats (only closed trades have a realized
// outcome) but are reported separately per strategy so the UI can show
// "offen: n" without implying they're part of the winrate/PnL numbers.
// Backtest has no open-trades concept (engine.js force-closes everything at
// the simulated window's end) — the caller never calls this for source
// 'backtest'.
async function fetchOpenCounts(env, { sources, symbol, strategyId }) {
  const clauses = [`t.status = 'open'`, `t.source IN (${sources.map(() => '?').join(',')})`];
  const params = [...sources];
  if (strategyId) {
    clauses.push('s.strategy_id = ?');
    params.push(strategyId);
  }
  if (symbol) {
    clauses.push('t.symbol = ?');
    params.push(symbol);
  }
  const sql = `SELECT s.strategy_id, COUNT(*) as cnt
    FROM trades t
    LEFT JOIN signals s ON s.id = t.signal_id
    WHERE ${clauses.join(' AND ')}
    GROUP BY s.strategy_id`;
  const { results } = await env.DB.prepare(sql).bind(...params).all();

  const map = new Map();
  for (const r of results) {
    if (r.strategy_id) map.set(r.strategy_id, r.cnt);
  }
  return map;
}
