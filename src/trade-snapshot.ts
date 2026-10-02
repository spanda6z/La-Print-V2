import { getSavedStrategyConfig, StrategyConfig } from "./settings-v2";
import { getActiveTradingWallet } from "./multi-wallets";

export async function snapshotStrategyForEntry(pool: any, telegramId: number): Promise<{ id: string; config: StrategyConfig }> {
  const config = await getSavedStrategyConfig(pool, telegramId);
  const wallet = await getActiveTradingWallet(pool, telegramId);
  if (!wallet) throw new Error("No active trading wallet is selected.");
  const snapshot = { ...config, wallet: { id: wallet.id, name: wallet.name, publicKey: wallet.publicKey } };
  const r = await pool.query(
    `INSERT INTO public.trade_config_snapshots(telegram_id,strategy_profile,strategy_version,config)
     VALUES($1,$2,$3,$4)
     RETURNING id`,
    [telegramId, config.profile, config.version, JSON.stringify(snapshot)]
  );
  return { id: String(r.rows[0].id), config };
}

export async function getTradeSnapshot(pool: any, snapshotId: string) {
  const r = await pool.query(
    "SELECT id,telegram_id,strategy_profile,strategy_version,config,created_at FROM public.trade_config_snapshots WHERE id=$1",
    [snapshotId]
  );
  return r.rows[0] || null;
}
