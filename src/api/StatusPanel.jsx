// Simple loading/error panel reused across worker-backed pages, styled with
// the app's existing CSS variables so it matches dark/light theme.
export default function StatusPanel({ loading, error, onRetry }) {
  if (loading) {
    return (
      <div style={{ padding: '14px 16px', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--txt2)' }}>
        Lade Daten…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--acc)' }}>
        <div>Worker nicht erreichbar · {error.message}</div>
        {onRetry && (
          <button onClick={onRetry} style={{ background: 'transparent', border: '1px solid var(--line2)', color: 'var(--txt)', fontFamily: 'inherit', fontSize: 10, padding: '3px 9px', cursor: 'pointer' }}>
            ERNEUT VERSUCHEN
          </button>
        )}
      </div>
    );
  }
  return null;
}
