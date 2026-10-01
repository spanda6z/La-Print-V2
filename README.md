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
