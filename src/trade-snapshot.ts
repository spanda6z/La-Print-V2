import { getSavedStrategyConfig, StrategyConfig } from "./settings-v2";

export async function snapshotStrategyForEntry(pool: any, telegramId: number): Promise<{ id: string; config: StrategyConfig }> {
  const config = await getSavedStrategyConfig(pool, telegramId);
  const r = await pool.query(
    `INSERT INTO public.trade_config_snapshots(telegram_id,strategy_profile,strategy_version,config)
     VALUES($1,$2,$3,$4)
     RETURNING id`,
    [telegramId, config.profile, config.version, JSON.stringify(config)]
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
