import { useState } from 'react';
import { useApp } from '../context/AppContext';

const PIN = '532018';
const PIN_LEN = 6;

function RevealField({ label, value, hiddenValue, revealed, onToggle, reconnectLabel = 'NEU VERBINDEN', danger }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <div style={{ color: 'var(--txt2)' }}>{label}</div>
      <div>{revealed ? value : hiddenValue}</div>
    </div>
  );
}

function ConnectionCard({ title, status, statusStyle, rows, revealed, onToggle, revealBtnLabel, reconnectLabel, reconnectStyle, live }) {
  return (
    <div style={{ background: 'var(--panel)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9, borderLeft: live ? '2px solid var(--acc)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 12 }}>{title}</div>
        <div style={{ flex: 1 }} />
        <div style={statusStyle}>{status}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
        {rows}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button onClick={onToggle} style={{ background: 'transparent', border: '1px solid var(--line2)', color: 'var(--txt2)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '4px 10px', cursor: 'pointer' }}>{revealBtnLabel}</button>
        <button style={{ background: 'transparent', border: `1px solid ${live ? 'var(--acc)' : 'var(--line2)'}`, color: live ? 'var(--acc)' : 'var(--txt2)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '4px 10px', cursor: 'pointer' }}>{reconnectLabel}</button>
      </div>
    </div>
  );
}

export default function Settings() {
  const { settingsUnlocked, unlockSettings, lockSettings } = useApp();
  const [pinValue, setPinValue] = useState('');
  const [pinError, setPinError] = useState(false);
  const [reveal, setReveal] = useState({ demoMt5: false, demoEx: false, liveMt5: false, liveEx: false });

  const toggleReveal = key => setReveal(r => ({ ...r, [key]: !r[key] }));

  const handlePinInput = digit => {
    setPinError(false);
    setPinValue(v => {
      if (v.length >= PIN_LEN) return v;
      const next = v + digit;
      if (next.length === PIN_LEN) {
        if (next === PIN) {
          setTimeout(() => unlockSettings(), 0);
          return '';
        } else {
          setPinError(true);
          setTimeout(() => setPinValue(''), 300);
        }
      }
      return next;
    });
  };
  const backspace = () => { setPinError(false); setPinValue(v => v.slice(0, -1)); };

  if (!settingsUnlocked) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', width: 280 }}>
          <div style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--txt2)' }}>Zugriff geschützt</div>
          <div style={{ fontSize: 11, color: 'var(--txt3)', textAlign: 'center' }}>PIN eingeben, um API-Verwaltung zu öffnen</div>

          <div style={{ display: 'flex', gap: 6 }}>
            {Array.from({ length: PIN_LEN }).map((_, i) => (
              <div key={i} style={{
                width: 32, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: "'IBM Plex Mono',monospace", fontSize: 20,
                background: 'var(--panel3)', border: `1px solid ${pinError ? 'var(--acc)' : 'var(--line2)'}`, color: 'var(--txt)',
              }}>
                {pinValue[i] ? '•' : ''}
              </div>
            ))}
          </div>

          {pinError && <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--acc)' }}>Falscher PIN</div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, width: '100%' }}>
            {['1','2','3','4','5','6','7','8','9'].map(d => (
              <button key={d} onClick={() => handlePinInput(d)} style={{ padding: '10px 0', background: 'var(--panel3)', border: '1px solid var(--line2)', color: 'var(--txt)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 14, cursor: 'pointer' }}>{d}</button>
            ))}
            <button onClick={backspace} style={{ padding: '10px 0', background: 'transparent', border: '1px solid var(--line2)', color: 'var(--txt2)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, cursor: 'pointer' }}>⌫</button>
            <button onClick={() => handlePinInput('0')} style={{ padding: '10px 0', background: 'var(--panel3)', border: '1px solid var(--line2)', color: 'var(--txt)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 14, cursor: 'pointer' }}>0</button>
            <div />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--line)', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div style={{ background: 'var(--panel)', display: 'flex', alignItems: 'center', padding: '11px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>API-Verwaltung</div>
        <div style={{ flex: 1 }} />
        <button onClick={lockSettings} style={{ background: 'transparent', border: '1px solid var(--line2)', color: 'var(--txt2)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '5px 10px', cursor: 'pointer', letterSpacing: '0.06em' }}>SPERREN</button>
      </div>

      <div style={{ background: 'var(--panel)', padding: '8px 16px', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase', borderTop: '2px solid var(--line2)' }}>Demo</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 1, background: 'var(--line)' }}>
        <ConnectionCard
          title="MT5 — Demo-Zugang"
          status="VERBUNDEN"
          statusStyle={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt2)', border: '1px solid var(--line2)', padding: '1px 6px' }}
          rows={<>
            <RevealField label="Server" value="SierraBroker-Demo01" hiddenValue="SierraBroker-Demo01" revealed />
            <RevealField label="Konto-Login" value="50184223" hiddenValue="50184223" revealed />
            <RevealField label="Passwort" value="Sierra#Demo24!" hiddenValue="••••••••••" revealed={reveal.demoMt5} />
          </>}
          revealBtnLabel={reveal.demoMt5 ? 'VERBERGEN' : 'ANZEIGEN'}
          onToggle={() => toggleReveal('demoMt5')}
          reconnectLabel="NEU VERBINDEN"
        />
        <ConnectionCard
          title="Kraken/Binance — Demo (Paper)"
          status="VERBUNDEN"
          statusStyle={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt2)', border: '1px solid var(--line2)', padding: '1px 6px' }}
          rows={<>
            <RevealField label="API-Key" value="SC-DEMO-KX9182KAT2" hiddenValue="••••••••••••••••" revealed={reveal.demoEx} />
            <RevealField label="API-Secret" value="a83f-92kd-tt01-Ω92s" hiddenValue="••••••••••••••••" revealed={reveal.demoEx} />
            <RevealField label="Umgebung" value="Testnet" hiddenValue="Testnet" revealed />
          </>}
          revealBtnLabel={reveal.demoEx ? 'VERBERGEN' : 'ANZEIGEN'}
          onToggle={() => toggleReveal('demoEx')}
          reconnectLabel="NEU VERBINDEN"
        />
      </div>

      <div style={{ background: 'var(--acc2)', padding: '8px 16px', fontSize: 10, letterSpacing: '0.1em', color: '#fff', textTransform: 'uppercase', borderTop: '2px solid var(--acc)' }}>Live — Echtes Kapital</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 1, background: 'var(--line)' }}>
        <ConnectionCard
          live
          title="MT5 — Live-Broker"
          status="VERBUNDEN"
          statusStyle={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: '#fff', background: 'var(--acc)', padding: '1px 6px' }}
          rows={<>
            <RevealField label="Server" value="SierraBroker-Live01" hiddenValue="SierraBroker-Live01" revealed />
            <RevealField label="Konto-Login" value="90447810" hiddenValue="90447810" revealed />
            <RevealField label="Passwort" value="Kx7!Live#9042" hiddenValue="••••••••••••" revealed={reveal.liveMt5} />
          </>}
          revealBtnLabel={reveal.liveMt5 ? 'VERBERGEN' : 'ANZEIGEN'}
          onToggle={() => toggleReveal('liveMt5')}
          reconnectLabel="TRENNEN"
        />
        <ConnectionCard
          live
          title="Kraken/Binance — Live-Exchange"
          status="VERBUNDEN"
          statusStyle={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: '#fff', background: 'var(--acc)', padding: '1px 6px' }}
          rows={<>
            <RevealField label="API-Key" value="SC-LIVE-8817QPLM40" hiddenValue="••••••••••••••••" revealed={reveal.liveEx} />
            <RevealField label="API-Secret" value="f01a-73nq-88jz-Ω14w" hiddenValue="••••••••••••••••" revealed={reveal.liveEx} />
            <RevealField label="Berechtigungen" value="Handel · kein Auszahlungsrecht" hiddenValue="Handel · kein Auszahlungsrecht" revealed />
          </>}
          revealBtnLabel={reveal.liveEx ? 'VERBERGEN' : 'ANZEIGEN'}
          onToggle={() => toggleReveal('liveEx')}
          reconnectLabel="TRENNEN"
        />
      </div>
    </div>
  );
}
