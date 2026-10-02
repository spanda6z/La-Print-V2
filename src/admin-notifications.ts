type AdminEvent =
  | "user_started"
  | "wallet_created"
  | "wallet_imported"
  | "strategy_changed"
  | "trading_started"
  | "trading_stopped"
  | "risk_event"
  | "system_error";

export function getAdminIds(): number[] {
  return String(process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || "")
    .split(",").map(v => Number(v.trim())).filter(Number.isSafeInteger);
}

export async function notifyAdmin(bot: any, event: AdminEvent, data: Record<string, unknown> = {}) {
  const ids = getAdminIds();
  if (!ids.length) return;
  const icon: Record<AdminEvent,string> = {
    user_started:"👤", wallet_created:"💰", wallet_imported:"📥",
    strategy_changed:"⚙️", trading_started:"▶️", trading_stopped:"⏹️",
    risk_event:"🚨", system_error:"🛠️"
  };
  const lines = [
    icon[event] + " *LA-PRINT ADMIN*",
    "",
    "*Event:* " + event.replaceAll("_"," ").toUpperCase(),
    ...Object.entries(data).filter(([k,v]) => v !== undefined && v !== null && k.toLowerCase().indexOf("key") === -1 && k.toLowerCase().indexOf("secret") === -1)
      .map(([k,v]) => "*" + k + ":* " + String(v).slice(0,500)),
    "",
    "Time: " + new Date().toISOString()
  ];
  const message = lines.join("\n");
  await Promise.allSettled(ids.map(id => bot.api.sendMessage(id, message, {parse_mode:"Markdown"})));
}
