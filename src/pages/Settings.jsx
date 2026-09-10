import { useCallback, useState } from 'react';
import { useApp } from '../context/AppContext';
import { fetchCredentials } from '../api/client';
import { useFetch } from '../api/useFetch';
import StatusPanel from '../api/StatusPanel';

const PIN = '532018';
const PIN_LEN = 6;

// Real connection status only (no add/reveal/rotate flow yet — see
// Settings component comment below on why that's still out of scope).
function ConnectionCard({ title, connected, createdAt, live }) {
  return (
    <div style={{ background: 'var(--panel)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9, borderLeft: live ? '2px solid var(--acc)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 12 }}>{title}</div>
        <div style={{ flex: 1 }} />
        <div style={{
          fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, padding: '1px 6px',
          color: connected ? (live ? '#fff' : 'var(--txt2)') : 'var(--txt3)',
          background: connected && live ? 'var(--acc)' : 'transparent',
          border: connected ? '1px solid var(--line2)' : '1px solid var(--line2)',
        }}>{connected ? 'VERBUNDEN' : 'NICHT VERBUNDEN'}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={{ color: 'var(--txt2)' }}>Status</div>
          <div>{connected ? `Hinterlegt seit ${createdAt}` : 'Keine Zugangsdaten hinterlegt'}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button disabled title="Zugangsdaten-Verwaltung (Hinzufügen/Ändern) ist noch nicht angebunden" style={{ background: 'transparent', border: '1px solid var(--line2)', color: 'var(--txt3)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '4px 10px', cursor: 'not-allowed' }}>
          {connected ? 'NEU VERBINDEN' : 'VERBINDEN'}
        </button>
      </div>
    </div>
  );
}

function fmtDe(ts) {
  if (!ts) return '';
  const [date] = ts.split(' ');
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}

export default function Settings() {
  const { settingsUnlocked, unlockSettings, lockSettings } = useApp();
  const [pinValue, setPinValue] = useState('');
  const [pinError, setPinError] = useState(false);

  const loadCredentials = useCallback(() => fetchCredentials(), []);
  const credentialsQ = useFetch(loadCredentials, [loadCredentials]);

  const credentialFor = (provider, env) =>
    (credentialsQ.data || []).find(c => c.provider === provider && c.env === env) || null;

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

      <StatusPanel loading={credentialsQ.loading} error={credentialsQ.error} onRetry={credentialsQ.reload} />

      {!credentialsQ.loading && !credentialsQ.error && (<>
      <div style={{ background: 'var(--panel)', padding: '8px 16px', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase', borderTop: '2px solid var(--line2)' }}>Demo</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 1, background: 'var(--line)' }}>
        <ConnectionCard
          title="MT5 (OANDA) — Demo-Zugang"
          connected={!!credentialFor('oanda', 'demo')}
          createdAt={fmtDe(credentialFor('oanda', 'demo')?.created_at)}
        />
        <ConnectionCard
          title="Kraken/Binance — Demo (Paper)"
          connected={!!credentialFor('binance', 'demo')}
          createdAt={fmtDe(credentialFor('binance', 'demo')?.created_at)}
        />
      </div>

      <div style={{ background: 'var(--acc2)', padding: '8px 16px', fontSize: 10, letterSpacing: '0.1em', color: '#fff', textTransform: 'uppercase', borderTop: '2px solid var(--acc)' }}>Live — Echtes Kapital</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 1, background: 'var(--line)' }}>
        <ConnectionCard
          live
          title="MT5 (OANDA) — Live-Broker"
          connected={!!credentialFor('oanda', 'live')}
          createdAt={fmtDe(credentialFor('oanda', 'live')?.created_at)}
        />
        <ConnectionCard
          live
          title="Kraken/Binance — Live-Exchange"
          connected={!!credentialFor('binance', 'live')}
          createdAt={fmtDe(credentialFor('binance', 'live')?.created_at)}
        />
      </div>
      </>)}
    </div>
  );
}
