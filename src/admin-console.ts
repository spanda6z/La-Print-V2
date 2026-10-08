import { InlineKeyboard } from "grammy";
import { getAdminIds, notifyAdmin } from "./admin-notifications.js";

type AdminDeps = { bot: any; pool: any; show: Function };

export async function ensureAdminAuditTable(pool: any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.admin_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'INFO',
      telegram_id BIGINT,
      token_address TEXT,
      trade_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      delivery_error TEXT
    );
    CREATE INDEX IF NOT EXISTS admin_events_created_idx ON public.admin_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_events_user_idx ON public.admin_events(telegram_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS public.admin_broadcasts (
      id BIGSERIAL PRIMARY KEY,
      admin_telegram_id BIGINT NOT NULL,
      message_text TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'active',
      total_recipients INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS admin_broadcasts_created_idx ON public.admin_broadcasts(created_at DESC);

    CREATE TABLE IF NOT EXISTS public.admin_broadcast_deliveries (
      id BIGSERIAL PRIMARY KEY,
      broadcast_id BIGINT NOT NULL REFERENCES public.admin_broadcasts(id) ON DELETE CASCADE,
      telegram_id BIGINT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      delivered_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS admin_broadcast_deliveries_broadcast_idx ON public.admin_broadcast_deliveries(broadcast_id);
  `);
}

export async function recordAdminEvent(pool: any, eventType: string, data: Record<string, unknown> = {}, severity = "INFO") {
  try {
    await ensureAdminAuditTable(pool);
    const clean = Object.fromEntries(Object.entries(data).filter(([k]) => !/key|secret|private|seed|mnemonic/i.test(k)));
    const result = await pool.query(
      `INSERT INTO public.admin_events(event_type,severity,telegram_id,token_address,trade_id,payload)
       VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [eventType, severity, clean.telegram_id ?? null, clean.token_address ?? null, clean.trade_id ?? null, JSON.stringify(clean)]
    );
    return result.rows[0]?.id ?? null;
  } catch (error) {
    console.error("[admin] audit write failed", error);
    return null;
  }
}

async function isAdmin(id: number) {
  const adminIds = getAdminIds();
  return adminIds.some(adminId => Number.isSafeInteger(adminId) && adminId === Number(id));
}

function homeKeyboard() {
  return new InlineKeyboard()
    .text("📊 OVERVIEW", "admin:overview").text("👥 USERS", "admin:users").row()
    .text("📢 BROADCAST", "admin:broadcast").text("📋 HISTORY", "admin:history").row()
    .text("⚡ TRADING", "admin:trading").text("🔎 SCANNER", "admin:scanner").row()
    .text("🚨 RISK", "admin:risk").text("🛠 SYSTEM", "admin:system").row()
    .text("🧾 EVENTS", "admin:events").text("❤️ HEALTH", "admin:health").row()
    .text("🏆 MILESTONES", "admin:milestones").text("🔔 TEST", "admin:test").row()
    .text("🏠 MAIN MENU", "menu");
}

function adminBack() {
  return new InlineKeyboard().text("🛡️ ADMIN HOME", "admin:home").row().text("🏠 MAIN MENU", "menu");
}

function userActions(id: string, blocked: boolean) {
  return new InlineKeyboard()
    .text(blocked ? "🟢 ENABLE USER" : "🔴 DISABLE USER", `admin:user:toggle:${id}`)
    .row()
    .text("⬅️ USER SEARCH", "admin:users").text("🛡️ ADMIN HOME", "admin:home");
}

async function sendBroadcast(bot: any, pool: any, adminId: number, messageText: string) {
  const recipients = await pool.query(
    "SELECT telegram_id FROM public.users WHERE COALESCE(admin_blocked,FALSE)=FALSE ORDER BY telegram_id"
  );
  const total = recipients.rows.length;
  const created = await pool.query(
    `INSERT INTO public.admin_broadcasts(admin_telegram_id,message_text,audience,total_recipients)
     VALUES($1,$2,'active',$3) RETURNING id`,
    [adminId, messageText, total]
  );
  const broadcastId = created.rows[0].id;
  let sent = 0;
  let failed = 0;

  for (const row of recipients.rows) {
    const telegramId = Number(row.telegram_id);
    try {
      await bot.api.sendMessage(telegramId, messageText);
      sent++;
      await pool.query(
        "INSERT INTO public.admin_broadcast_deliveries(broadcast_id,telegram_id,status) VALUES($1,$2,'sent')",
        [broadcastId, telegramId]
      );
    } catch (error: any) {
      const retryAfter = Number(error?.parameters?.retry_after || 0);
      if (retryAfter > 0 && retryAfter <= 60) {
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        try {
          await bot.api.sendMessage(telegramId, messageText);
          sent++;
          await pool.query(
            "INSERT INTO public.admin_broadcast_deliveries(broadcast_id,telegram_id,status) VALUES($1,$2,'sent')",
            [broadcastId, telegramId]
          );
          continue;
        } catch (retryError: any) {
          error = retryError;
        }
      }
      failed++;
      const reason = String(error?.description || error?.message || error).slice(0, 500);
      await pool.query(
        "INSERT INTO public.admin_broadcast_deliveries(broadcast_id,telegram_id,status,error) VALUES($1,$2,'failed',$3)",
        [broadcastId, telegramId, reason]
      );
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }

  await pool.query(
    "UPDATE public.admin_broadcasts SET sent_count=$2,failed_count=$3,completed_at=NOW() WHERE id=$1",
    [broadcastId, sent, failed]
  );
  await recordAdminEvent(pool, "admin_broadcast", {
    telegram_id: adminId, broadcast_id: broadcastId, total_recipients: total, sent_count: sent, failed_count: failed
  }, failed ? "WARNING" : "ACTION");
  return { broadcastId, total, sent, failed };
}

export function registerAdminConsole(deps: AdminDeps) {
  const { bot, pool, show } = deps;

  bot.command("admin", async (ctx: any) => {
    if (!(await isAdmin(ctx.from.id))) {
      await ctx.reply(
        "⛔ *ADMIN ACCESS DENIED*\n\n" +
        "Your Telegram ID is not configured as an admin.\n\n" +
        "Telegram ID: `" + ctx.from.id + "`\n\n" +
        "Add this ID to ADMIN_TELEGRAM_ID or ADMIN_TELEGRAM_IDS in Railway, then restart the bot.",
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }
    try {
      await ensureAdminAuditTable(pool);
      await show(ctx, "🛡️ *LA-PRINT ADMIN*\n\nManual control center for the bot. Choose an operation.", {
        parse_mode: "Markdown", reply_markup: homeKeyboard()
      });
    } catch (error) {
      console.error("[admin] open failed", error);
      await ctx.reply(
        "⚠️ *ADMIN PANEL ERROR*\n\nThe bot is running, but the admin panel could not load.\n\nCheck the Railway deployment logs.",
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  });

  bot.callbackQuery(/^admin:/, async (ctx: any) => {
    if (!(await isAdmin(ctx.from.id))) {
      await ctx.answerCallbackQuery("Admin only").catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery();
    const action = ctx.callbackQuery.data.slice(6);
    try {
    await ensureAdminAuditTable(pool);

    if (action === "home") {
      return show(ctx, "🛡️ *LA-PRINT ADMIN*\n\nManual control center for the bot. Choose an operation.", {
        parse_mode: "Markdown", reply_markup: homeKeyboard()
      });
    }

    if (action === "test") {
      await notifyAdmin(bot, "system_error", { message: "Admin console test", telegram_id: ctx.from.id });
      return show(ctx, "🔔 *TEST SENT*\n\nAdmin notification was dispatched.", { parse_mode: "Markdown", reply_markup: adminBack() });
    }

    if (action === "broadcast") {
      (ctx.session as any).adminInput = "broadcast";
      (ctx.session as any).adminBroadcastDraft = undefined;
      return show(ctx,
        "📢 *POST UPDATE*\n\nSend the announcement text as your next message.\n\nNothing will be sent until you preview and confirm it.",
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("❌ CANCEL", "admin:cancel_input") }
      );
    }

    if (action === "cancel_input") {
      (ctx.session as any).adminInput = undefined;
      (ctx.session as any).adminBroadcastDraft = undefined;
      return show(ctx, "🛡️ *ADMIN HOME*\n\nOperation cancelled.", { parse_mode: "Markdown", reply_markup: homeKeyboard() });
    }

    if (action === "confirm_broadcast") {
      const draft = String((ctx.session as any).adminBroadcastDraft || "").trim();
      if (!draft) return show(ctx, "⚠️ No broadcast draft is waiting.", { reply_markup: homeKeyboard() });
      (ctx.session as any).adminInput = undefined;
      (ctx.session as any).adminBroadcastDraft = undefined;
      await show(ctx, "📢 *SENDING UPDATE*\n\nThe announcement is being delivered to registered active users.\n\nPlease wait for the delivery summary.", { parse_mode: "Markdown" });
      const result = await sendBroadcast(bot, pool, ctx.from.id, draft);
      return show(ctx,
        "✅ *UPDATE SENT*\n\n👥 Recipients: " + result.total + "\n🟢 Delivered: " + result.sent + "\n🔴 Failed: " + result.failed + "\n\nThe broadcast was recorded in Admin History.",
        { parse_mode: "Markdown", reply_markup: adminBack() }
      );
    }

    if (action === "users") {
      (ctx.session as any).adminInput = "user_search";
      return show(ctx,
        "👥 *USER MANAGEMENT*\n\nSend a Telegram ID or username to search.\n\nYou can then disable or re-enable the account. Disabled users cannot operate the bot and their trading is stopped.",
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("📋 RECENT USERS", "admin:user_recent").row().text("❌ CANCEL", "admin:cancel_input") }
      );
    }

    if (action === "user_recent") {
      (ctx.session as any).adminInput = undefined;
      const r = await pool.query(
        "SELECT telegram_id,username,trading_active,COALESCE(admin_blocked,FALSE) AS admin_blocked,updated_at FROM public.users ORDER BY updated_at DESC LIMIT 15"
      );
      if (!r.rowCount) return show(ctx, "👥 *USERS*\n\nNo users registered yet.", { parse_mode: "Markdown", reply_markup: adminBack() });
      const lines = r.rows.map((u: any) =>
        "• " + u.telegram_id + " · @" + (u.username || "—") + " · " +
        (u.admin_blocked ? "DISABLED" : u.trading_active ? "TRADING" : "READY")
      );
      return show(ctx, "👥 *RECENT USERS*\n\n" + lines.join("\n") + "\n\nUse User Management search to act on a specific user.", {
        parse_mode: "Markdown", reply_markup: adminBack()
      });
    }

    if (action === "history") {
      const r = await pool.query(
        "SELECT id,admin_telegram_id,audience,total_recipients,sent_count,failed_count,created_at FROM public.admin_broadcasts ORDER BY created_at DESC LIMIT 15"
      );
      if (!r.rowCount) return show(ctx, "📋 *BROADCAST HISTORY*\n\nNo broadcasts yet.", { parse_mode: "Markdown", reply_markup: adminBack() });
      const lines = r.rows.map((b: any) =>
        "• #" + b.id + " · " + new Date(b.created_at).toISOString().replace("T", " ").slice(0, 16) +
        "\n  👥 " + b.total_recipients + " · 🟢 " + b.sent_count + " · 🔴 " + b.failed_count
      );
      return show(ctx, "📋 *BROADCAST HISTORY*\n\n" + lines.join("\n\n"), { parse_mode: "Markdown", reply_markup: adminBack() });
    }

    if (action === "health") {
      const seconds = Math.floor(process.uptime());
      const hh = Math.floor(seconds / 3600);
      const mm = Math.floor((seconds % 3600) / 60);
      const ss = seconds % 60;
      let db = "❌ DOWN";
      try {
        await pool.query("SELECT 1");
        db = "🟢 OK";
      } catch {
        db = "🔴 DOWN";
      }
      const engineMode = String(process.env.ENGINE_MODE || "unknown");
      const liveTrading = String(process.env.LIVE_TRADING || "false");
      return show(ctx,
        "❤️ *SYSTEM HEALTH*\\n\\n" +
        "🤖 Bot: 🟢 ONLINE\\n" +
        "🗄 Database: " + db + "\\n" +
        "⚙️ Engine mode: " + engineMode + "\\n" +
        "💹 Live trading: " + liveTrading + "\\n" +
        "⏱ Uptime: " + hh + "h " + mm + "m " + ss + "s\\n" +
        "🛡️ Admin IDs configured: " + getAdminIds().length,
        { parse_mode: "Markdown", reply_markup: adminBack() }
      );
    }

    if (action === "overview") {
      const r = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM public.users) users,
          (SELECT COUNT(*) FROM public.users WHERE trading_active=true AND COALESCE(admin_blocked,FALSE)=FALSE) active,
          (SELECT COUNT(*) FROM public.wallets) wallets,
          (SELECT COUNT(*) FROM public.admin_events WHERE created_at > NOW()-INTERVAL '24 hours') events_24h,
          (SELECT COUNT(*) FROM public.admin_events WHERE severity IN ('WARNING','CRITICAL') AND created_at > NOW()-INTERVAL '24 hours') alerts_24h,
          (SELECT COUNT(*) FROM public.users WHERE COALESCE(admin_blocked,FALSE)=TRUE) disabled
      `);
      const x = r.rows[0];
      return show(ctx, "📊 *ADMIN OVERVIEW*\n\n👥 Users: " + x.users + "\n⚡ Active trading: " + x.active +
        "\n🚫 Disabled: " + x.disabled + "\n💰 Wallets: " + x.wallets + "\n🧾 Events 24h: " + x.events_24h +
        "\n🚨 Warnings/Critical 24h: " + x.alerts_24h, { parse_mode: "Markdown", reply_markup: adminBack() });
    }

    if (action === "milestones") {
      const r = await pool.query(`
        SELECT event_type, COUNT(*)::int AS count, MAX(created_at) AS latest
        FROM public.engine_events
        WHERE event_type LIKE 'milestone_%' AND created_at > NOW()-INTERVAL '24 hours'
        GROUP BY event_type
        ORDER BY MAX(created_at) DESC
      `);
      const total = r.rows.reduce((sum: number, row: any) => sum + Number(row.count || 0), 0);
      const lines = r.rows.length
        ? r.rows.map((m: any) => "• " + m.event_type.replace("milestone_","").toUpperCase() + " — " + m.count).join("\\n")
        : "_No milestones in the last 24 hours._";
      return show(ctx,
        "🏆 *MILESTONE CENTER*\\n\\n" +
        "🎉 Achievements sent (24h): " + total + "\\n\\n" +
        lines +
        "\\n\\n*Recent achievement activity is recorded automatically.*",
        { parse_mode: "Markdown", reply_markup: adminBack() }
      );
    }

    if (action === "trading") {
      const r = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM public.engine_positions WHERE status='open') open_positions,
          (SELECT COUNT(*) FROM public.engine_positions WHERE created_at > NOW()-INTERVAL '24 hours') entries_24h,
          (SELECT COUNT(*) FROM public.engine_positions WHERE closed_at > NOW()-INTERVAL '24 hours') exits_24h,
          (SELECT COALESCE(SUM(realized_pnl_sol),0) FROM public.engine_positions WHERE closed_at > NOW()-INTERVAL '24 hours') pnl_24h,
          (SELECT COUNT(*) FROM public.trade_intents WHERE created_at > NOW()-INTERVAL '24 hours' AND status IN ('failed','unknown')) failed_24h,
          (SELECT COUNT(*) FROM public.trade_intents WHERE created_at > NOW()-INTERVAL '24 hours') intents_24h
      `);
      const x = r.rows[0];
      const recent = await pool.query(`
        SELECT id,telegram_id,token_address,side,status,signature,updated_at
        FROM public.trade_intents ORDER BY updated_at DESC LIMIT 8
      `);
      const lines = recent.rows.length
        ? recent.rows.map((t: any) => "• #" + String(t.id).slice(0,8) + " · " + t.side.toUpperCase() + " · " + t.status + " · " + String(t.token_address).slice(0,8) + "…").join("\\n")
        : "_No recent trade intents._";
      return show(ctx,
        "⚡ *TRADING MONITOR*\\n\\n" +
        "📂 Open positions: " + x.open_positions + "\\n" +
        "🟢 Entries 24h: " + x.entries_24h + "\\n" +
        "🔴 Exits 24h: " + x.exits_24h + "\\n" +
        "💰 Realized P&L 24h: " + Number(x.pnl_24h || 0).toFixed(4) + " SOL\\n" +
        "📡 Trade intents 24h: " + x.intents_24h + "\\n" +
        "❌ Failed/unknown 24h: " + x.failed_24h + "\\n\\n" +
        "*RECENT INTENTS*\\n" + lines,
        { parse_mode: "Markdown", reply_markup: adminBack() }
      );
    }

    if (action === "scanner") {
      const r = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM public.engine_candidates) total_candidates,
          (SELECT COUNT(*) FROM public.engine_candidates WHERE last_seen > NOW()-INTERVAL '1 hour') seen_1h,
          (SELECT COUNT(*) FROM public.engine_candidates WHERE status='qualified') qualified,
          (SELECT COUNT(*) FROM public.engine_candidate_users WHERE evaluated_at > NOW()-INTERVAL '24 hours') evaluations_24h,
          (SELECT COUNT(*) FROM public.engine_candidate_users WHERE status='rejected' AND evaluated_at > NOW()-INTERVAL '24 hours') rejected_24h
      `);
      const x = r.rows[0];
      return show(ctx,
        "🔎 *SCANNER MONITOR*\\n\\n" +
        "🧿 Candidates stored: " + x.total_candidates + "\\n" +
        "🕐 Seen in last hour: " + x.seen_1h + "\\n" +
        "✅ Qualified: " + x.qualified + "\\n" +
        "🧪 Evaluations 24h: " + x.evaluations_24h + "\\n" +
        "🚫 Rejected 24h: " + x.rejected_24h,
        { parse_mode: "Markdown", reply_markup: adminBack() }
      );
    }


      const r = await pool.query("SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events WHERE event_type IN ('trading_started','trading_stopped','risk_event') ORDER BY created_at DESC LIMIT 10");
      return renderRows(ctx, "⚡ *TRADING ACTIVITY*", r.rows, adminBack(), true);
    }
    if (action === "scanner") {
      const r = await pool.query("SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events WHERE event_type IN ('system_error','risk_event') AND payload::text ILIKE '%scanner%' ORDER BY created_at DESC LIMIT 10");
      return renderRows(ctx, "🔎 *SCANNER EVENTS*", r.rows, adminBack(), true);
    }
    if (action === "risk") {
      const r = await pool.query("SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events WHERE event_type='risk_event' ORDER BY created_at DESC LIMIT 10");
      return renderRows(ctx, "🚨 *RISK EVENTS*", r.rows, adminBack(), true);
    }
    if (action === "system") {
      const r = await pool.query("SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events WHERE event_type='system_error' ORDER BY created_at DESC LIMIT 10");
      return renderRows(ctx, "🛠 *SYSTEM EVENTS*", r.rows, adminBack(), true);
    }
    if (action === "events") {
      const r = await pool.query("SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events ORDER BY created_at DESC LIMIT 15");
      return renderRows(ctx, "🧾 *RECENT EVENTS*", r.rows, adminBack(), true);
    }

    const toggleMatch = action.match(/^user:toggle:(\d+)$/);
    if (toggleMatch) {
      const targetId = toggleMatch[1];
      const r = await pool.query("SELECT telegram_id,username,trading_active,COALESCE(admin_blocked,FALSE) AS admin_blocked FROM public.users WHERE telegram_id=$1", [targetId]);
      if (!r.rowCount) return show(ctx, "⚠️ User not found.", { reply_markup: adminBack() });
      const target = r.rows[0];
      const nextBlocked = !Boolean(target.admin_blocked);
      await pool.query("UPDATE public.users SET admin_blocked=$2,trading_active=CASE WHEN $2 THEN FALSE ELSE trading_active END,updated_at=NOW() WHERE telegram_id=$1", [targetId, nextBlocked]);
      await recordAdminEvent(pool, nextBlocked ? "admin_user_disabled" : "admin_user_enabled", {
        telegram_id: ctx.from.id, target_telegram_id: targetId, username: target.username
      }, "ACTION");
      return show(ctx,
        (nextBlocked ? "🚫 *USER DISABLED*" : "🟢 *USER ENABLED*") +
        "\n\nUser: " + targetId + "\nUsername: @" + (target.username || "—") +
        "\n\n" + (nextBlocked ? "Trading has been stopped and the user can no longer operate the bot." : "The user can access the bot again; trading remains stopped until they start it."),
        { parse_mode: "Markdown", reply_markup: userActions(targetId, nextBlocked) }
      );
    }

    return show(ctx, "Unknown admin action.", { reply_markup: adminBack() });
    } catch (error: any) {
      console.error("[admin] action failed", action, error);
      const message = String(error?.message || error).slice(0, 300);
      return show(ctx, "⚠️ *ADMIN ACTION FAILED*\\n\\n" + message, {
        parse_mode: "Markdown",
        reply_markup: adminBack()
      }).catch(() => {});
    }
  });

  bot.on("message:text", async (ctx: any, next: any) => {
    if (!(await isAdmin(ctx.from.id))) return next();
    const input = (ctx.session as any).adminInput;
    if (!input) return next();
    const raw = ctx.message.text.trim();
    if (!raw) return;
    if (input === "broadcast") {
      (ctx.session as any).adminInput = undefined;
      (ctx.session as any).adminBroadcastDraft = raw;
      return show(ctx,
        "👀 *PREVIEW UPDATE*\n\n" + raw + "\n\nThis will be sent to all registered users who are not disabled. Confirm only if the message is correct.",
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("📢 SEND TO USERS", "admin:confirm_broadcast").text("✏️ EDIT", "admin:broadcast").row().text("❌ CANCEL", "admin:cancel_input") }
      );
    }
    if (input === "user_search") {
      (ctx.session as any).adminInput = undefined;
      const normalized = raw.startsWith("@") ? raw.slice(1).toLowerCase() : raw;
      const r = /^\d+$/.test(normalized)
        ? await pool.query("SELECT telegram_id,username,trading_active,COALESCE(admin_blocked,FALSE) AS admin_blocked,created_at,updated_at FROM public.users WHERE telegram_id=$1", [normalized])
        : await pool.query("SELECT telegram_id,username,trading_active,COALESCE(admin_blocked,FALSE) AS admin_blocked,created_at,updated_at FROM public.users WHERE LOWER(username)=LOWER($1) LIMIT 1", [normalized]);
      if (!r.rowCount) return show(ctx, "⚠️ *USER NOT FOUND*\n\nNo registered user matched `" + raw + "`.", { parse_mode: "Markdown", reply_markup: adminBack() });
      const u = r.rows[0];
      return show(ctx,
        "👤 *USER MANAGEMENT*\n\nTelegram ID: " + u.telegram_id + "\nUsername: @" + (u.username || "—") +
        "\nTrading: " + (u.trading_active ? "ACTIVE" : "STOPPED") +
        "\nAccount: " + (u.admin_blocked ? "DISABLED" : "ENABLED") +
        "\nCreated: " + new Date(u.created_at).toISOString().slice(0, 16) +
        "\nUpdated: " + new Date(u.updated_at).toISOString().slice(0, 16),
        { parse_mode: "Markdown", reply_markup: userActions(String(u.telegram_id), Boolean(u.admin_blocked)) }
      );
    }
    return next();
  });
}

async function renderRows(ctx: any, title: string, rows: any[], keyboard: any, includePayload: boolean) {
  if (!rows.length) return ctx.editMessageText(title + "\n\n_No events yet._", { parse_mode: "Markdown", reply_markup: keyboard });
  const lines = rows.map((row: any) => {
    const when = new Date(row.created_at).toISOString().replace("T", " ").slice(0, 16);
    const payload = includePayload ? JSON.stringify(row.payload || {}).slice(0, 180) : "";
    return "• " + when + " · " + row.severity + " · " + row.event_type + (payload ? " · " + payload : "");
  });
  return ctx.editMessageText(title + "\n\n" + lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
}
