import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { fetchTrades, fetchActivityLog, fetchPnlCalendar } from '../api/client';
import { useFetch } from '../api/useFetch';
import { useLiveTradePnl } from '../api/useLiveTradePnl';
import { pnlDisplay } from '../lib/pnlFormat';
import { todayBerlinDateStr, isValidDateStr } from '../lib/berlinDay';
import StatusPanel from '../api/StatusPanel';
import ErrorBoundary from '../components/ErrorBoundary';

// Builds the calendar grid (leading blanks + one cell per day of the month)
// from the real per-day PnL totals returned by /api/pnl-calendar.
function buildCalendarCells(year, month, days) {
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const day = days?.[d];
    if (!day) {
      cells.push({ day: d, hasData: false });
    } else {
      cells.push({ day: d, hasData: true, mt5: day.mt5, exch: day.exch, total: day.total });
    }
  }
  return cells;
}

function segBtn(active, first) {
  return {
    padding: '4px 10px', borderLeft: first ? undefined : 0, cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${active ? 'var(--acc)' : 'var(--line2)'}`,
    background: active ? 'var(--acc)' : 'transparent',
    color: active ? '#fff' : 'var(--txt2)',
  };
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function fmtSigned(v) {
  const s = Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v >= 0 ? '+' : '−') + s + ' €';
}

function fmtNum(v, dec = 2) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 'YYYY-MM-DD' -> 'DD.MM.YYYY', for the day-filter empty-state messages.
function fmtDeDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function fmtDuration(openedAt, closedAt) {
  if (!openedAt) return '—';
  const start = new Date(openedAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(start.getTime())) return '—';
  const end = closedAt ? new Date(closedAt.replace(' ', 'T') + 'Z') : new Date();
  const hrs = Math.max(0, (end - start) / 3_600_000);
  return hrs.toFixed(2).replace('.', ',') + ' h';
}

// Backend `source` values (binance_*/oanda_*) collapse onto the same
// exchange/mt5 grouping the UI's filter buttons already use.
function sourceGroup(source) {
  if (!source) return 'exchange';
  return source.startsWith('oanda') ? 'mt5' : 'exchange';
}

function toRowTrade(t) {
  return {
    id: t.id,
    symbol: t.symbol ?? '—',
    direction: t.direction,
    entry: t.entry,
    volume: t.volume,
    dir: t.direction === 'long' ? 'LONG' : 'SHORT',
    vol: fmtNum(t.volume, 2),
    entryFmt: fmtNum(t.entry, Number(t.entry) < 50 ? 5 : 2),
    sl: fmtNum(t.sl, 2),
    tp: fmtNum(t.tp, 2),
    strategy: t.strategy_name || '—',
    factor: '—',
    duration: fmtDuration(t.opened_at, t.closed_at),
    source: sourceGroup(t.source),
  };
}

function toRowActivity(a) {
  const closed = /geschlossen/.test(a.message);
  const opened = /eröffnet|eroeffnet/.test(a.message);
  const timePart = (a.timestamp || '').split(' ')[1] || a.timestamp;
  const srcLabel = { binance: 'BINANCE', oanda: 'MT5', system: 'SYSTEM' }[a.source] || a.source?.toUpperCase();
  // Now joined server-side via related_trade_id -> trades -> signals ->
  // strategies (see worker/src/routes/api.js's getActivityLog) — appended
  // to the message rather than replacing it, since the message text itself
  // isn't otherwise touched.
  const text = a.strategy_name ? `${a.message} · ${a.strategy_name}` : a.message;
  return {
    time: timePart,
    src: srcLabel,
    mark: closed ? '✕' : opened ? '▸' : '·',
    text,
    source: a.source === 'system' ? 'system' : sourceGroup(a.source === 'oanda' ? 'oanda_demo' : 'binance_testnet'),
    closed,
  };
}

export default function LogPage() {
  const { dense } = useApp();
  const [logStatus, setLogStatus] = useState('all');
  const [logSrc, setLogSrc] = useState('all');

  // The active day filter ('YYYY-MM-DD', Europe/Berlin), synced to the
  // ?date= URL param via history.pushState/popstate (this app has no
  // router — see App.jsx's matching initial-page read). null = unfiltered.
  const [dateFilter, setDateFilterState] = useState(() => {
    const d = new URLSearchParams(window.location.search).get('date');
    return isValidDateStr(d) ? d : null;
  });
  const applyDateFilter = useCallback((dateStr) => {
    setDateFilterState(dateStr);
    const url = dateStr ? `?date=${dateStr}` : window.location.pathname;
    window.history.pushState({ date: dateStr ?? null }, '', url);
  }, []);
  useEffect(() => {
    const onPopState = () => {
      const d = new URLSearchParams(window.location.search).get('date');
      setDateFilterState(isValidDateStr(d) ? d : null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const loadTrades = useCallback(
    () => fetchTrades(logStatus === 'all' ? undefined : logStatus, dateFilter || undefined),
    [logStatus, dateFilter]
  );
  const loadActivity = useCallback(
    () => fetchActivityLog(undefined, dateFilter || undefined),
    [dateFilter]
  );
  const loadPnlCalendar = useCallback(() => fetchPnlCalendar(), []);
  // All three polled — trades/activity so new events show up without a
  // reload, calendar so a trade closing updates the day's total live.
  const tradesQ = useFetch(loadTrades, [loadTrades], { pollMs: 20_000 });
  const activityQ = useFetch(loadActivity, [loadActivity], { pollMs: 20_000 });
  const calendarQ = useFetch(loadPnlCalendar, [loadPnlCalendar], { pollMs: 30_000 });

  // The backend already returns exactly the status/date-matching rows (see
  // worker/src/routes/api.js's getTrades) — logStatus is no longer
  // re-applied client-side here. Doing so used to unconditionally empty
  // this table whenever "GESCHLOSSEN" was selected, since closed trades
  // were never even fetched (fixed above) — keeping a redundant client-side
  // status filter around would silently reintroduce that same bug class on
  // any future change to loadTrades.
  const openTrades = useMemo(() => {
    const rows = (Array.isArray(tradesQ.data) ? tradesQ.data : []).map(toRowTrade);
    return rows.filter(t => {
      if (logSrc === 'mt5' && t.source !== 'mt5') return false;
      if (logSrc === 'exchange' && t.source !== 'exchange') return false;
      return true;
    });
  }, [tradesQ.data, logSrc]);

  const activityLog = useMemo(() => {
    const rows = (Array.isArray(activityQ.data) ? activityQ.data : []).map(toRowActivity);
    return rows.filter(a => {
      if (logStatus === 'open' && a.closed) return false;
      if (logStatus === 'closed' && !a.closed) return false;
      if (logSrc === 'mt5' && a.source !== 'mt5') return false;
      if (logSrc === 'exchange' && a.source !== 'exchange') return false;
      return true;
    });
  }, [activityQ.data, logStatus, logSrc]);

  const calRaw = useMemo(() => {
    if (!calendarQ.data) return [];
    return buildCalendarCells(calendarQ.data.year, calendarQ.data.month, calendarQ.data.days);
  }, [calendarQ.data]);
  // The calendar grid always shows the current month (no month-navigation
  // UI) — a dateFilter from a different month still correctly filters
  // trades/activity (server-side, independent of this grid), it just isn't
  // highlighted here since the grid can't show a month it isn't displaying.
  const highlightedDay = useMemo(() => {
    if (!dateFilter || !calendarQ.data) return null;
    const [y, m, d] = dateFilter.split('-').map(Number);
    return y === calendarQ.data.year && m === calendarQ.data.month ? d : null;
  }, [dateFilter, calendarQ.data]);
  const selDay = calRaw.find(c => c && c.day === highlightedDay && c.hasData);
  const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const calendarTitle = calendarQ.data
    ? `${MONTH_NAMES[calendarQ.data.month - 1]} ${calendarQ.data.year}`
    : '—';
  const logCount = openTrades.length + activityLog.length;
  const livePnl = useLiveTradePnl(openTrades);
  const tradesPanelLabel = dateFilter
    ? `Trades · ${fmtDeDate(dateFilter)}`
    : logStatus === 'open' ? 'Offene Trades · vollständig'
    : logStatus === 'closed' ? 'Geschlossene Trades · vollständig'
    : 'Alle Trades · vollständig';

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--line)', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div style={{ background: 'var(--panel)', display: 'flex', alignItems: 'center', gap: 14, padding: '8px 14px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Status</div>
        <div style={{ display: 'flex', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
          <button onClick={() => setLogStatus('all')} style={segBtn(logStatus === 'all', true)}>ALLE</button>
          <button onClick={() => setLogStatus('open')} style={segBtn(logStatus === 'open')}>OFFEN</button>
          <button onClick={() => setLogStatus('closed')} style={segBtn(logStatus === 'closed')}>GESCHLOSSEN</button>
        </div>
        <div style={{ width: 1, height: 16, background: 'var(--line)' }} />
        <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Quelle</div>
        <div style={{ display: 'flex', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
          <button onClick={() => setLogSrc('all')} style={segBtn(logSrc === 'all', true)}>ALLE</button>
          <button onClick={() => setLogSrc('mt5')} style={segBtn(logSrc === 'mt5')}>MT5</button>
          <button onClick={() => setLogSrc('exchange')} style={segBtn(logSrc === 'exchange')}>KRAKEN/BINANCE</button>
        </div>
        <div style={{ width: 1, height: 16, background: 'var(--line)' }} />
        <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Tag</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
          <input
            type="date"
            value={dateFilter ?? ''}
            max={todayBerlinDateStr()}
            onChange={(e) => applyDateFilter(e.target.value || null)}
            style={{
              fontFamily: 'inherit', fontSize: 10, padding: '3px 6px',
              background: 'var(--panel3)', border: `1px solid ${dateFilter ? 'var(--acc)' : 'var(--line2)'}`, color: 'var(--txt)',
            }}
          />
          {dateFilter && (
            <button onClick={() => applyDateFilter(null)} style={segBtn(false, true)}>FILTER ENTFERNEN</button>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt3)' }}>{logCount} Einträge</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: dense ? '1fr 320px' : '1fr 280px', gap: 1, background: 'var(--line)', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', gap: 1, background: 'var(--line)', minHeight: 0 }}>
          <ErrorBoundary>
          <div style={{ background: 'var(--panel)' }}>
            <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>{tradesPanelLabel}</div>
            <StatusPanel loading={tradesQ.loading} error={tradesQ.error} onRetry={tradesQ.reload} />
            {!tradesQ.loading && !tradesQ.error && openTrades.length === 0 && (
              <div style={{ padding: '14px 12px', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--txt2)' }}>
                {dateFilter ? `Keine Trades am ${fmtDeDate(dateFilter)}.` : 'Keine Trades.'}
              </div>
            )}
            {!tradesQ.loading && !tradesQ.error && openTrades.length > 0 && (
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflowX: 'auto' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '74px 60px 54px 84px 84px 84px 110px 60px 72px 1fr', gap: 8, padding: '4px 10px', color: 'var(--txt3)', borderBottom: '1px solid var(--line)', minWidth: 820 }}>
                  <div>SYMBOL</div><div>RICHT.</div><div style={{ textAlign: 'right' }}>VOL.</div><div style={{ textAlign: 'right' }}>EINSTIEG</div><div style={{ textAlign: 'right' }}>SL</div><div style={{ textAlign: 'right' }}>TP</div><div>STRATEGIE</div><div style={{ textAlign: 'right' }}>FAKTOR</div><div style={{ textAlign: 'right' }}>LAUFZEIT</div><div style={{ textAlign: 'right' }}>P/L</div>
                </div>
                {openTrades.map((t) => {
                  const pnl = pnlDisplay(livePnl.get(t.id)?.pnl);
                  return (
                    <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '74px 60px 54px 84px 84px 84px 110px 60px 72px 1fr', gap: 8, padding: '5px 10px', borderBottom: '1px solid var(--line)', minWidth: 820 }}>
                      <div style={{ color: 'var(--txt)' }}>{t.symbol}</div><div style={{ color: 'var(--txt2)' }}>{t.dir}</div>
                      <div style={{ textAlign: 'right' }}>{t.vol}</div><div style={{ textAlign: 'right' }}>{t.entryFmt}</div>
                      <div style={{ textAlign: 'right' }}>{t.sl}</div><div style={{ textAlign: 'right' }}>{t.tp}</div>
                      <div style={{ color: 'var(--txt2)' }}>{t.strategy}</div>
                      <div style={{ textAlign: 'right', color: 'var(--acc)' }}>{t.factor}</div>
                      <div style={{ textAlign: 'right', color: 'var(--txt2)' }}>{t.duration}</div>
                      <div style={{ textAlign: 'right', color: pnl.color, fontWeight: 600 }}>{pnl.text}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </ErrorBoundary>

          <ErrorBoundary>
          <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>
              {dateFilter ? `Aktivitäts-Historie · ${fmtDeDate(dateFilter)}` : 'Vollständige Aktivitäts-Historie'}
            </div>
            <StatusPanel loading={activityQ.loading} error={activityQ.error} onRetry={activityQ.reload} />
            {!activityQ.loading && !activityQ.error && activityLog.length === 0 && (
              <div style={{ padding: '14px 10px', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--txt2)' }}>
                {dateFilter ? `Keine Log-Einträge am ${fmtDeDate(dateFilter)}.` : 'Keine Log-Einträge.'}
              </div>
            )}
            {!activityQ.loading && !activityQ.error && activityLog.length > 0 && (
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, lineHeight: 1.9, padding: '7px 10px', overflow: 'auto', flex: 1, minHeight: 0 }}>
                {activityLog.map((a, i) => (
                  <div key={i} style={{ borderBottom: '1px solid var(--line)', padding: '3px 0', color: 'var(--txt2)' }}>
                    <span style={{ color: 'var(--txt3)' }}>{a.time}</span>{' '}
                    <span style={{ color: 'var(--txt3)', width: 52, display: 'inline-block' }}>{a.src}</span>{' '}
                    <span style={{ color: a.mark === '·' ? 'var(--txt3)' : 'var(--acc)' }}>{a.mark}</span> {a.text}
                  </div>
                ))}
              </div>
            )}
          </div>
          </ErrorBoundary>
        </div>

        <ErrorBoundary>
        <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
          <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>PNL-Kalender · {calendarTitle}</div>
          <StatusPanel loading={calendarQ.loading} error={calendarQ.error} onRetry={calendarQ.reload} />
          {!calendarQ.loading && !calendarQ.error && (
          <div style={{ padding: '10px 12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3, fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt3)', textAlign: 'center', marginBottom: 4 }}>
              {WEEKDAYS.map(d => <div key={d}>{d}</div>)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3 }}>
              {calRaw.map((c, i) => {
                if (!c) return <div key={i} />;
                const selected = c.day === highlightedDay;
                let bg, border, dayColor, pnlShort, pnlColor;
                if (!c.hasData) {
                  bg = selected ? 'var(--panel3)' : 'var(--panel)';
                  border = selected ? 'var(--acc)' : 'var(--line)';
                  dayColor = 'var(--txt3)'; pnlShort = ''; pnlColor = 'var(--txt3)';
                } else {
                  const neg = c.total < 0;
                  pnlShort = (c.total >= 0 ? '+' : '−') + Math.abs(Math.round(c.total));
                  pnlColor = neg ? 'var(--acc)' : 'var(--txt)';
                  bg = neg ? 'var(--accsoft)' : 'var(--panel3)';
                  border = selected ? 'var(--acc)' : (neg ? 'var(--acc2)' : 'var(--line2)');
                  dayColor = 'var(--txt2)';
                }
                return (
                  <button
                    key={i}
                    onClick={() => applyDateFilter(`${calendarQ.data.year}-${pad2(calendarQ.data.month)}-${pad2(c.day)}`)}
                    style={{ aspectRatio: '1', background: bg, border: `1px solid ${border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontFamily: "'IBM Plex Mono',monospace", padding: 2 }}
                  >
                    <div style={{ fontSize: 9, color: dayColor }}>{c.day}</div>
                    {c.hasData && <div style={{ fontSize: 8, color: pnlColor, marginTop: 1 }}>{pnlShort}</div>}
                  </button>
                );
              })}
            </div>
          </div>
          )}
          <div style={{ padding: '10px 12px', borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>{highlightedDay ? `Tag ${highlightedDay} · nach Quelle` : 'Kein Tag ausgewählt'}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
              <div style={{ width: 9, height: 9, background: 'var(--txt2)' }} /><div style={{ flex: 1, color: 'var(--txt2)' }}>MT5</div><div>{selDay ? fmtSigned(selDay.mt5) : '—'}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
              <div style={{ width: 9, height: 9, background: 'var(--acc)' }} /><div style={{ flex: 1, color: 'var(--txt2)' }}>Kraken/Binance</div><div>{selDay ? fmtSigned(selDay.exch) : '—'}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', paddingTop: 5, borderTop: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
              <div style={{ flex: 1, color: 'var(--txt2)' }}>Gesamt</div><div style={{ fontWeight: 600 }}>{selDay ? fmtSigned(selDay.total) : '—'}</div>
            </div>
          </div>
        </div>
        </ErrorBoundary>
      </div>
    </div>
  );
}
