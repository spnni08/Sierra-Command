import { useState } from 'react';
import { getApiToken, setApiToken, login } from '../api/client';

// Login gate for the whole app — replaces the old raw-API_ACCESS_TOKEN
// paste flow (TokenGate.jsx). Single fixed account (no registration), so
// this is just a username/password form that calls POST /api/auth/login
// (see worker/src/routes/api.js's handleLogin) and stores the session
// token it returns under the same localStorage key TokenGate used to store
// the raw token in, so client.js doesn't need any changes to read it.
// client.js clears that key and reloads on any 401, which brings the user
// back here to log in again — same behavior as before, just a real login
// screen instead of a token-paste box.
export default function LoginGate({ children }) {
  const [hasToken, setHasToken] = useState(() => !!getApiToken());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (hasToken) return children;

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setError(false);
    if (!username.trim() || !password) {
      setError(true);
      return;
    }
    setSubmitting(true);
    const token = await login(username.trim(), password);
    setSubmitting(false);
    if (!token) {
      setError(true);
      setPassword('');
      return;
    }
    setApiToken(token);
    setHasToken(true);
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <form
        onSubmit={submit}
        style={{
          background: 'var(--panel)', border: '1px solid var(--line)', padding: '28px 32px',
          display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'stretch', width: 320,
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--txt2)', textAlign: 'center' }}>
          Anmeldung erforderlich
        </div>
        <div style={{ fontSize: 11, color: 'var(--txt3)', textAlign: 'center' }}>
          Zugangsdaten eingeben, um Sierra Command zu öffnen
        </div>
        <input
          type="text"
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => { setError(false); setUsername(e.target.value); }}
          placeholder="Benutzername"
          style={{
            fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, padding: '10px 12px',
            background: 'var(--panel3)', border: `1px solid ${error ? 'var(--acc)' : 'var(--line2)'}`, color: 'var(--txt)',
          }}
        />
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => { setError(false); setPassword(e.target.value); }}
          placeholder="Passwort"
          style={{
            fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, padding: '10px 12px',
            background: 'var(--panel3)', border: `1px solid ${error ? 'var(--acc)' : 'var(--line2)'}`, color: 'var(--txt)',
          }}
        />
        {error && <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--acc)' }}>Ungültige Anmeldedaten</div>}
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '10px 0', background: 'var(--acc2, #2f6fed)', border: 'none', color: '#fff',
            fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, cursor: submitting ? 'default' : 'pointer',
            opacity: submitting ? 0.6 : 1, letterSpacing: '0.06em',
          }}
        >
          {submitting ? 'PRÜFE…' : 'ANMELDEN'}
        </button>
      </form>
    </div>
  );
}
