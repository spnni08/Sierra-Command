import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { fetchStrategyDetail } from '../api/client';
import { useFetch } from '../api/useFetch';
import { fmtUsd, fmtPct, fmtR, fmtInt, fmtPrice, fmtBerlinDateTime, REASON, compareByField, segBtn } from '../lib/statsFormat';
import StatusPanel from '../api/StatusPanel';

const TRADES_LIMIT = 50;
// Same threshold as worker/src/routes/stats.js's BEST_COMBO_MIN_TRADES —
// duplicated (not imported: worker/ and src/ are separate deploy targets
// with no cross-imports anywhere in this codebase) rather than recomputed
// from data, since it's the same fixed business rule on both sides: a
// matrix cell with fewer trades is "wenig Daten" for the exact same reason
// bestCombo won't consider it.
const MATRIX_MIN_TRADES = 10;

// Same set + wording as worker/src/routes/stats.js's CRYPTO_SYMBOLS /
// Auswertung.jsx's SYNTHETIC_CANDLE_TOOLTIP — duplicated for the same
// reason as MATRIX_MIN_TRADES above (no cross-import between worker/ and
// src/, and StrategyDetailModal can't import from Auswertung.jsx since that
// file already imports this one). Computed here from byAssetTimeframe
// (always the full source/range-filtered set, unlike trades.rows which can
// be narrowed by the Asset/Timeframe filters in the "Alle Trades" tab) so
// no backend change is needed.
const SYNTHETIC_CANDLE_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
const SYNTHETIC_CANDLE_TOOLTIP = 'Backtest auf Tageskerzen ohne Intraday-Daten – nicht repräsentativ für Live-Timeframe';

const REASON_LABEL = { sl: 'SL', tp: 'TP', signal: 'Signal', period_end: 'Ende Zeitraum' };
function fmtReason(reason) {
  return REASON_LABEL[reason] ?? 'unbekannt';
}
function fmtDirection(d) {
  return d === 'long' ? 'LONG' : d === 'short' ? 'SHORT' : '–';
}
function fmtDuration(openedAt, closedAt) {
  if (!openedAt || !closedAt) return '–';
  const start = new Date(openedAt.replace(' ', 'T') + 'Z');
  const end = new Date(closedAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '–';
  const hrs = Math.max(0, (end.getTime() - start.getTime()) / 3_600_000);
  return hrs.toFixed(2).replace('.', ',') + ' h';
}

function SortHeaderSmall({ label, sortKey, sort, onSort, align }) {
  const active = sort.key === sortKey;
  return (
    <button
      onClick={() => onSort(sortKey)}
      style={{
        all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, width: '100%',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        color: active ? 'var(--txt)' : 'var(--txt3)',
      }}
    >
      {label}
      {active && <span style={{ fontSize: 8 }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );
}

const GROUP_GRID = '1fr 90px 110px 80px 110px 90px 110px 140px';

// Shared table for the "Nach Asset" and "Nach Timeframe" tabs — same columns,
// same sort logic (compareByField, reused from Auswertung.jsx's main table),
// just a different grouping key/label already computed server-side.
function GroupTable({ rows, labelKey, labelHeader, sort, onSort }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => compareByField(a, b, sort.key, sort.dir)), [rows, sort]);
  return (
    <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflow: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: GROUP_GRID, gap: 8, padding: '4px 10px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--panel)' }}>
        <SortHeaderSmall label={labelHeader} sortKey={labelKey} sort={sort} onSort={onSort} />
        <SortHeaderSmall label="TRADES" sortKey="tradeCount" sort={sort} onSort={onSort} align="right" />
        <SortHeaderSmall label="PNL" sortKey="pnlTotalUsd" sort={sort} onSort={onSort} align="right" />
        <SortHeaderSmall label="WINRATE" sortKey="winRate" sort={sort} onSort={onSort} align="right" />
        <SortHeaderSmall label="EXPECTANCY" sortKey="expectancyUsd" sort={sort} onSort={onSort} align="right" />
        <SortHeaderSmall label="Ø PNL" sortKey="avgPnlUsd" sort={sort} onSort={onSort} align="right" />
        <SortHeaderSmall label="Ø RR" sortKey="avgRealizedRR" sort={sort} onSort={onSort} align="right" />
        <SortHeaderSmall label="LETZTER TRADE" sortKey="lastTradeAt" sort={sort} onSort={onSort} align="right" />
      </div>
      {sorted.length === 0 && (
        <div style={{ padding: '14px 10px', color: 'var(--txt2)' }}>{REASON.noTrades}</div>
      )}
      {sorted.map((row) => (
        <div key={row[labelKey]} style={{ display: 'grid', gridTemplateColumns: GROUP_GRID, gap: 8, padding: '5px 10px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ color: 'var(--txt)' }}>{row[labelKey]}</div>
          <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtInt(row.tradeCount)}</div>
          <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtUsd(row.pnlTotalUsd)}</div>
          <div style={{ textAlign: 'right', color: 'var(--txt)' }} title={row.winRate === null ? REASON.winRate : undefined}>{fmtPct(row.winRate)}</div>
          <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtUsd(row.expectancyUsd)}</div>
          <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtUsd(row.avgPnlUsd)}</div>
          <div style={{ textAlign: 'right', color: 'var(--txt)' }} title={row.avgRealizedRR === null ? REASON.rr : undefined}>{fmtR(row.avgRealizedRR)}</div>
          <div style={{ textAlign: 'right', color: 'var(--txt2)' }} title={row.lastTradeAt === null ? REASON.lastTrade : undefined}>{fmtBerlinDateTime(row.lastTradeAt)}</div>
        </div>
      ))}
    </div>
  );
}

const MATRIX_METRICS = [
  { key: 'expectancyR', label: 'Expectancy (R)', fmt: fmtR },
  { key: 'pnlTotalUsd', label: 'PnL', fmt: fmtUsd },
  { key: 'winRate', label: 'Winrate', fmt: fmtPct },
  { key: 'avgRealizedRR', label: 'Ø RR', fmt: fmtR },
];

function bestComboSentence(bestCombo) {
  if (!bestCombo) return `Keine Kombination mit mindestens ${MATRIX_MIN_TRADES} Trades.`;
  const valueText = bestCombo.metric === 'expectancyR' ? fmtR(bestCombo.value) : fmtUsd(bestCombo.value);
  return `Beste Kombination (min. ${MATRIX_MIN_TRADES} Trades): ${bestCombo.symbol} · ${bestCombo.timeframe}, Expectancy ${valueText} aus ${bestCombo.tradeCount} Trades`;
}

function AssetTimeframeMatrix({ byAssetTimeframe, bestCombo, onCellClick }) {
  const [metricKey, setMetricKey] = useState('expectancyR');
  const metric = MATRIX_METRICS.find((m) => m.key === metricKey);

  const { symbols, timeframes, cellByKey } = useMemo(() => {
    const symbolSet = new Set();
    const timeframeSet = new Set();
    const map = new Map();
    for (const c of byAssetTimeframe) {
      symbolSet.add(c.symbol);
      timeframeSet.add(c.timeframe);
      map.set(`${c.symbol}::${c.timeframe}`, c);
    }
    const tfList = [...timeframeSet].filter((t) => t !== 'unbekannt').sort();
    if (timeframeSet.has('unbekannt')) tfList.push('unbekannt');
    return { symbols: [...symbolSet].sort(), timeframes: tfList, cellByKey: map };
  }, [byAssetTimeframe]);

  const intensityByKey = useMemo(() => {
    const qualifying = byAssetTimeframe.filter((c) => c.tradeCount >= MATRIX_MIN_TRADES && c[metricKey] != null);
    if (qualifying.length === 0) return new Map();
    const values = qualifying.map((c) => Math.abs(c[metricKey]));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const map = new Map();
    for (const c of qualifying) {
      const t = max > min ? (Math.abs(c[metricKey]) - min) / (max - min) : 1;
      map.set(`${c.symbol}::${c.timeframe}`, 0.15 + t * 0.65);
    }
    return map;
  }, [byAssetTimeframe, metricKey]);

  if (symbols.length === 0) {
    return <div style={{ padding: 16, fontSize: 11, color: 'var(--txt2)' }}>{REASON.noTrades}</div>;
  }

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
        <div style={{ color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Kennzahl</div>
        <div style={{ display: 'flex' }}>
          {MATRIX_METRICS.map((m, i) => (
            <button key={m.key} onClick={() => setMetricKey(m.key)} style={segBtn(metricKey === m.key, i === 0)}>{m.label.toUpperCase()}</button>
          ))}
        </div>
      </div>

      <div style={{ overflow: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `120px repeat(${timeframes.length}, 90px)`, gap: 4, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
          <div />
          {timeframes.map((tf) => (
            <div key={tf} style={{ textAlign: 'center', color: 'var(--txt3)', padding: '2px 0' }}>{tf}</div>
          ))}
          {symbols.map((sym) => (
            <Fragment key={sym}>
              <div style={{ display: 'flex', alignItems: 'center', color: 'var(--txt2)' }}>{sym}</div>
              {timeframes.map((tf) => {
                const key = `${sym}::${tf}`;
                const cell = cellByKey.get(key);
                if (!cell) {
                  return (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 40, border: '1px solid var(--line)', color: 'var(--txt3)' }}>–</div>
                  );
                }
                const lowData = cell.tradeCount < MATRIX_MIN_TRADES;
                const opacity = intensityByKey.get(key);
                return (
                  <button
                    key={key}
                    onClick={() => onCellClick(sym, tf)}
                    title={lowData ? `wenig Daten (${cell.tradeCount} Trades)` : undefined}
                    style={{
                      all: 'unset', cursor: 'pointer', position: 'relative', height: 40, boxSizing: 'border-box',
                      border: '1px solid var(--line)', display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                    }}
                  >
                    {!lowData && opacity != null && (
                      <div style={{ position: 'absolute', inset: 0, background: 'var(--acc)', opacity }} />
                    )}
                    <div style={{ position: 'relative', color: lowData ? 'var(--txt3)' : 'var(--txt)', fontWeight: 600 }}>
                      {lowData ? 'wenig Daten' : metric.fmt(cell[metricKey])}
                    </div>
                    {!lowData && <div style={{ position: 'relative', fontSize: 8, color: 'var(--txt3)' }}>{cell.tradeCount} Trades</div>}
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--txt2)', borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        {bestComboSentence(bestCombo)}
      </div>
    </div>
  );
}

const TRADES_GRID = '150px 90px 70px 60px 90px 90px 90px 90px 90px 70px 70px 90px';

function TradesTab({ detail, tradeSymbol, tradeTimeframe, setTradeSymbol, setTradeTimeframe, tradesOffset, setTradesOffset, tradesSort, tradesDir, onSort }) {
  const symbolOptions = detail.byAsset.map((r) => r.symbol);
  const timeframeOptions = detail.byTimeframe.map((r) => r.timeframe);
  const { rows, total } = detail.trades;
  const from = total === 0 ? 0 : tradesOffset + 1;
  const to = Math.min(tradesOffset + TRADES_LIMIT, total);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, flexWrap: 'wrap' }}>
        <select
          value={tradeSymbol ?? ''} onChange={(e) => setTradeSymbol(e.target.value || null)}
          style={{ fontFamily: 'inherit', fontSize: 10, padding: '3px 6px', background: 'var(--panel3)', border: `1px solid ${tradeSymbol ? 'var(--acc)' : 'var(--line2)'}`, color: 'var(--txt)' }}
        >
          <option value="">ALLE ASSETS</option>
          {symbolOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={tradeTimeframe ?? ''} onChange={(e) => setTradeTimeframe(e.target.value || null)}
          style={{ fontFamily: 'inherit', fontSize: 10, padding: '3px 6px', background: 'var(--panel3)', border: `1px solid ${tradeTimeframe ? 'var(--acc)' : 'var(--line2)'}`, color: 'var(--txt)' }}
        >
          <option value="">ALLE TIMEFRAMES</option>
          {timeframeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <div style={{ color: 'var(--txt3)' }}>{total > 0 ? `${from}–${to} von ${total}` : '0 Trades'}</div>
        <button disabled={tradesOffset === 0} onClick={() => setTradesOffset(Math.max(0, tradesOffset - TRADES_LIMIT))} style={{ ...segBtn(false, true), opacity: tradesOffset === 0 ? 0.4 : 1 }}>ZURÜCK</button>
        <button disabled={to >= total} onClick={() => setTradesOffset(tradesOffset + TRADES_LIMIT)} style={{ ...segBtn(false, true), opacity: to >= total ? 0.4 : 1 }}>WEITER</button>
      </div>

      <div style={{ overflow: 'auto', flex: 1, minHeight: 0, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: TRADES_GRID, gap: 6, padding: '4px 10px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--panel)' }}>
          <SortHeaderSmall label="DATUM/UHRZEIT" sortKey="closedAt" sort={{ key: tradesSort, dir: tradesDir }} onSort={onSort} />
          <SortHeaderSmall label="SYMBOL" sortKey="symbol" sort={{ key: tradesSort, dir: tradesDir }} onSort={onSort} />
          <div style={{ color: 'var(--txt3)' }}>TF</div>
          <div style={{ color: 'var(--txt3)' }}>RICHT.</div>
          <div style={{ textAlign: 'right', color: 'var(--txt3)' }}>ENTRY</div>
          <div style={{ textAlign: 'right', color: 'var(--txt3)' }}>SL</div>
          <div style={{ textAlign: 'right', color: 'var(--txt3)' }}>TP</div>
          <div style={{ textAlign: 'right', color: 'var(--txt3)' }}>EXIT</div>
          <SortHeaderSmall label="PNL" sortKey="pnl" sort={{ key: tradesSort, dir: tradesDir }} onSort={onSort} align="right" />
          <div style={{ textAlign: 'right', color: 'var(--txt3)' }}>RR</div>
          <div style={{ color: 'var(--txt3)' }}>LAUFZEIT</div>
          <div style={{ color: 'var(--txt3)' }}>GRUND</div>
        </div>
        {rows.length === 0 && <div style={{ padding: '14px 10px', color: 'var(--txt2)' }}>{REASON.noTrades}</div>}
        {rows.map((t) => (
          <div key={t.id} style={{ display: 'grid', gridTemplateColumns: TRADES_GRID, gap: 6, padding: '5px 10px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ color: 'var(--txt2)' }}>{fmtBerlinDateTime(t.closedAt)}</div>
            <div style={{ color: 'var(--txt)' }}>{t.symbol}</div>
            <div style={{ color: 'var(--txt2)' }}>{t.timeframe ?? 'unbekannt'}</div>
            <div style={{ color: 'var(--txt2)' }}>{fmtDirection(t.direction)}</div>
            <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtPrice(t.entry)}</div>
            <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtPrice(t.sl)}</div>
            <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtPrice(t.tp)}</div>
            <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtPrice(t.exit)}</div>
            <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtUsd(t.pnl)}</div>
            <div style={{ textAlign: 'right', color: 'var(--txt)' }} title={t.realizedR === null ? REASON.rr : undefined}>{fmtR(t.realizedR)}</div>
            <div style={{ color: 'var(--txt2)' }}>{fmtDuration(t.openedAt, t.closedAt)}</div>
            <div style={{ color: 'var(--txt2)' }}>{fmtReason(t.reason)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const TABS = [
  { key: 'asset', label: 'Nach Asset' },
  { key: 'timeframe', label: 'Nach Timeframe' },
  { key: 'matrix', label: 'Asset × Timeframe' },
  { key: 'trades', label: 'Alle Trades' },
];

export default function StrategyDetailModal({ strategyId, strategyName, source, sourceLabel, range, rangeLabel, customFrom, customTo, onClose }) {
  const [activeTab, setActiveTab] = useState('asset');
  const [assetSort, setAssetSort] = useState({ key: 'expectancyUsd', dir: 'desc' });
  const [timeframeSort, setTimeframeSort] = useState({ key: 'expectancyUsd', dir: 'desc' });
  const [tradeSymbol, setTradeSymbolState] = useState(null);
  const [tradeTimeframe, setTradeTimeframeState] = useState(null);
  const [tradesOffset, setTradesOffset] = useState(0);
  const [tradesSort, setTradesSort] = useState('closedAt');
  const [tradesDir, setTradesDir] = useState('desc');

  const setTradeSymbol = useCallback((v) => { setTradeSymbolState(v); setTradesOffset(0); }, []);
  const setTradeTimeframe = useCallback((v) => { setTradeTimeframeState(v); setTradesOffset(0); }, []);

  const handleTradesSort = useCallback((key) => {
    setTradesOffset(0);
    if (key === tradesSort) setTradesDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setTradesSort(key);
      setTradesDir('desc');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradesSort]);

  const handleMatrixCellClick = useCallback((symbol, timeframe) => {
    setTradeSymbolState(symbol);
    setTradeTimeframeState(timeframe);
    setTradesOffset(0);
    setActiveTab('trades');
  }, []);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const loadDetail = useCallback(
    () =>
      fetchStrategyDetail(strategyId, {
        source, range, from: customFrom, to: customTo,
        tradeSymbol, tradeTimeframe, tradesLimit: TRADES_LIMIT, tradesOffset, tradesSort, tradesDir,
      }),
    [strategyId, source, range, customFrom, customTo, tradeSymbol, tradeTimeframe, tradesOffset, tradesSort, tradesDir]
  );
  const detailQ = useFetch(loadDetail, [loadDetail]);
  const detail = detailQ.data;
  const name = detail?.name ?? strategyName ?? strategyId;
  const hasSyntheticDailyCandles =
    source === 'backtest' &&
    !!detail?.byAssetTimeframe.some((c) => c.timeframe === '1d' && SYNTHETIC_CANDLE_SYMBOLS.has(c.symbol));

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
    >
      <div
        className="strategy-detail-modal-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--panel)', border: '1px solid var(--line2)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt)' }}>{name}</div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt3)', border: '1px solid var(--line2)', padding: '2px 6px', textTransform: 'uppercase' }}>{sourceLabel}</div>
          {rangeLabel && <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: 'var(--txt3)', border: '1px solid var(--line2)', padding: '2px 6px', textTransform: 'uppercase' }}>{rangeLabel}</div>}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} title="Schließen (ESC)" style={{ all: 'unset', cursor: 'pointer', color: 'var(--txt2)', fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>

        <StatusPanel loading={detailQ.loading} error={detailQ.error} onRetry={detailQ.reload} />

        {detail && (
          <>
            {hasSyntheticDailyCandles && (
              <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>⚠</span>
                <span>{SYNTHETIC_CANDLE_TOOLTIP}</span>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
              <div><div style={{ color: 'var(--txt3)' }}>TRADES</div><div style={{ color: 'var(--txt)' }}>{fmtInt(detail.overall.tradeCount)}</div></div>
              <div><div style={{ color: 'var(--txt3)' }}>PNL</div><div style={{ color: 'var(--txt)' }}>{fmtUsd(detail.overall.pnlTotalUsd)}</div></div>
              <div><div style={{ color: 'var(--txt3)' }}>WINRATE</div><div style={{ color: 'var(--txt)' }} title={detail.overall.winRate === null ? REASON.winRate : undefined}>{fmtPct(detail.overall.winRate)}</div></div>
              <div><div style={{ color: 'var(--txt3)' }}>EXPECTANCY</div><div style={{ color: 'var(--txt)' }}>{fmtUsd(detail.overall.expectancyUsd)}</div></div>
              <div><div style={{ color: 'var(--txt3)' }}>Ø PNL</div><div style={{ color: 'var(--txt)' }}>{fmtUsd(detail.overall.avgPnlUsd)}</div></div>
              <div><div style={{ color: 'var(--txt3)' }}>Ø RR</div><div style={{ color: 'var(--txt)' }} title={detail.overall.avgRealizedRR === null ? REASON.rr : undefined}>{fmtR(detail.overall.avgRealizedRR)}</div></div>
              <div><div style={{ color: 'var(--txt3)' }}>LETZTER TRADE</div><div style={{ color: 'var(--txt2)' }} title={detail.overall.lastTradeAt === null ? REASON.lastTrade : undefined}>{fmtBerlinDateTime(detail.overall.lastTradeAt)}</div></div>
              <div><div style={{ color: 'var(--txt3)' }}>OFFEN</div><div style={{ color: 'var(--txt2)' }}>{detail.openCount}</div></div>
            </div>

            <div style={{ display: 'flex', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '8px 16px', gap: 0, borderBottom: '1px solid var(--line)' }}>
              {TABS.map((t, i) => (
                <button key={t.key} onClick={() => setActiveTab(t.key)} style={segBtn(activeTab === t.key, i === 0)}>{t.label.toUpperCase()}</button>
              ))}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {activeTab === 'asset' && (
                <GroupTable rows={detail.byAsset} labelKey="symbol" labelHeader="ASSET" sort={assetSort} onSort={(key) => setAssetSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))} />
              )}
              {activeTab === 'timeframe' && (
                <GroupTable rows={detail.byTimeframe} labelKey="timeframe" labelHeader="TIMEFRAME" sort={timeframeSort} onSort={(key) => setTimeframeSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))} />
              )}
              {activeTab === 'matrix' && (
                <AssetTimeframeMatrix byAssetTimeframe={detail.byAssetTimeframe} bestCombo={detail.bestCombo} onCellClick={handleMatrixCellClick} />
              )}
              {activeTab === 'trades' && (
                <TradesTab
                  detail={detail}
                  tradeSymbol={tradeSymbol} tradeTimeframe={tradeTimeframe}
                  setTradeSymbol={setTradeSymbol} setTradeTimeframe={setTradeTimeframe}
                  tradesOffset={tradesOffset} setTradesOffset={setTradesOffset}
                  tradesSort={tradesSort} tradesDir={tradesDir} onSort={handleTradesSort}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
