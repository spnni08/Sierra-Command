import { useCallback } from 'react';
import { useApp } from '../context/AppContext';
import CandlestickChart from '../components/CandlestickChart';
import { openTradesData, STRATEGY_SUGGESTIONS, SIGNAL_FACTORS } from '../data/mockData';
import { fetchBacktestRuns } from '../api/client';
import { useFetch } from '../api/useFetch';
import StatusPanel from '../api/StatusPanel';

function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return (v * 100).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
function fmtNum(v, dec = 2) {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

const TF = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

function tfStyle(active) {
  return {
    padding: '2px 7px', borderLeft: 0, fontFamily: 'inherit',
    border: active ? '1px solid var(--acc)' : '1px solid var(--line2)',
    background: active ? 'var(--acc)' : 'transparent',
    color: active ? '#fff' : 'var(--txt2)',
  };
}

const th = { };
function metricBox(label, val, accent) {
  return (
    <div style={{ background: 'var(--panel)', padding: '8px 9px' }}>
      <div style={{ fontSize: 9, color: 'var(--txt3)', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 16, marginTop: 2, color: accent ? 'var(--acc)' : 'var(--txt)' }}>{val}</div>
    </div>
  );
}

export default function ProTerminal() {
  const { dense } = useApp();
  const trades = openTradesData();

  const loadBacktests = useCallback(() => fetchBacktestRuns(), []);
  const backtestQ = useFetch(loadBacktests, [loadBacktests]);
  const latestBacktest = (backtestQ.data && backtestQ.data[0]) || null;

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateColumns: dense ? '1fr 340px' : '1fr 300px', gap: 1, background: 'var(--line)', minHeight: 0 }}>
      <div style={{ display: 'grid', gridTemplateRows: '1fr auto', gap: 1, background: 'var(--line)', minHeight: 0 }}>

        <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.03em' }}>BTC/USD</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 15 }}>64.812,50</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>+542,10 (+0,84%)</div>
            <div style={{ width: 1, height: 16, background: 'var(--line)' }} />
            <div style={{ display: 'flex', gap: 0, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
              {TF.map(t => <div key={t} style={tfStyle(t === 'M15')}>{t}</div>)}
            </div>
            {dense && (
              <div style={{ display: 'flex', gap: 6, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>
                <div style={{ padding: '2px 7px', border: '1px solid var(--line)' }}>EMA 21/55</div>
                <div style={{ padding: '2px 7px', border: '1px solid var(--line)' }}>ATR 14</div>
                <div style={{ padding: '2px 7px', border: '1px solid var(--line)' }}>VOL-PROFIL</div>
              </div>
            )}
            <div style={{ flex: 1 }} />
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>MOMENTUM-M7 · AKTIV</div>
          </div>
          <div style={{ flex: 1, minHeight: 0, background: 'var(--chart)' }}>
            <CandlestickChart symbol="BTCUSD" kind="candles" n={120} levels />
          </div>
          <div style={{ display: 'flex', gap: 16, padding: '5px 9px', borderTop: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, background: 'var(--panel2)', flexWrap: 'wrap' }}>
            <div style={{ color: 'var(--txt2)' }}>EINSTIEG <span style={{ color: 'var(--txt)' }}>64.310,00</span></div>
            <div style={{ color: 'var(--txt2)' }}>TP <span style={{ color: 'var(--txt)' }}>66.150,00</span> <span style={{ color: 'var(--txt3)' }}>(+2,86%)</span></div>
            <div style={{ color: 'var(--txt2)' }}>SL <span style={{ color: 'var(--txt)' }}>63.720,00</span> <span style={{ color: 'var(--txt3)' }}>(−0,92%)</span></div>
            <div style={{ color: 'var(--txt2)' }}>CRV <span style={{ color: 'var(--txt)' }}>1 : 3,12</span></div>
            <div style={{ color: 'var(--txt2)' }}>RISIKO <span style={{ color: 'var(--txt)' }}>0,8% · 236 €</span></div>
            <div style={{ flex: 1 }} />
            <div style={{ color: 'var(--txt2)' }}>LAUFZEIT <span style={{ color: 'var(--txt)' }}>02:41 h</span></div>
          </div>
        </div>

        <div style={{ background: 'var(--panel)' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '5px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)' }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Aktuelle Trades</div>
            <div style={{ flex: 1 }} />
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>3 offen · Exposure 1,42% · schwebend <span style={{ color: 'var(--txt)' }}>+418,60 €</span></div>
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '78px 62px 56px 88px 88px 88px 1fr 84px', padding: '4px 9px', color: 'var(--txt3)', borderBottom: '1px solid var(--line)', minWidth: 640 }}>
              <div>SYMBOL</div><div>RICHTUNG</div><div style={{ textAlign: 'right' }}>VOL.</div><div style={{ textAlign: 'right' }}>EINSTIEG</div><div style={{ textAlign: 'right' }}>SL</div><div style={{ textAlign: 'right' }}>TP</div><div style={{ textAlign: 'right' }}>STRATEGIE</div><div style={{ textAlign: 'right' }}>P/L</div>
            </div>
            {trades.map((t, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '78px 62px 56px 88px 88px 88px 1fr 84px', padding: '5px 9px', borderBottom: '1px solid var(--line)', minWidth: 640 }}>
                <div style={{ color: 'var(--txt)' }}>{t.symbol}</div><div style={{ color: 'var(--txt2)' }}>{t.dir}</div>
                <div style={{ textAlign: 'right' }}>{t.vol}</div><div style={{ textAlign: 'right' }}>{t.entry}</div>
                <div style={{ textAlign: 'right' }}>{t.sl}</div><div style={{ textAlign: 'right' }}>{t.tp}</div>
                <div style={{ textAlign: 'right', color: 'var(--txt2)' }}>{t.strategy}</div>
                <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{t.pnl}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Backtest · MOMENTUM-M7 · 24 Monate</div>
        <StatusPanel loading={backtestQ.loading} error={backtestQ.error} onRetry={backtestQ.reload} />
        {!backtestQ.loading && !backtestQ.error && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--line)', borderBottom: '1px solid var(--line)' }}>
          {metricBox('PROFIT-FAKTOR', fmtNum(latestBacktest?.profit_factor))}
          {metricBox('MAX. DRAWDOWN', latestBacktest ? '−' + fmtPct(Math.abs(latestBacktest.max_drawdown)) : '—', true)}
          {metricBox('SHARPE', fmtNum(latestBacktest?.sharpe))}
          {metricBox('SORTINO', fmtNum(latestBacktest?.sortino))}
        </div>
        )}

        {dense && !backtestQ.loading && !backtestQ.error && (
          <>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, borderBottom: '1px solid var(--line)' }}>
              {[
                ['Symbol', latestBacktest?.symbol ?? '—'],
                ['Zeitraum', latestBacktest ? `${latestBacktest.timeframe_start} – ${latestBacktest.timeframe_end}` : '—'],
                ['Sharpe / Sortino', `${fmtNum(latestBacktest?.sharpe)} / ${fmtNum(latestBacktest?.sortino)}`],
                ['Out-of-Sample-Abweichung', latestBacktest ? fmtPct(latestBacktest.out_of_sample_deviation) : '—'],
              ].map(([l, v], i, arr) => (
                <div key={l} style={{ display: 'flex', padding: '4px 9px', borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 'none' }}>
                  <div style={{ flex: 1, color: 'var(--txt2)' }}>{l}</div><div>{v}</div>
                </div>
              ))}
            </div>

            <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Equity-Kurve (Backtest)</div>
            <div style={{ height: 96, background: 'var(--chart)', borderBottom: '1px solid var(--line)' }}>
              <CandlestickChart symbol="BTEQ" kind="line" n={180} />
            </div>
          </>
        )}

        <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Strategie-Verbesserungen</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {STRATEGY_SUGGESTIONS.filter(s => dense || !s.denseOnly).map((s, i) => (
            <div key={i} style={{ padding: '8px 9px', borderBottom: '1px solid var(--line)', borderLeft: `2px solid ${s.priority === 'HOCH' ? 'var(--acc)' : 'var(--line2)'}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: s.priority === 'NIEDRIG' ? 'var(--txt3)' : (s.priority === 'HOCH' ? 'var(--acc)' : 'var(--txt2)'), letterSpacing: '0.08em' }}>{s.priority}</div>
                <div style={{ fontWeight: 600, fontSize: 11 }}>{s.title}</div>
              </div>
              <div style={{ color: 'var(--txt2)', lineHeight: 1.5, marginTop: 3, fontSize: 11 }}>{s.body}</div>
              {s.expect && <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', marginTop: 5 }}>{s.expect}</div>}
              {s.actions && (dense || s.priority === 'HOCH') && (
                <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                  <button style={{ background: 'var(--acc)', border: 0, color: '#fff', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '4px 10px', cursor: 'pointer', letterSpacing: '0.06em' }}>ÜBERNEHMEN</button>
                  <button style={{ background: 'transparent', border: '1px solid var(--line2)', color: 'var(--txt2)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '4px 10px', cursor: 'pointer', letterSpacing: '0.06em' }}>BACKTEST</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {dense && (
          <>
            <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Signal-Faktoren · aktuell</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
              {SIGNAL_FACTORS.map((f, i, arr) => (
                <div key={f.label} style={{ display: 'flex', padding: '4px 9px', borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 'none' }}>
                  <div style={{ width: 12, color: f.on ? 'var(--acc)' : 'var(--txt3)' }}>{f.on ? '✓' : '×'}</div>
                  <div style={{ flex: 1, color: f.on ? 'var(--txt2)' : 'var(--txt3)' }}>{f.label}</div>
                  <div style={{ color: f.on ? 'var(--txt)' : 'var(--txt3)' }}>{f.val}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
