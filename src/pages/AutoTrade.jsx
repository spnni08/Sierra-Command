import { useCallback, useEffect, useState } from 'react';
import { SESSIONS, NEWSLV } from '../data/mockData';
import { fetchStrategies, putStrategySettings } from '../api/client';
import { useFetch } from '../api/useFetch';
import StatusPanel from '../api/StatusPanel';

function sessionIdxFromFilter(filter) {
  if (!Array.isArray(filter) || filter.length === 0) return 0; // Alle Sessions
  if (filter.length === 1) return 2; // Ohne Asien (heuristic: partial filter)
  return 1; // Nur EU+US
}

function sessionFilterFromIdx(idx) {
  if (idx === 0) return [];
  if (idx === 1) return ['eu', 'us'];
  return ['eu'];
}

function newsIdxFromThreshold(t) {
  if (typeof t !== 'number') return 1;
  if (t < 0.4) return 0;
  if (t < 0.55) return 1;
  return 2;
}

function newsThresholdFromIdx(idx) {
  return [0.3, 0.5, 0.6][idx] ?? 0.5;
}

function toCardStrategy(row) {
  const factorCount = Array.isArray(row.factor_definition?.factors) ? row.factor_definition.factors.length : 0;
  return {
    id: row.id,
    name: row.name,
    market: Array.isArray(row.asset_classes) ? row.asset_classes.join(', ') : '',
    active: row.active,
    risk: row.settings.risk_per_trade_pct ?? 1.0,
    sessionIdx: sessionIdxFromFilter(row.settings.session_filter),
    corr: row.settings.correlation_limit ?? 0.8,
    newsIdx: newsIdxFromThreshold(row.settings.news_filter_threshold),
    factors: factorCount ? `${factorCount}/7` : '—',
  };
}

function StrategyCard({ st, onToggle, onRisk, onSession, onCorr, onNews }) {
  return (
    <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', borderTop: '2px solid var(--acc)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', flexWrap: 'wrap' }}>
        <button onClick={onToggle} style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}>
          <span style={{ width: 12, height: 12, border: '1px solid var(--line2)', display: 'block', position: 'relative', background: 'var(--panel3)' }}>
            {st.active && <span style={{ position: 'absolute', inset: 2, background: 'var(--acc)', display: 'block' }} />}
          </span>
        </button>
        <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: '0.03em' }}>{st.name}</div>
        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt3)' }}>{st.market}</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt2)' }}>Faktor {st.factors}</div>
      </div>

      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
          <div style={{ flex: 1, color: 'var(--txt2)' }}>Risiko pro Trade</div><div>{st.risk.toFixed(1)}%</div>
        </div>
        <input type="range" min="0.1" max="2" step="0.1" value={st.risk} onChange={onRisk} style={{ width: '100%', accentColor: 'var(--acc)', height: 14 }} />
      </div>

      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, color: 'var(--txt2)', fontSize: 11 }}>Session-Filter</div>
        <button onClick={onSession} style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '3px 9px', border: '1px solid var(--line2)', background: 'var(--panel3)', color: 'var(--txt)', cursor: 'pointer' }}>{SESSIONS[st.sessionIdx]}</button>
      </div>

      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
          <div style={{ flex: 1, color: 'var(--txt2)' }}>Korrelationsgrenze (ρ)</div><div>{st.corr.toFixed(2)}</div>
        </div>
        <input type="range" min="0.5" max="1" step="0.05" value={st.corr} onChange={onCorr} style={{ width: '100%', accentColor: 'var(--acc)', height: 14 }} />
      </div>

      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, color: 'var(--txt2)', fontSize: 11 }}>News-Filter-Schwelle</div>
        <button onClick={onNews} style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '3px 9px', border: '1px solid var(--line2)', background: 'var(--panel3)', color: 'var(--txt)', cursor: 'pointer' }}>{NEWSLV[st.newsIdx]}</button>
      </div>
    </div>
  );
}

export default function AutoTrade() {
  const [auto, setAuto] = useState(true);
  const [strategies, setStrategies] = useState([]);

  const loadStrategies = useCallback(() => fetchStrategies(), []);
  const { data, loading, error, reload } = useFetch(loadStrategies, [loadStrategies]);

  useEffect(() => {
    if (data) setStrategies(data.map(toCardStrategy));
  }, [data]);

  const activeCount = strategies.filter(s => s.active).length;
  const autoLabel = auto ? `AKTIV · ${activeCount} Strategien` : 'PAUSIERT';

  const update = (i, patch) => {
    setStrategies(prev => {
      const arr = prev.slice();
      const next = { ...arr[i], ...patch };
      arr[i] = next;

      // Best-effort write-through to the backend; UI stays optimistic even
      // if the PUT fails (surfaced only via console, not blocking the page).
      putStrategySettings(next.id, {
        risk_per_trade_pct: next.risk,
        session_filter: sessionFilterFromIdx(next.sessionIdx),
        correlation_limit: next.corr,
        news_filter_threshold: newsThresholdFromIdx(next.newsIdx),
      }).catch(err => console.error('Failed to save strategy settings', err));

      return arr;
    });
  };

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateRows: 'auto auto auto 1fr', background: 'var(--line)', gap: 1, minHeight: 0 }}>
      <div style={{ background: 'var(--panel)', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Auto-Trade-Einstellungen</div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setAuto(a => !a)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--txt)' }}>
          <span style={{ width: 34, height: 16, border: '1px solid var(--line2)', background: 'var(--panel3)', display: 'block', position: 'relative' }}>
            {auto
              ? <span style={{ position: 'absolute', top: 1, right: 1, width: 15, height: 12, background: 'var(--acc)', display: 'block' }} />
              : <span style={{ position: 'absolute', top: 1, left: 1, width: 15, height: 12, background: 'var(--line2)', display: 'block' }} />}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Automatischer Handel: {autoLabel}</span>
        </button>
      </div>

      <div style={{ background: 'var(--panel)', padding: '11px 16px', display: 'flex', flexWrap: 'wrap', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}><div style={{ color: 'var(--txt2)' }}>Max. gleichzeitige Positionen</div><div style={{ fontWeight: 600 }}>5</div></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}><div style={{ color: 'var(--txt2)' }}>Tages-Verlustlimit</div><div style={{ fontWeight: 600 }}>−2,5% · 1.205 €</div></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}><div style={{ color: 'var(--txt2)' }}>Max. Slippage</div><div style={{ fontWeight: 600 }}>3 Pips</div></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}><div style={{ color: 'var(--txt2)' }}>Handelszeiten (global)</div><div style={{ fontWeight: 600 }}>06:00 – 22:00 UTC</div></div>
      </div>

      <div style={{ padding: '6px 16px', background: 'var(--panel)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Pro Strategie ({strategies.length})</div>

      <div style={{ overflow: 'auto', minHeight: 0 }}>
        <StatusPanel loading={loading} error={error} onRetry={reload} />

        {!loading && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line)' }}>
            {strategies.map((st, i) => (
              <StrategyCard
                key={st.id}
                st={st}
                onToggle={() => update(i, { active: !st.active })}
                onRisk={e => update(i, { risk: parseFloat(e.target.value) })}
                onCorr={e => update(i, { corr: parseFloat(e.target.value) })}
                onSession={() => update(i, { sessionIdx: (st.sessionIdx + 1) % SESSIONS.length })}
                onNews={() => update(i, { newsIdx: (st.newsIdx + 1) % NEWSLV.length })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
