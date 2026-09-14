import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { TICKER } from '../data/mockData';

const DASHBOARD_TAB = { key: 'dash', label: 'Dashboard' };

// Group A: chart/analysis pages. Group B: operations/config pages.
// "Dashboard" deliberately stays out of both, per design — it's the one
// standalone direct tab.
const GROUPS = [
  {
    key: 'groupA',
    label: 'Analyse',
    items: [
      { key: 'multi', label: 'Multi-Chart' },
      { key: 'pro', label: 'Pro-Terminal' },
      { key: 'auswertung', label: 'Auswertung' },
    ],
  },
  {
    key: 'groupB',
    label: 'Verwaltung',
    items: [
      { key: 'autosettings', label: 'Auto-Trade' },
      { key: 'settings', label: 'Einstellungen' },
      { key: 'log', label: 'Log' },
    ],
  },
];

const tabBtn = {
  position: 'relative', background: 'transparent', border: 0, borderRight: '1px solid var(--line)',
  color: 'var(--txt)', fontFamily: 'inherit', fontSize: 11, letterSpacing: '0.06em', padding: '0 16px',
  cursor: 'pointer', textTransform: 'uppercase', height: '100%', whiteSpace: 'nowrap', flexShrink: 0,
};

function labelFor(group, pageKey) {
  return group.items.find(i => i.key === pageKey)?.label ?? pageKey;
}

// Angular/kantig dropdown menu — square corners, hard borders, no shadow
// softness beyond the existing panel/line theme tokens, matching the rest
// of the app's chrome in both light and dark themes.
function GroupDropdown({ group, page, setPage, lastVisitedByGroup, setLastVisited }) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const ref = useRef(null);
  const active = group.items.some(i => i.key === page);
  const lastVisited = lastVisitedByGroup[group.key];

  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // The header bar clips overflow (horizontal ticker scroll), so an
  // absolutely-positioned menu inside it would be cut off — fixed-position
  // it instead, anchored to the trigger button's own on-screen rect.
  function toggleOpen() {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom, left: r.left });
    }
    setOpen(o => !o);
  }

  function go(pageKey) {
    setPage(pageKey);
    setLastVisited(group.key, pageKey);
    setOpen(false);
  }

  function goQuickSelect() {
    if (lastVisited) {
      setPage(lastVisited);
      setOpen(false);
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
      <button
        onClick={toggleOpen}
        style={{ ...tabBtn, display: 'flex', alignItems: 'center', gap: 5 }}
      >
        {group.label}
        <span style={{ fontSize: 8 }}>{open ? '▲' : '▼'}</span>
        {active && (
          <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'var(--acc)' }} />
        )}
      </button>

      {open && menuPos && (
        <div style={{
          position: 'fixed', top: menuPos.top, left: menuPos.left, minWidth: 200, zIndex: 50,
          background: 'var(--panel)', border: '1px solid var(--line2)',
        }}>
          {lastVisited && (
            <button
              onClick={goQuickSelect}
              style={{
                display: 'block', width: '100%', textAlign: 'left', background: 'var(--panel2)', border: 0,
                borderBottom: '1px solid var(--line2)', color: 'var(--txt2)', fontFamily: 'inherit', fontSize: 10,
                letterSpacing: '0.05em', padding: '8px 12px', cursor: 'pointer', textTransform: 'uppercase',
              }}
            >
              Schnellauswahl: {labelFor(group, lastVisited)}
            </button>
          )}
          {group.items.map(item => (
            <button
              key={item.key}
              onClick={() => go(item.key)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', background: page === item.key ? 'var(--accsoft)' : 'transparent',
                border: 0, borderBottom: '1px solid var(--line)', color: 'var(--txt)', fontFamily: 'inherit',
                fontSize: 11, letterSpacing: '0.04em', padding: '9px 12px', cursor: 'pointer', textTransform: 'uppercase',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Header({ page, setPage }) {
  const { theme, toggleTheme, dense, setPro, setSimple, lastVisitedByGroup, setLastVisited } = useApp();
  const themeLabel = theme === 'dark' ? 'DUNKEL' : 'HELL';

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'stretch', background: 'var(--panel)', borderBottom: '1px solid var(--line)', height: 38, overflowX: 'auto', overflowY: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px 0 12px', borderRight: '1px solid var(--line)', flexShrink: 0, whiteSpace: 'nowrap' }}>
          <div style={{ width: 13, height: 13, background: 'var(--acc)', flexShrink: 0 }} />
          <div style={{ fontWeight: 700, letterSpacing: '0.14em', fontSize: 12 }}>
            SIERRA<span style={{ color: 'var(--txt3)', fontWeight: 500 }}> COMMAND</span>
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt3)', border: '1px solid var(--line)', padding: '1px 4px' }}>v4.2.1</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
          <button onClick={() => setPage(DASHBOARD_TAB.key)} style={tabBtn}>
            {DASHBOARD_TAB.label}
            {page === DASHBOARD_TAB.key && (
              <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'var(--acc)' }} />
            )}
          </button>
          {GROUPS.map(g => (
            <GroupDropdown
              key={g.key}
              group={g}
              page={page}
              setPage={setPage}
              lastVisitedByGroup={lastVisitedByGroup}
              setLastVisited={setLastVisited}
            />
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 12 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 0, borderLeft: '1px solid var(--line)', flexShrink: 0, whiteSpace: 'nowrap' }}>
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 0, background: 'var(--panel2)', borderBottom: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, height: 30, overflowX: 'auto', overflowY: 'hidden' }}>
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
