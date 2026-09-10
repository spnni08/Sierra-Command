import { useCallback, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { fetchTrades, fetchActivityLog, fetchPnlCalendar } from '../api/client';
import { useFetch } from '../api/useFetch';
import StatusPanel from '../api/StatusPanel';

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

function fmtDuration(openedAt, closedAt) {
  const start = new Date(openedAt.replace(' ', 'T') + 'Z');
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
    symbol: t.symbol,
    dir: t.direction === 'long' ? 'LONG' : 'SHORT',
    vol: fmtNum(t.volume, 2),
    entry: fmtNum(t.entry, t.entry < 50 ? 5 : 2),
    sl: fmtNum(t.sl, 2),
    tp: fmtNum(t.tp, 2),
    strategy: '—',
    factor: '—',
    duration: fmtDuration(t.opened_at, t.closed_at),
    pnl: t.pnl === null || t.pnl === undefined ? '—' : (t.pnl >= 0 ? '+' : '−') + fmtNum(Math.abs(t.pnl), 2),
    source: sourceGroup(t.source),
  };
}

function toRowActivity(a) {
  const closed = /geschlossen/.test(a.message);
  const opened = /eröffnet|eroeffnet/.test(a.message);
  const timePart = (a.timestamp || '').split(' ')[1] || a.timestamp;
  const srcLabel = { binance: 'BINANCE', oanda: 'MT5', system: 'SYSTEM' }[a.source] || a.source?.toUpperCase();
  return {
    time: timePart,
    src: srcLabel,
    mark: closed ? '✕' : opened ? '▸' : '·',
    text: a.message,
    source: a.source === 'system' ? 'system' : sourceGroup(a.source === 'oanda' ? 'oanda_demo' : 'binance_testnet'),
    closed,
  };
}

export default function LogPage() {
  const { dense } = useApp();
  const [logStatus, setLogStatus] = useState('all');
  const [logSrc, setLogSrc] = useState('all');
  const [selectedDay, setSelectedDay] = useState(9);

  const loadTrades = useCallback(() => fetchTrades('open'), []);
  const loadActivity = useCallback(() => fetchActivityLog(), []);
  const loadPnlCalendar = useCallback(() => fetchPnlCalendar(), []);
  const tradesQ = useFetch(loadTrades, [loadTrades]);
  const activityQ = useFetch(loadActivity, [loadActivity]);
  const calendarQ = useFetch(loadPnlCalendar, [loadPnlCalendar]);

  const openTrades = useMemo(() => {
    const rows = (tradesQ.data || []).map(toRowTrade);
    return rows.filter(t => {
      if (logStatus === 'closed') return false;
      if (logSrc === 'mt5' && t.source !== 'mt5') return false;
      if (logSrc === 'exchange' && t.source !== 'exchange') return false;
      return true;
    });
  }, [tradesQ.data, logStatus, logSrc]);

  const activityLog = useMemo(() => {
    const rows = (activityQ.data || []).map(toRowActivity);
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
  const selDay = calRaw.find(c => c && c.day === selectedDay && c.hasData);
  const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const calendarTitle = calendarQ.data
    ? `${MONTH_NAMES[calendarQ.data.month - 1]} ${calendarQ.data.year}`
    : '—';
  const logCount = openTrades.length + activityLog.length;

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
        <div style={{ flex: 1 }} />
        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt3)' }}>{logCount} Einträge</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: dense ? '1fr 320px' : '1fr 280px', gap: 1, background: 'var(--line)', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', gap: 1, background: 'var(--line)', minHeight: 0 }}>
          <div style={{ background: 'var(--panel)' }}>
            <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Offene Trades · vollständig</div>
            <StatusPanel loading={tradesQ.loading} error={tradesQ.error} onRetry={tradesQ.reload} />
            {!tradesQ.loading && !tradesQ.error && (
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflowX: 'auto' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '74px 60px 54px 84px 84px 84px 110px 60px 72px 1fr', gap: 8, padding: '4px 10px', color: 'var(--txt3)', borderBottom: '1px solid var(--line)', minWidth: 820 }}>
                  <div>SYMBOL</div><div>RICHT.</div><div style={{ textAlign: 'right' }}>VOL.</div><div style={{ textAlign: 'right' }}>EINSTIEG</div><div style={{ textAlign: 'right' }}>SL</div><div style={{ textAlign: 'right' }}>TP</div><div>STRATEGIE</div><div style={{ textAlign: 'right' }}>FAKTOR</div><div style={{ textAlign: 'right' }}>LAUFZEIT</div><div style={{ textAlign: 'right' }}>P/L</div>
                </div>
                {openTrades.map((t, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '74px 60px 54px 84px 84px 84px 110px 60px 72px 1fr', gap: 8, padding: '5px 10px', borderBottom: '1px solid var(--line)', minWidth: 820 }}>
                    <div style={{ color: 'var(--txt)' }}>{t.symbol}</div><div style={{ color: 'var(--txt2)' }}>{t.dir}</div>
                    <div style={{ textAlign: 'right' }}>{t.vol}</div><div style={{ textAlign: 'right' }}>{t.entry}</div>
                    <div style={{ textAlign: 'right' }}>{t.sl}</div><div style={{ textAlign: 'right' }}>{t.tp}</div>
                    <div style={{ color: 'var(--txt2)' }}>{t.strategy}</div>
                    <div style={{ textAlign: 'right', color: 'var(--acc)' }}>{t.factor}</div>
                    <div style={{ textAlign: 'right', color: 'var(--txt2)' }}>{t.duration}</div>
                    <div style={{ textAlign: 'right' }}>{t.pnl}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Vollständige Aktivitäts-Historie</div>
            <StatusPanel loading={activityQ.loading} error={activityQ.error} onRetry={activityQ.reload} />
            {!activityQ.loading && !activityQ.error && (
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
        </div>

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
                const selected = c.day === selectedDay;
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
                  <button key={i} onClick={() => setSelectedDay(c.day)} style={{ aspectRatio: '1', background: bg, border: `1px solid ${border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontFamily: "'IBM Plex Mono',monospace", padding: 2 }}>
                    <div style={{ fontSize: 9, color: dayColor }}>{c.day}</div>
                    {c.hasData && <div style={{ fontSize: 8, color: pnlColor, marginTop: 1 }}>{pnlShort}</div>}
                  </button>
                );
              })}
            </div>
          </div>
          )}
          <div style={{ padding: '10px 12px', borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Tag {selectedDay} · nach Quelle</div>
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
      </div>
    </div>
  );
}
