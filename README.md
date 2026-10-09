# LaPrint V2

Telegram-native Autopilot / Manual trading terminal foundation.

## Built
- First-time /start onboarding
- Autopilot and Manual mode
- Mandatory Buy Amount, TP, SL, filters and alerts
- Balanced two-column Telegram keyboards
- Smart filter defaults
- No random scanner DMs
- Mandatory trade milestone alert policy
- Persistent zero-balance notification guard
- Main menu and stop-trading confirmation
- PostgreSQL user state
- No fake balances, positions or execution success

## Not connected yet
- Real wallet adapter
- Solana scanner
- Execution engine
- Position/PnL stream
- Live filter evaluator

## Environment
BOT_TOKEN=Telegram bot token
DATABASE_URL=PostgreSQL connection string
ENGINE_MODE=disabled or live

## Deploy
Railway: deploy this repository, add BOT_TOKEN and DATABASE_URL, keep ENGINE_MODE=disabled until the real adapters are connected, then use npm start.

The Telegram UI is intentionally built first so the execution layer can be connected without changing the user flow.

## Engine foundation

- Birdeye new-listing discovery worker with persisted candidates
- Strategy-based qualification with explicit rejection reasons
- PostgreSQL engine candidate, event, and position tables
- Jupiter quote + transaction-build + simulation + guarded broadcast adapter
- Selected multi-wallet signer integration
- Telegram engine monitoring starts without claiming that orders are executing

### Engine environment

Set `BIRDEYE_API_KEY` and `SOLANA_RPC_URL` to enable the discovery worker. Set `JUPITER_API_KEY` to configure the Jupiter adapter. The live transaction adapter additionally requires all of the following:
- `ENGINE_MODE=enabled`
- `LIVE_TRADING=true`
- `LIVE_TRADING_ACK=I_ACCEPT_REAL_SOLANA_TRANSACTIONS`
- `LIVE_TRADING_SIMULATION_ONLY=false`

**Important:** automatic entry scheduling, token-account reconciliation, automated sell execution, and realized/unrealized PnL reconciliation are not yet complete. The engine must remain in discovery/monitoring mode until those modules are implemented and tested. Do not enable live trading based on this foundation alone.

## Shared web terminal

The same Node process can serve the La-Print web terminal alongside the Telegram bot. The web terminal reads the existing PostgreSQL user, wallet-public-address, strategy, position, and engine-activity records; it does not create a second trading account or trading engine.

### Web terminal environment

- `BOT_USERNAME`: Telegram bot username without the `@` sign. Configure the Telegram Login Widget domain in BotFather for the deployed web domain.
- `WEB_SESSION_SECRET`: a random secret of at least 32 characters used to sign HttpOnly web sessions.
- `PORT`: supplied by Railway or another host; defaults to 3000 locally.
- `SOLANA_RPC_URL`: optional for live SOL balance display. If missing or unavailable, balances are shown as unavailable rather than invented.

After deploying, open the service's public URL. Sign in using the same Telegram account that completed La-Print onboarding. The server verifies Telegram's signed login payload and maps the account to the existing `telegram_id`; it never accepts a Telegram ID supplied by the browser as identity. The web API only returns public wallet addresses and account/position settings; encrypted wallet secrets and private keys are never returned to the browser.

**Current scope:** account dashboard plus validated shared strategy edits (profile, buy amount, stop loss, and trailing-stop toggle). Edits use the same strategy save path as Telegram, including strategy versioning and the existing `strategy_changed` admin event. Web buy/sell actions are not enabled yet. The repository documents that automated entry scheduling and position reconciliation are still incomplete, so live web trading must not be enabled until those paths are completed and tested. `src/admin-notifications.ts` is unchanged; the existing wallet notification flow is untouched.
