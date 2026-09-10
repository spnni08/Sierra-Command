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
  source TEXT NOT NULL CHECK (source IN ('kraken_demo','kraken_live','oanda_demo','oanda_live')),
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
CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('kraken','oanda')),
  env TEXT NOT NULL CHECK (env IN ('demo','live')),
  encrypted_key TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_credentials_provider_env ON api_credentials(provider, env);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('system','kraken','oanda')),
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  related_trade_id TEXT REFERENCES trades(id)
);
CREATE INDEX IF NOT EXISTS idx_activity_log_source ON activity_log(source);
CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_activity_log_related_trade_id ON activity_log(related_trade_id);
