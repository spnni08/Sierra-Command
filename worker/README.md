# Sierra Command Worker

Cloudflare Worker + D1 backend for Sierra Command, on a separate Cloudflare
account from WAVESCOUT (so D1's daily quota isn't shared).

## Deployed at

`https://sierra-command-worker.vinhehemar.workers.dev`

## Endpoints (GET-only, no order execution yet)

- `GET /health` — service status check
- `GET /binance/candles?symbol=BTCUSDT&interval=1h&limit=100` — Binance
  Futures Testnet OHLC candles (`/fapi/v1/klines`)
- `GET /binance/account-status` — signed Futures Testnet account summary
  (`/fapi/v2/account`); returns `{"status":"not_configured"}` until
  `BINANCE_TESTNET_API_KEY`/`BINANCE_TESTNET_API_SECRET` are set
- `GET /oanda/candles?instrument=EUR_USD&granularity=H1&count=100` —
  OANDA practice-account candles; `not_configured` until `OANDA_API_TOKEN`
  is set
- `GET /oanda/account-status` — OANDA practice account summary;
  `not_configured` until `OANDA_API_TOKEN`/`OANDA_ACCOUNT_ID` are set

## Deploy

Deploys automatically via `.github/workflows/worker-deploy.yml` on every
push to `main` touching `worker/**` (or manually via that workflow's
`workflow_dispatch` trigger in the Actions tab). Authenticated solely with
the `CLOUDFLARE_API_TOKEN` repository secret — no interactive
`wrangler login` involved.

Secrets (`CREDENTIALS_ENCRYPTION_KEY`, `BINANCE_TESTNET_API_KEY`/`SECRET`,
`OANDA_API_TOKEN`/`OANDA_ACCOUNT_ID`) are managed as GitHub Actions repo
secrets and synced into the Worker by that same workflow — see
`wrangler.toml` for the full list.
