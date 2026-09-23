import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchStrategies, fetchStrategyStats } from '../api/client';
import { useFetch } from '../api/useFetch';
import { todayBerlinDateStr } from '../lib/berlinDay';
import { fmtUsd, fmtPct, fmtR, fmtRatio, fmtInt, fmtBerlinDateTime, REASON, compareByField, segBtn } from '../lib/statsFormat';
import StatusPanel from '../api/StatusPanel';
import StrategyDetailModal from '../components/StrategyDetailModal';

// Every symbol this app's backtest/live/demo pipeline actually knows about
// (worker/src/backtest/candles.js's assetClassFor / worker/src/backtest/
// window.js's ASSET_WINDOW) — fixed set, not derived, since a strategy with
// zero trades in the current filter would otherwise never contribute a
// symbol to pick from.
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'EURUSD', 'SPX500', 'NAS100'];

const SOURCE_OPTIONS = [
  { key: 'live', label: 'Live' },
  { key: 'demo', label: 'Demo' },
  { key: 'backtest', label: 'Backtest' },
];
const RANGE_OPTIONS = [
  { key: '7d', label: '7 Tage' },
  { key: '30d', label: '30 Tage' },
  { key: '90d', label: '90 Tage' },
  { key: 'all', label: 'Alle' },
  { key: 'custom', label: 'Eigener Zeitraum' },
];

const HEADER_TOOLTIP = {
  trades: 'Anzahl geschlossener Trades. Klein darunter: Gewinne / Verluste / Breakeven.',
  pnl: 'Summe der realisierten Ergebnisse. In R nur über Trades mit hinterlegtem SL.',
  winRate: 'Gewinn-Trades / (Gewinn-Trades + Verlust-Trades). Breakeven-Trades zählen nicht mit.',
  expectancy: 'Erwarteter Gewinn/Verlust pro Trade: Trefferquote × Ø Gewinn − Gegenquote × Ø Verlust.',
  avgPnl: 'Gesamt-PnL / Anzahl Trades.',
  rr: 'Realisiert: tatsächliche Kursbewegung im Verhältnis zum SL-Abstand, mit Vorzeichen. Geplant (klein darunter): TP-Abstand im Verhältnis zum SL-Abstand.',
  lastTrade: 'Zeitpunkt des letzten geschlossenen Trades (Europe/Berlin).',
  open: 'Aktuell offene Trades dieser Strategie (fließen nicht in die Kennzahlen ein).',
};

const VIEW_KEY = 'auswertung.view';

function readInitialView() {
  const fromUrl = new URLSearchParams(window.location.search).get('view');
  if (fromUrl === 'cards' || fromUrl === 'table') return fromUrl;
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    if (stored === 'cards' || stored === 'table') return stored;
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return 'table';
}

// Cumulative-PnL sparkline path, technique mirrored from Dashboard.jsx's
// EquityCurveFromTrades (same viewBox/M-L-path/non-scaling-stroke
// approach) but over a plain number[] instead of trade objects, and
// deliberately NOT colored by up/down like that component — PnL stays
// neutral everywhere on this page.
function buildSparklinePath(pnlSeries, w, h) {
  if (!pnlSeries || pnlSeries.length < 2) return null;
  const points = pnlSeries.reduce((acc, v) => [...acc, acc[acc.length - 1] + v], [0]);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const pad = (max - min) * 0.1 || 1;
  const lo = min - pad;
  const hi = max + pad;
  return points
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i / (points.length - 1)) * w} ${h - ((v - lo) / (hi - lo)) * h}`)
    .join(' ');
}

function SortHeader({ label, sortKey, sort, onSort, align, tooltip }) {
  const active = sort.key === sortKey;
  return (
    <button
      onClick={() => onSort(sortKey)}
      title={tooltip}
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

const GRID_COLUMNS = '1.3fr 100px 130px 90px 130px 100px 130px 150px 70px';

function StrategyNameButton({ name, active, onClick, style }) {
  return (
    <button
      onClick={onClick}
      title="Details anzeigen"
      style={{
        all: 'unset', cursor: 'pointer', color: active ? 'var(--txt)' : 'var(--txt3)',
        textDecoration: 'underline', textDecorationColor: 'var(--line2)', textUnderlineOffset: 2,
        ...style,
      }}
    >
      {name}
    </button>
  );
}

function StatsTable({ rows, sort, onSort, rowRefs, highlightedStrategyId, onOpenDetail }) {
  return (
    <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflow: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: GRID_COLUMNS, padding: '4px 12px', gap: 8, borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--panel)' }}>
        <SortHeader label="STRATEGIE" sortKey="name" sort={sort} onSort={onSort} />
        <SortHeader label="TRADES" sortKey="tradeCount" sort={sort} onSort={onSort} align="right" tooltip={HEADER_TOOLTIP.trades} />
        <SortHeader label="PNL GESAMT" sortKey="pnlTotalUsd" sort={sort} onSort={onSort} align="right" tooltip={HEADER_TOOLTIP.pnl} />
        <SortHeader label="WINRATE" sortKey="winRate" sort={sort} onSort={onSort} align="right" tooltip={HEADER_TOOLTIP.winRate} />
        <SortHeader label="EXPECTANCY" sortKey="expectancyUsd" sort={sort} onSort={onSort} align="right" tooltip={HEADER_TOOLTIP.expectancy} />
        <SortHeader label="Ø PNL" sortKey="avgPnlUsd" sort={sort} onSort={onSort} align="right" tooltip={HEADER_TOOLTIP.avgPnl} />
        <SortHeader label="Ø RR" sortKey="avgRealizedRR" sort={sort} onSort={onSort} align="right" tooltip={HEADER_TOOLTIP.rr} />
        <SortHeader label="LETZTER TRADE" sortKey="lastTradeAt" sort={sort} onSort={onSort} align="right" tooltip={HEADER_TOOLTIP.lastTrade} />
        <SortHeader label="OFFEN" sortKey="openCount" sort={sort} onSort={onSort} align="right" tooltip={HEADER_TOOLTIP.open} />
      </div>
      {rows.map((row) => {
        const highlighted = row.strategyId === highlightedStrategyId;
        return (
          <div
            key={row.strategyId}
            ref={(el) => { rowRefs.current[row.strategyId] = el; }}
            style={{
              display: 'grid', gridTemplateColumns: GRID_COLUMNS, gap: 8, padding: '6px 12px',
              borderBottom: '1px solid var(--line)',
              background: highlighted ? 'var(--accsoft)' : 'transparent',
              transition: 'background 0.4s ease',
            }}
          >
            <div>
              <StrategyNameButton name={row.name} active={row.active} onClick={() => onOpenDetail(row.strategyId)} />
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ color: 'var(--txt)' }}>{fmtInt(row.tradeCount)}</div>
              <div style={{ fontSize: 9, color: 'var(--txt3)' }}>W:{row.wins} L:{row.losses} BE:{row.breakeven}</div>
              {row.lowData && row.tradeCount > 0 && <div style={{ fontSize: 9, color: 'var(--txt3)' }}>wenig Daten</div>}
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ color: 'var(--txt)' }}>{fmtUsd(row.pnlTotalUsd)}</div>
              <div style={{ fontSize: 9, color: 'var(--txt3)' }} title={row.pnlTotalR === null ? REASON.rr : undefined}>{fmtR(row.pnlTotalR)}</div>
            </div>

            <div style={{ textAlign: 'right', color: 'var(--txt)' }} title={row.winRate === null ? REASON.winRate : undefined}>
              {fmtPct(row.winRate)}
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ color: 'var(--txt)' }}>{fmtUsd(row.expectancyUsd)}</div>
              <div style={{ fontSize: 9, color: 'var(--txt3)' }} title={row.expectancyR === null ? REASON.expectancyR : undefined}>{fmtR(row.expectancyR)}</div>
            </div>

            <div style={{ textAlign: 'right', color: 'var(--txt)' }}>{fmtUsd(row.avgPnlUsd)}</div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ color: 'var(--txt)' }} title={row.avgRealizedRR === null ? REASON.rr : undefined}>{fmtR(row.avgRealizedRR)}</div>
              <div style={{ fontSize: 9, color: 'var(--txt3)' }} title={row.avgPlannedRR === null ? REASON.rr : undefined}>geplant {fmtRatio(row.avgPlannedRR)}</div>
            </div>

            <div style={{ textAlign: 'right', color: 'var(--txt2)' }} title={row.lastTradeAt === null ? REASON.lastTrade : undefined}>
              {fmtBerlinDateTime(row.lastTradeAt)}
            </div>

            <div style={{ textAlign: 'right', color: 'var(--txt2)' }}>{row.openCount}</div>
          </div>
        );
      })}
    </div>
  );
}

function InfoDot({ text }) {
  return <span title={text} style={{ color: 'var(--txt3)', cursor: 'help', fontSize: 10 }}>ⓘ</span>;
}

function StrategyCard({ row, symbolLabel, sourceLabel, onOpen, onOpenDetail }) {
  const path = buildSparklinePath(row.pnlSeries, 100, 28);
  const hitText = row.wins + row.losses > 0 ? `von ${row.wins + row.losses} Trades` : 'keine Trades';
  return (
    <button
      onClick={() => onOpen(row.strategyId)}
      style={{
        all: 'unset', cursor: 'pointer', background: 'var(--panel)', border: '1px solid var(--line)',
        padding: 14, display: 'flex', flexDirection: 'column', gap: 10, boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <StrategyNameButton
            name={row.name}
            active={row.active}
            onClick={(e) => { e.stopPropagation(); onOpenDetail(row.strategyId); }}
            style={{ fontSize: 12, fontWeight: 700, display: 'block' }}
          />
          <div style={{ fontSize: 9, color: 'var(--txt3)', marginTop: 2, fontFamily: "'IBM Plex Mono',monospace" }}>{symbolLabel}</div>
        </div>
        <div style={{ fontSize: 9, letterSpacing: '0.05em', color: 'var(--txt2)', border: '1px solid var(--line2)', padding: '2px 6px', textTransform: 'uppercase', flexShrink: 0 }}>
          {sourceLabel}
        </div>
      </div>

      {row.lowData && row.tradeCount > 0 && <div style={{ fontSize: 9, color: 'var(--txt3)' }}>Noch wenig Daten</div>}

      <div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--txt)' }}>{fmtUsd(row.pnlTotalUsd, 0)}</div>
        <div style={{ fontSize: 10, color: 'var(--txt3)' }}>Gewinn gesamt</div>
      </div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt)' }} title={row.winRate === null ? REASON.winRate : undefined}>
          {fmtPct(row.winRate)} <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--txt3)' }}>({hitText})</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--txt3)' }}>Trefferquote</div>
      </div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt)' }}>{fmtUsd(row.avgPnlUsd)}</div>
        <div style={{ fontSize: 10, color: 'var(--txt3)' }}>Im Schnitt pro Trade</div>
      </div>

      {path && (
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" style={{ width: '100%', height: 28 }}>
          <path d={path} fill="none" stroke="var(--txt2)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        </svg>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, color: 'var(--txt2)', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Expectancy <InfoDot text="Erwarteter Gewinn/Verlust pro Trade im Schnitt." />
          </span>
          <span title={row.expectancyUsd === null ? REASON.winRate : undefined}>{fmtUsd(row.expectancyUsd)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Ø RR <InfoDot text="Wie viel im Schnitt im Verhältnis zum eingegangenen Risiko gewonnen/verloren wurde." />
          </span>
          <span title={row.avgRealizedRR === null ? REASON.rr : undefined}>{fmtR(row.avgRealizedRR)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <span>Letzter Trade</span>
          <span title={row.lastTradeAt === null ? REASON.lastTrade : undefined}>{fmtBerlinDateTime(row.lastTradeAt)}</span>
        </div>
        {row.openCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
            <span>Offen</span>
            <span>{row.openCount}</span>
          </div>
        )}
      </div>
    </button>
  );
}

export default function Auswertung() {
  const [source, setSource] = useState('live');
  const [range, setRange] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [symbol, setSymbol] = useState('');
  const [sort, setSort] = useState({ key: 'expectancyUsd', dir: 'desc' });
  const [view, setViewState] = useState(readInitialView);
  const [highlightedStrategyId, setHighlightedStrategyId] = useState(null);
  const [openStrategyId, setOpenStrategyId] = useState(
    () => new URLSearchParams(window.location.search).get('strategy') || null
  );
  const rowRefs = useRef({});

  const openStrategyDetail = useCallback((strategyId) => {
    setOpenStrategyId(strategyId);
    const url = new URL(window.location.href);
    url.searchParams.set('strategy', strategyId);
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, []);
  const closeStrategyDetail = useCallback(() => {
    setOpenStrategyId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('strategy');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, []);

  const setView = useCallback((v) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // per-viewer convenience only — not fatal if storage is blocked.
    }
    const url = new URL(window.location.href);
    if (v === 'cards') url.searchParams.set('view', 'cards');
    else url.searchParams.delete('view');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, []);

  // Keep the URL in sync even when the initial view came from localStorage
  // (not the URL itself) — otherwise a freshly-loaded card view has nothing
  // to share until the user clicks the toggle once.
  useEffect(() => {
    if (view !== 'cards') return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('view') === 'cards') return;
    url.searchParams.set('view', 'cards');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    // Mount-only: this reflects the initial view, later changes go through setView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSort = useCallback((key) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  }, []);

  const focusStrategyRow = useCallback((strategyId) => {
    setView('table');
    setHighlightedStrategyId(strategyId);
  }, [setView]);

  const strategiesQ = useFetch(fetchStrategies, []);
  const strategyMeta = useMemo(() => {
    const map = new Map();
    (Array.isArray(strategiesQ.data) ? strategiesQ.data : []).forEach((s) => map.set(s.id, s));
    return map;
  }, [strategiesQ.data]);

  const customRangeReady = range !== 'custom' || (!!customFrom && !!customTo);
  const loadStats = useCallback(() => {
    if (!customRangeReady) return Promise.resolve({ rows: [], generatedAt: null });
    return fetchStrategyStats({ source, range, from: customFrom, to: customTo, symbol: symbol || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, range, customFrom, customTo, symbol, customRangeReady]);
  const statsQ = useFetch(loadStats, [loadStats]);

  const rows = useMemo(() => statsQ.data?.rows ?? [], [statsQ.data]);
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareByField(a, b, sort.key, sort.dir)),
    [rows, sort]
  );

  // Scroll the highlighted row into view once the table is actually showing
  // it (after a card click switches the view), then clear the highlight.
  useEffect(() => {
    if (view !== 'table' || !highlightedStrategyId) return undefined;
    const el = rowRefs.current[highlightedStrategyId];
    if (!el) return undefined;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => setHighlightedStrategyId(null), 1500);
    return () => clearTimeout(t);
  }, [view, highlightedStrategyId, sortedRows]);

  const sourceLabel = SOURCE_OPTIONS.find((o) => o.key === source)?.label ?? source;
  const rangeLabel = RANGE_OPTIONS.find((o) => o.key === range)?.label ?? range;

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--line)', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div style={{ background: 'var(--panel)', display: 'flex', alignItems: 'center', padding: '11px 16px', gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Auswertung</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt3)' }}>
          {statsQ.data ? `${rows.length} Strategien` : 'Lade Daten…'}
        </div>
        <div style={{ display: 'flex', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
          <button onClick={() => setView('table')} style={segBtn(view === 'table', true)}>TABELLE</button>
          <button onClick={() => setView('cards')} style={segBtn(view === 'cards')}>KACHELN</button>
        </div>
      </div>

      <div style={{ background: 'var(--panel)', display: 'flex', alignItems: 'center', gap: 14, padding: '8px 14px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Quelle</div>
        <div style={{ display: 'flex', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
          {SOURCE_OPTIONS.map((o, i) => (
            <button key={o.key} onClick={() => setSource(o.key)} style={segBtn(source === o.key, i === 0)}>{o.label.toUpperCase()}</button>
          ))}
        </div>
        <div style={{ width: 1, height: 16, background: 'var(--line)' }} />
        <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Zeitraum</div>
        <div style={{ display: 'flex', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
          {RANGE_OPTIONS.map((o, i) => (
            <button key={o.key} onClick={() => setRange(o.key)} style={segBtn(range === o.key, i === 0)}>{o.label.toUpperCase()}</button>
          ))}
        </div>
        {range === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
            <input
              type="date" value={customFrom} max={customTo || todayBerlinDateStr()}
              onChange={(e) => setCustomFrom(e.target.value)}
              style={{ fontFamily: 'inherit', fontSize: 10, padding: '3px 6px', background: 'var(--panel3)', border: `1px solid ${customFrom ? 'var(--acc)' : 'var(--line2)'}`, color: 'var(--txt)' }}
            />
            <span style={{ color: 'var(--txt3)' }}>–</span>
            <input
              type="date" value={customTo} min={customFrom || undefined} max={todayBerlinDateStr()}
              onChange={(e) => setCustomTo(e.target.value)}
              style={{ fontFamily: 'inherit', fontSize: 10, padding: '3px 6px', background: 'var(--panel3)', border: `1px solid ${customTo ? 'var(--acc)' : 'var(--line2)'}`, color: 'var(--txt)' }}
            />
          </div>
        )}
        <div style={{ width: 1, height: 16, background: 'var(--line)' }} />
        <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--txt3)', textTransform: 'uppercase' }}>Symbol</div>
        <select
          value={symbol} onChange={(e) => setSymbol(e.target.value)}
          style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: '4px 6px', background: 'var(--panel3)', border: `1px solid ${symbol ? 'var(--acc)' : 'var(--line2)'}`, color: 'var(--txt)' }}
        >
          <option value="">ALLE</option>
          {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <StatusPanel loading={statsQ.loading} error={statsQ.error} onRetry={statsQ.reload} />

      {!statsQ.loading && !statsQ.error && rows.length === 0 && (
        <div style={{ background: 'var(--panel)', padding: '14px 16px', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--txt2)' }}>
          {REASON.noTrades}
        </div>
      )}

      {!statsQ.loading && !statsQ.error && rows.length > 0 && (
        <div style={{ background: 'var(--panel)', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {view === 'table' ? (
            <StatsTable
              rows={sortedRows} sort={sort} onSort={handleSort} rowRefs={rowRefs}
              highlightedStrategyId={highlightedStrategyId} onOpenDetail={openStrategyDetail}
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10, padding: 14, overflow: 'auto' }}>
              {sortedRows.map((row) => (
                <StrategyCard
                  key={row.strategyId}
                  row={row}
                  sourceLabel={sourceLabel}
                  symbolLabel={symbol || (strategyMeta.get(row.strategyId)?.asset_classes ?? []).join(' · ') || '–'}
                  onOpen={focusStrategyRow}
                  onOpenDetail={openStrategyDetail}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {openStrategyId && (
        <StrategyDetailModal
          strategyId={openStrategyId}
          strategyName={rows.find((r) => r.strategyId === openStrategyId)?.name}
          source={source}
          sourceLabel={sourceLabel}
          range={range}
          rangeLabel={rangeLabel}
          customFrom={customFrom}
          customTo={customTo}
          onClose={closeStrategyDetail}
        />
      )}
    </div>
  );
}
