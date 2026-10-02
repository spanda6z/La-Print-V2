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
  return getAdminIds().includes(id);
}

export function registerAdminConsole(deps: AdminDeps) {
  const { bot, pool, show } = deps;

  bot.command("admin", async (ctx: any) => {
    if (!(await isAdmin(ctx.from.id))) return;
    await ensureAdminAuditTable(pool);
    await show(ctx, "🛡️ *LA-PRINT ADMIN*\\n\\nChoose an admin view.", {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("📊 OVERVIEW", "admin:overview")
        .text("👥 USERS", "admin:users")
        .row()
        .text("⚡ TRADING", "admin:trading")
        .text("🔎 SCANNER", "admin:scanner")
        .row()
        .text("🚨 RISK", "admin:risk")
        .text("🛠 SYSTEM", "admin:system")
        .row()
        .text("🧾 EVENTS", "admin:events")
        .text("🔔 TEST", "admin:test")
    });
  });

  bot.callbackQuery(/^admin:/, async (ctx: any) => {
    if (!(await isAdmin(ctx.from.id))) {
      await ctx.answerCallbackQuery("Admin only").catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery();
    const action = ctx.callbackQuery.data.slice(6);
    await ensureAdminAuditTable(pool);

    if (action === "test") {
      await notifyAdmin(bot, "system_error", { message: "Admin console test", telegram_id: ctx.from.id });
      return show(ctx, "🔔 *TEST SENT*\\n\\nAdmin notification was dispatched.", {
        parse_mode: "Markdown",
        reply_markup: adminBack()
      });
    }

    let title = "";
    let query = "";
    let params: any[] = [];

    if (action === "overview") {
      const r = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM public.users) users,
          (SELECT COUNT(*) FROM public.users WHERE trading_active=true) active,
          (SELECT COUNT(*) FROM public.wallets) wallets,
          (SELECT COUNT(*) FROM public.admin_events WHERE created_at > NOW()-INTERVAL '24 hours') events_24h,
          (SELECT COUNT(*) FROM public.admin_events WHERE severity IN ('WARNING','CRITICAL') AND created_at > NOW()-INTERVAL '24 hours') alerts_24h
      `);
      const x = r.rows[0];
      return show(ctx, "📊 *ADMIN OVERVIEW*\\n\\n👥 Users: "+x.users+"\\n⚡ Active trading: "+x.active+"\\n💰 Wallets: "+x.wallets+"\\n🧾 Events 24h: "+x.events_24h+"\\n🚨 Warnings/Critical 24h: "+x.alerts_24h, {parse_mode:"Markdown", reply_markup:adminBack()});
    }

    if (action === "users") {
      title = "👥 *RECENT USERS*";
      query = "SELECT telegram_id,username,mode,trading_active,strategy_profile,strategy_version,updated_at FROM public.users ORDER BY updated_at DESC LIMIT 10";
    } else if (action === "trading") {
      title = "⚡ *TRADING ACTIVITY*";
      query = "SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events WHERE event_type IN ('trading_started','trading_stopped','risk_event') ORDER BY created_at DESC LIMIT 10";
    } else if (action === "scanner") {
      title = "🔎 *SCANNER EVENTS*";
      query = "SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events WHERE event_type IN ('system_error','risk_event') AND payload::text ILIKE '%scanner%' ORDER BY created_at DESC LIMIT 10";
    } else if (action === "risk") {
      title = "🚨 *RISK EVENTS*";
      query = "SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events WHERE event_type='risk_event' ORDER BY created_at DESC LIMIT 10";
    } else if (action === "system") {
      title = "🛠 *SYSTEM EVENTS*";
      query = "SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events WHERE event_type='system_error' ORDER BY created_at DESC LIMIT 10";
    } else if (action === "events") {
      title = "🧾 *RECENT EVENTS*";
      query = "SELECT telegram_id,event_type,severity,payload,created_at FROM public.admin_events ORDER BY created_at DESC LIMIT 15";
    } else {
      return show(ctx, "Unknown admin action.", {reply_markup: adminBack()});
    }

    const r = await pool.query(query, params);
    if (!r.rows.length) return show(ctx, title+"\\n\\n_No events yet._", {parse_mode:"Markdown", reply_markup:adminBack()});
    const lines = r.rows.map((row:any) => {
      const when = new Date(row.created_at).toISOString().replace("T"," ").slice(0,16);
      if (action === "users") return "• "+row.telegram_id+" · @"+(row.username||"—")+" · "+(row.strategy_profile||"—")+" v"+(row.strategy_version||"—")+" · "+(row.trading_active?"ACTIVE":"OFF");
      const payload = JSON.stringify(row.payload||{}).slice(0,180);
      return "• "+when+" · "+row.severity+" · "+row.event_type+" · "+payload;
    });
    return show(ctx, title+"\\n\\n"+lines.join("\\n"), {parse_mode:"Markdown", reply_markup:adminBack()});
  });

  function adminBack() {
    return new InlineKeyboard().text("🛡️ ADMIN HOME","admin:home").row().text("🏠 MAIN MENU","menu");
  }

  bot.callbackQuery("admin:home", async (ctx:any) => {
    if (!(await isAdmin(ctx.from.id))) return;
    await ctx.answerCallbackQuery();
    await show(ctx, "🛡️ *LA-PRINT ADMIN*\\n\\nChoose an admin view.", {
      parse_mode:"Markdown",
      reply_markup:new InlineKeyboard()
        .text("📊 OVERVIEW","admin:overview").text("👥 USERS","admin:users").row()
        .text("⚡ TRADING","admin:trading").text("🔎 SCANNER","admin:scanner").row()
        .text("🚨 RISK","admin:risk").text("🛠 SYSTEM","admin:system").row()
        .text("🧾 EVENTS","admin:events").text("🔔 TEST","admin:test")
    });
  });
}
