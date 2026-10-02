import "dotenv/config";
import { Bot, Context, InlineKeyboard, session, SessionFlavor } from "grammy";
import pg from "pg";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { registerStrategySettings } from "./settings-v2";
import { notifyAdmin } from "./admin-notifications";
import { registerAdminConsole, ensureAdminAuditTable, recordAdminEvent } from "./admin-console";
import { registerMultiWallets, ensureMultiWalletSchema } from "./multi-wallets";

const { Pool } = pg;
const token = process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
type FilterField = "minMc"|"maxMc"|"minLiquidity"|"minVolume5m"|"minHolders"|"maxTop10"|"maxDev"|"minAgeSec"|"maxAgeMin";
type Session = { input?: "buy"|"sl"|"tp"|"wallet_import"|`filter_${FilterField}`; walletReturnTo?: "setup"|"menu" };
type Ctx = Context & SessionFlavor<Session>;
const bot = new Bot<Ctx>(token);
async function show(ctx: Ctx, message: string, extra: any = {}) {
  if (ctx.callbackQuery && "message" in ctx.callbackQuery && ctx.callbackQuery.message) {
    try { return await ctx.editMessageText(message, extra); }
    catch (error) {
      const description = String((error as any)?.description || (error as any)?.message || error);
      if (description.includes("message is not modified")) return;
      if (!description.includes("message to edit") && !description.includes("can't be edited") && !description.includes("message can't be edited")) throw error;
    }
  }
  return ctx.reply(message, extra);
}
bot.use(session({ initial: (): Session => ({}) }));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      telegram_id BIGINT PRIMARY KEY, username TEXT, mode TEXT,
      onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE, buy_amount NUMERIC,
      tp_config JSONB, sl_percent NUMERIC, filters JSONB, alerts JSONB,
      wallet_address TEXT, wallet_balance NUMERIC NOT NULL DEFAULT 0,
      funding_prompt_sent BOOLEAN NOT NULL DEFAULT FALSE,
      trading_active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username TEXT;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS mode TEXT;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS buy_amount NUMERIC;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tp_config JSONB;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS sl_percent NUMERIC;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS filters JSONB;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS alerts JSONB;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS wallet_address TEXT;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS funding_prompt_sent BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS trading_active BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS strategy_profile TEXT NOT NULL DEFAULT 'balanced';
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS strategy_customized BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS strategy_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS strategy_config JSONB;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_uidx ON public.users(telegram_id);
    CREATE TABLE IF NOT EXISTS public.wallets (
      telegram_id BIGINT PRIMARY KEY REFERENCES public.users(telegram_id) ON DELETE CASCADE,
      public_key TEXT NOT NULL UNIQUE,
      encrypted_secret TEXT NOT NULL,
      encryption_iv TEXT NOT NULL,
      encryption_tag TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS public.trade_config_snapshots (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
      strategy_profile TEXT NOT NULL,
      strategy_version INTEGER NOT NULL,
      config JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS trade_config_snapshots_user_created_idx
      ON public.trade_config_snapshots(telegram_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS public.notification_events (
      telegram_id BIGINT NOT NULL, event_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (telegram_id, event_key)
    );
  `);
  const check = await pool.query(`
    SELECT current_database() AS database, current_schema() AS schema,
      current_setting('search_path') AS search_path,
      to_regclass('public.users')::text AS users_table,
      to_regclass('public.notification_events')::text AS notifications_table
  `);
  const state = check.rows[0];
  if (!state.users_table || !state.notifications_table) {
    throw new Error("Database migration verification failed: " + JSON.stringify(state));
  }
  console.log("[db] schema ready", JSON.stringify(state));
  await ensureMultiWalletSchema(pool);
}

async function databaseSmokeTest() {
  const client = await pool.connect();
  const probeId = -7319042601;
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO public.users(telegram_id,username) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,updated_at=NOW()",
      [probeId, "__laprint_v2_smoke_test__"]
    );
    const userCheck = await client.query(
      "SELECT telegram_id,username FROM public.users WHERE telegram_id=$1",
      [probeId]
    );
    if (userCheck.rowCount !== 1 || userCheck.rows[0]?.username !== "__laprint_v2_smoke_test__") {
      throw new Error("Database smoke test failed: user insert/upsert did not round-trip");
    }
    const firstEvent = await client.query(
      "INSERT INTO public.notification_events(telegram_id,event_key) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [probeId, "smoke-test"]
    );
    const duplicateEvent = await client.query(
      "INSERT INTO public.notification_events(telegram_id,event_key) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [probeId, "smoke-test"]
    );
    if (firstEvent.rowCount !== 1 || duplicateEvent.rowCount !== 0) {
      throw new Error("Database smoke test failed: notification deduplication is not working");
    }
    await client.query("ROLLBACK");
    console.log("[db] smoke test passed: user upsert + notification deduplication");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const TELEGRAM_POLL_LOCK = 7319042601;

async function acquireTelegramPollingLock() {
  const client = await pool.connect();
  try {
    for (;;) {
      const result = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [TELEGRAM_POLL_LOCK]);
      if (result.rows[0]?.locked) {
        console.log("[telegram] exclusive polling lock acquired");
        return client;
      }
      console.warn("[telegram] another LaPrint V2 poller holds the lock; waiting");
      await sleep(5000);
    }
  } catch (error) {
    client.release();
    throw error;
  }
}


function walletEncryptionKey(): Buffer {
  const configured = process.env.WALLET_ENCRYPTION_KEY;
  if (!configured || configured.length < 32) throw new Error("WALLET_ENCRYPTION_KEY must be configured with at least 32 characters.");
  return createHash("sha256").update(configured, "utf8").digest();
}
function encryptSecret(secret: Uint8Array) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", walletEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
  return { encrypted: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
function decryptSecret(encrypted: string, iv: string, tag: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", walletEncryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
}
async function saveWallet(telegramId: number, keypair: Keypair) {
  const secret = encryptSecret(keypair.secretKey);
  const address = keypair.publicKey.toBase58();
  await pool.query(
    `INSERT INTO public.wallets(telegram_id,public_key,encrypted_secret,encryption_iv,encryption_tag)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(telegram_id) DO NOTHING`,
    [telegramId,address,secret.encrypted,secret.iv,secret.tag]
  );
  const saved = await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[telegramId]);
  if (saved.rows[0]?.public_key !== address) throw new Error("A wallet already exists; it was not replaced.");
  await patch(telegramId,{wallet_address:address,wallet_balance:0});
  return address;
}
async function walletBackup(telegramId: number): Promise<string> {
  const result = await pool.query("SELECT encrypted_secret,encryption_iv,encryption_tag FROM public.wallets WHERE telegram_id=$1",[telegramId]);
  if (!result.rowCount) throw new Error("No wallet exists.");
  return bs58.encode(decryptSecret(result.rows[0].encrypted_secret,result.rows[0].encryption_iv,result.rows[0].encryption_tag));
}

async function user(id:number, username?:string) {
  await pool.query("INSERT INTO public.users(telegram_id,username) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,updated_at=NOW()",[id,username||null]);
  const r=await pool.query("SELECT * FROM public.users WHERE telegram_id=$1",[id]); return r.rows[0];
}
async function patch(id:number, fields:Record<string,unknown>) {
  const e=Object.entries(fields); if(!e.length) return user(id);
  const set=e.map((x,i)=>x[0]+"=$"+(i+2)).join(",");
  await pool.query("UPDATE public.users SET "+set+",updated_at=NOW() WHERE telegram_id=$1",[id,...e.map(x=>x[1])]);
  return user(id);
}
async function readSolBalance(address:string):Promise<number>{
  const endpoint=process.env.SOLANA_RPC_URL;
  if(!endpoint) throw new Error("SOLANA_RPC_URL is not configured");
  const connection=new Connection(endpoint,{commitment:"confirmed"});
  const lamports=await connection.getBalance(new PublicKey(address),"confirmed");
  return lamports/LAMPORTS_PER_SOL;
}
async function once(id:number,key:string) {
  const r=await pool.query("INSERT INTO public.notification_events(telegram_id,event_key) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,key]); return r.rowCount===1;
}

const back = (target="setup") => new InlineKeyboard().text("⬅️ BACK",target).text("🏠 MAIN MENU","menu");
const modeKb = () => new InlineKeyboard().text("🎯 AUTOPILOT","mode:auto").text("✋ MANUAL","mode:manual");
const setupKb = () => new InlineKeyboard().text("💰 BUY AMOUNT","setup:buy").text("🎯 TAKE PROFIT","setup:tp").row().text("🛑 STOP LOSS","setup:sl").text("🔎 FILTERS","setup:filters").row().text("🔔 ALERTS","setup:alerts").text("💰 WALLET","wallet:setup").row().text("👀 REVIEW","review").row().text("⬅️ BACK","mode:back").text("🏠 MAIN MENU","menu");
const mainKb = (active:boolean,mode:string) => { const k=new InlineKeyboard().text(mode==="manual"?"▶️ START FEED":"🚀 START","trade:start").text("📊 POSITIONS","positions").row().text("📡 ACTIVITY","activity").text("🔔 ALERTS","alerts").row().text("⚙️ SETTINGS","settings:v2").text("👛 WALLETS","wallets").row(); if(active) k.text(mode==="manual"?"⏹️ STOP FEED":"⏹️ STOP AUTOPILOT","trade:stop"); return k; };
const buyKb=()=>new InlineKeyboard().text("0.01 SOL","buy:0.01").text("0.05 SOL","buy:0.05").row().text("0.10 SOL","buy:0.10").text("0.25 SOL","buy:0.25").row().text("✏️ CUSTOM","buy:custom").row().text("⬅️ BACK","setup");
const tpKb=()=>new InlineKeyboard().text("⚡ SIMPLE TP","tp:simple").text("🧠 PARTIAL EXITS","tp:partial").row().text("⬅️ BACK","setup");
const slKb=()=>new InlineKeyboard().text("-10%","sl:-10").text("-15%","sl:-15").row().text("-20%","sl:-20").text("-25%","sl:-25").row().text("✏️ CUSTOM","sl:custom").row().text("⬅️ BACK","setup");
const filterKb=()=>new InlineKeyboard().text("🟢 PRE-BOND","filter:pre").text("🚀 NEW LAUNCHES","filter:new").row().text("🔥 BOTH","filter:both").row().text("⚙️ FILTER SETTINGS","filter:settings").text("🧠 SMART","filter:smart").row().text("⬅️ BACK","setup");
const alertKb=(a:any={})=>new InlineKeyboard().text("🟢 MILESTONES: ALWAYS ON","noop").row().text((a.newToken?"☑":"☐")+" NEW TOKEN","alert:new").text((a.liquidity?"☑":"☐")+" LIQUIDITY","alert:liq").row().text((a.volume?"☑":"☐")+" VOLUME","alert:vol").text((a.bonding?"☑":"☐")+" BONDING","alert:bond").row().text("💾 SAVE","alert:save").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu");
const walletKb=(target="menu")=>new InlineKeyboard().text("➕ CREATE WALLET","wallet:create").text("📥 IMPORT WALLET","wallet:import").row().text("🔄 REFRESH","wallet:refresh").row().text("⬅️ BACK",target).text("🏠 MAIN MENU","menu");

async function menu(ctx:Ctx){ const u=await user(ctx.from!.id,ctx.from!.username); const wallet=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from!.id]); await show(ctx,"🤖 *TRADE AUTOPILOT*\n\n⚙️ Engine: UNAVAILABLE — execution adapter not connected\n🎯 Mode: "+(u.mode==="manual"?"MANUAL":"AUTOPILOT")+"\n💰 Wallet: "+(wallet.rowCount?"CREATED — BALANCE NOT VERIFIED":"NOT SET UP")+"\n📊 Positions: Not connected\n📈 PnL: Not connected\n\nYour settings are saved. Trading cannot start until live wallet, scanner, safety and execution services are connected.",{parse_mode:"Markdown",reply_markup:mainKb(false,u.mode)}); }
async function setup(ctx:Ctx){ const u=await user(ctx.from!.id,ctx.from!.username); const wallet=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from!.id]); await show(ctx,"⚙️ *TRADE SETUP*\n\nConfigure your rules before receiving trading calls.\n\n💰 Buy Amount "+(u.buy_amount?"✅":"❌")+"\n🎯 Take Profit "+(u.tp_config?"✅":"❌")+"\n🛑 Stop Loss "+(u.sl_percent?"✅":"❌")+"\n🔎 Filters "+(u.filters?"✅":"❌")+"\n🔔 Alerts "+(u.alerts?"✅":"❌")+"\n💰 Wallet "+(wallet.rowCount?"CREATED — BALANCE UNVERIFIED":"❌ NOT SET UP"),{parse_mode:"Markdown",reply_markup:setupKb()}); }

bot.command("start",async ctx=>{if(!ctx.from)return;const u=await user(ctx.from.id,ctx.from.username); await recordAdminEvent(pool,"user_started",{telegram_id:ctx.from.id,username:ctx.from.username||null}); if(u.onboarding_complete) return menu(ctx); await show(ctx,"🤖 *TRADE AUTOPILOT*\n\nYour Telegram trading assistant for qualified calls and automated execution.\n\n🎯 *AUTOPILOT* — qualified calls can be executed automatically.\n\n✋ *MANUAL* — review each call before execution.\n\nSet your trade rules, filters and alerts before trading begins.\n\nChoose your mode:",{parse_mode:"Markdown",reply_markup:modeKb()});});
bot.command("menu",menu);\nbot.command("admin_test", async ctx=>{ await ctx.deleteMessage().catch(()=>{}); await notifyAdmin(bot,"system_error",{message:"Admin notification test",telegram_id:ctx.from.id}); });
bot.command("mode",async ctx=>show(ctx,"🎯 *TRADING MODE*\n\nChoose how you want the bot to operate.",{parse_mode:"Markdown",reply_markup:modeKb()}));

bot.callbackQuery("mode:auto",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{mode:"autopilot",onboarding_complete:true});await show(ctx,"🎯 *AUTOPILOT*\n\nQualified calls that pass your filters and safety checks can be executed automatically.\n\nNothing starts until your setup is complete.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ SET UP AUTOPILOT","setup").row().text("⬅️ BACK","start").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("mode:manual",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{mode:"manual",onboarding_complete:true});await show(ctx,"✋ *MANUAL*\n\nYou will receive qualified calls that match your filters and decide whether each trade executes.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ SET UP MANUAL","setup").row().text("⬅️ BACK","start").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("start",async ctx=>{await ctx.answerCallbackQuery();await show(ctx,"🤖 *TRADE AUTOPILOT*\n\nChoose your mode:",{parse_mode:"Markdown",reply_markup:modeKb()});});
bot.callbackQuery("mode:back",async ctx=>{await ctx.answerCallbackQuery();await show(ctx,"🎯 *TRADING MODE*\n\nChoose how you want the bot to operate.",{parse_mode:"Markdown",reply_markup:modeKb()});});
 bot.callbackQuery("menu",async ctx=>{await ctx.answerCallbackQuery();ctx.session.input=undefined;await menu(ctx);});

bot.callbackQuery("setup:buy",async ctx=>{await ctx.answerCallbackQuery();await show(ctx,"💰 *BUY AMOUNT*\n\nHow much SOL should each trade use?",{parse_mode:"Markdown",reply_markup:buyKb()});});
bot.callbackQuery(/^buy:(.+)$/,async ctx=>{await ctx.answerCallbackQuery();const v=ctx.match[1];if(v==="custom"){ctx.session.input="buy";return show(ctx,"✏️ Enter the SOL amount. Example: 0.05",{reply_markup:new InlineKeyboard().text("↩️ RETURN TO SETUP","setup")});}await patch(ctx.from.id,{buy_amount:Number(v)});await show(ctx,"✅ *BUY AMOUNT SAVED*\n\nTrade size: "+v+" SOL",{parse_mode:"Markdown",reply_markup:setupKb()});});
bot.callbackQuery("setup:tp",async ctx=>{await ctx.answerCallbackQuery();await show(ctx,"🎯 *TAKE PROFIT*\n\nChoose how profits should be taken.",{parse_mode:"Markdown",reply_markup:tpKb()});});
bot.callbackQuery("tp:simple",async ctx=>{await ctx.answerCallbackQuery();ctx.session.input="tp";return show(ctx,"✏️ *CUSTOM TAKE PROFIT*\n\nEnter the profit target as a positive percentage. Example: 40 means +40%. The full position will be sold at this target.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ BACK","setup:tp").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("tp:partial",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{tp_config:{type:"partial",targets:[{pct:40,sellPct:50},{pct:100,sellPct:25},{pct:200,sellPct:15}]}});await show(ctx,"✅ *TP SAVED*\n\n+40% → 50%\n+100% → 25%\n+200% → 15%\nRemaining: 10%",{parse_mode:"Markdown",reply_markup:setupKb()});});
bot.callbackQuery("setup:sl",async ctx=>{await ctx.answerCallbackQuery();await show(ctx,"🛑 *STOP LOSS*\n\nSet the maximum loss per position.",{parse_mode:"Markdown",reply_markup:slKb()});});
bot.callbackQuery(/^sl:(.+)$/,async ctx=>{await ctx.answerCallbackQuery();const v=ctx.match[1];if(v==="custom"){ctx.session.input="sl";return show(ctx,"✏️ Enter the stop loss. Example: -20",{reply_markup:new InlineKeyboard().text("↩️ RETURN TO SETUP","setup")});}await patch(ctx.from.id,{sl_percent:Number(v)});await show(ctx,"✅ *STOP LOSS SAVED*\n\nSL: "+v+"%",{parse_mode:"Markdown",reply_markup:setupKb()});});

bot.callbackQuery("setup:filters",async ctx=>{await ctx.answerCallbackQuery();await show(ctx,"🔎 *TOKEN FILTERS*\n\nOnly tokens that pass your filters can generate a trading call.\n\nA low market cap alone never qualifies a token.",{parse_mode:"Markdown",reply_markup:filterKb()});});
bot.callbackQuery(/^filter:(pre|new|both)$/,async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{filters:{type:ctx.match[1],minMc:3000,maxMc:50000,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30,smart:true}});await show(ctx,"✅ *FILTERS SAVED*\n\nMC: $3K → $50K\nLiquidity: ≥ $5K\n5M Volume: ≥ $2K\nHolders: ≥ 50\nTop 10: ≤ 35%\nDev: ≤ 5%\nSmart filters: ON",{parse_mode:"Markdown",reply_markup:setupKb()});});
bot.callbackQuery("filter:settings",async ctx=>{
  await ctx.answerCallbackQuery();
  const u=await user(ctx.from.id,ctx.from.username);const f=u.filters||{minMc:3000,maxMc:50000,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30,smart:true};
  const k=new InlineKeyboard().text("MIN MC","filter:edit:minMc").text("MAX MC","filter:edit:maxMc").row().text("MIN LIQUIDITY","filter:edit:minLiquidity").text("MIN 5M VOL","filter:edit:minVolume5m").row().text("MIN HOLDERS","filter:edit:minHolders").text("MAX TOP 10 %","filter:edit:maxTop10").row().text("MAX DEV %","filter:edit:maxDev").text("MIN AGE SEC","filter:edit:minAgeSec").row().text("MAX AGE MIN","filter:edit:maxAgeMin").row().text("🧠 SMART: "+(f.smart===false?"OFF":"ON"),"filter:smart").row().text("⬅️ BACK","setup:filters").text("🏠 MAIN MENU","menu");
  await show(ctx,"🔎 *FILTER SETTINGS*\\n\\nMarket: "+(f.type||"Both")+"\\nMin MC: $"+(f.minMc??3000)+" | Max MC: $"+(f.maxMc??50000)+"\\nMin liquidity: $"+(f.minLiquidity??5000)+"\\n5M volume: $"+(f.minVolume5m??2000)+"\\nMin holders: "+(f.minHolders??50)+"\\nTop 10 max: "+(f.maxTop10??35)+"%\\nDev max: "+(f.maxDev??5)+"%\\nAge: "+(f.minAgeSec??30)+"s – "+(f.maxAgeMin??30)+"m\\nSmart filters: "+(f.smart===false?"OFF":"ON")+"\\n\\nTap a field to edit its threshold. Changes save immediately.",{parse_mode:"Markdown",reply_markup:k});
});
bot.callbackQuery(/^filter:edit:(minMc|maxMc|minLiquidity|minVolume5m|minHolders|maxTop10|maxDev|minAgeSec|maxAgeMin)$/,async ctx=>{
  await ctx.answerCallbackQuery();const field=ctx.match[1] as FilterField;ctx.session.input=("filter_"+field) as Session["input"];
  const labels:Record<FilterField,string>={minMc:"minimum market cap in USD",maxMc:"maximum market cap in USD",minLiquidity:"minimum liquidity in USD",minVolume5m:"minimum 5-minute volume in USD",minHolders:"minimum holder count",maxTop10:"maximum top-10 holder concentration percentage",maxDev:"maximum developer holding percentage",minAgeSec:"minimum token age in seconds",maxAgeMin:"maximum token age in minutes"};
  await show(ctx,"✏️ *EDIT FILTER*\\n\\nEnter the "+labels[field]+".\\nNumbers only. Other filter settings will be preserved.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ CANCEL","filter:settings").text("🏠 MAIN MENU","menu")});
});
bot.callbackQuery("filter:smart",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);const old=u.filters||{type:"both",minMc:3000,maxMc:50000,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30};const next={...old,smart:old.smart===false};await patch(ctx.from.id,{filters:next});await show(ctx,"🧠 *SMART FILTERS "+(next.smart?"ON":"OFF")+"*\\n\\n"+(next.smart?"Smart checks are enabled in your saved configuration.":"Smart checks are disabled in your saved configuration.")+"\\n\\nLive token qualification remains unavailable until the filter evaluator is connected.",{parse_mode:"Markdown",reply_markup:filterKb()});});

bot.callbackQuery(/^alert:(new|liq|vol|bond)$/,async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);const old=u.alerts||{};const key=({new:"newToken",liq:"liquidity",vol:"volume",bond:"bonding"} as Record<string,string>)[ctx.match[1]];const next={...old,milestones:true,[key]:!old[key]};await patch(ctx.from.id,{alerts:next});const k=new InlineKeyboard().text((next.newToken?"☑":"☐")+" NEW TOKEN","alert:new").text((next.liquidity?"☑":"☐")+" LIQUIDITY","alert:liq").row().text((next.volume?"☑":"☐")+" VOLUME","alert:vol").text((next.bonding?"☑":"☐")+" BONDING","alert:bond").row().text("💾 SAVE","alert:save").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu");await show(ctx,"🔔 *OPTIONAL ALERTS*\n\nTrade milestones: ALWAYS ON\nTap an option to toggle it. Your selection is saved immediately.",{parse_mode:"Markdown",reply_markup:k});});
bot.callbackQuery("alert:save",async ctx=>{await ctx.answerCallbackQuery();const old=(await user(ctx.from.id,ctx.from.username)).alerts||{};await patch(ctx.from.id,{alerts:{...old,milestones:true}});await show(ctx,"✅ *ALERTS SAVED*\n\nTrade lifecycle milestones are always on. Optional market alerts are saved.",{parse_mode:"Markdown",reply_markup:setupKb()});});

bot.callbackQuery("setup:alerts",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);return show(ctx,"🔔 *ALERT SETTINGS*\n\nTrade lifecycle milestones are mandatory and always on. Toggle optional market alerts below. Changes save immediately.",{parse_mode:"Markdown",reply_markup:alertKb(u.alerts||{})});});
bot.callbackQuery("alerts",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);return show(ctx,"🔔 *ALERT SETTINGS*\n\nTrade lifecycle milestones are mandatory and always on. Toggle optional market alerts below. Changes save immediately.",{parse_mode:"Markdown",reply_markup:alertKb(u.alerts||{})});});
bot.callbackQuery("noop",async ctx=>ctx.answerCallbackQuery("Trade milestones are mandatory."));

bot.callbackQuery("wallet",async ctx=>{
  await ctx.answerCallbackQuery();
  ctx.session.walletReturnTo="menu";
  ctx.session.input=undefined;
  const result=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from.id]);
  if(!result.rowCount) return show(ctx,"💰 *YOUR TRADING WALLET*\n\nNo wallet has been created or imported yet.\n\nChoose an option below.",{parse_mode:"Markdown",reply_markup:walletKb("menu")});
  return show(ctx,"💰 *YOUR TRADING WALLET*\n\nStatus: WALLET CREATED\nAddress: \x60"+result.rows[0].public_key+"\x60\n\nBalance: unavailable — live Solana RPC balance lookup is not connected yet.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("🔄 REFRESH","wallet:refresh").row().text("↩️ RETURN TO MAIN MENU","menu")});
});
bot.callbackQuery("wallet:setup",async ctx=>{await ctx.answerCallbackQuery();ctx.session.walletReturnTo="setup";ctx.session.input=undefined;const result=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from.id]);if(!result.rowCount)return show(ctx,"💰 *WALLET*\n\nCreate or import your trading wallet. Live balance verification is not connected yet.",{parse_mode:"Markdown",reply_markup:walletKb("setup")});return show(ctx,"💰 *WALLET*\n\nAddress: `"+result.rows[0].public_key+"`\nBalance: unavailable — live RPC lookup is not connected.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔐 BACK UP","wallet:backup").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("wallet:create",async ctx=>{
  await ctx.answerCallbackQuery();
  const existing=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from.id]);
  if(existing.rowCount) return show(ctx,"A wallet already exists. LaPrint will not replace it.",{reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("↩️ RETURN","wallet")});
  try {
    const address=await saveWallet(ctx.from.id,Keypair.generate());
    await recordAdminEvent(pool,"wallet_created",{telegram_id:ctx.from.id,wallet_address:address},"ACTION");
    return show(ctx,"✅ *WALLET CREATED*\n\nYour Solana wallet was generated and encrypted before storage.\n\nAddress:\n\x60"+address+"\x60\n\nUse the backup action only in a private setting. Never share your private key.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("📋 COPY ADDRESS","wallet:copy").row().text("↩️ RETURN TO WALLET","wallet")});
  } catch(error) {
    console.error("[wallet] create failed",error);
    return show(ctx,"⚠️ *WALLET NOT CREATED*\n\nWallet encryption is not configured or the operation failed. No wallet was saved.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ RETURN","wallet")});
  }
});
bot.callbackQuery("wallet:import",async ctx=>{
  await ctx.answerCallbackQuery();
  const existing=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from.id]);
  if(existing.rowCount) return show(ctx,"A wallet already exists. Import will not overwrite it.",{reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("↩️ RETURN","wallet")});
  ctx.session.input="wallet_import";
  return show(ctx,"📥 *IMPORT SOLANA WALLET*\n\nSend your private key as a Base58 string or JSON secret-key array. Recovery phrases are not supported in this import screen.\n\nYour message will be deleted immediately where Telegram permits. Sending a key through Telegram still means Telegram processes that message; only continue if you accept that risk.\n\n↩️ Return to cancel.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ CANCEL / RETURN","wallet")});
});
bot.callbackQuery("wallet:backup",async ctx=>{
  await ctx.answerCallbackQuery();
  try {
    const secret=await walletBackup(ctx.from.id);
    return show(ctx,"🔐 *PRIVATE WALLET BACKUP*\n\nBase58 private key:\n\n\x60"+secret+"\x60\n\nAnyone with this key can control your funds. Store it securely, then delete this message. LaPrint support will never ask for it.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ RETURN TO WALLET","wallet")});
  } catch(error) {
    console.error("[wallet] backup failed",error);
    return show(ctx,"⚠️ Wallet backup is unavailable. Check encryption configuration and wallet status.",{reply_markup:new InlineKeyboard().text("↩️ RETURN","wallet")});
  }
});
bot.callbackQuery("wallet:copy",async ctx=>{
  await ctx.answerCallbackQuery();
  const result=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from.id]);
  if(!result.rowCount) return show(ctx,"No wallet was found.",{reply_markup:walletKb(ctx.session.walletReturnTo==="setup"?"setup":"menu")});
  return show(ctx,"📋 Wallet address:\n\x60"+result.rows[0].public_key+"\x60",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ RETURN","wallet")});
});
bot.callbackQuery("wallet:refresh",async ctx=>{
  await ctx.answerCallbackQuery("Checking Solana balance…");
  const result=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from.id]);
  if(!result.rowCount) return show(ctx,"No wallet has been created or imported yet.",{reply_markup:walletKb(ctx.session.walletReturnTo==="setup"?"setup":"menu")});
  try{
    const balance=await readSolBalance(result.rows[0].public_key);
    await patch(ctx.from.id,{wallet_balance:balance});
    const target=ctx.session.walletReturnTo==="setup"?"setup":"menu";
    return show(ctx,"💰 *YOUR TRADING WALLET*\\n\\nStatus: "+(balance>0?"FUNDED":"CREATED — NO SOL")+"\\nAddress: \\x60"+result.rows[0].public_key+"\\x60\\nBalance: *"+balance.toFixed(6)+" SOL*\\n\\nBalance checked from Solana RPC.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("🔄 REFRESH","wallet:refresh").row().text("⬅️ BACK",target).text("🏠 MAIN MENU","menu")});
  }catch(error){
    console.error("[wallet] balance refresh failed",(error as any)?.message||error);
    return show(ctx,"⚠️ *BALANCE CHECK FAILED*\\n\\nSolana RPC did not return a verified balance. Check the RPC endpoint and try again. No balance has been assumed.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 TRY AGAIN","wallet:refresh").row().text("⬅️ BACK",ctx.session.walletReturnTo==="setup"?"setup":"menu").text("🏠 MAIN MENU","menu")});
  }
});
bot.callbackQuery("review",async ctx=>{
  await ctx.answerCallbackQuery();
  const u=await user(ctx.from.id,ctx.from.username);
  const wallet=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from.id]);
  const missing:string[]=[];
  if(!u.buy_amount)missing.push("Buy Amount");
  if(!u.tp_config)missing.push("Take Profit");
  if(!u.sl_percent)missing.push("Stop Loss");
  if(!u.filters)missing.push("Filters");
  if(!u.alerts)missing.push("Alerts");
  if(!wallet.rowCount)missing.push("Wallet");
  let balanceLine="Wallet balance: NOT VERIFIED";
  if(wallet.rowCount){
    try{const balance=await readSolBalance(wallet.rows[0].public_key);await patch(ctx.from.id,{wallet_balance:balance});balanceLine="Wallet balance: "+balance.toFixed(6)+" SOL";if(balance<=0)missing.push("Funded Wallet");}
    catch{missing.push("Verified wallet balance");}
  }
  const filters=u.filters||{};const tp=u.tp_config?.targets?.map((t:any)=>"+"+t.pct+"% sell "+t.sellPct+"%").join(", ")||"Not set";const alerts=u.alerts||{};
  const optional=["newToken","liquidity","volume","bonding"].filter(k=>alerts[k]).join(", ")||"None";
  const txt="🧾 *CONFIGURATION REVIEW*\\n\\n💰 Buy: "+(u.buy_amount||"Not set")+" SOL\\n🎯 Take Profit: "+tp+"\\n🛑 Stop Loss: "+(u.sl_percent??"Not set")+"%\\n🔎 Market: "+(filters.type||"Not set")+"\\nMC: $"+(filters.minMc??"—")+" – $"+(filters.maxMc??"—")+"\\nLiquidity: ≥ $"+(filters.minLiquidity??"—")+"\\n5M volume: ≥ $"+(filters.minVolume5m??"—")+"\\nHolders: ≥ "+(filters.minHolders??"—")+"\\nTop 10: ≤ "+(filters.maxTop10??"—")+"%\\nDev: ≤ "+(filters.maxDev??"—")+"%\\nSmart filters: "+(filters.smart===false?"OFF":"ON")+"\\n🔔 Mandatory trade alerts: ON\\nOptional alerts: "+optional+"\\n"+balanceLine+"\\n\\n"+(missing.length?"⚠️ *NOT READY*\\nMissing / unverified:\\n"+missing.map(x=>"❌ "+x).join("\\n")+"\\n\\n":"⚠️ *ENGINE NOT CONNECTED*\\n")+"No trading will start until scanner, safety and execution services are verified.";
  await show(ctx,txt,{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ EDIT SETTINGS","setup").row().text("🏠 MAIN MENU","menu")});
});
bot.callbackQuery("activate",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);const wallet=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from.id]);const missing:string[]=[];if(!u.buy_amount)missing.push("Buy Amount");if(!u.tp_config)missing.push("Take Profit");if(!u.sl_percent)missing.push("Stop Loss");if(!u.filters)missing.push("Filters");if(!u.alerts)missing.push("Alerts");if(!wallet.rowCount)missing.push("Wallet");if(missing.length)return show(ctx,"⚠️ *TRADING NOT READY*\n\n"+missing.map(x=>"❌ "+x).join("\n"),{parse_mode:"Markdown",reply_markup:setupKb()});return show(ctx,"⚠️ *TRADING NOT READY*\n\nYour settings are saved, but live Solana balance verification, scanner, safety evaluator and execution adapter are not connected and verified.\n\nNo trade has been started.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ EDIT SETTINGS","setup").row().text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("trade:start",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);const wallet=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from.id]);const missing:string[]=[];if(!u.buy_amount)missing.push("Buy Amount");if(!u.tp_config)missing.push("Take Profit");if(!u.sl_percent)missing.push("Stop Loss");if(!u.filters)missing.push("Filters");if(!u.alerts)missing.push("Alerts");if(!wallet.rowCount)missing.push("Wallet");if(missing.length)return show(ctx,"⚠️ *TRADING NOT READY*\n\n"+missing.map(x=>"❌ "+x).join("\n"),{parse_mode:"Markdown",reply_markup:setupKb()});return show(ctx,"⚠️ *TRADING ENGINE UNAVAILABLE*\n\nYour wallet exists, but its live SOL balance has not been verified. The scanner, safety evaluator and execution adapter are also not connected.\n\nNo trade was started and no funding balance is being assumed.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("💰 WALLET","wallet").text("⚙️ TRADE SETUP","setup").row().text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("trade:stop",async ctx=>{await ctx.answerCallbackQuery();await show(ctx,"⏹️ *STOP TRADING?*\n\nNew entries will stop. Existing positions are not automatically closed.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⏹️ YES, STOP","trade:stop:confirm").text("↩️ KEEP RUNNING","menu")});});
bot.callbackQuery("trade:stop:confirm",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{trading_active:false});await recordAdminEvent(pool,"trading_stopped",{telegram_id:ctx.from.id},"ACTION");await notifyAdmin(bot,"trading_stopped",{telegram_id:ctx.from.id});await show(ctx,"⏹️ *TRADING STOPPED*\n\nNo new entries will be opened.",{parse_mode:"Markdown",reply_markup:mainKb(false,"autopilot")});});
bot.callbackQuery("positions",async ctx=>{await ctx.answerCallbackQuery();await show(ctx,"📊 *POSITIONS*\n\nNo live position adapter is connected. No fake positions are shown.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 REFRESH","positions").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("activity",async ctx=>{await ctx.answerCallbackQuery();await show(ctx,"📡 *ACTIVITY*\n\nNo live execution events are connected yet.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 REFRESH","activity").text("🏠 MAIN MENU","menu")});});

bot.on("message:text",async ctx=>{
  if(!ctx.session.input)return;
  const raw=ctx.message.text.trim();
  if(ctx.session.input==="wallet_import"){
    ctx.session.input=undefined;
    try{await ctx.deleteMessage();}catch{}
    try{
      const bytes=raw.startsWith("[")?Uint8Array.from(JSON.parse(raw)):bs58.decode(raw);
      const keypair=Keypair.fromSecretKey(bytes);
      const address=await saveWallet(ctx.from.id,keypair);
      await recordAdminEvent(pool,"wallet_imported",{telegram_id:ctx.from.id,wallet_address:address},"ACTION");
      return show(ctx,"✅ *WALLET IMPORTED*\n\nYour Solana private key was validated and encrypted before storage.\n\nAddress:\n\x60"+address+"\x60\n\nYour submitted message was deleted where Telegram permitted it.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("↩️ RETURN TO WALLET","wallet")});
    }catch(error){
      console.error("[wallet] import failed",error);
      return show(ctx,"⚠️ *IMPORT FAILED*\n\nThe key was invalid, encryption is not configured, or a wallet already exists. No existing wallet was overwritten.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("📥 TRY AGAIN","wallet:import").row().text("↩️ RETURN","wallet")});
    }
  }
  if(ctx.session.input==="buy"){
    const v=Number(raw);if(!Number.isFinite(v)||v<=0)return show(ctx,"⚠️ Enter a valid positive SOL amount.");
    await patch(ctx.from.id,{buy_amount:v});ctx.session.input=undefined;return show(ctx,"✅ BUY AMOUNT SAVED\n\nTrade size: "+v+" SOL",{reply_markup:setupKb()});
  }
  if(ctx.session.input==="sl"){
    const v=Number(raw);if(!Number.isFinite(v)||v>=0||v<-100)return show(ctx,"⚠️ Enter a stop loss between -1 and -100.");
    await patch(ctx.from.id,{sl_percent:v});ctx.session.input=undefined;return show(ctx,"✅ STOP LOSS SAVED\n\nSL: "+v+"%",{reply_markup:setupKb()});
  }
  if(ctx.session.input?.startsWith("filter_")){
    const field=ctx.session.input.slice(7) as FilterField;const value=Number(raw);
    const valid=Number.isFinite(value)&&value>=0&&((field!=="maxTop10"&&field!=="maxDev")||value<=100)&&((field!=="minHolders"&&field!=="minAgeSec"&&field!=="maxAgeMin")||Number.isInteger(value));
    if(!valid)return show(ctx,"⚠️ Enter a valid non-negative number. Percentages must be 0–100; holder count and age values must be whole numbers.");
    const u=await user(ctx.from.id,ctx.from.username);const current=u.filters||{type:"both",minMc:3000,maxMc:50000,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30,smart:true};
    const next={...current,[field]:value};if(next.minMc>next.maxMc)return show(ctx,"⚠️ Minimum market cap cannot exceed maximum market cap.");
    await patch(ctx.from.id,{filters:next});ctx.session.input=undefined;
    return show(ctx,"✅ FILTER SAVED\\n\\n"+field+": "+value+"\\n\\nYour other filter settings were preserved.",{reply_markup:filterKb()});
  }
  if(ctx.session.input==="tp"){
    const v=Number(raw);if(!Number.isFinite(v)||v<=0||v>1000)return show(ctx,"⚠️ Enter a positive take-profit target between 1% and 1000%.");
    await patch(ctx.from.id,{tp_config:{type:"simple",targets:[{pct:v,sellPct:100}]}});ctx.session.input=undefined;return show(ctx,"✅ TAKE PROFIT SAVED\n\n+"+v+"% → sell 100%",{reply_markup:setupKb()});
  }
});
registerStrategySettings({ bot, pool, show, user, patch });
registerAdminConsole({ bot, pool, show });
registerMultiWallets({ bot, pool, show, recordAdminEvent });

bot.catch(e=>console.error("BOT_ERROR",e.error));
await init();
await ensureAdminAuditTable(pool);
await databaseSmokeTest();
await bot.api.setMyCommands([{command:"start",description:"Open LaPrint"},{command:"menu",description:"Main menu"},{command:"setup",description:"Trading setup"},{command:"mode",description:"Switch mode"},{command:"wallets",description:"Manage trading wallets"}]);
console.log("LaPrint V2 starting. ENGINE_MODE="+(process.env.ENGINE_MODE||"disabled"));
const pollingClient = await acquireTelegramPollingLock();
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[shutdown] received " + signal);
  bot.stop();
  try { await pollingClient.query("SELECT pg_advisory_unlock($1)", [TELEGRAM_POLL_LOCK]); } catch {}
  pollingClient.release();
  await pool.end();
};
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
const me = await bot.api.getMe();
console.log("[telegram] authenticated as @" + me.username);
while (!shuttingDown) {
  try {
    await bot.start({onStart:i=>console.log("Bot @"+i.username+" running")});
    break;
  } catch (error) {
    const err = error as { error_code?: number; description?: string };
    if (err?.error_code === 409 || String(err?.description || error).includes("409: Conflict")) {
      console.error("[telegram] polling conflict; retrying after 5 seconds while previous deploy drains");
      await sleep(5000);
      continue;
    }
    throw error;
  }
}