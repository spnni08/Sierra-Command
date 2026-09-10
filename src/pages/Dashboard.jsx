import { useCallback, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import CandlestickChart from '../components/CandlestickChart';
import { fetchTrades } from '../api/client';
import { useFetch } from '../api/useFetch';
import StatusPanel from '../api/StatusPanel';

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

function toClosedRow(t) {
  const neg = (t.pnl ?? 0) < 0;
  const pnlAbs = Math.abs(t.pnl ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    time: fmtClosedTime(t.closed_at),
    symbol: t.symbol,
    dir: t.direction === 'long' ? 'LONG' : 'SHORT',
    strategy: '—',
    duration: fmtHours(t.opened_at, t.closed_at || t.opened_at),
    pnl: (neg ? '−' : '+') + pnlAbs + ' €',
    neg,
  };
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
  const closedQ = useFetch(loadClosedTrades, [loadClosedTrades]);
  const recentClosedTrades = useMemo(
    () => (closedQ.data || []).slice(0, 5).map(toClosedRow),
    [closedQ.data]
  );

  const kpis = isBacktest
    ? [
        { label: 'Endkapital (Backtest)', val: '61.842,00 €', sub: 'Startkapital 42.000 € · +47,2%' },
        { label: 'Nettogewinn (Backtest)', val: '+18.427 €', sub: 'Profit-Faktor 1,74' },
        { label: 'Trefferquote (Backtest)', val: '57,2%', sub: '1.284 Trades gesamt' },
        { label: 'Max. Drawdown', val: '−9,4%', sub: 'Längste Verlustserie 7', accent: true },
      ]
    : [
        { label: 'Kontostand', val: '48.216,40 €', sub: 'Frei 46.798,10 € · Margin 1.418,30 €' },
        { label: 'Ergebnis heute', val: '+418,60 €', sub: '+0,87% · 6 Trades' },
        { label: 'Trefferquote 30 T.', val: '57,2%', sub: '124 Trades · PF 1,74' },
        { label: 'Offenes Risiko', val: '1,42%', sub: 'Limit 3,00% · 3 Positionen', accent: true },
      ];

  const equityTitle = isBacktest ? 'Equity-Kurve · Backtest 24 Monate' : 'Kapitalentwicklung · 90 Tage';
  const equitySub = isBacktest ? 'Start 42.000 € · Endkapital 61.842 € · +47,2%' : 'Start 42.000 € · Aktuell 48.216 € · +14,8%';
  const equityKey = isBacktest ? 'BTEQ' : 'EQUITY';
  const equityN = isBacktest ? 180 : 90;

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
          {isBacktest ? '24-Monats-Backtest, keine echten Positionen' : 'Zusammengeführt: MT5 + Kraken/Binance'}
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

      <div style={{ display: 'grid', gridTemplateColumns: dense ? '1fr 340px' : '1fr 300px', gap: 1, background: 'var(--line)', flex: 1, minHeight: 0 }}>
        <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 260 }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)' }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>{equityTitle}</div>
            <div style={{ flex: 1 }} />
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>{equitySub}</div>
          </div>
          <div style={{ flex: 1, minHeight: 180, background: 'var(--chart)' }}>
            <CandlestickChart symbol={equityKey} kind="line" n={equityN} />
          </div>
        </div>

        <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>PNL nach Quelle · heute</div>
          <div style={{ padding: '11px 12px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
              <div style={{ width: 9, height: 9, background: 'var(--txt2)' }} />
              <div style={{ flex: 1, color: 'var(--txt2)' }}>MT5 · Forex/Indizes</div><div style={{ color: 'var(--txt)' }}>+186,20 €</div>
            </div>
            <div style={{ height: 6, background: 'var(--panel3)' }}><div style={{ width: '45%', height: '100%', background: 'var(--txt2)' }} /></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
              <div style={{ width: 9, height: 9, background: 'var(--acc)' }} />
              <div style={{ flex: 1, color: 'var(--txt2)' }}>Kraken/Binance · Krypto</div><div style={{ color: 'var(--txt)' }}>+232,40 €</div>
            </div>
            <div style={{ height: 6, background: 'var(--panel3)' }}><div style={{ width: '55%', height: '100%', background: 'var(--acc)' }} /></div>
            <div style={{ display: 'flex', alignItems: 'center', paddingTop: 4, borderTop: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
              <div style={{ flex: 1, color: 'var(--txt2)' }}>Gesamt</div><div style={{ fontWeight: 600 }}>+418,60 €</div>
            </div>
          </div>
          <div style={{ padding: '11px 12px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Konto-Kennzahlen</div>
            <div style={{ display: 'flex', alignItems: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}><div style={{ flex: 1, color: 'var(--txt2)' }}>Freie Margin</div><div>46.798,10 €</div></div>
            <div style={{ display: 'flex', alignItems: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}><div style={{ flex: 1, color: 'var(--txt2)' }}>Gebundene Margin</div><div>1.418,30 €</div></div>
            <div style={{ display: 'flex', alignItems: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}><div style={{ flex: 1, color: 'var(--txt2)' }}>Offenes Risiko</div><div style={{ color: 'var(--acc)' }}>1,42% / 3,00%</div></div>
          </div>
          <button onClick={goAutoSettings} style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'transparent', border: 0, borderBottom: '1px solid var(--line)', padding: '11px 12px', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--txt)', textAlign: 'left' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Auto-Trade-Einstellungen</div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', marginTop: 2 }}>AKTIV · 3 Strategien · pro Strategie konfigurierbar</div>
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
