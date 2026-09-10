import { useApp } from '../context/AppContext';

const cell = { padding: '0 10px', lineHeight: '23px', borderRight: '1px solid var(--line)' };

export default function Footer() {
  const { dense } = useApp();
  const modeLabel = dense ? 'ANSICHT: PROFESSIONELL' : 'ANSICHT: EINFACH';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, background: 'var(--panel2)', borderTop: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>
      <div style={{ ...cell, color: 'var(--txt)' }}>{modeLabel}</div>
      <div style={cell}>Konto 48.216,40 €</div>
      <div style={cell}>Schwebend +418,60 €</div>
      <div style={cell}>Exposure 1,42% / 3,00%</div>
      <div style={{ flex: 1 }} />
      <div style={{ padding: '0 10px', lineHeight: '23px', borderLeft: '1px solid var(--line)' }}>Datenfeed OK</div>
      <div style={{ padding: '0 10px', lineHeight: '23px', borderLeft: '1px solid var(--line)' }}>09.09.2026 · 14:12:31 UTC</div>
    </div>
  );
}
