import { useEffect, useState } from 'react';

const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const CURRENT_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export default function UpdateAvailableModal() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkVersion() {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.version && data.version !== CURRENT_VERSION) {
          setUpdateAvailable(true);
        }
      } catch {
        // network hiccup — try again next interval
      }
    }

    checkVersion();
    const id = setInterval(checkVersion, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!updateAvailable) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      }}
    >
      <div
        style={{
          background: 'var(--panel)', border: '1px solid var(--line2)', borderTop: '2px solid var(--acc)',
          padding: '24px 28px', maxWidth: 360, width: '90%', fontFamily: "'IBM Plex Sans',system-ui,sans-serif",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--txt)', marginBottom: 8, textTransform: 'uppercase' }}>
          Neue Version verfügbar
        </div>
        <div style={{ fontSize: 12, color: 'var(--txt2)', marginBottom: 18, lineHeight: 1.5 }}>
          Sierra Command wurde aktualisiert. Bitte lade die Seite neu, um mit der aktuellen Version weiterzuarbeiten.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            width: '100%', background: 'var(--acc)', color: '#fff', border: 0, padding: '10px 0',
            fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Seite neu laden
        </button>
      </div>
    </div>
  );
}
