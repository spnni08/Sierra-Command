// Minimal pub/sub store for trade-open/trade-close toasts. Kept outside
// React state (rather than context) because the toasts are pushed from
// useLiveTradePnl's polling effect, which runs in whichever page happens to
// have that hook mounted (ProTerminal/LogPage) — a plain module-level store
// lets the toast UI (mounted once at the app shell level) subscribe
// regardless of which page pushed the event.
let toasts = [];
let nextId = 1;
const listeners = new Set();

function emit() {
  for (const l of listeners) l([...toasts]);
}

export function pushTradeToast(toast) {
  const id = nextId++;
  toasts = [...toasts, { id, ...toast }];
  emit();
  return id;
}

export function dismissTradeToast(id) {
  toasts = toasts.filter(t => t.id !== id);
  emit();
}

export function subscribeTradeToasts(listener) {
  listeners.add(listener);
  listener([...toasts]);
  return () => listeners.delete(listener);
}
