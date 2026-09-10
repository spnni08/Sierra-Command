import { useApp } from '../context/AppContext';
import CandlestickChart from '../components/CandlestickChart';
import { MULTI_CHART_TILES, BOT_ACTIVITY, STRATEGY_MATRIX, FACTOR_UTIL } from '../data/mockData';

function badgeStyle(kind) {
  if (kind === 'active') return { fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: '#fff', background: 'var(--acc)', padding: '1px 5px', letterSpacing: '0.06em' };
  return { fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt2)', border: '1px solid var(--line2)', padding: '0 5px', letterSpacing: '0.06em' };
}

function ChartTile({ tile }) {
  return (
    <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)' }}>
        <div style={{ fontWeight: 600, fontSize: 11, letterSpacing: '0.04em' }}>{tile.label}</div>
        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt3)', border: '1px solid var(--line2)', padding: '0 4px' }}>{tile.tf}</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>{tile.price}</div>
        <div style={badgeStyle(tile.badge.kind)}>{tile.badge.text}</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: 'var(--chart)' }}>
        <CandlestickChart symbol={tile.sym} kind="candles" n={tile.n} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderTop: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt2)' }}>
        <div style={{ display: 'flex', gap: 2 }}>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} style={{ width: 9, height: 9, background: i < tile.factors ? 'var(--acc)' : 'transparent', border: i < tile.factors ? 'none' : '1px solid var(--line2)' }} />
          ))}
        </div>
        <div>{tile.strategy}</div>
        <div style={{ flex: 1 }} />
        <div style={{ color: 'var(--txt)' }}>KONF {tile.conf}%</div>
      </div>
    </div>
  );
}

export default function MultiChart() {
  const { dense } = useApp();

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateColumns: dense ? '1fr 268px' : '1fr', gap: 1, background: 'var(--line)', minHeight: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(290px,1fr))', gridAutoRows: 'minmax(210px,1fr)', gap: 1, background: 'var(--line)', overflow: 'auto', minHeight: 0 }}>
        {MULTI_CHART_TILES.map(tile => <ChartTile key={tile.sym} tile={tile} />)}
      </div>

      {dense && (
        <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
          <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Bot-Aktivität</div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, lineHeight: 1.75, padding: '7px 9px', borderBottom: '1px solid var(--line)', color: 'var(--txt2)' }}>
            {BOT_ACTIVITY.map((a, i) => (
              <div key={i}>
                <span style={{ color: 'var(--txt3)' }}>{a.time}</span>{' '}
                <span style={{ color: a.mark === '·' ? 'var(--txt3)' : 'var(--acc)' }}>{a.mark}</span> {a.text}
              </div>
            ))}
          </div>

          <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Strategie-Matrix</div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 42px 42px 44px', padding: '4px 9px', color: 'var(--txt3)', borderBottom: '1px solid var(--line)' }}>
              <div>STRATEGIE</div><div style={{ textAlign: 'right' }}>FAKT.</div><div style={{ textAlign: 'right' }}>SIG.</div><div style={{ textAlign: 'right' }}>TREFF.</div>
            </div>
            {STRATEGY_MATRIX.map(row => (
              <div key={row.name} style={{ display: 'grid', gridTemplateColumns: '1fr 42px 42px 44px', padding: '5px 9px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ color: 'var(--txt)' }}>{row.name}</div>
                <div style={{ textAlign: 'right', color: row.hot ? 'var(--acc)' : 'var(--txt2)' }}>{row.factor}</div>
                <div style={{ textAlign: 'right', color: 'var(--txt2)' }}>{row.sig}</div>
                <div style={{ textAlign: 'right', color: 'var(--txt2)' }}>{row.hit}</div>
              </div>
            ))}
          </div>

          <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', borderTop: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Faktor-Auslastung</div>
          <div style={{ padding: '8px 9px', display: 'flex', flexDirection: 'column', gap: 6, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
            {FACTOR_UTIL.map(f => (
              <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <div style={{ width: 96, color: 'var(--txt2)' }}>{f.label}</div>
                <div style={{ flex: 1, height: 7, background: 'var(--panel3)' }}><div style={{ width: f.pct + '%', height: '100%', background: 'var(--acc)' }} /></div>
                <div style={{ width: 26, textAlign: 'right' }}>{f.pct}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
