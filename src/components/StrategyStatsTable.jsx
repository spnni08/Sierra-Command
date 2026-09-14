// Shared strategy-stats table building blocks — used by Dashboard's
// truncated widget and the full Auswertung page, so both stay visually and
// behaviorally identical rather than maintaining two markup copies.
//
// Column layout: name/symbol/profit-factor/sharpe/max-drawdown always;
// winrate is opt-in via `showWinrate` since Dashboard's compact widget
// doesn't have room for it.
const BASE_COLUMNS = '1fr 90px 90px 90px 90px';
const WITH_WINRATE_COLUMNS = '1fr 90px 90px 90px 90px 90px';

export function strategyStatsGridColumns(showWinrate) {
  return showWinrate ? WITH_WINRATE_COLUMNS : BASE_COLUMNS;
}

export function StrategyStatsHeaderRow({ showWinrate, minWidth }) {
  const gridTemplateColumns = strategyStatsGridColumns(showWinrate);
  return (
    <div style={{ display: 'grid', gridTemplateColumns, padding: '4px 12px', color: 'var(--txt3)', borderBottom: '1px solid var(--line)', minWidth, position: 'sticky', top: 0, background: 'var(--panel)' }}>
      <div>STRATEGIE</div><div>SYMBOL</div><div style={{ textAlign: 'right' }}>PROFIT-F.</div><div style={{ textAlign: 'right' }}>SHARPE</div><div style={{ textAlign: 'right' }}>MAX. DD</div>
      {showWinrate && <div style={{ textAlign: 'right' }}>WINRATE</div>}
    </div>
  );
}

// IMPORTANT design rule: winrate is deliberately rendered as plain/neutral
// text (var(--txt2)), never colored green/red like the other metrics —
// winrate alone can mislead when real PnL is what actually matters.
export function StrategyStatsRow({ row, showWinrate, minWidth }) {
  const gridTemplateColumns = strategyStatsGridColumns(showWinrate);
  return (
    <div style={{ display: 'grid', gridTemplateColumns, padding: '5px 12px', borderBottom: '1px solid var(--line)', minWidth }}>
      <div style={{ color: row.active ? 'var(--txt)' : 'var(--txt3)' }}>{row.name}</div>
      <div style={{ color: 'var(--txt2)' }}>{row.symbol}</div>
      <div style={{ textAlign: 'right' }}>{row.profitFactor}</div>
      <div style={{ textAlign: 'right' }}>{row.sharpe}</div>
      <div style={{ textAlign: 'right', color: 'var(--acc)' }}>{row.maxDrawdown}</div>
      {showWinrate && <div style={{ textAlign: 'right', color: 'var(--txt2)' }}>{row.winrate}</div>}
    </div>
  );
}
