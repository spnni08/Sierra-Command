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
  source TEXT NOT NULL CHECK (source IN ('binance_testnet','binance_live','oanda_demo','oanda_live')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  pnl REAL,
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
-- Obviously-fake rows (TEST- prefixed strategy names) used to exercise the
-- /api/* routes end to end before real signal/trade generation exists.
-- Fixed IDs + INSERT OR IGNORE keep this idempotent: safe to re-run on every
-- deploy (this file runs unconditionally in worker-deploy.yml).

INSERT OR IGNORE INTO strategies (id, name, asset_classes, active, factor_definition, created_at, updated_at) VALUES
  ('seed-strat-1', 'TEST-MOMENTUM', '["BTCUSDT","ETHUSDT"]', 1, '{"factors":["ema_cross","volume_spike"]}', '2026-09-01 08:00:00', '2026-09-01 08:00:00'),
  ('seed-strat-2', 'TEST-BREAKOUT', '["SOLUSDT"]', 1, '{"factors":["range_break","volume_spike","atr_band"]}', '2026-09-01 08:05:00', '2026-09-01 08:05:00'),
  ('seed-strat-3', 'TEST-TREND', '["EURUSD","SPX500"]', 0, '{"factors":["ema_slope"]}', '2026-09-01 08:10:00', '2026-09-01 08:10:00');

INSERT OR IGNORE INTO strategy_settings (strategy_id, risk_per_trade_pct, session_filter, correlation_limit, news_filter_threshold) VALUES
  ('seed-strat-1', 0.8, '["eu","us"]', 0.85, 0.5),
  ('seed-strat-2', 1.0, '[]', 0.75, 0.6),
  ('seed-strat-3', 0.5, '["eu"]', 0.9, 0.3);

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
  ('seed-bt-1', 'seed-strat-1', 'BTCUSDT', '2024-09-01', '2026-09-01', 1.38, 2.04, -0.094, 1.74, -0.112, '2026-09-02 09:00:00'),
  ('seed-bt-2', 'seed-strat-2', 'SOLUSDT', '2024-09-01', '2026-09-01', 1.61, 2.21, -0.078, 1.91, -0.084, '2026-09-02 09:05:00'),
  ('seed-bt-3', 'seed-strat-3', 'SPX500', '2024-09-01', '2026-09-01', 0.92, 1.30, -0.132, 1.28, -0.145, '2026-09-02 09:10:00');
