import { useEffect, useState } from 'react';
import { subscribeTradeToasts, dismissTradeToast } from '../lib/tradeToastStore';
import { pnlDisplay } from '../lib/pnlFormat';

const VISIBLE_MS = 10_000;
const FADE_MS = 1200;

// Corner-positioned, dismissible-but-not-blocking trade notifications —
// deliberately distinct from UpdateAvailableModal (full-screen, modal,
// requires a click to proceed). These never block interaction with the
// page and disappear on their own via an opacity fade rather than an
// abrupt unmount.
function Toast({ toast, onDone }) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFading(true), VISIBLE_MS - FADE_MS);
    const removeTimer = setTimeout(onDone, VISIBLE_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const directionLabel = toast.direction === 'long' ? 'Long' : 'Short';
  const pnl = toast.kind === 'close' ? pnlDisplay(toast.pnl) : null;

  return (
    <div
      style={{
        width: 240, background: 'var(--panel)', border: '1px solid var(--line2)',
        borderLeft: `2px solid ${toast.kind === 'open' ? 'var(--acc)' : 'var(--line2)'}`,
        padding: '10px 12px', boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        opacity: fading ? 0 : 1, transition: `opacity ${FADE_MS}ms ease`,
        fontFamily: "'IBM Plex Sans',system-ui,sans-serif", pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--txt3)', textTransform: 'uppercase' }}>
          {toast.kind === 'open' ? 'Trade eröffnet' : 'Trade geschlossen'}
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => onDone()}
          style={{ background: 'transparent', border: 0, color: 'var(--txt3)', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}
          aria-label="Schließen"
        >×</button>
      </div>
      <div style={{ marginTop: 4, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>
        {toast.symbol} <span style={{ color: 'var(--txt2)', fontWeight: 500 }}>· {directionLabel}</span>
      </div>
      {pnl && (
        <div style={{ marginTop: 3, fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 600, color: pnl.color }}>
          {pnl.text}
        </div>
      )}
    </div>
  );
}

export default function TradeToasts() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => subscribeTradeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed', top: 46, right: 12, zIndex: 9998,
        display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none',
      }}
    >
      {toasts.map(t => (
        <Toast key={t.id} toast={t} onDone={() => dismissTradeToast(t.id)} />
      ))}
    </div>
  );
}
