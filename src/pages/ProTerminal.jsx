import { useCallback, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import TradingViewWidget from '../components/TradingViewWidget';
import { STRATEGY_SUGGESTIONS, SIGNAL_FACTORS, MULTI_CHART_TILES } from '../data/mockData';
import { fetchBacktestRuns, fetchStrategies, fetchTrades, runBacktest } from '../api/client';
import { useFetch } from '../api/useFetch';
import { useLiveTradePnl } from '../api/useLiveTradePnl';
import { pnlDisplay, fmtPnlNum } from '../lib/pnlFormat';
import { normalizeSymbol } from '../lib/symbols';
import StatusPanel from '../api/StatusPanel';

// Strategy IDs with a real or partial indicator adapter in
// worker/src/backtest/adapters.js — only these can actually produce a
// backtest today (see that file's header comment for exactly why the other
// 5 base strategies can't). There's no API endpoint exposing this yet, so
// it's mirrored here by hand; keep in sync with adapters.js's ADAPTERS map
// whenever a new adapter is added.
const BACKTESTABLE_STRATEGY_IDS = new Set([
  'crypto_baseline', 'crypto_baseline_sl',
  'crypto_bb_rsi_trendfilter', 'crypto_bb_rsi_trendfilter_sl',
  'crypto_orderflow_breakout', 'crypto_orderflow_breakout_sl',
  'crypto_ichimoku_breakout', 'crypto_ichimoku_breakout_sl',
  'crypto_sr_exclusion', 'crypto_sr_exclusion_sl',
  'crypto_sr_bollinger', 'crypto_sr_bollinger_sl', // partial adapter — flagged via the run response's partialAdapter field, not here
]);

// All backtestable strategies are crypto-only today (see adapters.js), and
// the backtest engine only knows these three crypto symbols (candles.js).
const BACKTEST_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

function describeBacktestError(body) {
  const message = body?.message || '';
  if (body?.error === 'no_indicator_adapter') {
    return `Für diese Strategie ist noch kein Indikator-Adapter vorhanden — Backtesting ist dafür (noch) nicht möglich. ${message}`;
  }
  if (body?.error === 'candle_fetch_failed') {
    if (message.includes('coingecko_upstream_error:403')) {
      return 'CoinGecko hat die Anfrage blockiert (403) — API-Key-Problem auf Worker-Seite.';
    }
    if (message.includes('401') || message.toLowerCase().includes('exceeds the allowed time range')) {
      return 'CoinGecko-Datenlimit überschritten (Free-Tier: max. 365 Tage Historie).';
    }
    return `Kerzendaten konnten nicht geladen werden: ${message}`;
  }
  if (body?.error === 'insufficient_candle_history') {
    return message || 'Nicht genug Kerzenhistorie für den Indikator-Warmup.';
  }
  if (body?.error === 'unknown_strategy') {
    return 'Unbekannte Strategie-ID.';
  }
  return message || body?.error || 'Backtest fehlgeschlagen.';
}

function fmtEntryNum(v, dec = 2) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// Sums only the trades a live price was actually resolved for — an open
// position with no live source (per useLiveTradePnl) contributes nothing
// rather than being silently treated as 0, since that would understate a
// mixed open-P/L total without saying so.
function liveSum(livePnlValues) {
  const withPnl = livePnlValues.filter(Number.isFinite);
  if (withPnl.length === 0) return null;
  return withPnl.reduce((a, b) => a + b, 0);
}

function fmtSignedLivePnlTotal(livePnlValues) {
  const sum = liveSum(livePnlValues);
  return sum === null ? '—' : fmtPnlNum(sum) + ' €';
}

function liveTotalColor(trades, livePnl) {
  const sum = liveSum(trades.map(t => livePnl.get(t.id)?.pnl));
  if (sum === null) return 'var(--txt)';
  if (sum === 0) return 'var(--txt)';
  return sum > 0 ? 'var(--pos)' : 'var(--neg)';
}

function fmtOpenDuration(openedAt) {
  const start = new Date(openedAt.replace(' ', 'T') + 'Z');
  const hrs = Math.max(0, (new Date() - start) / 3_600_000);
  return hrs.toFixed(2).replace('.', ',') + ' h';
}


function toOpenTradeRow(t) {
  return {
    id: t.id,
    symbol: normalizeSymbol(t.symbol),
    direction: t.direction,
    entry: t.entry,
    volume: t.volume,
    dir: t.direction === 'long' ? 'LONG' : 'SHORT',
    vol: fmtEntryNum(t.volume, 2),
    entryFmt: fmtEntryNum(t.entry, t.entry < 50 ? 5 : 2),
    sl: fmtEntryNum(t.sl, t.sl < 50 ? 5 : 2),
    tp: fmtEntryNum(t.tp, t.tp < 50 ? 5 : 2),
    strategy: '—', // trades.signal_id -> signals -> strategies join not wired yet
    duration: fmtOpenDuration(t.opened_at),
  };
}

function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return (v * 100).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
function fmtNum(v, dec = 2) {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtSignedNum(v) {
  if (v === null || v === undefined) return '—';
  return (v >= 0 ? '+' : '−') + Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Display order for the session-breakdown table — matches
// worker/src/backtest/sessions.js's SESSION_WINDOWS keys. Overlap is shown
// last and labeled as such since it's an informational subset of
// London+New York, not a fourth additive bucket: total trades ===
// asia + london + new_york - overlap (see that file's header for why).
const SESSION_BREAKDOWN_ROWS = [
  { key: 'asia', label: 'Asia' },
  { key: 'london', label: 'London' },
  { key: 'new_york', label: 'New York' },
  { key: 'overlap', label: 'Overlap (London/NY)' },
];

const TF = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

function tfStyle(active) {
  return {
    padding: '2px 7px', borderLeft: 0, fontFamily: 'inherit',
    border: active ? '1px solid var(--acc)' : '1px solid var(--line2)',
    background: active ? 'var(--acc)' : 'transparent',
    color: active ? '#fff' : 'var(--txt2)',
    cursor: 'pointer',
  };
}

function symBtnStyle(active) {
  return {
    padding: '2px 8px', fontFamily: 'inherit', fontWeight: 700, fontSize: 12,
    border: active ? '1px solid var(--acc)' : '1px solid var(--line2)',
    background: active ? 'var(--acc)' : 'transparent',
    color: active ? '#fff' : 'var(--txt)',
    cursor: 'pointer', letterSpacing: '0.03em',
  };
}

const th = { };
function metricBox(label, val, accent) {
  return (
    <div style={{ background: 'var(--panel)', padding: '8px 9px' }}>
      <div style={{ fontSize: 9, color: 'var(--txt3)', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 16, marginTop: 2, color: accent ? 'var(--acc)' : 'var(--txt)' }}>{val}</div>
    </div>
  );
}

function parseDeNum(s) {
  if (!s) return NaN;
  return parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
}
function fmtSignedPct(v) {
  if (!Number.isFinite(v)) return '—';
  const s = (v * 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v >= 0 ? '+' : '') + s + '%';
}

// Net profit isn't a field the engine stores on backtest_runs — it's the
// straightforward sum of a run's own trade PnLs, so it's computed here from
// the just-run response's `trades` array rather than shown as unavailable.
function fmtSignedNetProfit(trades) {
  const sum = trades.reduce((a, t) => a + (Number.isFinite(t.pnl) ? t.pnl : 0), 0);
  return (sum >= 0 ? '+' : '−') + Math.abs(sum).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Chance-Risk-Verhältnis (avg win / avg loss) — also not computed by the
// engine, derived client-side from the run's own trades. "—" when there's
// no losing trade to divide by (undefined ratio) rather than a fake number.
function fmtCrv(trades) {
  const wins = trades.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const losses = trades.filter((t) => t.pnl <= 0).map((t) => Math.abs(t.pnl));
  if (wins.length === 0 || losses.length === 0) return '—';
  const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / losses.length;
  if (avgLoss === 0) return '—';
  return (avgWin / avgLoss).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Minimal real equity curve (no mock data generator) — cumulative PnL over
// the run's own trades, same startingEquity convention as metrics.js.
function EquityCurve({ trades, startingEquity = 10000 }) {
  const points = trades.reduce(
    (acc, t) => [...acc, acc[acc.length - 1] + (Number.isFinite(t.pnl) ? t.pnl : 0)],
    [startingEquity]
  );
  const min = Math.min(...points), max = Math.max(...points);
  const pad = (max - min) * 0.1 || 1;
  const lo = min - pad, hi = max + pad;
  const w = 100, h = 100;
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i / (points.length - 1)) * w} ${h - ((v - lo) / (hi - lo)) * h}`)
    .join(' ');
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
      <path d={path} fill="none" stroke={up ? 'var(--pos, #16a34a)' : 'var(--acc)'} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function ProTerminal() {
  const { dense } = useApp();
  const [activeSym, setActiveSym] = useState('BTCUSD');
  const [activeTf, setActiveTf] = useState('M15');
  const activeTile = MULTI_CHART_TILES.find(t => t.sym === activeSym) || MULTI_CHART_TILES[0];

  const loadOpenTrades = useCallback(() => fetchTrades('open'), []);
  const openTradesQ = useFetch(loadOpenTrades, [loadOpenTrades]);
  const trades = useMemo(() => (openTradesQ.data || []).map(toOpenTradeRow), [openTradesQ.data]);
  const livePnl = useLiveTradePnl(trades);
  const primaryTrade = trades[0] ?? { id: null, entry: NaN, entryFmt: '—', tp: '—', sl: '—', strategy: '—', duration: '—' };
  const entryNum = primaryTrade.entry;
  const tpPct = fmtSignedPct((parseDeNum(primaryTrade.tp) - entryNum) / entryNum);
  const slPct = fmtSignedPct((parseDeNum(primaryTrade.sl) - entryNum) / entryNum);
  const primaryPnl = pnlDisplay(livePnl.get(primaryTrade.id)?.pnl);

  const loadBacktests = useCallback(() => fetchBacktestRuns(), []);
  const backtestQ = useFetch(loadBacktests, [loadBacktests]);
  const latestStoredBacktest = (backtestQ.data && backtestQ.data[0]) || null;

  const loadStrategies = useCallback(() => fetchStrategies(), []);
  const strategiesQ = useFetch(loadStrategies, [loadStrategies]);
  const allStrategies = strategiesQ.data || [];
  const backtestableStrategies = allStrategies.filter(s => BACKTESTABLE_STRATEGY_IDS.has(s.id));
  const nonBacktestableStrategies = allStrategies.filter(s => !BACKTESTABLE_STRATEGY_IDS.has(s.id));

  const [btStrategyId, setBtStrategyId] = useState('');
  const [btSymbol, setBtSymbol] = useState(BACKTEST_SYMBOLS[0]);
  const [btLoading, setBtLoading] = useState(false);
  const [btResult, setBtResult] = useState(null); // { data } on success, { error, message, ... } on a known failure
  const [btNetworkError, setBtNetworkError] = useState(null); // transport-level failure (worker unreachable)

  const effectiveStrategyId = btStrategyId || backtestableStrategies[0]?.id || '';
  const selectedIsBacktestable = BACKTESTABLE_STRATEGY_IDS.has(effectiveStrategyId);

  const handleRunBacktest = useCallback(async () => {
    if (!effectiveStrategyId) return;
    setBtLoading(true);
    setBtNetworkError(null);
    setBtResult(null);
    try {
      const body = await runBacktest(effectiveStrategyId, btSymbol);
      setBtResult(body);
    } catch (err) {
      setBtNetworkError(err);
    } finally {
      setBtLoading(false);
    }
  }, [effectiveStrategyId, btSymbol]);

  const manualRun = btResult?.data ?? null;
  // The metrics panel prefers a just-run result over the last stored run so
  // the UI reflects what the user actually triggered; falls back to the
  // latest persisted backtest_runs row when nothing's been run this session.
  const displayedBacktest = manualRun?.run ?? latestStoredBacktest;
  const displayedMetrics = manualRun?.metrics ?? null;

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateColumns: dense ? '1fr 340px' : '1fr 300px', gap: 1, background: 'var(--line)', minHeight: 0 }}>
      <div style={{ display: 'grid', gridTemplateRows: '1fr auto', gap: 1, background: 'var(--line)', minHeight: 0 }}>

        <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 0, fontFamily: "'IBM Plex Mono',monospace" }}>
              {MULTI_CHART_TILES.map(t => (
                <button key={t.sym} onClick={() => setActiveSym(t.sym)} style={symBtnStyle(t.sym === activeSym)}>{t.label}</button>
              ))}
            </div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 15 }}>{activeTile.price}</div>
            <div style={{ width: 1, height: 16, background: 'var(--line)' }} />
            <div style={{ display: 'flex', gap: 0, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
              {TF.map(t => <div key={t} onClick={() => setActiveTf(t)} style={tfStyle(t === activeTf)}>{t}</div>)}
            </div>
            {dense && (
              <div style={{ display: 'flex', gap: 6, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>
                <div style={{ padding: '2px 7px', border: '1px solid var(--line)' }}>EMA 21/55</div>
                <div style={{ padding: '2px 7px', border: '1px solid var(--line)' }}>ATR 14</div>
                <div style={{ padding: '2px 7px', border: '1px solid var(--line)' }}>VOL-PROFIL</div>
              </div>
            )}
            <div style={{ flex: 1 }} />
            {/* Was a static "MOMENTUM-M7 · AKTIV" mock badge unrelated to any
                real active strategy — replaced with the strategy actually
                selected in the Backtest panel below (real state), or
                dropped entirely once no backtestable strategy has loaded. */}
            {effectiveStrategyId && (
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>
                BACKTEST: {backtestableStrategies.find(s => s.id === effectiveStrategyId)?.name ?? effectiveStrategyId}
              </div>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, background: 'var(--chart)' }}>
            <TradingViewWidget symbol={activeSym} interval={activeTf} />
          </div>
          {/* The free TradingView embed can't render TP/SL lines on the chart itself
              (no chart-internals access outside the paid Advanced Charts Library), so
              Entry/SL/TP are shown here as a badge row instead — values pulled from the
              same "Aktuelle Trades" table below (primaryTrade), never re-entered. */}
          <div style={{ display: 'flex', gap: 16, padding: '5px 9px', borderTop: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, background: 'var(--panel2)', flexWrap: 'wrap' }}>
            <div style={{ color: 'var(--txt2)' }}>EINSTIEG <span style={{ color: 'var(--txt)' }}>{primaryTrade.entryFmt}</span></div>
            <div style={{ color: 'var(--txt2)' }}>TP <span style={{ color: 'var(--txt)' }}>{primaryTrade.tp}</span> <span style={{ color: 'var(--txt3)' }}>({tpPct})</span></div>
            <div style={{ color: 'var(--txt2)' }}>SL <span style={{ color: 'var(--txt)' }}>{primaryTrade.sl}</span> <span style={{ color: 'var(--txt3)' }}>({slPct})</span></div>
            <div style={{ color: 'var(--txt2)' }}>STRATEGIE <span style={{ color: 'var(--txt)' }}>{primaryTrade.strategy}</span></div>
            <div style={{ color: 'var(--txt2)' }}>P/L <span style={{ color: primaryPnl.color, fontWeight: 600 }}>{primaryPnl.text}</span></div>
            <div style={{ flex: 1 }} />
            <div style={{ color: 'var(--txt2)' }}>LAUFZEIT <span style={{ color: 'var(--txt)' }}>{primaryTrade.duration}</span></div>
          </div>
        </div>

        <div style={{ background: 'var(--panel)' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '5px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)' }}>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Aktuelle Trades</div>
            <div style={{ flex: 1 }} />
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)' }}>
              {trades.length} offen · schwebend{' '}
              <span style={{ color: liveTotalColor(trades, livePnl) }}>{fmtSignedLivePnlTotal(trades.map(t => livePnl.get(t.id)?.pnl))}</span>
            </div>
          </div>
          <StatusPanel loading={openTradesQ.loading} error={openTradesQ.error} onRetry={openTradesQ.reload} />
          {!openTradesQ.loading && !openTradesQ.error && (
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '78px 62px 56px 88px 88px 88px 1fr 84px', padding: '4px 9px', color: 'var(--txt3)', borderBottom: '1px solid var(--line)', minWidth: 640 }}>
              <div>SYMBOL</div><div>RICHTUNG</div><div style={{ textAlign: 'right' }}>VOL.</div><div style={{ textAlign: 'right' }}>EINSTIEG</div><div style={{ textAlign: 'right' }}>SL</div><div style={{ textAlign: 'right' }}>TP</div><div style={{ textAlign: 'right' }}>STRATEGIE</div><div style={{ textAlign: 'right' }}>P/L</div>
            </div>
            {trades.map((t) => {
              const pnl = pnlDisplay(livePnl.get(t.id)?.pnl);
              return (
                <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '78px 62px 56px 88px 88px 88px 1fr 84px', padding: '5px 9px', borderBottom: '1px solid var(--line)', minWidth: 640 }}>
                  <div style={{ color: 'var(--txt)' }}>{t.symbol}</div><div style={{ color: 'var(--txt2)' }}>{t.dir}</div>
                  <div style={{ textAlign: 'right' }}>{t.vol}</div><div style={{ textAlign: 'right' }}>{t.entryFmt}</div>
                  <div style={{ textAlign: 'right' }}>{t.sl}</div><div style={{ textAlign: 'right' }}>{t.tp}</div>
                  <div style={{ textAlign: 'right', color: 'var(--txt2)' }}>{t.strategy}</div>
                  <div style={{ textAlign: 'right', color: pnl.color, fontWeight: 600 }}>{pnl.text}</div>
                </div>
              );
            })}
          </div>
          )}
        </div>
      </div>

      <div style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Backtest</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 9px', borderBottom: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
          <select
            value={effectiveStrategyId}
            onChange={(e) => setBtStrategyId(e.target.value)}
            disabled={strategiesQ.loading}
            style={{ background: 'var(--panel3)', border: '1px solid var(--line2)', color: 'var(--txt)', fontFamily: 'inherit', fontSize: 10, padding: '4px 6px' }}
          >
            {backtestableStrategies.length === 0 && <option value="">— keine Strategien geladen —</option>}
            {backtestableStrategies.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
            ))}
            {nonBacktestableStrategies.length > 0 && (
              <optgroup label="Noch kein Adapter — Backtest nicht möglich">
                {nonBacktestableStrategies.map((s) => (
                  <option key={s.id} value={s.id} disabled>{s.name} ({s.id})</option>
                ))}
              </optgroup>
            )}
          </select>

          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={btSymbol}
              onChange={(e) => setBtSymbol(e.target.value)}
              style={{ flex: 1, background: 'var(--panel3)', border: '1px solid var(--line2)', color: 'var(--txt)', fontFamily: 'inherit', fontSize: 10, padding: '4px 6px' }}
            >
              {BACKTEST_SYMBOLS.map((sym) => <option key={sym} value={sym}>{sym}</option>)}
            </select>
            <button
              onClick={handleRunBacktest}
              disabled={btLoading || !selectedIsBacktestable || !effectiveStrategyId}
              style={{
                flex: 1, fontFamily: 'inherit', fontSize: 10, padding: '4px 10px', letterSpacing: '0.06em', cursor: btLoading || !selectedIsBacktestable ? 'not-allowed' : 'pointer',
                background: 'var(--acc)', border: 0, color: '#fff', opacity: btLoading || !selectedIsBacktestable ? 0.5 : 1,
              }}
            >
              {btLoading ? 'LÄUFT…' : 'BACKTEST STARTEN'}
            </button>
          </div>

          {!selectedIsBacktestable && effectiveStrategyId && (
            <div style={{ color: 'var(--txt3)' }}>Für diese Strategie ist noch kein Indikator-Adapter vorhanden — Backtesting ist dafür (noch) nicht möglich.</div>
          )}
        </div>

        {btLoading && (
          <div style={{ padding: '14px 9px', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--txt2)' }}>
            Lade Kerzendaten und werte Strategie aus…
          </div>
        )}
        {!btLoading && btNetworkError && (
          <div style={{ padding: '14px 9px', display: 'flex', alignItems: 'center', gap: 10, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--acc)' }}>
            <div>Worker nicht erreichbar · {btNetworkError.message}</div>
          </div>
        )}
        {!btLoading && !btNetworkError && btResult?.error && (
          <div style={{ padding: '10px 9px', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--acc)', borderBottom: '1px solid var(--line)' }}>
            {describeBacktestError(btResult)}
          </div>
        )}
        {!btLoading && manualRun?.partialAdapter && (
          <div style={{ padding: '10px 9px', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', borderBottom: '1px solid var(--line)', background: 'var(--panel2)' }}>
            ⚠ Vereinfachter Adapter: {manualRun.partialAdapter}
          </div>
        )}
        {!btLoading && manualRun?.window?.apiLimited && (
          <div style={{ padding: '10px 9px', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', borderBottom: '1px solid var(--line)', background: 'var(--panel2)' }}>
            ⚠ Zeitraum wurde auf CoinGeckos 365-Tage-Historienlimit begrenzt.
          </div>
        )}

        <StatusPanel loading={backtestQ.loading && !manualRun} error={!manualRun ? backtestQ.error : null} onRetry={backtestQ.reload} />
        {!btLoading && (backtestQ.data || manualRun) && !(backtestQ.error && !manualRun) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--line)', borderBottom: '1px solid var(--line)' }}>
          {metricBox('NETTOGEWINN', displayedMetrics && manualRun.trades ? fmtSignedNetProfit(manualRun.trades) : '—')}
          {metricBox('PROFIT-FAKTOR', fmtNum(displayedMetrics ? displayedMetrics.profitFactor : displayedBacktest?.profit_factor))}
          {metricBox('MAX. DRAWDOWN', displayedBacktest ? (displayedMetrics ? fmtSignedPct(displayedMetrics.maxDrawdown) : '−' + fmtPct(Math.abs(displayedBacktest.max_drawdown))) : '—', true)}
          {metricBox('TREFFERQUOTE', fmtPct(displayedMetrics ? displayedMetrics.winRate : displayedBacktest?.win_rate))}
          {metricBox('SHARPE', fmtNum(displayedMetrics ? displayedMetrics.sharpe : displayedBacktest?.sharpe))}
          {metricBox('SORTINO', fmtNum(displayedMetrics ? displayedMetrics.sortino : displayedBacktest?.sortino))}
          {metricBox('CRV', manualRun?.trades ? fmtCrv(manualRun.trades) : '—')}
          {metricBox('OUT-OF-SAMPLE-ABW.', displayedBacktest?.out_of_sample_deviation != null ? fmtPct(displayedBacktest.out_of_sample_deviation) : '—')}
        </div>
        )}

        {!btLoading && (backtestQ.data || manualRun) && (
          <>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, borderBottom: '1px solid var(--line)' }}>
              {[
                ['Strategie', displayedBacktest?.strategy_id ?? '—'],
                ['Symbol', displayedBacktest?.symbol ?? '—'],
                ['Zeitraum', displayedBacktest ? `${displayedBacktest.timeframe_start} – ${displayedBacktest.timeframe_end}` : '—'],
                ['Kerzen ausgewertet', manualRun?.candleCount ?? '—'],
                ['Anzahl Trades', displayedMetrics ? displayedMetrics.tradeCount : (displayedBacktest?.trade_count ?? '—')],
              ].map(([l, v], i, arr) => (
                <div key={l} style={{ display: 'flex', padding: '4px 9px', borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 'none' }}>
                  <div style={{ flex: 1, color: 'var(--txt2)' }}>{l}</div><div>{v}</div>
                </div>
              ))}
            </div>

            <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Equity-Kurve (Backtest)</div>
            <div style={{ height: 96, background: 'var(--chart)', borderBottom: '1px solid var(--line)' }}>
              {manualRun?.trades?.length > 0 ? (
                <EquityCurve trades={manualRun.trades} />
              ) : (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt3)' }}>
                  {manualRun ? 'Keine Trades im Zeitraum' : 'Noch kein Backtest in dieser Sitzung gelaufen'}
                </div>
              )}
            </div>

            {/* Session-breakdown axis alongside winrate/overall and asset-fit:
                which strategy performs how in which trading session. Only
                real numbers for a just-run, backtestable strategy — a
                stored/older run has no sessionBreakdown persisted-and-refetched
                here yet (POST /backtest/run returns it, GET /backtest-runs
                list rows don't join it), so that case (and any
                non-backtestable selection) falls back to the same "—" /
                "noch nicht verfügbar" placeholder pattern used above for
                out-of-sample deviation etc. Overlap is NOT additive with the
                other three — see worker/src/backtest/sessions.js. */}
            <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>Session-Auswertung</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 64px 72px', padding: '4px 9px', color: 'var(--txt3)', borderBottom: '1px solid var(--line)' }}>
                <div>SESSION</div><div style={{ textAlign: 'right' }}>TRADES</div><div style={{ textAlign: 'right' }}>QUOTE</div><div style={{ textAlign: 'right' }}>P/L</div>
              </div>
              {SESSION_BREAKDOWN_ROWS.map(({ key, label }, i, arr) => {
                const bucket = manualRun?.sessionBreakdown?.[key];
                return (
                  <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr 56px 64px 72px', padding: '4px 9px', borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 'none' }}>
                    <div style={{ color: 'var(--txt2)' }}>{label}</div>
                    <div style={{ textAlign: 'right' }}>{bucket ? bucket.trades : '—'}</div>
                    <div style={{ textAlign: 'right' }}>{bucket ? fmtPct(bucket.winRate) : '—'}</div>
                    <div style={{ textAlign: 'right' }}>{bucket ? fmtSignedNum(bucket.netPnl) : '—'}</div>
                  </div>
                );
              })}
              {!manualRun?.sessionBreakdown && (
                <div style={{ padding: '4px 9px', color: 'var(--txt3)' }}>
                  {selectedIsBacktestable ? 'Session-Auswertung: noch nicht verfügbar — Backtest oben starten.' : 'Session-Auswertung noch nicht verfügbar.'}
                </div>
              )}
            </div>
          </>
        )}

        {/* No real AI/analytics engine generates these suggestions (per PR
            #24's docs — unchanged status) — same treatment as Multi-Chart's
            Strategie-Matrix/Faktor-Auslastung: heading labeled and the
            content dimmed + tagged MOCK rather than looking like live
            engine output, layout kept as-is. */}
        <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>
          Strategie-Verbesserungen <span style={{ color: 'var(--txt3)', textTransform: 'none', letterSpacing: 0 }}>· noch nicht verfügbar (MOCK)</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', opacity: 0.5 }}>
          {STRATEGY_SUGGESTIONS.filter(s => dense || !s.denseOnly).map((s, i) => (
            <div key={i} style={{ padding: '8px 9px', borderBottom: '1px solid var(--line)', borderLeft: `2px solid ${s.priority === 'HOCH' ? 'var(--acc)' : 'var(--line2)'}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: s.priority === 'NIEDRIG' ? 'var(--txt3)' : (s.priority === 'HOCH' ? 'var(--acc)' : 'var(--txt2)'), letterSpacing: '0.08em' }}>{s.priority}</div>
                <div style={{ fontWeight: 600, fontSize: 11 }}>{s.title}</div>
              </div>
              <div style={{ color: 'var(--txt2)', lineHeight: 1.5, marginTop: 3, fontSize: 11 }}>{s.body}</div>
              {s.expect && <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', marginTop: 5 }}>{s.expect}</div>}
              {s.actions && (dense || s.priority === 'HOCH') && (
                <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                  <button disabled style={{ background: 'var(--acc)', border: 0, color: '#fff', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '4px 10px', cursor: 'not-allowed', letterSpacing: '0.06em' }}>ÜBERNEHMEN</button>
                  <button disabled style={{ background: 'transparent', border: '1px solid var(--line2)', color: 'var(--txt2)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '4px 10px', cursor: 'not-allowed', letterSpacing: '0.06em' }}>BACKTEST</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {dense && (
          <>
            {/* No real signal-factor engine backs these values either (same
                mock status as above) — dimmed + labeled, layout unchanged. */}
            <div style={{ padding: '6px 9px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt2)', textTransform: 'uppercase' }}>
              Signal-Faktoren · aktuell <span style={{ color: 'var(--txt3)', textTransform: 'none', letterSpacing: 0 }}>· noch nicht verfügbar (MOCK)</span>
            </div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, opacity: 0.5 }}>
              {SIGNAL_FACTORS.map((f, i, arr) => (
                <div key={f.label} style={{ display: 'flex', padding: '4px 9px', borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 'none' }}>
                  <div style={{ width: 12, color: f.on ? 'var(--acc)' : 'var(--txt3)' }}>{f.on ? '✓' : '×'}</div>
                  <div style={{ flex: 1, color: f.on ? 'var(--txt2)' : 'var(--txt3)' }}>{f.label}</div>
                  <div style={{ color: f.on ? 'var(--txt)' : 'var(--txt3)' }}>{f.val}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
