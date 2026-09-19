import { useState } from 'react';
import { getApiToken, setApiToken } from '../api/client';

// One-time entry gate for the worker's API_ACCESS_TOKEN (see
// worker/src/auth.js). Single-user app, no login/password flow needed — the
// token is a shared secret Marvin generates once (e.g. `openssl rand -hex
// 32`) and pastes in here; it's then kept in localStorage so this only shows
// once per browser. client.js clears it and the app falls back here again
// on any 401, since that means the stored token is wrong or was rotated.
export default function TokenGate({ children }) {
  const [hasToken, setHasToken] = useState(() => !!getApiToken());
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  if (hasToken) return children;

  const submit = (e) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError(true);
      return;
    }
    setApiToken(trimmed);
    setHasToken(true);
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b0d10' }}>
      <form
        onSubmit={submit}
        style={{
          background: '#14171b', border: '1px solid #262b31', padding: '28px 32px',
          display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'stretch', width: 320,
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9aa4af', textAlign: 'center' }}>
          Zugriffstoken erforderlich
        </div>
        <div style={{ fontSize: 11, color: '#6b7580', textAlign: 'center' }}>
          API-Token eingeben, um Sierra Command zu öffnen
        </div>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => { setError(false); setValue(e.target.value); }}
          placeholder="API_ACCESS_TOKEN"
          style={{
            fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, padding: '10px 12px',
            background: '#1c2026', border: `1px solid ${error ? '#e5484d' : '#262b31'}`, color: '#e6e8eb',
          }}
        />
        {error && <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: '#e5484d' }}>Token darf nicht leer sein</div>}
        <button
          type="submit"
          style={{ padding: '10px 0', background: '#2f6fed', border: 'none', color: '#fff', fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, cursor: 'pointer' }}
        >
          BESTÄTIGEN
        </button>
      </form>
    </div>
  );
}
