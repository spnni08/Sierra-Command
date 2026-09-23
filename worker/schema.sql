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
  -- fills are simulated against real Twelve Data prices — see
  -- worker/src/simulation/execution-engine.js.
  source TEXT NOT NULL CHECK (source IN ('binance_testnet','binance_live','oanda_demo','oanda_live','oanda_demo_simulated')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  pnl REAL,
  -- Mirrors signals.exit_mode at the time this trade was opened: 'fixed'
  -- (static SL/TP) or 'trailing' (SL trails the strategy's anchor — see
  -- worker/src/strategies/*.js EXIT.trailing.anchor per strategy).
  exit_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (exit_mode IN ('fixed','trailing')),
  -- The chart timeframe the TradingView alert fired from (e.g. TradingView's
  -- raw {{interval}} codes: '1','5','15','60','240','D','W'), read verbatim
  -- from the webhook payload (routes/webhook.js) — never inferred from
  -- anything else. NULL for trades opened before this column existed, or
  -- whose alert didn't include it; the API/UI show "unbekannt" for NULL,
  -- never guess a value. Raw TradingView codes and the backtest engine's own
  -- human-readable labels ('15m','4h',...) are normalized to a common set
  -- only at query/grouping time (stats/computeStats.js's normalizeTimeframe)
  -- — this column always keeps exactly what was received/computed, nothing
  -- is rewritten on write.
  timeframe TEXT,
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
  win_rate REAL,
  trade_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy_id ON backtest_runs(strategy_id);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_symbol ON backtest_runs(symbol);

-- One row per (backtest_run_id, session) — session breakdown axis alongside
-- backtest_runs' overall winrate/asset-fit metrics. Session classification
-- is worker/src/lib/sessions.js's sessionOf() (real local-market-time
-- windows, DST-aware) via worker/src/backtest/sessions.js's
-- computeSessionBreakdown — every trade lands in exactly one of the 6
-- session values below, so they sum directly to the run's total
-- trade_count with no double-counting correction needed.
CREATE TABLE IF NOT EXISTS backtest_session_breakdown (
  backtest_run_id TEXT NOT NULL REFERENCES backtest_runs(id),
  session TEXT NOT NULL CHECK (session IN ('asia','london','new_york','london_ny_overlap','asia_london_overlap','outside')),
  trade_count INTEGER NOT NULL DEFAULT 0,
  win_rate REAL,
  net_pnl REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (backtest_run_id, session)
);
CREATE INDEX IF NOT EXISTS idx_backtest_session_breakdown_run_id ON backtest_session_breakdown(backtest_run_id);

-- One row per individual simulated trade a backtest run actually opened and
-- closed — unlike backtest_runs (aggregate metrics only: sharpe/profit_
-- factor/win_rate/trade_count), this is what lets /stats/strategies compute
-- exact per-strategy expectancy/realized-RR/wins-losses-breakeven for the
-- "Backtest" source from real numbers instead of estimating them from the
-- aggregate. Written once per trade at the end of backtest/engine.js's
-- runBacktest (see that file — a single env.DB.batch() call, not N
-- sequential awaited inserts). strategy_id is denormalized from
-- backtest_runs.strategy_id (every row here has exactly one parent run, so
-- this never disagrees with it) purely so /stats/strategies can group by
-- strategy without an extra JOIN on every query.
--
-- Every row is fully closed by construction: engine.js force-closes any
-- position still open at the end of the simulated window (reason
-- 'period_end') rather than ever persisting a row mid-trade, so closed_at
-- is NOT NULL here (unlike the live `trades` table, where an open position
-- genuinely has no closed_at yet).
--
-- exit_price IS the real simulated fill price (engine.js's t.exitFill) —
-- kept explicit here because, unlike this table, the live `trades` table
-- doesn't store a fill price at all (only pnl); scripts/lib/logic-
-- invalidation-sql.mjs deletes this table's rows for a strategy alongside
-- backtest_runs/backtest_session_breakdown whenever that strategy's adapter
-- logic actually changes (children before the backtest_runs parent, same
-- FK-ordering reason as backtest_session_breakdown already documents).
CREATE TABLE IF NOT EXISTS backtest_trades (
  id TEXT PRIMARY KEY,
  backtest_run_id TEXT NOT NULL REFERENCES backtest_runs(id),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  entry REAL NOT NULL,
  sl REAL,
  tp REAL,
  exit_price REAL NOT NULL,
  pnl REAL NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('sl','tp','signal','period_end')),
  -- The candle interval this specific trade was actually simulated on (e.g.
  -- '15m','30m','4h','1d','4d') — the backtest engine picks this implicitly
  -- per strategy/symbol/window-length (see backtest/candles.js), so it's
  -- always known and set for every row written from here on. Existing rows
  -- from before this column existed are NULL, shown as "unbekannt" same as
  -- trades.timeframe — never backfilled by guessing.
  timeframe TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backtest_trades_run_id ON backtest_trades(backtest_run_id);
CREATE INDEX IF NOT EXISTS idx_backtest_trades_strategy_id ON backtest_trades(strategy_id);
CREATE INDEX IF NOT EXISTS idx_backtest_trades_closed_at ON backtest_trades(closed_at);

CREATE TABLE IF NOT EXISTS strategy_settings (
  strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
  risk_per_trade_pct REAL NOT NULL DEFAULT 1.0,
  session_filter TEXT NOT NULL DEFAULT '[]', -- JSON array
  correlation_limit REAL NOT NULL DEFAULT 0.7,
  news_filter_threshold REAL NOT NULL DEFAULT 0.5,
  -- Generic per-strategy logic-threshold overrides (JSON object), read by a
  -- strategy's backtest adapter (see backtest/engine.js's runBacktest and
  -- backtest/ictSweepMssAdapter.js's DEFAULT_PARAMS) instead of the fixed
  -- risk/session/correlation/news knobs above, which are auto-trade
  -- position-sizing/risk knobs, not signal-detection logic. Every existing
  -- strategy ignores this column (defaults to '{}', i.e. "use the adapter's
  -- own built-in constants") — introduced for ict_sweep_mss/_sl, whose rules
  -- (swing lookback, ATR multiples, R-multiple minimum, entry mode, ...) are
  -- all meant to be configurable without a code change.
  params_json TEXT NOT NULL DEFAULT '{}'
);

-- One row per strategy that has an entry in backtest/adapters.js's ADAPTERS
-- map, tracking a content hash of that strategy's adapter function (the
-- actual indicator/gate logic a backtest runs against) as of the last
-- deploy. Deliberately does NOT cover strategy_settings (risk_per_trade_pct,
-- session_filter, correlation_limit, news_filter_threshold) — those are
-- auto-trade knobs, not logic, and changing them must never invalidate a
-- strategy's backtest_runs. See worker/scripts/invalidate-backtest-logic.mjs
-- (generates the idempotent SQL run by worker-deploy.yml on every deploy)
-- and worker/src/backtest/adapters.js's header comment for why some
-- strategies never get a row here at all (no adapter => no backtest_runs to
-- ever invalidate).
CREATE TABLE IF NOT EXISTS strategy_logic_versions (
  strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
  logic_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set only when a hash change actually deleted existing backtest_runs
  -- rows for this strategy (see the invalidation script) — distinct from
  -- updated_at, which also moves on the very first hash capture (no prior
  -- runs to invalidate). NULL means "never invalidated"; the frontend uses
  -- this to tell "logic changed, please re-run" apart from "never run yet".
  last_invalidated_at TEXT
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
  provider TEXT NOT NULL CHECK (provider IN ('binance','oanda','coingecko','twelvedata')),
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
  related_trade_id TEXT REFERENCES trades(id),
  -- Caller identity for every row routes/webhook.js writes (both accepted
  -- and rejected calls) — 'damit die Herkunft nachvollziehbar ist': lets a
  -- rejected/unrecognized webhook call be traced back to TradingView vs. an
  -- unexpected sender without ever storing the submitted secret value
  -- itself. NULL for every row written by something other than a webhook
  -- call (existing rows, and this app's own auto-trade/simulation logging),
  -- since there's no inbound request to read headers from there.
  user_agent TEXT,
  source_ip TEXT
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
-- backtest_runs.strategy_id is a NOT NULL FK with no ON DELETE clause, and
-- the original seed data had backtest_runs rows (seed-bt-1/2/3) referencing
-- these placeholder ids — deleting strategies first broke every deploy
-- since this migration landed ("FOREIGN KEY constraint failed", silently
-- failing before `wrangler deploy` ever ran). Clear the dependent rows
-- first.
DELETE FROM backtest_runs WHERE strategy_id IN ('seed-strat-1', 'seed-strat-2', 'seed-strat-3');
DELETE FROM strategy_settings WHERE strategy_id IN ('seed-strat-1', 'seed-strat-2', 'seed-strat-3');
DELETE FROM strategies WHERE id IN ('seed-strat-1', 'seed-strat-2', 'seed-strat-3');

-- seed-bt-1/2/3 were fabricated backtest_runs rows carrying the original
-- design mockup's exact numbers (sharpe 1.38/profit_factor 1.74/max_drawdown
-- -9.4% for crypto_baseline, etc.) — indistinguishable from a real result in
-- the UI once the real backtest engine shipped (PR #31), since the
-- Dashboard's strategy-stats table just reads "latest backtest_runs row per
-- strategy" and these were the only row some strategies had. Purged
-- unconditionally on every deploy, same pattern as the TEST-* strategies
-- above — a real run (see worker/src/backtest/) is the only way a strategy
-- gets a stats row from here on.
DELETE FROM backtest_runs WHERE id IN ('seed-bt-1', 'seed-bt-2', 'seed-bt-3');

-- seed-trade-1..8 and seed-log-1..20 were the same kind of fabricated rows
-- as seed-bt-1/2/3 above, just never caught by that cleanup pass: static
-- trades/activity_log data ported from the original design mockup, still
-- referencing the TEST-MOMENTUM/TEST-BREAKOUT/TEST-TREND placeholder
-- strategy names purged from `strategies` at the top of this file. They sat
-- in the live D1 table with fixed opened_at/closed_at timestamps that only
-- got staler with every day the app ran, and rendered in the Dashboard
-- "Letzte Abschlüsse" widget, Pro-Terminal "Aktuelle Trades" list/Entry-TP-
-- SL row, and the Multi-Chart "Bot-Aktivität" feed as if they were live
-- results. Purged unconditionally on every deploy, same idempotent pattern
-- as above — from here on these tables only ever hold rows written by real
-- trading/simulation activity (see worker/src/simulation/execution-engine.js
-- and worker/src/routes/webhook.js).
DELETE FROM activity_log WHERE id LIKE 'seed-log-%';
DELETE FROM trades WHERE id LIKE 'seed-trade-%';

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
  ('crypto_flawless_victory_v2', 'Crypto Flawless Victory v2', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["bb2_17_1.0_cross_trigger","rsi_guard_only","optional_htf_trend_filter"],"sl_pct":3.5,"tp_pct":5.0,"exit_mode":"signal_or_sltp"}',
    '2026-09-14 08:07:30', '2026-09-14 08:07:30'),
  ('crypto_flawless_victory_v3', 'Crypto Flawless Victory v3', '["BTCUSDT","ETHUSDT","SOLUSDT"]', 1,
    '{"factors":["bb1_20_1.0_cross_trigger","mfi_entry_guard","rsi_and_mfi_exit_guard","optional_htf_trend_filter"],"sl_pct":4.0,"tp_pct":5.5,"exit_mode":"signal_or_sltp"}',
    '2026-09-14 08:07:31', '2026-09-14 08:07:31'),

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
    '2026-09-01 08:10:00', '2026-09-01 08:10:00'),

  -- ict_sweep_mss / ict_sweep_mss_sl — Liquidity Sweep -> Displacement ->
  -- MSS -> FVG -> Entry -> Target (see worker/src/strategies/ictSweepMss.js
  -- and worker/src/backtest/ictSweepMssAdapter.js). Unlike every strategy
  -- above, usable across crypto AND forex/index (this worker's full
  -- ASSET_WINDOW symbol set) — see backtest/window.js.
  ('ict_sweep_mss', 'ICT Sweep -> MSS -> FVG', '["BTCUSDT","ETHUSDT","SOLUSDT","EURUSD","SPX500","NAS100"]', 1,
    '{"factors":["liquidity_sweep","displacement","mss","fvg_present","min_rr_ok","htf_bias_ok"],"exit_mode":"levels","timeframe":"15m"}',
    '2026-09-22 09:00:00', '2026-09-22 09:00:00'),
  ('ict_sweep_mss_sl', 'ICT Sweep -> MSS -> FVG (SL)', '["BTCUSDT","ETHUSDT","SOLUSDT","EURUSD","SPX500","NAS100"]', 1,
    '{"factors":["liquidity_sweep","displacement","mss","fvg_present","min_rr_ok","htf_bias_ok"],"exit_mode":"levels_trailing","timeframe":"15m","trailing_anchor":"swing_point_breakeven_then_trail"}',
    '2026-09-22 09:00:01', '2026-09-22 09:00:01');

-- Deliberately does NOT list params_json here, even though the CREATE TABLE
-- above declares it: on the already-live remote D1, this file's own CREATE
-- TABLE IF NOT EXISTS is a no-op (the table already exists without that
-- column), and this INSERT runs BEFORE worker-deploy.yml's later "Migrate
-- existing table columns" step ever gets a chance to ALTER TABLE ADD COLUMN
-- it in — referencing params_json here would make ALL these INSERTs fail
-- with "no such column" on every deploy until the migration step (which
-- can't run first; it comes after this file in the workflow). Every other
-- column added to an existing table since this file's original seed (exit_
-- mode, win_rate, trade_count) followed the same rule: never referenced in
-- a seed INSERT, only in CREATE TABLE (harmless no-op on remote) and in
-- application code. ict_sweep_mss/_sl's actual params_json defaults are set
-- by a dedicated UPDATE step in worker-deploy.yml instead, which runs after
-- the ALTER TABLE step.
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
  ('crypto_flawless_victory_v2', 1.0, '[]', 0.7, 0.5),
  ('crypto_flawless_victory_v3', 1.0, '[]', 0.7, 0.5),
  ('crypto_mfi_engulfing', 1.0, '[]', 0.7, 0.5),
  ('crypto_mfi_engulfing_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_holy_grail_adx_sma_bb', 1.0, '[]', 0.7, 0.5),
  ('crypto_holy_grail_adx_sma_bb_sl', 1.0, '[]', 0.7, 0.5),
  ('crypto_bb_rsi_trendfilter', 1.0, '[]', 0.7, 0.5),
  ('crypto_bb_rsi_trendfilter_sl', 1.0, '[]', 0.7, 0.5),
  ('ict_sweep_mss', 1.0, '[]', 0.7, 0.5),
  ('ict_sweep_mss_sl', 1.0, '[]', 0.7, 0.5);

-- No seed trades/activity_log/backtest_runs rows here on purpose — see the
-- DELETEs above. From here on these tables only ever hold rows written by
-- real trading/simulation/backtest activity.
