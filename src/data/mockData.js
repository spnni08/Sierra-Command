// Mock data ported 1:1 from the Sierra Command design prototype.
// All values are static/generated mock data — no real API/exchange integration.

export const SYMS = {
  BTCUSD: { base: 64812.5, vol: 0.0065, dec: 2 },
  ETHUSD: { base: 3184.2, vol: 0.0072, dec: 2 },
  SOLUSD: { base: 168.42, vol: 0.011, dec: 2 },
  EURUSD: { base: 1.08423, vol: 0.0011, dec: 5 },
  SPX500: { base: 5482.1, vol: 0.0026, dec: 2 },
  NAS100: { base: 19240.75, vol: 0.0038, dec: 2 },
};

export function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const seriesCache = {};
export function series(sym, n) {
  const key = sym + ':' + n;
  if (seriesCache[key]) return seriesCache[key];
  const cfg = SYMS[sym] || { base: 100, vol: 0.01, dec: 2 };
  const r = rng(seedOf(key));
  const out = [];
  let p = cfg.base * (1 - cfg.vol * n * 0.06);
  let drift = 0;
  for (let i = 0; i < n; i++) {
    drift = drift * 0.92 + (r() - 0.47) * cfg.vol * 0.9;
    const o = p;
    const c = o * (1 + drift + (r() - 0.5) * cfg.vol * 0.5);
    const hi = Math.max(o, c) * (1 + r() * cfg.vol * 0.55);
    const lo = Math.min(o, c) * (1 - r() * cfg.vol * 0.55);
    out.push({ o, h: hi, l: lo, c, v: 0.25 + r() * 0.75 });
    p = c;
  }
  const last = out[out.length - 1];
  const k = cfg.base / last.c;
  out.forEach(d => { d.o *= k; d.h *= k; d.l *= k; d.c *= k; });
  seriesCache[key] = out;
  return out;
}

const lineCache = {};
export function lineSeries(key, n, up) {
  if (lineCache[key]) return lineCache[key];
  const r = rng(seedOf(key));
  const out = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    v *= 1 + (r() - 0.44) * 0.018 + up * 0.0016;
    out.push(v);
  }
  lineCache[key] = out;
  return out;
}

export function fmt(v, d) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtPct(v) {
  return (v / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'x';
}

export const SESSIONS = ['Alle Sessions', 'Nur EU+US', 'Ohne Asien'];
export const NEWSLV = ['Niedrig', 'Mittel', 'Hoch'];

export const TICKER = [
  { sym: 'BTC/USD', price: '64.812,50', chg: '+0,84%' },
  { sym: 'ETH/USD', price: '3.184,20', chg: '−0,41%' },
  { sym: 'SOL/USD', price: '168,42', chg: '+2,17%' },
  { sym: 'EUR/USD', price: '1,08423', chg: '−0,09%' },
  { sym: 'S&P 500', price: '5.482,10', chg: '+0,22%' },
  { sym: 'NAS 100', price: '19.240,75', chg: '+0,63%' },
];

export const INITIAL_STRATEGIES = [
  { id: 's1', name: 'MOMENTUM-M7', market: 'Krypto · BTC, ETH', active: true, risk: 0.8, sessionIdx: 0, corr: 0.85, newsIdx: 1, factors: '5/7', winrate: 57.2 },
  { id: 's2', name: 'BREAKOUT-V2', market: 'Krypto · SOL', active: true, risk: 1.0, sessionIdx: 2, corr: 0.75, newsIdx: 2, factors: '6/7', winrate: 61.0 },
  { id: 's3', name: 'TREND-FOLLOW', market: 'Indizes · S&P500, NAS100', active: true, risk: 0.6, sessionIdx: 1, corr: 0.90, newsIdx: 0, factors: '4/7', winrate: 49.0 },
  { id: 's4', name: 'SESSION-FX', market: 'Forex · EURUSD', active: false, risk: 0.5, sessionIdx: 1, corr: 0.80, newsIdx: 2, factors: '2/7', winrate: 38.0 },
];

export const MULTI_CHART_TILES = [
  { sym: 'BTCUSD', label: 'BTC/USD', tf: 'M15', price: '64.812,50', badge: { text: 'LONG 0,40', kind: 'active' }, n: 72, strategy: 'MOMENTUM-M7 · 5/7', factors: 5, conf: 71 },
  { sym: 'ETHUSD', label: 'ETH/USD', tf: 'M15', price: '3.184,20', badge: { text: 'FLAT', kind: 'flat' }, n: 72, strategy: 'MEAN-REV-3 · 3/7', factors: 3, conf: 38 },
  { sym: 'SOLUSD', label: 'SOL/USD', tf: 'M5', price: '168,42', badge: { text: 'SHORT 12', kind: 'active' }, n: 80, strategy: 'BREAKOUT-V2 · 6/7', factors: 6, conf: 84 },
  { sym: 'EURUSD', label: 'EUR/USD', tf: 'M30', price: '1,08423', badge: { text: 'FLAT', kind: 'flat' }, n: 72, strategy: 'SESSION-FX · 2/7', factors: 2, conf: 21 },
  { sym: 'SPX500', label: 'S&P 500', tf: 'H1', price: '5.482,10', badge: { text: 'LONG 1,0', kind: 'active' }, n: 64, strategy: 'TREND-FOLLOW · 4/7', factors: 4, conf: 57 },
  { sym: 'NAS100', label: 'NAS 100', tf: 'H1', price: '19.240,75', badge: { text: 'BEOBACHTUNG', kind: 'flat' }, n: 64, strategy: 'GAP-REVERSAL · 5/7', factors: 5, conf: 66 },
];

export const BOT_ACTIVITY = [
  { time: '14:12:08', mark: '▸', text: 'SOL/USD Short 12 eröffnet · BREAKOUT-V2' },
  { time: '14:11:44', mark: '·', text: 'NAS100 Signal verworfen · Spread > Limit' },
  { time: '14:09:20', mark: '·', text: 'BTC/USD SL nachgezogen 63.980 → 64.310' },
  { time: '14:04:51', mark: '▸', text: 'S&P500 Long 1,0 eröffnet · TREND-FOLLOW' },
  { time: '13:58:02', mark: '·', text: 'ETH/USD Faktor 3/7 · unter Schwelle 5' },
  { time: '13:47:36', mark: '·', text: 'Regime-Wechsel erkannt: Trend → Range (FX)' },
];

export const STRATEGY_MATRIX = [
  { name: 'BREAKOUT-V2', factor: '6/7', sig: 18, hit: '61%', hot: true },
  { name: 'MOMENTUM-M7', factor: '5/7', sig: 24, hit: '57%', hot: true },
  { name: 'GAP-REVERSAL', factor: '5/7', sig: 9, hit: '66%', hot: true },
  { name: 'TREND-FOLLOW', factor: '4/7', sig: 31, hit: '49%', hot: false },
  { name: 'MEAN-REV-3', factor: '3/7', sig: 12, hit: '42%', hot: false },
  { name: 'SESSION-FX', factor: '2/7', sig: 7, hit: '38%', hot: false },
];

export const FACTOR_UTIL = [
  { label: 'Volatilität', pct: 78 },
  { label: 'Volumen', pct: 64 },
  { label: 'Trendstärke', pct: 52 },
  { label: 'Korrelation', pct: 41 },
  { label: 'Session-Bias', pct: 33 },
  { label: 'Liquidität', pct: 86 },
];

export function openTradesData() {
  return [
    { symbol: 'BTC/USD', dir: 'LONG', vol: '0,40', entry: '64.310,00', sl: '63.720,00', tp: '66.150,00', strategy: 'MOMENTUM-M7', factor: '5/7', duration: '02:41 h', pnl: '+200,80', source: 'exchange' },
    { symbol: 'SOL/USD', dir: 'SHORT', vol: '12,0', entry: '171,05', sl: '174,20', tp: '162,40', strategy: 'BREAKOUT-V2', factor: '6/7', duration: '01:12 h', pnl: '+31,56', source: 'exchange' },
    { symbol: 'S&P 500', dir: 'LONG', vol: '1,00', entry: '5.463,80', sl: '5.428,00', tp: '5.552,00', strategy: 'TREND-FOLLOW', factor: '4/7', duration: '04:55 h', pnl: '+186,24', source: 'mt5' },
  ];
}

export function activityLogData() {
  return [
    { time: '14:12:08', src: 'KRAKEN', mark: '▸', text: 'SOL/USD Short 12 eröffnet · BREAKOUT-V2', source: 'exchange', closed: false },
    { time: '14:11:44', src: 'SYSTEM', mark: '·', text: 'NAS100 Signal verworfen · Spread > Limit', source: 'mt5', closed: false },
    { time: '14:09:20', src: 'MT5', mark: '·', text: 'BTC/USD SL nachgezogen 63.980 → 64.310', source: 'exchange', closed: false },
    { time: '14:04:51', src: 'MT5', mark: '▸', text: 'S&P500 Long 1,0 eröffnet · TREND-FOLLOW', source: 'mt5', closed: false },
    { time: '13:58:02', src: 'SYSTEM', mark: '·', text: 'ETH/USD Faktor 3/7 · unter Schwelle 5', source: 'exchange', closed: false },
    { time: '13:47:36', src: 'SYSTEM', mark: '·', text: 'Regime-Wechsel erkannt: Trend → Range (FX)', source: 'mt5', closed: false },
    { time: '13:22:15', src: 'BINANCE', mark: '✕', text: 'ETH/USD Long 0,8 geschlossen · TP · +142,10 €', source: 'exchange', closed: true },
    { time: '12:58:40', src: 'MT5', mark: '✕', text: 'NAS 100 Short 0,5 geschlossen · SL · −88,40 €', source: 'mt5', closed: true },
    { time: '12:31:09', src: 'SYSTEM', mark: '·', text: 'Korrelation BTC/ETH 0,88 > Limit · ETH-Signal unterdrückt', source: 'exchange', closed: false },
    { time: '11:47:02', src: 'KRAKEN', mark: '▸', text: 'BTC/USD Long 0,4 eröffnet · MOMENTUM-M7', source: 'exchange', closed: false },
    { time: '11:20:33', src: 'SYSTEM', mark: '·', text: 'News-Fenster EUR (hoch) · SESSION-FX pausiert 15 min', source: 'mt5', closed: false },
    { time: '10:52:18', src: 'MT5', mark: '✕', text: 'EUR/USD Short 0,6 geschlossen · SL · −41,20 €', source: 'mt5', closed: true },
    { time: '10:14:47', src: 'BINANCE', mark: '✕', text: 'BTC/USD Long 0,3 geschlossen · TP · +306,75 €', source: 'exchange', closed: true },
    { time: '09:41:05', src: 'SYSTEM', mark: '·', text: 'Faktor-Update GAP-REVERSAL: 4/7 → 5/7', source: 'exchange', closed: false },
    { time: '09:03:52', src: 'MT5', mark: '▸', text: 'S&P500 Long 1,0 eröffnet · TREND-FOLLOW', source: 'mt5', closed: false },
    { time: '08:37:29', src: 'SYSTEM', mark: '·', text: 'Volatilität Krypto-Cluster: 78 → 82', source: 'exchange', closed: false },
    { time: '07:58:11', src: 'MT5', mark: '✕', text: 'NAS 100 Long 0,4 geschlossen · TP · +219,80 €', source: 'mt5', closed: true },
    { time: '07:12:44', src: 'SYSTEM', mark: '·', text: 'Asia-Session-Filter aktiv · SESSION-FX Signale verworfen', source: 'mt5', closed: false },
    { time: '06:44:20', src: 'KRAKEN', mark: '▸', text: 'SOL/USD Short 8 eröffnet · BREAKOUT-V2', source: 'exchange', closed: false },
    { time: '06:15:07', src: 'SYSTEM', mark: '·', text: 'Engine-Neustart nach Daten-Feed-Timeout (3 s)', source: 'mt5', closed: false },
    { time: '05:48:31', src: 'BINANCE', mark: '✕', text: 'SOL/USD Short 8 geschlossen · TP · +64,30 €', source: 'exchange', closed: true },
    { time: '05:02:19', src: 'MT5', mark: '·', text: 'EUR/USD SL nachgezogen 1,0821 → 1,0836', source: 'mt5', closed: false },
  ];
}

export const RECENT_CLOSED_TRADES = [
  { time: '09.09. 13:41', symbol: 'ETH/USD', dir: 'LONG', strategy: 'MOMENTUM-M7', duration: '1,8 h', pnl: '+142,10 €', neg: false },
  { time: '09.09. 11:02', symbol: 'NAS 100', dir: 'SHORT', strategy: 'GAP-REVERSAL', duration: '0,6 h', pnl: '−88,40 €', neg: true },
  { time: '09.09. 09:17', symbol: 'BTC/USD', dir: 'LONG', strategy: 'BREAKOUT-V2', duration: '3,4 h', pnl: '+306,75 €', neg: false },
  { time: '08.09. 21:55', symbol: 'EUR/USD', dir: 'SHORT', strategy: 'SESSION-FX', duration: '5,1 h', pnl: '−41,20 €', neg: true },
  { time: '08.09. 16:30', symbol: 'S&P 500', dir: 'LONG', strategy: 'TREND-FOLLOW', duration: '7,9 h', pnl: '+219,80 €', neg: false },
];

export function calendarData() {
  const first = new Date(2026, 8, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(2026, 9, 0).getDate();
  const r = rng(seedOf('calendar-2026-09'));
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) {
    if (d > 10) { cells.push({ day: d, hasData: false }); continue; }
    const mt5 = (r() - 0.42) * 260;
    const exch = (r() - 0.4) * 320;
    cells.push({ day: d, hasData: true, mt5, exch, total: mt5 + exch });
  }
  return cells;
}

export const STRATEGY_SUGGESTIONS = [
  {
    priority: 'HOCH', title: 'SL-Abstand an ATR koppeln',
    body: 'Fixer 0,9%-Stop wird in Hochvolatilitätsphasen 3,1× häufiger ausgelöst. ATR(14) × 1,6 senkt Fehlstopps auf 11%.',
    expect: 'Erwartet: PF 1,74 → 1,91 · MaxDD −9,4% → −7,8%', actions: true, denseOnly: false,
  },
  {
    priority: 'MITTEL', title: 'Asia-Session ausschließen',
    body: '00:00–06:00 UTC liefert 19% der Trades, aber −4,2% Nettobeitrag.',
    expect: 'Erwartet: Trefferquote 57,2% → 60,1%', actions: true, denseOnly: true,
  },
  {
    priority: 'MITTEL', title: 'Teilverkauf bei 1R',
    body: '50% der Position bei 1R schließen glättet die Kurve; Nettogewinn −3%, Drawdown −24%.',
    expect: 'Erwartet: Sharpe 1,38 → 1,61', actions: false, denseOnly: true,
  },
  {
    priority: 'NIEDRIG', title: 'Korrelationsfilter BTC/ETH',
    body: 'Bei ρ > 0,85 nur die stärkere Seite handeln — verhindert doppeltes Risiko.',
    expect: null, actions: false, denseOnly: true,
  },
];

export const SIGNAL_FACTORS = [
  { label: 'EMA 21 > EMA 55', val: '+1,0', on: true },
  { label: 'Volumen > Ø 20', val: '+0,8', on: true },
  { label: 'Höheres Tief (H4)', val: '+0,9', on: true },
  { label: 'ATR im Zielband', val: '+0,6', on: true },
  { label: 'Funding neutral', val: '+0,4', on: true },
  { label: 'Kein Widerstand < 2R', val: '0,0', on: false },
  { label: 'News-Fenster frei', val: '0,0', on: false },
];
