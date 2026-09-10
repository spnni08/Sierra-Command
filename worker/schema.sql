-- Sierra Command D1 schema

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  asset_classes TEXT NOT NULL DEFAULT '[]', -- JSON array
  active INTEGER NOT NULL DEFAULT 1,        -- 0/1 bool
  factor_definition TEXT NOT NULL DEFAULT '{}', -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  symbol TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  score REAL NOT NULL,
  factor_state TEXT NOT NULL DEFAULT '{}', -- JSON
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','converted','rejected')),
  -- 'fixed' = static %/R SL+TP from EXIT_CONFIG defaults (or a strategy
  -- override); 'trailing' = the strategy's "(SL)" variant, whose SL trails
  -- a per-strategy anchor (ATR, S&R zone, Bollinger band edge, Kumo edge, or
  -- last HL/LH swing point — see strategies.factor_definition.trailing_anchor).
  exit_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (exit_mode IN ('fixed','trailing')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_strategy_id ON signals(strategy_id);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  signal_id TEXT REFERENCES signals(id),
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  entry REAL NOT NULL,
  sl REAL,
  tp REAL,
  volume REAL NOT NULL,
  -- 'oanda_demo_simulated' = no real OANDA account (KYC was never completed);
  -- fills are simulated against real Alpha Vantage prices — see
  -- worker/src/simulation/execution-engine.js.
  source TEXT NOT NULL CHECK (source IN ('binance_testnet','binance_live','oanda_demo','oanda_live','oanda_demo_simulated')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  pnl REAL,
  -- Mirrors signals.exit_mode at the time this trade was opened: 'fixed'
  -- (static SL/TP) or 'trailing' (SL trails the strategy's anchor — see
  -- worker/src/strategies/*.js EXIT.trailing.anchor per strategy).
  exit_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (exit_mode IN ('fixed','trailing')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_source ON trades(source);
CREATE INDEX IF NOT EXISTS idx_trades_signal_id ON trades(signal_id);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  symbol TEXT NOT NULL,
  timeframe_start TEXT NOT NULL,
  timeframe_end TEXT NOT NULL,
  sharpe REAL,
  sortino REAL,
  max_drawdown REAL,
  profit_factor REAL,
  out_of_sample_deviation REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy_id ON backtest_runs(strategy_id);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_symbol ON backtest_runs(symbol);

CREATE TABLE IF NOT EXISTS strategy_settings (
  strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
  risk_per_trade_pct REAL NOT NULL DEFAULT 1.0,
  session_filter TEXT NOT NULL DEFAULT '[]', -- JSON array
  correlation_limit REAL NOT NULL DEFAULT 0.7,
  news_filter_threshold REAL NOT NULL DEFAULT 0.5
);

-- Credentials are encrypted client-side of the DB (see worker/src/lib/crypto.js);
-- D1 only ever stores ciphertext. See README note below for rationale.
--
-- provider is 'binance' (Futures Testnet for now, live Futures/Spot later) or
-- 'oanda'. Kraken has no public spot demo account and was dropped before this
-- table was ever created in D1 (the only prior deploy failed before running
-- this file), so no migration of existing rows is needed here.
CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('binance','oanda','alphavantage')),
  env TEXT NOT NULL CHECK (env IN ('demo','live')),
  encrypted_key TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_credentials_provider_env ON api_credentials(provider, env);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('system','binance','oanda')),
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  related_trade_id TEXT REFERENCES trades(id)
);
CREATE INDEX IF NOT EXISTS idx_activity_log_source ON activity_log(source);
CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_activity_log_related_trade_id ON activity_log(related_trade_id);

-- Seed / test data ----------------------------------------------------------
-- The 22 WAVESCOUT strategies (11 base + their trailing-SL "(SL)" variants),
-- ported from spnni08/tradingview-bot worker.js STRATEGIES /
-- CANDIDATE_SCORING_DEFAULTS and pinescript/strategies/*.pine. Each base id
-- matches the WAVESCOUT strategy_key 1:1; the "_sl" id is the same signal
-- logic with a trailing stop substituted for the fixed SL/TP (see
-- worker/src/strategies/*.js EXIT.trailing.anchor for the per-strategy
-- anchor — ATR by default, else S&R zone / Bollinger band edge / Kumo edge /
-- last HL-LH swing point per the mapping below).
-- Fixed IDs + INSERT OR IGNORE keep this idempotent: safe to re-run on every
-- deploy (this file runs unconditionally in worker-deploy.yml).

-- Purge the TEST-MOMENTUM/TEST-BREAKOUT/TEST-TREND placeholder strategies
-- from any D1 instance that was already seeded before the 22-strategy
-- migration (INSERT OR IGNORE below never touches pre-existing rows, so a
-- live database would otherwise keep these 3 alongside the 22 real ones).
DELETE FROM strategy_settings WHERE strategy_id IN ('seed-strat-1', 'seed-strat-2', 'seed-strat-3');
DELETE FROM strategies WHERE id IN ('seed-strat-1', 'seed-strat-2', 'seed-strat-3');

INSERT OR IGNORE INTO strategies (id, name, asset_classes, active, factor_definition, created_at, updated_at) VALUES
  ('crypto_baseline', 'Crypto Baseline (RSI+EMA200)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["ema200_trend","rsi_pullback_35_65","ema_dist_sweet_spot_0.5_1.3pct","rsi_dead_zone_avoid"],"trailing_anchor":"atr"}',
    '2026-09-01 08:00:00', '2026-09-01 08:00:00'),
  ('crypto_baseline_sl', 'Crypto Baseline (RSI+EMA200) (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["ema200_trend","rsi_pullback_35_65","ema_dist_sweet_spot_0.5_1.3pct","rsi_dead_zone_avoid"],"trailing_anchor":"atr"}',
    '2026-09-01 08:00:00', '2026-09-01 08:00:00'),

  ('crypto_sr_volume', 'Crypto S&R Volume Profile', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["val_vah_bounce","ema200_trend_filter","reclaim_breakdown_trigger"],"disable_shorts":true,"cooldown_minutes":30,"trailing_anchor":"sr_zone"}',
    '2026-09-01 08:01:00', '2026-09-01 08:01:00'),
  ('crypto_sr_volume_sl', 'Crypto S&R Volume Profile (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["val_vah_bounce","ema200_trend_filter","reclaim_breakdown_trigger"],"disable_shorts":true,"cooldown_minutes":30,"trailing_anchor":"sr_zone"}',
    '2026-09-01 08:01:00', '2026-09-01 08:01:00'),

  ('crypto_orderflow_breakout', 'Crypto Orderflow Breakout', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["range_break_n20","volume_ratio_min_1.5x","edge_buffer_pct","ema200_trend_filter","rsi9_exhaustion_reject"],"cooldown_minutes":30,"risk_pct":0.25,"trailing_anchor":"atr"}',
    '2026-09-01 08:02:00', '2026-09-01 08:02:00'),
  ('crypto_orderflow_breakout_sl', 'Crypto Orderflow Breakout (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["range_break_n20","volume_ratio_min_1.5x","edge_buffer_pct","ema200_trend_filter","rsi9_exhaustion_reject"],"cooldown_minutes":30,"risk_pct":0.25,"trailing_anchor":"atr"}',
    '2026-09-01 08:02:00', '2026-09-01 08:02:00'),

  ('crypto_ichimoku_breakout', 'Crypto Ichimoku Breakout', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["kumo_breakout","adx_min_22","chikou_confirm","volume_ratio_min_1.5x","structure_regime_filter"],"cooldown_minutes":30,"trailing_anchor":"kumo_edge"}',
    '2026-09-01 08:03:00', '2026-09-01 08:03:00'),
  ('crypto_ichimoku_breakout_sl', 'Crypto Ichimoku Breakout (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["kumo_breakout","adx_min_22","chikou_confirm","volume_ratio_min_1.5x","structure_regime_filter"],"cooldown_minutes":30,"trailing_anchor":"kumo_edge"}',
    '2026-09-01 08:03:00', '2026-09-01 08:03:00'),

  ('crypto_sr_bollinger', 'Crypto S&R Bollinger Bounce', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["bb_20_2_band_touch","ema200_trend_context"],"shorts_default_off":true,"trailing_anchor":"bollinger_band_edge"}',
    '2026-09-01 08:04:00', '2026-09-01 08:04:00'),
  ('crypto_sr_bollinger_sl', 'Crypto S&R Bollinger Bounce (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["bb_20_2_band_touch","ema200_trend_context"],"shorts_default_off":true,"trailing_anchor":"bollinger_band_edge"}',
    '2026-09-01 08:04:00', '2026-09-01 08:04:00'),

  ('crypto_sr_exclusion', 'Crypto S&R Exclusion Filter', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["sr_zone_touch_no_volume","rsi_trend_bounce_direction","negative_score_no_atr_spike","negative_score_no_thin_volume","negative_score_rsi_not_opposite_extreme","negative_score_cooldown_elapsed"],"threshold":60,"trailing_anchor":"sr_zone"}',
    '2026-09-01 08:05:00', '2026-09-01 08:05:00'),
  ('crypto_sr_exclusion_sl', 'Crypto S&R Exclusion Filter (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["sr_zone_touch_no_volume","rsi_trend_bounce_direction","negative_score_no_atr_spike","negative_score_no_thin_volume","negative_score_rsi_not_opposite_extreme","negative_score_cooldown_elapsed"],"threshold":60,"trailing_anchor":"sr_zone"}',
    '2026-09-01 08:05:00', '2026-09-01 08:05:00'),

  ('crypto_ict_smc', 'Crypto ICT/SMC', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["htf_zone_touch","bos_ob_smt_min_confirmations_2"],"trailing_anchor":"swing_point"}',
    '2026-09-01 08:06:00', '2026-09-01 08:06:00'),
  ('crypto_ict_smc_sl', 'Crypto ICT/SMC (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["htf_zone_touch","bos_ob_smt_min_confirmations_2"],"trailing_anchor":"swing_point"}',
    '2026-09-01 08:06:00', '2026-09-01 08:06:00'),

  ('crypto_flawless_victory', 'Crypto Flawless Victory', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["bb_rsi_mfi_cross_trigger","version_v1_v2_v3","optional_htf_trend_filter"],"trailing_anchor":"atr"}',
    '2026-09-01 08:07:00', '2026-09-01 08:07:00'),
  ('crypto_flawless_victory_sl', 'Crypto Flawless Victory (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["bb_rsi_mfi_cross_trigger","version_v1_v2_v3","optional_htf_trend_filter"],"trailing_anchor":"atr"}',
    '2026-09-01 08:07:00', '2026-09-01 08:07:00'),

  ('crypto_mfi_engulfing', 'Crypto MFI Engulfing', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["mfi14_extreme_10_90","filtered_engulfing_pattern"],"trailing_anchor":"atr"}',
    '2026-09-01 08:08:00', '2026-09-01 08:08:00'),
  ('crypto_mfi_engulfing_sl', 'Crypto MFI Engulfing (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["mfi14_extreme_10_90","filtered_engulfing_pattern"],"trailing_anchor":"atr"}',
    '2026-09-01 08:08:00', '2026-09-01 08:08:00'),

  ('crypto_holy_grail_adx_sma_bb', 'Crypto Holy Grail ADX/SMA/BB', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["adx14_min_25_trending","sma20_bb_0.25_pullback_zone","candle_pattern_hammer_engulfing_doji"],"trailing_anchor":"atr"}',
    '2026-09-01 08:09:00', '2026-09-01 08:09:00'),
  ('crypto_holy_grail_adx_sma_bb_sl', 'Crypto Holy Grail ADX/SMA/BB (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["adx14_min_25_trending","sma20_bb_0.25_pullback_zone","candle_pattern_hammer_engulfing_doji"],"trailing_anchor":"atr"}',
    '2026-09-01 08:09:00', '2026-09-01 08:09:00'),

  ('crypto_bb_rsi_trendfilter', 'Crypto BB Trendfilter RSI', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["bb200_0.2_trend_filter","rsi3_cross_80_20"],"trailing_anchor":"atr"}',
    '2026-09-01 08:10:00', '2026-09-01 08:10:00'),
  ('crypto_bb_rsi_trendfilter_sl', 'Crypto BB Trendfilter RSI (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["bb200_0.2_trend_filter","rsi3_cross_80_20"],"trailing_anchor":"atr"}',
    '2026-09-01 08:10:00', '2026-09-01 08:10:00');

INSERT OR IGNORE INTO strategy_settings (strategy_id, risk_per_trade_pct, session_filter, correlation_limit, news_filter_threshold) VALUES
  ('crypto_baseline', 1.0, '[]', 0.7, 0.5),
  ('crypto_baseline_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_sr_volume', 1.0, '[]', 0.7, 0.5),
  ('crypto_sr_volume_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_orderflow_breakout', 0.25, '[]', 0.7, 0.5),
  ('crypto_orderflow_breakout_sl', 0.25, '[]', 0.7, 0.5),
  ('crypto_ichimoku_breakout', 1.0, '[]', 0.7, 0.5),
  ('crypto_ichimoku_breakout_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_sr_bollinger', 1.0, '[]', 0.7, 0.5),
  ('crypto_sr_bollinger_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_sr_exclusion', 1.0, '[]', 0.7, 0.5),
  ('crypto_sr_exclusion_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_ict_smc', 1.0, '[]', 0.7, 0.5),
  ('crypto_ict_smc_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_flawless_victory', 1.0, '[]', 0.7, 0.5),
  ('crypto_flawless_victory_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_mfi_engulfing', 1.0, '[]', 0.7, 0.5),
  ('crypto_mfi_engulfing_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_holy_grail_adx_sma_bb', 1.0, '[]', 0.7, 0.5),
  ('crypto_holy_grail_adx_sma_bb_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_bb_rsi_trendfilter', 1.0, '[]', 0.7, 0.5),
  ('crypto_bb_rsi_trendfilter_sl', 1.0, '[]', 0.7, 0.5);

INSERT OR IGNORE INTO trades (id, signal_id, symbol, direction, entry, sl, tp, volume, source, status, pnl, opened_at, closed_at) VALUES
  ('seed-trade-1', NULL, 'BTCUSDT', 'long', 64310.00, 63720.00, 66150.00, 0.40, 'binance_testnet', 'open', 200.80, '2026-09-09 11:31:00', NULL),
  ('seed-trade-2', NULL, 'SOLUSDT', 'short', 171.05, 174.20, 162.40, 12.00, 'binance_testnet', 'open', 31.56, '2026-09-09 12:50:00', NULL),
  ('seed-trade-3', NULL, 'EUR_USD', 'long', 1.08210, 1.07850, 1.08900, 5000.00, 'oanda_demo', 'open', -12.40, '2026-09-09 09:05:00', NULL),
  ('seed-trade-4', NULL, 'ETHUSDT', 'long', 3040.00, 2980.00, 3180.00, 0.80, 'binance_testnet', 'closed', 142.10, '2026-09-08 09:40:00', '2026-09-08 11:12:00'),
  ('seed-trade-5', NULL, 'NAS100', 'short', 19320.00, 19410.00, 19150.00, 0.50, 'oanda_live', 'closed', -88.40, '2026-09-08 07:30:00', '2026-09-08 08:15:00'),
  ('seed-trade-6', NULL, 'BTCUSDT', 'long', 63900.00, 63500.00, 64800.00, 0.30, 'binance_testnet', 'closed', 306.75, '2026-09-08 03:10:00', '2026-09-08 06:04:00'),
  ('seed-trade-7', NULL, 'EUR_USD', 'short', 1.08650, 1.08960, 1.08000, 6000.00, 'oanda_demo', 'closed', -41.20, '2026-09-07 20:00:00', '2026-09-08 01:05:00'),
  ('seed-trade-8', NULL, 'SPX500', 'long', 5463.80, 5428.00, 5552.00, 1.00, 'oanda_live', 'open', 186.24, '2026-09-09 08:14:00', NULL);

INSERT OR IGNORE INTO activity_log (id, source, message, timestamp, related_trade_id) VALUES
  ('seed-log-1', 'binance', 'SOL/USD Short 12 eroeffnet - TEST-BREAKOUT', '2026-09-09 14:12:08', 'seed-trade-2'),
  ('seed-log-2', 'system', 'NAS100 Signal verworfen - Spread > Limit', '2026-09-09 14:11:44', NULL),
  ('seed-log-3', 'binance', 'BTC/USD SL nachgezogen 63.980 -> 64.310', '2026-09-09 14:09:20', 'seed-trade-1'),
  ('seed-log-4', 'oanda', 'S&P500 Long 1,0 eroeffnet - TEST-TREND', '2026-09-09 14:04:51', 'seed-trade-8'),
  ('seed-log-5', 'system', 'ETH/USD Faktor 3/7 - unter Schwelle 5', '2026-09-09 13:58:02', NULL),
  ('seed-log-6', 'system', 'Regime-Wechsel erkannt: Trend -> Range (FX)', '2026-09-09 13:47:36', NULL),
  ('seed-log-7', 'binance', 'ETH/USD Long 0,8 geschlossen - TP - +142,10', '2026-09-08 13:22:15', 'seed-trade-4'),
  ('seed-log-8', 'oanda', 'NAS 100 Short 0,5 geschlossen - SL - -88,40', '2026-09-08 12:58:40', 'seed-trade-5'),
  ('seed-log-9', 'system', 'Korrelation BTC/ETH 0,88 > Limit - ETH-Signal unterdrueckt', '2026-09-08 12:31:09', NULL),
  ('seed-log-10', 'binance', 'BTC/USD Long 0,4 eroeffnet - TEST-MOMENTUM', '2026-09-08 11:47:02', 'seed-trade-1'),
  ('seed-log-11', 'system', 'News-Fenster EUR (hoch) - TEST-TREND pausiert 15 min', '2026-09-08 11:20:33', NULL),
  ('seed-log-12', 'oanda', 'EUR/USD Short 0,6 geschlossen - SL - -41,20', '2026-09-08 10:52:18', 'seed-trade-7'),
  ('seed-log-13', 'binance', 'BTC/USD Long 0,3 geschlossen - TP - +306,75', '2026-09-08 10:14:47', 'seed-trade-6'),
  ('seed-log-14', 'system', 'Faktor-Update TEST-BREAKOUT: 4/7 -> 5/7', '2026-09-08 09:41:05', NULL),
  ('seed-log-15', 'oanda', 'S&P500 Long 1,0 eroeffnet - TEST-TREND', '2026-09-08 09:03:52', 'seed-trade-8'),
  ('seed-log-16', 'system', 'Volatilitaet Krypto-Cluster: 78 -> 82', '2026-09-08 08:37:29', NULL),
  ('seed-log-17', 'oanda', 'NAS 100 Long 0,4 geschlossen - TP - +219,80', '2026-09-07 07:58:11', NULL),
  ('seed-log-18', 'system', 'Asia-Session-Filter aktiv - TEST-TREND Signale verworfen', '2026-09-07 07:12:44', NULL),
  ('seed-log-19', 'binance', 'SOL/USD Short 8 eroeffnet - TEST-BREAKOUT', '2026-09-07 06:44:20', NULL),
  ('seed-log-20', 'system', 'Engine-Neustart nach Daten-Feed-Timeout (3s)', '2026-09-07 06:15:07', NULL);

INSERT OR IGNORE INTO backtest_runs (id, strategy_id, symbol, timeframe_start, timeframe_end, sharpe, sortino, max_drawdown, profit_factor, out_of_sample_deviation, created_at) VALUES
  ('seed-bt-1', 'crypto_baseline', 'BTCUSDT', '2024-09-01', '2026-09-01', 1.38, 2.04, -0.094, 1.74, -0.112, '2026-09-02 09:00:00'),
  ('seed-bt-2', 'crypto_orderflow_breakout', 'SOLUSDT', '2024-09-01', '2026-09-01', 1.61, 2.21, -0.078, 1.91, -0.084, '2026-09-02 09:05:00'),
  ('seed-bt-3', 'crypto_ict_smc', 'ETHUSDT', '2024-09-01', '2026-09-01', 0.92, 1.30, -0.132, 1.28, -0.145, '2026-09-02 09:10:00');
