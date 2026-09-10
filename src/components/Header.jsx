import { useApp } from '../context/AppContext';
import { TICKER } from '../data/mockData';

const TABS = [
  { key: 'multi', label: 'Multi-Chart' },
  { key: 'pro', label: 'Pro-Terminal' },
  { key: 'dash', label: 'Dashboard' },
  { key: 'log', label: 'Log' },
  { key: 'autosettings', label: 'Auto-Trade' },
  { key: 'settings', label: 'Einstellungen' },
];

const tabBtn = {
  position: 'relative', background: 'transparent', border: 0, borderRight: '1px solid var(--line)',
  color: 'var(--txt)', fontFamily: 'inherit', fontSize: 11, letterSpacing: '0.06em', padding: '0 16px',
  cursor: 'pointer', textTransform: 'uppercase', height: '100%',
};

export default function Header({ page, setPage }) {
  const { theme, toggleTheme, dense, setPro, setSimple } = useApp();
  const themeLabel = theme === 'dark' ? 'DUNKEL' : 'HELL';

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'stretch', background: 'var(--panel)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px 0 12px', borderRight: '1px solid var(--line)' }}>
          <div style={{ width: 13, height: 13, background: 'var(--acc)' }} />
          <div style={{ fontWeight: 700, letterSpacing: '0.14em', fontSize: 12 }}>
            SIERRA<span style={{ color: 'var(--txt3)', fontWeight: 500 }}> COMMAND</span>
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt3)', border: '1px solid var(--line)', padding: '1px 4px' }}>v4.2.1</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setPage(t.key)} style={tabBtn}>
              {t.label}
              {page === t.key && (
                <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'var(--acc)' }} />
              )}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 0, borderLeft: '1px solid var(--line)' }}>
          <div style={{ padding: '0 10px', fontSize: 10, color: 'var(--txt3)', letterSpacing: '0.08em' }}>ANSICHT</div>
          <button onClick={setPro} style={{ ...tabBtn, borderLeft: '1px solid var(--line)', fontSize: 11, padding: '0 12px' }}>
            Professionell
            {dense && <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'var(--acc)' }} />}
          </button>
          <button onClick={setSimple} style={{ ...tabBtn, borderLeft: '1px solid var(--line)', fontSize: 11, padding: '0 12px' }}>
            Einfach
            {!dense && <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'var(--acc)' }} />}
          </button>
          <button onClick={toggleTheme} style={{ background: 'transparent', border: 0, borderRight: '1px solid var(--line)', color: 'var(--txt2)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '0 12px', height: '100%', cursor: 'pointer', letterSpacing: '0.06em' }}>
            {themeLabel}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 14px' }}>
            <div style={{ width: 7, height: 7, background: 'var(--acc)' }} />
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>DEMO · SC-EU-01</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 0, background: 'var(--panel2)', borderBottom: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <div style={{ padding: '0 10px', color: 'var(--txt3)', letterSpacing: '0.08em', borderRight: '1px solid var(--line)', lineHeight: '29px' }}>MÄRKTE</div>
          {TICKER.map(t => (
            <div key={t.sym} style={{ padding: '0 11px', borderRight: '1px solid var(--line)', lineHeight: '29px' }}>
              <span style={{ color: 'var(--txt2)' }}>{t.sym}</span>{' '}
              <span style={{ color: 'var(--txt)' }}>{t.price}</span>{' '}
              <span style={{ color: 'var(--txt3)' }}>{t.chg}</span>
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', height: '100%', borderLeft: '1px solid var(--line)' }}>
          <div style={{ padding: '0 11px', lineHeight: '29px', color: 'var(--txt2)' }}>ENGINE <span style={{ color: 'var(--txt)' }}>LÄUFT</span></div>
          <div style={{ padding: '0 11px', lineHeight: '29px', borderLeft: '1px solid var(--line)', color: 'var(--txt2)' }}>TICKS/S <span style={{ color: 'var(--txt)' }}>1.284</span></div>
          <div style={{ padding: '0 11px', lineHeight: '29px', borderLeft: '1px solid var(--line)', color: 'var(--txt2)' }}>LATENZ <span style={{ color: 'var(--txt)' }}>12 ms</span></div>
        </div>
      </div>
    </>
  );
}
