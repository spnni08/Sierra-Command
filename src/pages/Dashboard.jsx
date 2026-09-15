import { useCallback, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { fetchTrades, fetchStrategies, fetchBacktestRuns, fetchPnlCalendar } from '../api/client';
import { useFetch } from '../api/useFetch';
import StatusPanel from '../api/StatusPanel';
import { StrategyStatsHeaderRow, StrategyStatsRow } from '../components/StrategyStatsTable';

function fmtNum(v, dec = 2) {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return (v * 100).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}

// Per-strategy stats are joined from strategies + their latest backtest_runs
// row — the fields actually available today (profit factor, Sharpe, max
// drawdown, win rate). trades.signal_id isn't populated in the current seed
// data, so there's no real per-strategy trade linkage yet to derive trade
// count/live PnL from; that's a later step once real signal->trade linkage
// exists.
export function toStrategyStatRow(strategy, backtestRuns) {
  const runs = backtestRuns.filter(r => r.strategy_id === strategy.id);
  const latest = runs[0] || null;
  return {
    id: strategy.id,
    name: strategy.name,
    active: strategy.active,
    symbol: latest?.symbol ?? '—',
    profitFactor: latest ? fmtNum(latest.profit_factor) : '—',
    sharpe: latest ? fmtNum(latest.sharpe) : '—',
    maxDrawdown: latest ? '−' + fmtPct(Math.abs(latest.max_drawdown)) : '—',
    winrate: latest && latest.win_rate != null ? fmtPct(latest.win_rate) : '—',
  };
}

function fmtClosedTime(ts) {
  if (!ts) return '—';
  const [date, time] = ts.split(' ');
  const [, m, d] = date.split('-');
  return `${d}.${m}. ${time?.slice(0, 5) ?? ''}`;
}

function fmtHours(openedAt, closedAt) {
  const start = new Date(openedAt.replace(' ', 'T') + 'Z');
  const end = new Date(closedAt.replace(' ', 'T') + 'Z');
  const hrs = Math.max(0, (end - start) / 3_600_000);
  return hrs.toFixed(1).replace('.', ',') + ' h';
}

// Some seeded/real trades rows carry EUR_USD instead of the rest of the
// app's no-separator convention (EURUSD, BTCUSDT, SPX500) — normalized for
// display only, not rewritten in the DB.
function normalizeSymbol(sym) {
  return String(sym ?? '').replace(/_/g, '');
}

function toClosedRow(t) {
  const neg = (t.pnl ?? 0) < 0;
  const pnlAbs = Math.abs(t.pnl ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    time: fmtClosedTime(t.closed_at),
    symbol: normalizeSymbol(t.symbol),
    dir: t.direction === 'long' ? 'LONG' : 'SHORT',
    strategy: '—',
    duration: fmtHours(t.opened_at, t.closed_at || t.opened_at),
    pnl: (neg ? '−' : '+') + pnlAbs + ' €',
    neg,
  };
}

function fmtSignedEUR(v) {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v >= 0 ? '+' : '−') + s + ' €';
}

// D1 stores closed_at as 'YYYY-MM-DD HH:MM:SS' (no explicit timezone
// suffix) — treated as UTC here, matching how the rest of the app parses
// these timestamps (see ProTerminal.jsx's fmtOpenDuration).
function parseDbTimestamp(ts) {
  return new Date(ts.replace(' ', 'T') + 'Z');
}

// Real win rate + trade count over closed trades within the trailing N
// days — no live account/margin system exists in the schema (see schema.sql:
// only strategies/signals/trades/backtest_runs), so this is the one KPI in
// that row derivable from real data at all.
function computeTrailingStats(closedTrades, days) {
  const cutoff = Date.now() - days * 86_400_000;
  const inWindow = closedTrades.filter((t) => t.closed_at && parseDbTimestamp(t.closed_at).getTime() >= cutoff);
  if (inWindow.length === 0) return null;
  const wins = inWindow.filter((t) => (t.pnl ?? 0) > 0).length;
  return { winRate: wins / inWindow.length, count: inWindow.length };
}

// Real cumulative realized PnL over closed trades in the trailing N days —
// deliberately NOT labeled "account equity"/"Kontostand": there is no
// starting balance anywhere in the schema, so this is a trade-PnL curve,
// not a balance history. Chronological, oldest first.
function EquityCurveFromTrades({ trades, days }) {
  const cutoff = Date.now() - days * 86_400_000;
  const inWindow = trades
    .filter((t) => t.closed_at && parseDbTimestamp(t.closed_at).getTime() >= cutoff)
    .slice()
    .sort((a, b) => parseDbTimestamp(a.closed_at) - parseDbTimestamp(b.closed_at));
  if (inWindow.length === 0) return null;
  const points = inWindow.reduce((acc, t) => [...acc, acc[acc.length - 1] + (t.pnl ?? 0)], [0]);
  const min = Math.min(...points), max = Math.max(...points);
  const pad = (max - min) * 0.1 || 1;
  const lo = min - pad, hi = max + pad;
  const w = 100, h = 100;
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i / (points.length - 1)) * w} ${h - ((v - lo) / (hi - lo)) * h}`)
    .join(' ');
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
      <path d={path} fill="none" stroke={up ? 'var(--pos, #16a34a)' : 'var(--acc)'} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function segBtn(active) {
  return {
    padding: '4px 12px', borderLeft: 0, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.06em',
    border: `1px solid ${active ? 'var(--acc)' : 'var(--line2)'}`,
    background: active ? 'var(--acc)' : 'transparent',
    color: active ? '#fff' : 'var(--txt2)',
  };
}

export default function Dashboard({ goAutoSettings, goLog }) {
  const { dense } = useApp();
  const [dashMode, setDashMode] = useState('live');
  const isBacktest = dashMode === 'backtest';

  const loadClosedTrades = useCallback(() => fetchTrades('closed'), []);
  // Polled — headline numbers (balance/win-rate/etc.) were previously frozen
  // at whatever they were on mount, in both live and backtest mode.
  const closedQ = useFetch(loadClosedTrades, [loadClosedTrades], { pollMs: 20_000 });
  const recentClosedTrades = useMemo(
    () => (closedQ.data || []).slice(0, 5).map(toClosedRow),
    [closedQ.data]
  );

  const loadStrategyStats = useCallback(
    () => Promise.all([fetchStrategies(), fetchBacktestRuns()]),
    []
  );
  const strategyStatsQ = useFetch(loadStrategyStats, [loadStrategyStats], { pollMs: 30_000 });
  const strategyStats = useMemo(() => {
    if (!strategyStatsQ.data) return [];
    const [strategies, backtestRuns] = strategyStatsQ.data;
    return strategies.map(s => toStrategyStatRow(s, backtestRuns));
  }, [strategyStatsQ.data]);
  // /api/backtest-runs is ordered by created_at DESC (see routes/api.js), so
  // [1] (index 0 is [strategies, backtestRuns]) index 1's first entry is the
  // single most recent real backtest run across ANY strategy — used as the
  // Backtest-mode KPI row below. Not an aggregate across all runs (those
  // aren't comparable across different strategies/symbols/windows) — just
  // the latest one, clearly labeled with which strategy/symbol it's from.
  const latestBacktestRun = strategyStatsQ.data?.[1]?.[0] ?? null;

  const loadPnlCalendar = useCallback(() => fetchPnlCalendar(), []);
  const pnlCalendarQ = useFetch(loadPnlCalendar, [loadPnlCalendar], { pollMs: 30_000 });

  const trailing30 = useMemo(() => computeTrailingStats(closedQ.data || [], 30), [closedQ.data]);
  const todayStats = useMemo(() => {
    const cal = pnlCalendarQ.data;
    if (!cal) return null;
    const now = new Date();
    if (cal.year !== now.getUTCFullYear() || cal.month !== now.getUTCMonth() + 1) return null;
    return cal.days?.[String(now.getUTCDate())] ?? { mt5: 0, exch: 0, total: 0 };
  }, [pnlCalendarQ.data]);
  const monthPnlBySource = useMemo(() => {
    const cal = pnlCalendarQ.data;
    if (!cal?.days) return null;
    const totals = Object.values(cal.days).reduce(
      (acc, d) => ({ mt5: acc.mt5 + d.mt5, exch: acc.exch + d.exch, total: acc.total + d.total }),
      { mt5: 0, exch: 0, total: 0 }
    );
    return totals;
  }, [pnlCalendarQ.data]);

  // Kontostand/Margin/"Offenes Risiko" have no real source at all — the
  // schema has no accounts/balance/margin table (see worker/schema.sql),
  // and open trades carry no live mark-to-market price to size risk against.
  // Shown as explicit "keine Datenquelle" placeholders rather than inventing
  // a number, per the same standard the backtest adapters used.
  const kpis = isBacktest
    ? [
        { label: 'Endkapital (Backtest)', val: '—', sub: 'Nicht in backtest_runs gespeichert (nur Kennzahlen, kein Kapitalverlauf)' },
        { label: 'Nettogewinn (Backtest)', val: '—', sub: 'Nicht in backtest_runs gespeichert' },
        {
          label: 'Trefferquote (Backtest)',
          val: latestBacktestRun ? fmtPct(latestBacktestRun.win_rate) : '—',
          sub: latestBacktestRun
            ? `${latestBacktestRun.strategy_id} · ${latestBacktestRun.symbol} · ${latestBacktestRun.trade_count ?? '—'} Trades`
            : 'Noch keine Backtest-Daten',
        },
        {
          label: 'Max. Drawdown (letzter Lauf)',
          val: latestBacktestRun?.max_drawdown != null ? '−' + fmtPct(Math.abs(latestBacktestRun.max_drawdown)) : '—',
          sub: latestBacktestRun ? `Lauf vom ${latestBacktestRun.created_at?.slice(0, 10) ?? '—'}` : 'Noch keine Backtest-Daten',
          accent: true,
        },
      ]
    : [
        { label: 'Kontostand', val: '—', sub: 'Keine Konto-/Margin-Datenquelle vorhanden' },
        {
          label: 'Ergebnis heute',
          val: todayStats ? fmtSignedEUR(todayStats.total) : '—',
          sub: todayStats ? 'aus geschlossenen Trades (pnl-calendar)' : 'Keine Trades heute',
        },
        {
          label: 'Trefferquote 30 T.',
          val: trailing30 ? fmtPct(trailing30.winRate) : '—',
          sub: trailing30 ? `${trailing30.count} Trades` : 'Keine geschlossenen Trades in 30 Tagen',
        },
        { label: 'Offenes Risiko', val: '—', sub: 'Keine Margin-/Limit-Datenquelle vorhanden', accent: true },
      ];

  const equityTitle = isBacktest ? 'Equity-Kurve · Backtest' : 'Kumulierte PnL · 90 Tage (realisierte Trades)';

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--line)', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div style={{ background: 'var(--panel)', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Datenquelle</div>
        <div style={{ display: 'flex', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
          <button onClick={() => setDashMode('live')} style={{ ...segBtn(!isBacktest), borderLeft: `1px solid ${!isBacktest ? 'var(--acc)' : 'var(--line2)'}` }}>LIVE / DEMO</button>
          <button onClick={() => setDashMode('backtest')} style={segBtn(isBacktest)}>BACKTEST</button>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt3)' }}>
          {isBacktest ? 'Letzter Backtest-Lauf, keine echten Positionen' : 'Zusammengeführt: MT5 + Kraken/Binance'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 1, background: 'var(--line)' }}>
        {kpis.slice(0, 3).map(k => (
          <div key={k.label} style={{ background: 'var(--panel)', padding: '14px 16px' }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>{k.label}</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 26, marginTop: 6 }}>{k.val}</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', marginTop: 3 }}>{k.sub}</div>
          </div>
        ))}
        {dense && (() => { const k = kpis[3]; return (
          <div style={{ background: 'var(--panel)', padding: '14px 16px' }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>{k.label}</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 26, marginTop: 6, color: 'var(--acc)' }}>{k.val}</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', marginTop: 3 }}>{k.sub}</div>
          </div>
        ); })()}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: dense ? '1fr 340px' : '1fr 300px', gap: 1, background: 'var(--line)', flex: '1 1 320px', minHeight: 320 }}>
        <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 260 }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)' }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>{equityTitle}</div>
          </div>
          <div style={{ flex: 1, minHeight: 180, background: 'var(--chart)' }}>
            {isBacktest ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt3)' }}>
                Keine Kurve verfügbar — backtest_runs speichert nur Kennzahlen, keine Trade-für-Trade-Historie
              </div>
            ) : !closedQ.data ? null : (
              (() => {
                const withPnlIn90d = (closedQ.data || []).filter(
                  (t) => t.closed_at && parseDbTimestamp(t.closed_at).getTime() >= Date.now() - 90 * 86_400_000
                );
                return withPnlIn90d.length > 0 ? (
                  <EquityCurveFromTrades trades={closedQ.data} days={90} />
                ) : (
                  <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt3)' }}>
                    Keine geschlossenen Trades in den letzten 90 Tagen
                  </div>
                );
              })()
            )}
          </div>
        </div>

        <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
          <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>PNL nach Quelle · aktueller Monat</div>
          {!monthPnlBySource ? (
            <div style={{ padding: '11px 12px', borderBottom: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--txt3)' }}>
              {pnlCalendarQ.loading ? 'Lade Daten…' : 'Keine Daten für diesen Monat'}
            </div>
          ) : (() => {
            const maxAbs = Math.max(Math.abs(monthPnlBySource.mt5), Math.abs(monthPnlBySource.exch), 1);
            return (
          <div style={{ padding: '11px 12px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
              <div style={{ width: 9, height: 9, background: 'var(--txt2)' }} />
              <div style={{ flex: 1, color: 'var(--txt2)' }}>MT5/OANDA · Forex/Indizes</div><div style={{ color: 'var(--txt)' }}>{fmtSignedEUR(monthPnlBySource.mt5)}</div>
            </div>
            <div style={{ height: 6, background: 'var(--panel3)' }}><div style={{ width: `${Math.abs(monthPnlBySource.mt5) / maxAbs * 100}%`, height: '100%', background: 'var(--txt2)' }} /></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
              <div style={{ width: 9, height: 9, background: 'var(--acc)' }} />
              <div style={{ flex: 1, color: 'var(--txt2)' }}>Binance · Krypto</div><div style={{ color: 'var(--txt)' }}>{fmtSignedEUR(monthPnlBySource.exch)}</div>
            </div>
            <div style={{ height: 6, background: 'var(--panel3)' }}><div style={{ width: `${Math.abs(monthPnlBySource.exch) / maxAbs * 100}%`, height: '100%', background: 'var(--acc)' }} /></div>
            <div style={{ display: 'flex', alignItems: 'center', paddingTop: 4, borderTop: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
              <div style={{ flex: 1, color: 'var(--txt2)' }}>Gesamt</div><div style={{ fontWeight: 600 }}>{fmtSignedEUR(monthPnlBySource.total)}</div>
            </div>
          </div>
            ); })()}
          <div style={{ padding: '11px 12px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Konto-Kennzahlen</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt3)' }}>Keine Margin-/Konto-Datenquelle vorhanden</div>
          </div>
          <button onClick={goAutoSettings} style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'transparent', border: 0, borderBottom: '1px solid var(--line)', padding: '11px 12px', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--txt)', textAlign: 'left' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Auto-Trade-Einstellungen</div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', marginTop: 2 }}>
                {strategyStatsQ.data ? `${strategyStats.filter(s => s.active).length} von ${strategyStats.length} Strategien aktiv` : 'Lade Daten…'}
              </div>
            </div>
            <div style={{ color: 'var(--acc)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 14 }}>→</div>
          </button>
          <button onClick={goLog} style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'transparent', border: 0, padding: '11px 12px', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--txt)', textAlign: 'left' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Log & PNL-Kalender</div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', marginTop: 2 }}>Volle Historie, offene Trades, Tagesergebnisse</div>
            </div>
            <div style={{ color: 'var(--acc)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 14 }}>→</div>
          </button>
        </div>
      </div>

      <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Strategie-Statistik ({strategyStats.length})</div>
        <StatusPanel loading={strategyStatsQ.loading} error={strategyStatsQ.error} onRetry={strategyStatsQ.reload} />
        {!strategyStatsQ.loading && !strategyStatsQ.error && (
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflow: 'auto', maxHeight: 220 }}>
            <StrategyStatsHeaderRow minWidth={480} />
            {strategyStats.map(s => (
              <StrategyStatsRow key={s.id} row={s} minWidth={480} />
            ))}
          </div>
        )}
      </div>

      {dense && (
        <div style={{ background: 'var(--panel)' }}>
          <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Letzte Abschlüsse</div>
          <StatusPanel loading={closedQ.loading} error={closedQ.error} onRetry={closedQ.reload} />
          {!closedQ.loading && !closedQ.error && (
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflowX: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '110px 90px 70px 1fr 90px 90px', padding: '4px 12px', color: 'var(--txt3)', borderBottom: '1px solid var(--line)', minWidth: 560 }}>
                <div>ZEIT</div><div>SYMBOL</div><div>RICHTUNG</div><div>STRATEGIE</div><div style={{ textAlign: 'right' }}>DAUER</div><div style={{ textAlign: 'right' }}>ERGEBNIS</div>
              </div>
              {recentClosedTrades.map((t, i, arr) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px 90px 70px 1fr 90px 90px', padding: '5px 12px', borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 'none', minWidth: 560 }}>
                  <div style={{ color: 'var(--txt2)' }}>{t.time}</div><div>{t.symbol}</div><div style={{ color: 'var(--txt2)' }}>{t.dir}</div>
                  <div style={{ color: 'var(--txt2)' }}>{t.strategy}</div><div style={{ textAlign: 'right', color: 'var(--txt2)' }}>{t.duration}</div>
                  <div style={{ textAlign: 'right', color: t.neg ? 'var(--acc)' : 'var(--txt)' }}>{t.pnl}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
