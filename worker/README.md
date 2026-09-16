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
- `GET /alphavantage/candles?symbol=EURUSD&interval=daily` — forex and
  index candles via Alpha Vantage. `symbol` is one of `EURUSD` (forex) or
  `SP500`/`SPX`/`NASDAQ`/`NDX` (index, tracked via the SPY/QQQ ETF proxies
  — Alpha Vantage's free tier has no raw index endpoint). `interval` is
  `daily` (default) or `intraday` (add `intraday_interval`, default
  `60min`). Returns `not_configured` until `ALPHA_VANTAGE_API_KEY` is set.
  Confirmed end-to-end working (secret synced, request/response handling
  correct); the free-tier key is capped at 25 requests/day by Alpha
  Vantage, resetting daily — a `502 alphavantage_api_error` with a `Note`/
  `Information` field is that quota, not a bug.

## TradingView webhooks: `POST /webhook/<strategy-id>`

Signal ingestion for the 22 WAVESCOUT strategies in `src/strategies/` (11
base strategies, each with a fixed-exit key and a trailing-SL `_sl` key —
see `src/strategies/index.js`). Point a TradingView alert at
`/webhook/<strategy-id>` with a JSON payload (`symbol`, `direction`,
`price`/`close`, and whatever indicator fields that strategy's factor
checks read).

**Only one alert per base strategy is needed.** A hit on the fixed-variant
endpoint (e.g. `/webhook/crypto_baseline`) evaluates the signal once and,
if it passes, opens **both** trades in the same call: the fixed-exit trade
(`crypto_baseline`) and the paired trailing-SL trade (`crypto_baseline_sl`,
reusing that variant's already-registered trailing-exit config — ATR for
most strategies, or the per-strategy anchor: `crypto_ict_smc` uses the last
HL/LH swing point, `crypto_sr_bollinger` the Bollinger edge,
`crypto_sr_exclusion` the S&R zone, `crypto_ichimoku_breakout` the Kumo
edge). You no longer need to separately configure a `_sl` alert for these
— see `src/routes/webhook.js`'s `processWebhook` for the fan-out logic.

Exceptions, where a fixed endpoint does **not** fan out and you do still
need your own alert per key:

- `crypto_flawless_victory` (v1) has no SL/TP at all in the original Pine
  source (its only exit is the opposing signal) — there's no `_sl` variant
  to pair with, so `/webhook/crypto_flawless_victory` opens a single
  signal-only-exit trade, unchanged.
- `crypto_flawless_victory_v2` and `_v3` are **not** `_sl` variants of the
  base strategy — they're independently registered strategy keys with
  their own entry/exit logic (a parallel fixed SL/TP bracket alongside the
  signal-close exit). Each needs its own TradingView alert
  (`/webhook/crypto_flawless_victory_v2`, `/webhook/crypto_flawless_victory_v3`)
  if you want to trade them; neither fans out and neither has a `_sl` pair.

Hitting a `_sl` endpoint **directly** (e.g.
`/webhook/crypto_baseline_sl`) still works exactly as before — a single
trailing-exit trade, no fan-out — for backwards compatibility with any
alert still configured that way, but it's no longer the recommended setup;
point new alerts at the fixed endpoint instead.

## Public read-only export: `GET /api/public/trades`

Deliberately separate from the internal `/api/trades` used by Sierra
Command's own frontend — built for external, read-only dashboards (first
consumer: Ground Delta's trade panel, a completely separate project/
Cloudflare account/D1 instance). Returns open trades plus trades closed in
the last 24h, `{ symbol, direction, entry, sl, tp, status, pnl,
strategy_name, opened_at, closed_at }` only — no trade id, no signal_id,
no `source` (which would leak testnet vs. live), no volume, no
credentials.

CORS-allowed for `https://ground-delta-journal.web.app` (and its
`.firebaseapp.com` twin) in `src/cors.js`.

Optional query-token gate via the `PUBLIC_TRADES_TOKEN` secret — if unset,
the endpoint is open to anyone who has the URL (fine for local dev, not
for sharing the URL publicly). Set it with:

```
npx wrangler secret put PUBLIC_TRADES_TOKEN
```

then callers pass `?token=<the same value>`, e.g.
`GET /api/public/trades?token=...`. This is a plain shared secret, not a
per-client credential — rotate it (set a new value, update every
consumer) if it ever leaks, rather than trying to revoke one caller.

## Deploy

Deploys automatically via `.github/workflows/worker-deploy.yml` on every
push to `main` touching `worker/**` (or manually via that workflow's
`workflow_dispatch` trigger in the Actions tab). Authenticated solely with
the `CLOUDFLARE_API_TOKEN` repository secret — no interactive
`wrangler login` involved.

Secrets (`CREDENTIALS_ENCRYPTION_KEY`, `BINANCE_TESTNET_API_KEY`/`SECRET`,
`OANDA_API_TOKEN`/`OANDA_ACCOUNT_ID`, `ALPHA_VANTAGE_API_KEY`) are managed
as GitHub Actions repo secrets and synced into the Worker by that same
workflow — see `wrangler.toml` for the full list. `schema.sql`'s
`api_credentials.provider` column tracks the same three providers
(`binance`/`oanda`/`alphavantage`) for credentials stored in D1, separate
from these Worker-level secrets.

## Known limitation: Binance Futures Testnet blocks this Worker entirely

Both `/binance/candles` (public, unauthenticated market data) and
`/binance/account-status` (signed) are deployed and correct (confirmed:
schema migrated, secrets synced, deploy green), but every request gets a
`403` from Binance Testnet's CloudFront WAF before it reaches Binance's own
API logic — confirmed identically on the public candles endpoint, so this
is not specific to the signed/authenticated call. This isn't a credentials
or signing bug; it's Binance's edge blocking Cloudflare Workers' outbound
IP ranges as generic cloud/datacenter traffic. Confirmed this isn't an IP
allowlist setting on the API key itself (checked in the Binance dashboard
— no restriction configured there).

Deliberately not working around this (e.g. proxying through non-Cloudflare
egress) — that would mean actively evading Binance's bot/abuse protection,
which we're not going to do. Revisit once the *live* Binance integration is
being built: live endpoints may not have the same WAF behavior as testnet,
so re-check there before assuming this still applies.

**Re-tested 2026-09-16** after futures trading was enabled account-side on
the testnet account (no external KYC step involved) — same result. 4
consecutive requests each against the deployed Worker for both
`/binance/candles` and `/binance/account-status`: 8/8 still come back `403`
from CloudFront. The account-side futures permission doesn't change
anything here, since the block happens at CloudFront before the request
reaches Binance's API/account layer at all — it's not gated on what the API
key is allowed to do.
