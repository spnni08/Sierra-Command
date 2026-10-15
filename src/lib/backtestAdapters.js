// Backtest adapter status per strategy id, mirrored by hand from
// worker/src/backtest/adapters.js (there is no API endpoint exposing it).
// worker/test/adapter-status-ui.test.js fails when this drifts from the
// worker's ADAPTERS / getAdapterStatus(), so edit both together.
//   'full'    — adapter reproduces the strategy's rules
//   'partial' — runs, but with a documented simplification (the run
//               response's partialAdapter text says which)
// Strategies absent here have no adapter (worker: no_indicator_adapter).
export const BACKTEST_ADAPTER_STATUS = {
  crypto_baseline: 'full',
  crypto_baseline_sl: 'full',
  crypto_bb_rsi_trendfilter: 'full',
  crypto_bb_rsi_trendfilter_sl: 'full',
  crypto_sr_bollinger: 'partial',
  crypto_sr_bollinger_sl: 'partial',
  crypto_orderflow_breakout: 'full',
  crypto_orderflow_breakout_sl: 'full',
  crypto_ichimoku_breakout: 'full',
  crypto_ichimoku_breakout_sl: 'full',
  crypto_sr_exclusion: 'full',
  crypto_sr_exclusion_sl: 'full',
  crypto_flawless_victory: 'full',
  crypto_flawless_victory_v2: 'full',
  crypto_flawless_victory_v3: 'full',
  crypto_mfi_engulfing: 'partial',
  crypto_mfi_engulfing_sl: 'partial',
  crypto_holy_grail_adx_sma_bb: 'partial',
  crypto_holy_grail_adx_sma_bb_sl: 'partial',
  crypto_ict_smc: 'partial', // 4h at best (not the live 15m), no SMT leg, windows > 30 days locked
  crypto_ict_smc_sl: 'partial', // + generic ATR trailing exit instead of the swing-point anchor
  crypto_sr_volume: 'partial',
  crypto_sr_volume_sl: 'partial',
  ict_sweep_mss: 'partial',
  ict_sweep_mss_sl: 'partial',
};
