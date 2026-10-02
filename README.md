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
