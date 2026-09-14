import { useCallback, useMemo } from 'react';
import { fetchStrategies, fetchBacktestRuns } from '../api/client';
import { useFetch } from '../api/useFetch';
import StatusPanel from '../api/StatusPanel';
import { StrategyStatsHeaderRow, StrategyStatsRow } from '../components/StrategyStatsTable';
import { toStrategyStatRow } from './Dashboard';

// Full-page listing of all 22 strategies with their metrics — same table
// building blocks as Dashboard's "Strategie-Statistik" widget
// (src/components/StrategyStatsTable.jsx), just untruncated and with the
// winrate column turned on. See StrategyStatsTable.jsx's header comment for
// why winrate is never colored green/red here, unlike the other columns.
export default function Auswertung() {
  const loadStrategyStats = useCallback(
    () => Promise.all([fetchStrategies(), fetchBacktestRuns()]),
    []
  );
  const strategyStatsQ = useFetch(loadStrategyStats, [loadStrategyStats]);
  const strategyStats = useMemo(() => {
    if (!strategyStatsQ.data) return [];
    const [strategies, backtestRuns] = strategyStatsQ.data;
    return strategies.map(s => toStrategyStatRow(s, backtestRuns));
  }, [strategyStatsQ.data]);

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--line)', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div style={{ background: 'var(--panel)', display: 'flex', alignItems: 'center', padding: '11px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Auswertung</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: 'var(--txt3)' }}>
          {strategyStatsQ.data ? `${strategyStats.length} Strategien` : 'Lade Daten…'}
        </div>
      </div>

      <StatusPanel loading={strategyStatsQ.loading} error={strategyStatsQ.error} onRetry={strategyStatsQ.reload} />

      {!strategyStatsQ.loading && !strategyStatsQ.error && (
        <div style={{ background: 'var(--panel)', flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflow: 'auto' }}>
            <StrategyStatsHeaderRow showWinrate minWidth={570} />
            {strategyStats.map(s => (
              <StrategyStatsRow key={s.id} row={s} showWinrate minWidth={570} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
