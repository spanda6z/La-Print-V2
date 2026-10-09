import "dotenv/config";
import { Bot, Context, InlineKeyboard, session, SessionFlavor } from "grammy";
import pg from "pg";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { notifyAdmin, getAdminIds } from "./admin-notifications.js";
import { registerAdminConsole, recordAdminEvent } from "./admin-console.js";
import { registerStrategySettings } from "./settings-v2.js";
import { registerMultiWallets, ensureMultiWalletSchema } from "./multi-wallets.js";
import { ensureEngineSchema, startEngine, getScannerView, getScannerToken, executeQualifiedEntry, manualScanToken } from "./engine.js";
import { uiHeader, uiSection, uiFooter, uiKeyboard, mainMenuKeyboard, navigationKeyboard } from "./ui.js";
import { startWebServer } from "./web.js";

const { Pool } = pg;
const token = process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
type FilterField = "minMc"|"maxMc"|"minLiquidity"|"minVolume5m"|"minHolders"|"maxTop10"|"maxDev"|"minAgeSec"|"maxAgeMin";
type Session = { input?: "buy"|"sl"|"tp"|"wallet_import"|`filter_${FilterField}`; walletReturnTo?: "setup"|"menu"; onboardingWallet?: boolean };
type Ctx = Context & SessionFlavor<Session>;
const bot = new Bot<Ctx>(token);
function terminalHeader(screen: string) { return "🚀 *LA-PRINT ┃ " + screen + "*\\n━━━━━━━━━━━━━━━━━━━━"; }
function terminalSection(label: string) { return "▸ " + label.toUpperCase(); }
function terminalAction(label: string, tone: "primary"|"success"|"danger" = "primary") { return (tone==="success"?"🟢":tone==="danger"?"🔴":"🔵")+" ⟪ "+label+" ⟫"; }
function styleBotMessage(message: string) {
  const opening = message.split("\n").slice(0, 3).join("\n");
  if (/LA[\s-]?PRINT/i.test(opening)) return message;
  return "⚡ *LA-PRINT ┃ TERMINAL*\n━━━━━━━━━━━━━━━━━━━━\n\n" + message;
}

async function show(ctx: Ctx, message: string, extra: any = {}) {
  const styledMessage = styleBotMessage(message);
  if (ctx.callbackQuery && "message" in ctx.callbackQuery && ctx.callbackQuery.message) {
    try { return await ctx.editMessageText(styledMessage, extra); }
    catch (error) {
      const description = String((error as any)?.description || (error as any)?.message || error);
      if (description.includes("message is not modified")) return;
      if (!description.includes("message to edit") && !description.includes("can't be edited") && !description.includes("message can't be edited")) throw error;
    }
  }
  return ctx.reply(styledMessage, extra);
}
bot.use(session({ initial: (): Session => ({}) }));
bot.use(async (ctx: Ctx, next) => {
  const id = ctx.from?.id;
  if (!id) return next();
  const admins = getAdminIds();
  if (admins.includes(id)) return next();
  try {
    const r = await pool.query("SELECT COALESCE(admin_blocked,FALSE) AS admin_blocked FROM public.users WHERE telegram_id=$1", [id]);
    if (r.rows[0]?.admin_blocked) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery("Account disabled").catch(() => {});
      else await ctx.reply("🚫 Your LA-PRINT account is currently disabled. Contact support if you believe this is a mistake.");
      return;
    }
  } catch (error) {
    console.error("[admin] account-status check failed", error);
  }
  return next();
});

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
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS terms_accepted BOOLEAN NOT NULL DEFAULT FALSE;
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
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS admin_blocked BOOLEAN NOT NULL DEFAULT FALSE;
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
    CREATE TABLE IF NOT EXISTS public.referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_telegram_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
      referred_telegram_id BIGINT NOT NULL UNIQUE REFERENCES public.users(telegram_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      reward_sol NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS referrals_referrer_created_idx
      ON public.referrals(referrer_telegram_id, created_at DESC);
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
  await ensureEngineSchema(pool);
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
  await pool.query(
    `INSERT INTO public.trading_wallets(telegram_id,name,public_key,encrypted_secret,encryption_iv,encryption_tag,is_active)
     VALUES($1,$2,$3,$4,$5,$6,TRUE)
     ON CONFLICT(public_key) DO UPDATE SET is_active=TRUE,updated_at=NOW()`,
    [telegramId,"Primary",address,secret.encrypted,secret.iv,secret.tag]
  );
  await pool.query("UPDATE public.trading_wallets SET is_active=FALSE,updated_at=NOW() WHERE telegram_id=$1 AND public_key<>$2",[telegramId,address]);
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

const modeKb = () => uiKeyboard([
  [["🎯 AUTOPILOT","mode:auto"],["✋ MANUAL","mode:manual"]],
  [["⬅️ BACK","menu"],["🏠 MAIN MENU","menu"]]
]);

const setupKb = (_u?:any) => {
  const k=new InlineKeyboard()
    .text("💰 BUY AMOUNT","setup:buy").text("🎯 TAKE PROFIT","setup:tp").row()
    .text("🛑 STOP LOSS","setup:sl").text("🔎 FILTERS","setup:filters").row()
    .text("🔔 ALERTS","setup:alerts").text("💰 WALLET","wallets").row()
    .text("🧾 REVIEW","review").row()
    .text("⬅️ BACK","mode:back").text("🏠 MAIN MENU","menu");
  return k;
};

const mainKb = (active:boolean,mode:string) => {
  const k=new InlineKeyboard();
  k.text(active ? (mode==="manual"?"⏹️ STOP FEED":"⏹️ STOP AUTOPILOT") : (mode==="manual"?"▶️ START FEED":"🚀 START"), active?"trade:stop":"trade:start").row();
  k.text("📊 POSITIONS","positions").text("📡 ACTIVITY","activity").row();
  k.text("🔔 ALERTS","alerts").text("⚙️ SETTINGS","setup").row();
  k.text("💰 WALLET","wallets").text("🔎 DISCOVER","discover").row();
  return k;
};

const buyKb=()=>uiKeyboard([
  [["0.01 SOL","buy:0.01"],["0.05 SOL","buy:0.05"]],
  [["0.10 SOL","buy:0.10"],["0.25 SOL","buy:0.25"]],
  [["✏️ CUSTOM AMOUNT","buy:custom"]],
  [["⬅️ BACK","setup"],["🏠 MAIN MENU","menu"]]
]);

const tpKb=()=>uiKeyboard([
  [["⚡ SIMPLE TP","tp:simple"],["🧠 PARTIAL EXITS","tp:partial"]],
  [["⬅️ BACK","setup"],["🏠 MAIN MENU","menu"]]
]);

const slKb=()=>uiKeyboard([
  [["-10%","sl:-10"],["-15%","sl:-15"]],
  [["-20%","sl:-20"],["-25%","sl:-25"]],
  [["✏️ CUSTOM STOP LOSS","sl:custom"]],
  [["⬅️ BACK","setup"],["🏠 MAIN MENU","menu"]]
]);

const filterKb=()=>uiKeyboard([
  [["🟢 PRE-BOND","filter:pre"],["🚀 NEW LAUNCHES","filter:new"]],
  [["🔥 BOTH","filter:both"]],
  [["⚙️ FILTER SETTINGS","filter:settings"],["🧠 SMART FILTERS","filter:smart"]],
  [["⬅️ BACK","setup"],["🏠 MAIN MENU","menu"]]
]);

const walletKb=(target="menu")=>uiKeyboard([
  [["➕ CREATE WALLET","mw:create"],["📥 IMPORT WALLET","mw:import"]],
  [["🔄 REFRESH BALANCE","wallets:refresh"]],
  [["⬅️ BACK",target],["🏠 MAIN MENU","menu"]]
]);

const alertKb=(a:any={})=>uiKeyboard([
  [["🟢 MILESTONES: ALWAYS ON","noop"]],
  [[(a.newToken?"☑":"☐")+" NEW TOKEN","alert:new"],[(a.liquidity?"☑":"☐")+" LIQUIDITY","alert:liq"]],
  [[(a.volume?"☑":"☐")+" VOLUME","alert:vol"],[(a.bonding?"☑":"☐")+" BONDING","alert:bond"]],
  [[(a.watchlist?"☑":"☐")+" WATCHLIST","alert:watch"]],
  [["💾 SAVE ALERTS","alert:save"]],
  [["⬅️ BACK","setup"],["🏠 MAIN MENU","menu"]]
]);

async function menu(ctx:Ctx){
  const u=await user(ctx.from!.id,ctx.from!.username);
  const active=Boolean(u.trading_active);
  const wallet=await pool.query("SELECT name,public_key,is_active FROM public.trading_wallets WHERE telegram_id=$1 AND is_active=TRUE LIMIT 1",[ctx.from!.id]);
  let balance=Number(u.wallet_balance||0);
  if(wallet.rowCount){
    try { balance=await readSolBalance(wallet.rows[0].public_key); await patch(ctx.from!.id,{wallet_balance:balance,...(balance>0?{funding_prompt_sent:false}:{})}); } catch {}
  }
  const configured=Boolean(u.buy_amount&&u.tp_config&&u.sl_percent&&u.filters&&u.alerts&&wallet.rowCount);
  const mode=u.mode==="manual"?"✋ Manual":u.mode==="autopilot"?"🎯 Autopilot":"⚪ Not configured";
  const text=[
    uiHeader("MAIN MENU"),
    "",
    "Welcome back to LA-PRINT.",
    "",
    uiSection("Trading Overview","📊"),
    "",
    "💰 Balance       "+(Number.isFinite(balance)?balance.toFixed(4):"—")+" SOL",
    "🎯 Mode          "+mode,
    "🟢 Status        "+(active?"Trading active":"Ready / stopped"),
    "⚙️ Setup         "+(configured?"Complete":"Needs configuration"),
    "",
    "LA-PRINT helps you discover qualified Solana tokens and manage them through your saved trading rules. Use the sections below to review your wallet, strategy, positions, referrals and support resources.",
    "",
    uiFooter()
  ].join("\n");
  return show(ctx,text,{parse_mode:"Markdown",reply_markup:mainMenuKeyboard(active,u.mode||"autopilot")});
}

async function modeScreen(ctx:Ctx){
  await user(ctx.from!.id,ctx.from!.username);
  await show(ctx,"🚀 LAPrINT TRADE\\n━━━━━━━━━━━━━━━━━━━━\\n\\n"+
    "Automated Solana trading for qualified token calls.\\n\\n"+
    "The bot scans the market using your configured filters and safety checks. You choose how a qualified call is handled.\\n\\n"+
    "🎯 AUTOPILOT\\nQualified calls can move into automatic execution using your saved buy, TP, SL and filter rules.\\n\\n"+
    "✋ MANUAL\\nQualified calls are sent to you first. You review the token and approve or reject the entry.\\n\\n"+
    "Wallet, trade rules, filters and alerts must be configured before trading can start.",{reply_markup:modeKb()});
}

async function setupScreen(ctx:Ctx){
  const u=await user(ctx.from!.id,ctx.from!.username);
  const wallet=await pool.query("SELECT id FROM public.trading_wallets WHERE telegram_id=$1 AND is_active=TRUE",[ctx.from!.id]);
  const missing=[!u.buy_amount?"Buy amount":null,!u.tp_config?"Take profit":null,!u.sl_percent?"Stop loss":null,!u.filters?"Filters":null,!u.alerts?"Alerts":null,!wallet.rowCount?"Wallet":null].filter(Boolean) as string[];
  const text=[
    uiHeader("TRADE SETUP","⚙️"),
    "",
    "Build a ready-to-use strategy or customize each rule yourself.",
    "",
    uiSection("SETUP STATUS","📊"),
    "",
    missing.length ? "⚠️ Next required: "+missing[0] : "✅ Your current setup is complete.",
    "",
    uiSection("READY-MADE SETUPS","🛡️"),
    "",
    "Balanced and Aggressive presets configure the core trading rules for you.",
    "",
    uiSection("CUSTOM SETUP","✏️"),
    "",
    "Change buy size, TP, SL, filters, alerts and wallet settings individually.",
    "",
    uiFooter()
  ].join("\n");
  await show(ctx,text,{parse_mode:"Markdown",reply_markup:uiKeyboard([
    [["🛡️ BALANCED","preset:balanced"],["⚡ AGGRESSIVE","preset:aggressive"]],
    [["✏️ CUSTOMIZE SETUP","preset:custom"]],
    [["🧾 REVIEW CURRENT SETUP","review"]],
    [["⬅️ BACK","menu"],["🏠 MAIN MENU","menu"]]
  ])});
}

async function manualSetupScreen(ctx:Ctx){
  const u=await user(ctx.from!.id,ctx.from!.username);
  const wallet=await pool.query("SELECT id FROM public.trading_wallets WHERE telegram_id=$1 AND is_active=TRUE",[ctx.from!.id]);
  const text=[
    uiHeader("CUSTOM SETUP","⚙️"),
    "",
    "Adjust your trading rules one section at a time.",
    "",
    uiSection("CURRENT CONFIGURATION","📊"),
    "",
    "💰 Buy amount   "+(u.buy_amount?"✅ "+u.buy_amount+" SOL":"❌ Required"),
    "🎯 Take profit  "+(u.tp_config?"✅ Saved":"❌ Required"),
    "🛑 Stop loss    "+(u.sl_percent?"✅ "+u.sl_percent+"%":"❌ Required"),
    "🔎 Filters      "+(u.filters?"✅ Saved":"❌ Required"),
    "🔔 Alerts       "+(u.alerts?"✅ Saved":"❌ Required"),
    "👛 Wallet       "+(wallet.rowCount?"✅ Ready":"❌ Required"),
    "",
    uiFooter()
  ].join("\n");
  await show(ctx,text,{parse_mode:"Markdown",reply_markup:uiKeyboard([
    [["💰 BUY AMOUNT","setup:buy"],["🎯 TAKE PROFIT","setup:tp"]],
    [["🛑 STOP LOSS","setup:sl"],["🔎 FILTERS","setup:filters"]],
    [["🔔 ALERTS","setup:alerts"],["👛 WALLET","wallets"]],
    [["🧾 REVIEW SETUP","review"]],
    [["⬅️ BACK","setup"],["🏠 MAIN MENU","menu"]]
  ])});
}

async function setupDetails(ctx:Ctx){
  const u=await user(ctx.from!.id,ctx.from!.username),f=u.filters||{};
  const tp=u.tp_config?.targets?.map((t:any)=>"+"+t.pct+"% → sell "+t.sellPct+"%").join(" / ")||"Not set";
  const mode=u.mode==="manual"?"✋ Manual":"🎯 Autopilot";
  const text=[
    uiHeader("TRADING CONFIGURATION","⚙️"),
    "",
    "Review the rules currently used for qualified calls.",
    "",
    uiSection("TRADE RULES","🎯"),
    "",
    "💰 Buy amount     "+(u.buy_amount??"Not set")+" SOL",
    "🎯 Take profit    "+tp,
    "🛑 Stop loss      "+(u.sl_percent??"Not set")+"%",
    "",
    uiSection("DISCOVERY FILTERS","🔎"),
    "",
    "📈 Market cap     $"+(f.minMc??"—")+" → "+(f.maxMc==null?"∞":"$"+f.maxMc),
    "💧 Liquidity      ≥ $"+(f.minLiquidity??"—"),
    "📊 5M volume      ≥ $"+(f.minVolume5m??"—"),
    "⏱️ Token age      "+(f.minAgeSec??"—")+" sec → "+(f.maxAgeMin??"—")+" min",
    "👥 Holders        ≥ "+(f.minHolders??"—"),
    "🐳 Top 10         ≤ "+(f.maxTop10??"—")+"%",
    "👨‍💻 Developer      ≤ "+(f.maxDev??"—")+"%",
    "🧠 Smart filters  "+(f.smart===false?"OFF":"ON"),
    "",
    uiSection("STATUS","📊"),
    "",
    "🎯 Mode           "+mode,
    "🔔 Alerts         "+(u.alerts?"Configured":"Not set"),
    "",
    "Edit any rule before activating trading.",
    "",
    uiFooter()
  ].join("\n");
  await show(ctx,text,{parse_mode:"Markdown",reply_markup:uiKeyboard([
    [["✏️ EDIT SETTINGS","setup"]],
    [["🚀 AUTOPILOT","mode:auto"],["✋ MANUAL","mode:manual"]],
    [["🧾 FINAL REVIEW","review"]],
    [["🏠 MAIN MENU","menu"]]
  ])});
}

async function referralLink(ctx:Ctx){
  const me=await bot.api.getMe();
  return "https://t.me/"+me.username+"?start=ref_"+ctx.from!.id;
}
async function recordReferral(referrerId:number,referredId:number){
  if(referrerId===referredId)return false;
  const u=await pool.query("SELECT telegram_id FROM public.users WHERE telegram_id=$1",[referredId]);
  if(!u.rowCount)return false;
  const existing=await pool.query("SELECT id FROM public.referrals WHERE referred_telegram_id=$1",[referredId]);
  if(existing.rowCount)return false;
  const referrer=await pool.query("SELECT telegram_id FROM public.users WHERE telegram_id=$1",[referrerId]);
  if(!referrer.rowCount)return false;
  const inserted=await pool.query(
    "INSERT INTO public.referrals(referrer_telegram_id,referred_telegram_id) VALUES($1,$2) ON CONFLICT(referred_telegram_id) DO NOTHING",
    [referrerId,referredId]
  );
  return inserted.rowCount===1;
}

async function introScreen(ctx:Ctx){
  const text=[
    uiHeader("WELCOME","🚀"),
    "",
    "Trade qualified Solana tokens using your own rules.",
    "",
    uiSection("HOW LA-PRINT WORKS","💡"),
    "",
    "LA-PRINT finds tokens that match your configured filters and safety checks. You choose whether qualified calls are handled manually or automatically.",
    "",
    uiSection("BEFORE YOU START","📋"),
    "",
    "Review the bot terms, then create or import a trading wallet before configuring your strategy.",
    "",
    uiFooter()
  ].join("\n");
  await show(ctx,text,{parse_mode:"Markdown",reply_markup:uiKeyboard([
    [["➡️ CONTINUE","onboarding:terms"]]
  ])});
}

async function termsScreen(ctx:Ctx){
  const text=[
    uiHeader("ALPHATRADE RULES","📜"),
    "",
    "Crypto trading can cause total loss. AlphaTrade does not guarantee profit.",
    "",
    "• You are responsible for confirmed trades.",
    "• Execution depends on fees, slippage, liquidity and network conditions.",
    "• Safety checks reduce risk but cannot eliminate it.",
    "• Use a dedicated trading wallet.",
    "• Never share a seed phrase or private key.",
    "• Verify withdrawal addresses and transactions on-chain.",
    "• Automated trading can execute without a final manual confirmation after you enable it.",
    "• Emergency controls pause automation but do not reverse blockchain transactions.",
    "",
    "Read and accept these rules before continuing.",
    "",
    uiFooter()
  ].join("\n");
  await show(ctx,text,{parse_mode:"Markdown",reply_markup:uiKeyboard([
    [["📖 READ FULL TERMS","terms:full"]],
    [["✅ ACCEPT","terms:accept"],["❌ DECLINE","terms:decline"]],
    [["⬅️ BACK","onboarding:intro"],["🏠 MAIN MENU","menu"]]
  ])});
}

async function walletOnboardingScreen(ctx:Ctx){
  ctx.session.onboardingWallet=true;
  const text=[
    uiHeader("TRADING WALLET","👛"),
    "",
    "LA-PRINT needs a trading wallet before you can configure live trading.",
    "",
    uiSection("YOUR OPTIONS","🛠️"),
    "",
    "Create a new Solana trading wallet or import an existing wallet.",
    "",
    "The active wallet is used for trades you choose to execute.",
    "",
    "🔐 Keep your wallet credentials private and never share recovery information.",
    "",
    uiFooter()
  ].join("\n");
  await show(ctx,text,{parse_mode:"Markdown",reply_markup:uiKeyboard([
    [["🆕 CREATE WALLET","mw:create"],["📥 IMPORT WALLET","mw:import"]],
    [["⬅️ BACK","onboarding:terms"],["🏠 MAIN MENU","menu"]]
  ])});
}

async function termsFull(ctx:Ctx){
  const text=[
    uiHeader("ALPHATRADE RULES","📜"),
    "",
    "Crypto trading can cause total loss. AlphaTrade does not guarantee profit.",
    "",
    "• You are responsible for confirmed trades.",
    "• Execution depends on fees, slippage, liquidity and network conditions.",
    "• Safety checks reduce risk but cannot eliminate it.",
    "• Use a dedicated trading wallet.",
    "• Never share a seed phrase or private key.",
    "• Verify withdrawal addresses and transactions on-chain.",
    "• Automated trading can execute without a final manual confirmation after you enable it.",
    "• Emergency controls pause automation but do not reverse blockchain transactions.",
    "",
    "If you agree, return and accept the rules to continue."
  ].join("\n");
  return show(ctx,text,{parse_mode:"Markdown",reply_markup:uiKeyboard([
    [["⬅️ BACK TO RULES","onboarding:terms"]],
    [["🏠 MAIN MENU","menu"]]
  ])});
}

bot.command("start", async ctx => {
  const u=await user(ctx.from!.id,ctx.from!.username);
  const payload=typeof ctx.match==="string"?ctx.match.trim():"";
  if(payload.startsWith("ref_")){
    const referrerId=Number(payload.slice(4));
    if(Number.isSafeInteger(referrerId) && referrerId>0){
      try { await recordReferral(referrerId,ctx.from!.id); } catch(error) { console.error("[referral] attribution failed",error); }
    }
  }
  if(u.onboarding_complete) return menu(ctx);
  if(!u.terms_accepted) return introScreen(ctx);
  const wallet=await pool.query("SELECT id FROM public.trading_wallets WHERE telegram_id=$1 AND is_active=TRUE",[ctx.from!.id]);
  if(!wallet.rowCount) return walletOnboardingScreen(ctx);
  return menu(ctx);
});
bot.callbackQuery("onboarding:intro",async ctx=>{await ctx.answerCallbackQuery();return introScreen(ctx);});
bot.callbackQuery("onboarding:terms",async ctx=>{await ctx.answerCallbackQuery();return termsScreen(ctx);});
bot.callbackQuery("terms:full",async ctx=>{await ctx.answerCallbackQuery();return termsFull(ctx);});
bot.callbackQuery("terms:accept",async ctx=>{await ctx.answerCallbackQuery("Terms accepted");await patch(ctx.from!.id,{terms_accepted:true});return walletOnboardingScreen(ctx);});
bot.callbackQuery("terms:decline",async ctx=>{await ctx.answerCallbackQuery("Terms declined");return show(ctx,"❌ Terms declined\n\nYou must accept the bot terms before using LAPrINT trading features.",{reply_markup:new InlineKeyboard().text("📜 VIEW TERMS","onboarding:terms")});});
bot.callbackQuery("onboarding:dashboard",async ctx=>{await ctx.answerCallbackQuery("Trading configuration");return setupScreen(ctx);});
bot.command("menu", async ctx => menu(ctx));
bot.callbackQuery("menu", async ctx => { await ctx.answerCallbackQuery("Main menu"); return menu(ctx); });

bot.callbackQuery("mode:auto",async ctx=>{await ctx.answerCallbackQuery("Autopilot selected");const u=await user(ctx.from!.id,ctx.from!.username);if(!u.buy_amount||!u.tp_config||!u.sl_percent||!u.filters||!u.alerts)return setupScreen(ctx);await patch(ctx.from!.id,{mode:"autopilot"});return setupDetails(ctx);});
bot.callbackQuery("mode:manual",async ctx=>{await ctx.answerCallbackQuery("Manual selected");const u=await user(ctx.from!.id,ctx.from!.username);if(!u.buy_amount||!u.tp_config||!u.sl_percent||!u.filters||!u.alerts)return setupScreen(ctx);await patch(ctx.from!.id,{mode:"manual"});return setupDetails(ctx);});
bot.callbackQuery("mode:back",async ctx=>{await ctx.answerCallbackQuery();return modeScreen(ctx);});

bot.callbackQuery("setup",async ctx=>{await ctx.answerCallbackQuery();return setupScreen(ctx);});
bot.callbackQuery("preset:balanced",async ctx=>{
  await ctx.answerCallbackQuery("Balanced selected");
  await patch(ctx.from!.id,{buy_amount:0.10,tp_config:{type:"partial",targets:[{pct:40,sellPct:50},{pct:100,sellPct:25},{pct:200,sellPct:15}]},sl_percent:-15,filters:{type:"both",minMc:20000,maxMc:50000,minLiquidity:7000,minVolume5m:5000,minHolders:100,maxTop10:30,maxDev:5,minAgeSec:300,maxAgeMin:15,smart:true,strictData:true},alerts:{milestones:true,newToken:false,liquidity:false,volume:false,bonding:false,watchlist:false}});
  return show(ctx,"🛡️ Balanced setup selected.\n\n💰 Buy amount: 0.10 SOL\n🎯 Take profit: +40% / +100% / +200%\n🛑 Stop loss: -15%\n\n🔎 Market cap: $20K–$50K\n💧 Liquidity: $7K+\n📈 5M volume: $5K+\n⏱️ Token age: 5–15 minutes\n👥 Holders: 100+\n🐳 Top 10: ≤ 30%\n👨‍💻 Developer: ≤ 5%\n🧠 Smart Filters: ON\n🔔 Trade alerts: ON\n\nUse this setup as-is or edit it before activating trading.",{reply_markup:new InlineKeyboard().text("✅ USE THIS SETUP","preset:use").row().text("✏️ EDIT SETTINGS","setup:edit").row().text("⬅️ BACK","setup")});
});
bot.callbackQuery("preset:aggressive",async ctx=>{
  await ctx.answerCallbackQuery("Aggressive selected");
  await patch(ctx.from!.id,{buy_amount:0.25,tp_config:{type:"partial",targets:[{pct:50,sellPct:50},{pct:100,sellPct:25},{pct:200,sellPct:15}]},sl_percent:-20,filters:{type:"both",minMc:16000,maxMc:30000,minLiquidity:6000,minVolume5m:10000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:60,maxAgeMin:10,smart:true,strictData:true},alerts:{milestones:true,newToken:false,liquidity:false,volume:false,bonding:false,watchlist:false}});
  return show(ctx,"⚡ Aggressive setup selected.\n\n💰 Buy amount: 0.25 SOL\n🎯 Take profit: +50% / +100% / +200%\n🛑 Stop loss: -20%\n\n🔎 Market cap: $16K–$30K\n💧 Liquidity: $6K+\n📈 5M volume: $10K+\n⏱️ Token age: 1–10 minutes\n👥 Holders: 50+\n🐳 Top 10: ≤ 35%\n👨‍💻 Developer: ≤ 5%\n🧠 Smart Filters: ON\n🔔 Trade alerts: ON\n\nUse this setup as-is or edit it before activating trading.",{reply_markup:new InlineKeyboard().text("✅ USE THIS SETUP","preset:use").row().text("✏️ EDIT SETTINGS","setup:edit").row().text("⬅️ BACK","setup")});
});
bot.callbackQuery("preset:use",async ctx=>{
  await ctx.answerCallbackQuery("Setup saved");
  const u=await user(ctx.from!.id,ctx.from!.username);
  await patch(ctx.from!.id,{strategy_profile:u.buy_amount===0.25?"aggressive":"balanced",strategy_customized:false});
  return show(ctx,"✅ Trading setup saved.\n\nYour suggested configuration is now your active configuration.\n\nChoose how qualified calls should be handled.",{reply_markup:new InlineKeyboard().text("🎯 AUTOPILOT","preset:mode:auto").text("✋ MANUAL","preset:mode:manual").row().text("✏️ EDIT SETTINGS","setup:edit").text("🏠 MAIN MENU","menu")});
});
bot.callbackQuery("preset:mode:auto",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from!.id,{mode:"autopilot"});return setupDetails(ctx);});
bot.callbackQuery("preset:mode:manual",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from!.id,{mode:"manual"});return setupDetails(ctx);});
bot.callbackQuery("setup:edit",async ctx=>{await ctx.answerCallbackQuery();return manualSetupScreen(ctx);});
bot.callbackQuery("preset:custom",async ctx=>{await ctx.answerCallbackQuery();return manualSetupScreen(ctx);});
bot.callbackQuery("setup:buy",async ctx=>{await ctx.answerCallbackQuery();return show(ctx,"🚀 LAPrINT TRADE ┃ BUY AMOUNT\\n━━━━━━━━━━━━━━━━━━━━\\n\\nSet the SOL amount the bot will use for each new entry.\\n\\nThis value is applied to qualified trades after your other rules pass.",{reply_markup:buyKb()});});
bot.callbackQuery(/^buy:(0\\.01|0\\.05|0\\.10|0\\.25)$/,async ctx=>{await ctx.answerCallbackQuery();const v=Number(ctx.match[1]);await patch(ctx.from!.id,{buy_amount:v});return show(ctx,"✅ *BUY AMOUNT SAVED*\\n\\nTrade size: *"+v+" SOL*\\n\\nNext required setting: Take Profit.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🎯 SET TAKE PROFIT","setup:tp").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("buy:custom",async ctx=>{await ctx.answerCallbackQuery();ctx.session.input="buy";return show(ctx,"💰 *CUSTOM BUY AMOUNT*\\n\\nEnter the SOL amount for each trade.\\n\\nExample: 0.05",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu")});});

bot.callbackQuery("setup:tp",async ctx=>{await ctx.answerCallbackQuery();return show(ctx,"🚀 LAPrINT TRADE ┃ TAKE PROFIT\\n━━━━━━━━━━━━━━━━━━━━\\n\\nChoose how the bot should take profit after an entry.\\n\\nSimple TP exits the configured position at one target. Partial exits let the bot take profit at multiple milestones while keeping the remaining position open.",{reply_markup:tpKb()});});
bot.callbackQuery("tp:simple",async ctx=>{await ctx.answerCallbackQuery();return show(ctx,"🎯 *SIMPLE TP*\\n\\nChoose your target.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("+20%","tp:set:20").text("+40%","tp:set:40").row().text("+75%","tp:set:75").text("+100%","tp:set:100").row().text("✏️ CUSTOM","tp:custom").row().text("⬅️ BACK","setup")});});
bot.callbackQuery(/^tp:set:(20|40|75|100)$/,async ctx=>{await ctx.answerCallbackQuery();const v=Number(ctx.match[1]);await patch(ctx.from!.id,{tp_config:{type:"simple",targets:[{pct:v,sellPct:100}]}});return show(ctx,"✅ *TAKE PROFIT SAVED*\\n\\nTarget: *+"+v+"%* → sell 100%.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🛑 SET STOP LOSS","setup:sl").row().text("🔎 SET FILTERS","setup:filters").text("⬅️ BACK","setup")});});
bot.callbackQuery("tp:custom",async ctx=>{await ctx.answerCallbackQuery();ctx.session.input="tp";return show(ctx,"🎯 *CUSTOM TAKE PROFIT*\\n\\nEnter a positive target percentage. Example: 75",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("tp:partial",async ctx=>{await ctx.answerCallbackQuery();const targets=[{pct:40,sellPct:50},{pct:100,sellPct:25},{pct:200,sellPct:15}];await patch(ctx.from!.id,{tp_config:{type:"partial",targets}});return show(ctx,"🎯 *PARTIAL EXITS*\\n\\nTP1: +40% → Sell 50%\\nTP2: +100% → Sell 25%\\nTP3: +200% → Sell 15%\\nRemaining: 10%\\n\\n✅ TAKE PROFIT SAVED",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🛑 SET STOP LOSS","setup:sl").text("🔎 SET FILTERS","setup:filters").row().text("⬅️ BACK","setup")});});

bot.callbackQuery("setup:sl",async ctx=>{await ctx.answerCallbackQuery();return show(ctx,"🚀 LAPrINT TRADE ┃ STOP LOSS\\n━━━━━━━━━━━━━━━━━━━━\\n\\nSet the maximum percentage loss allowed for each position.\\n\\nWhen the configured stop is reached, the position management flow can trigger the exit.",{reply_markup:slKb()});});
bot.callbackQuery(/^sl:(-10|-15|-20|-25)$/,async ctx=>{await ctx.answerCallbackQuery();const v=Number(ctx.match[1]);await patch(ctx.from!.id,{sl_percent:v});return show(ctx,"✅ *STOP LOSS SAVED*\\n\\nSL: *"+v+"%*\\n\\nNext: configure your token filters.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔎 SET FILTERS","setup:filters").text("🔔 ALERTS","setup:alerts").row().text("⬅️ BACK","setup")});});
bot.callbackQuery("sl:custom",async ctx=>{await ctx.answerCallbackQuery();ctx.session.input="sl";return show(ctx,"🛑 *CUSTOM STOP LOSS*\\n\\nEnter a negative percentage between -1 and -100. Example: -20",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu")});});

bot.callbackQuery("setup:filters",async ctx=>{await ctx.answerCallbackQuery();return show(ctx,"🚀 LAPrINT TRADE ┃ TOKEN FILTERS\\n━━━━━━━━━━━━━━━━━━━━\\n\\nThe scanner can see the market, but only tokens that pass your saved rules can become qualified calls.\\n\\nChoose the market type first, then configure the market, liquidity, volume, holder, concentration, developer and Smart Filter checks.",{reply_markup:filterKb()});});
bot.callbackQuery(/^filter:(pre|new|both)$/,async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from!.id,ctx.from!.username);const type=ctx.match[1];const current=u.filters||{type:"both",minMc:16000,maxMc:null,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30,smart:true};const next={...current,type:type==="pre"?"pre":type==="new"?"new":"both"};await patch(ctx.from!.id,{filters:next});return show(ctx,"✅ *MARKET TYPE SAVED*\\n\\nMode: *"+next.type.toUpperCase()+"*\\n\\nMarket cap never qualifies below the hard $16K floor.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ FILTER SETTINGS","filter:settings").text("🧠 SMART FILTERS","filter:smart").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("filter:settings",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from!.id,ctx.from!.username);const f=u.filters||{type:"both",minMc:16000,maxMc:50000,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30,smart:true};const text="🔎 *FILTER SETTINGS*\\n\\nMarket Cap\\nMinimum: $"+f.minMc+"\\nMaximum: "+(f.maxMc==null?"$∞":"$"+f.maxMc)+"\\n\\nLiquidity\\nMinimum: $"+f.minLiquidity+"\\n\\n5M Volume\\nMinimum: $"+f.minVolume5m+"\\n\\nToken Age\\n"+f.minAgeSec+" seconds → "+f.maxAgeMin+" minutes\\n\\nHolders\\nMinimum: "+f.minHolders+"\\n\\nTop 10 Holders\\nMaximum: "+f.maxTop10+"%\\n\\nDev Holding\\nMaximum: "+f.maxDev+"%\\n\\nSmart Filters: "+(f.smart===false?"OFF":"ON");const k=new InlineKeyboard().text("💵 MARKET CAP","filter:edit:minMc").text("💧 LIQUIDITY","filter:edit:minLiquidity").row().text("📈 VOLUME","filter:edit:minVolume5m").text("👥 HOLDERS","filter:edit:minHolders").row().text("🐳 TOP HOLDERS","filter:edit:maxTop10").text("👨‍💻 DEV","filter:edit:maxDev").row().text("⏱️ TOKEN AGE","filter:edit:minAgeSec").text("🧠 SMART","filter:smart").row().text("✅ SAVE FILTERS","filter:save").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu");return show(ctx,text,{parse_mode:"Markdown",reply_markup:k});});
bot.callbackQuery("filter:save",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from!.id,ctx.from!.username);const f=u.filters||{};if(Number(f.minMc||0)<16000)return show(ctx,"⚠️ *FILTERS NOT SAVED*\\n\\nMinimum market cap cannot be below $16K.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("💵 MARKET CAP","filter:edit:minMc").text("⬅️ BACK","setup")});await patch(ctx.from!.id,{filters:{...f,minMc:Math.max(16000,Number(f.minMc||16000)),smart:f.smart!==false}});return show(ctx,"✅ *FILTERS SAVED*\\n\\nOnly tokens passing the configured combination of market, quality and safety checks can generate a call.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔔 SET ALERTS","setup:alerts").text("🧾 REVIEW","review").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery(/^filter:edit:(minMc|maxMc|minLiquidity|minVolume5m|minHolders|maxTop10|maxDev|minAgeSec|maxAgeMin)$/,async ctx=>{
  await ctx.answerCallbackQuery();const field=ctx.match[1] as FilterField;ctx.session.input=("filter_"+field) as Session["input"];
  const labels:Record<FilterField,string>={minMc:"minimum market cap in USD",maxMc:"maximum market cap in USD",minLiquidity:"minimum liquidity in USD",minVolume5m:"minimum 5-minute volume in USD",minHolders:"minimum holder count",maxTop10:"maximum top-10 holder concentration percentage",maxDev:"maximum developer holding percentage",minAgeSec:"minimum token age in seconds",maxAgeMin:"maximum token age in minutes"};
  await show(ctx,"✏️ *EDIT FILTER*\\n\\nEnter the "+labels[field]+".\\nNumbers only. Other filter settings will be preserved.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ CANCEL","filter:settings").text("🏠 MAIN MENU","menu")});
});
bot.callbackQuery("filter:smart",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from!.id,ctx.from!.username);const old=u.filters||{type:"both",minMc:16000,maxMc:null,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30};const next={...old,smart:old.smart===false};await patch(ctx.from!.id,{filters:next});await show(ctx,"🧠 *SMART FILTERS "+(next.smart?"ON":"OFF")+"*\\n\\n"+(next.smart?"Smart checks are enabled in your saved configuration.":"Smart checks are disabled in your saved configuration.")+"\\n\\nLive token qualification remains unavailable until the filter evaluator is connected.",{parse_mode:"Markdown",reply_markup:filterKb()});});

bot.callbackQuery(/^alert:(new|liq|vol|bond)$/,async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from!.id,ctx.from!.username);const old=u.alerts||{};const key=({new:"newToken",liq:"liquidity",vol:"volume",bond:"bonding"} as Record<string,string>)[ctx.match[1]];const next={...old,milestones:true,[key]:!old[key]};await patch(ctx.from!.id,{alerts:next});const k=new InlineKeyboard().text((next.newToken?"☑":"☐")+" NEW TOKEN","alert:new").text((next.liquidity?"☑":"☐")+" LIQUIDITY","alert:liq").row().text((next.volume?"☑":"☐")+" VOLUME","alert:vol").text((next.bonding?"☑":"☐")+" BONDING","alert:bond").row().text("💾 SAVE","alert:save").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu");await show(ctx,"🔔 *OPTIONAL ALERTS*\n\nTrade milestones: ALWAYS ON\nTap an option to toggle it. Your selection is saved immediately.",{parse_mode:"Markdown",reply_markup:k});});
bot.callbackQuery("alert:save",async ctx=>{await ctx.answerCallbackQuery();const old=(await user(ctx.from!.id,ctx.from!.username)).alerts||{};await patch(ctx.from!.id,{alerts:{...old,milestones:true}});await show(ctx,"✅ *ALERTS SAVED*\n\nTrade lifecycle milestones are always on. Optional market alerts are saved.",{parse_mode:"Markdown",reply_markup:setupKb()});});

bot.callbackQuery("setup:alerts",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from!.id,ctx.from!.username);return show(ctx,"🚀 LAPrINT TRADE ┃ ALERTS\\n━━━━━━━━━━━━━━━━━━━━\\n\\nTrade lifecycle alerts are always on so you never miss a qualified call, entry, TP, SL, exit or execution failure.\\n\\nThe options below control additional market alerts. Changes are saved as you toggle them.",{reply_markup:alertKb(u.alerts||{})});});
bot.callbackQuery("alerts",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from!.id,ctx.from!.username);return show(ctx,"🚀 LAPrINT TRADE ┃ ALERTS\\n━━━━━━━━━━━━━━━━━━━━\\n\\nTrade lifecycle alerts are always on so you never miss a qualified call, entry, TP, SL, exit or execution failure.\\n\\nThe options below control additional market alerts. Changes are saved as you toggle them.",{reply_markup:alertKb(u.alerts||{})});});
bot.callbackQuery("noop",async ctx=>ctx.answerCallbackQuery("Trade milestones are mandatory."));

bot.callbackQuery("wallet",async ctx=>{
  await ctx.answerCallbackQuery();
  ctx.session.walletReturnTo="menu";
  ctx.session.input=undefined;
  const result=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from!.id]);
  if(!result.rowCount) return show(ctx,"💰 *YOUR TRADING WALLET*\n\nNo wallet has been created or imported yet.\n\nChoose an option below.",{parse_mode:"Markdown",reply_markup:walletKb("menu")});
  return show(ctx,"💰 *YOUR TRADING WALLET*\n\nStatus: WALLET CREATED\nAddress: \x60"+result.rows[0].public_key+"\x60\n\nBalance: unavailable — live Solana RPC balance lookup is not connected yet.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("🔄 REFRESH","wallet:refresh").row().text("↩️ RETURN TO MAIN MENU","menu")});
});
bot.callbackQuery("wallet:setup",async ctx=>{await ctx.answerCallbackQuery();ctx.session.walletReturnTo="setup";ctx.session.input=undefined;const result=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from!.id]);if(!result.rowCount)return show(ctx,"💰 *WALLET*\n\nCreate or import your trading wallet. Live balance verification is not connected yet.",{parse_mode:"Markdown",reply_markup:walletKb("setup")});return show(ctx,"💰 *WALLET*\n\nAddress: `"+result.rows[0].public_key+"`\nBalance: unavailable — live RPC lookup is not connected.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔐 BACK UP","wallet:backup").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("wallet:create",async ctx=>{
  await ctx.answerCallbackQuery();
  const existing=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from!.id]);
  if(existing.rowCount) return show(ctx,"A wallet already exists. LaPrint will not replace it.",{reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("↩️ RETURN","wallet")});
  try {
    const keypair=Keypair.generate();
    const address=await saveWallet(ctx.from!.id,keypair);
    await recordAdminEvent(pool,"wallet_created",{telegram_id:ctx.from!.id,wallet_address:address},"ACTION");
    return show(ctx,address+"\\n"+bs58.encode(keypair.secretKey));
  } catch(error) {
    console.error("[wallet] create failed",error);
    return show(ctx,"⚠️ *WALLET NOT CREATED*\n\nWallet encryption is not configured or the operation failed. No wallet was saved.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ RETURN","wallet")});
  }
});
bot.callbackQuery("wallet:import",async ctx=>{
  await ctx.answerCallbackQuery();
  const existing=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from!.id]);
  if(existing.rowCount) return show(ctx,"A wallet already exists. Import will not overwrite it.",{reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("↩️ RETURN","wallet")});
  ctx.session.input="wallet_import";
  return show(ctx,"📥 *IMPORT SOLANA WALLET*\n\nSend your private key as a Base58 string or JSON secret-key array. Recovery phrases are not supported in this import screen.\n\nYour message will be deleted immediately where Telegram permits. Sending a key through Telegram still means Telegram processes that message; only continue if you accept that risk.\n\n↩️ Return to cancel.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ CANCEL / RETURN","wallet")});
});
bot.callbackQuery("wallet:backup",async ctx=>{
  await ctx.answerCallbackQuery();
  try {
    const secret=await walletBackup(ctx.from!.id);
    return show(ctx,"🔐 *PRIVATE WALLET BACKUP*\n\nBase58 private key:\n\n\x60"+secret+"\x60\n\nAnyone with this key can control your funds. Store it securely, then delete this message. LaPrint support will never ask for it.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ RETURN TO WALLET","wallet")});
  } catch(error) {
    console.error("[wallet] backup failed",error);
    return show(ctx,"⚠️ Wallet backup is unavailable. Check encryption configuration and wallet status.",{reply_markup:new InlineKeyboard().text("↩️ RETURN","wallet")});
  }
});
bot.callbackQuery("wallet:copy",async ctx=>{
  await ctx.answerCallbackQuery();
  const result=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from!.id]);
  if(!result.rowCount) return show(ctx,"No wallet was found.",{reply_markup:walletKb(ctx.session.walletReturnTo==="setup"?"setup":"menu")});
  return show(ctx,"📋 Wallet address:\n\x60"+result.rows[0].public_key+"\x60",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ RETURN","wallet")});
});
bot.callbackQuery("wallet:refresh",async ctx=>{
  await ctx.answerCallbackQuery("Checking Solana balance…");
  const result=await pool.query("SELECT public_key FROM public.wallets WHERE telegram_id=$1",[ctx.from!.id]);
  if(!result.rowCount) return show(ctx,"No wallet has been created or imported yet.",{reply_markup:walletKb(ctx.session.walletReturnTo==="setup"?"setup":"menu")});
  try{
    const balance=await readSolBalance(result.rows[0].public_key);
    await patch(ctx.from!.id,{wallet_balance:balance});
    const target=ctx.session.walletReturnTo==="setup"?"setup":"menu";
    return show(ctx,"💰 *YOUR TRADING WALLET*\\n\\nStatus: "+(balance>0?"FUNDED":"CREATED — NO SOL")+"\\nAddress: \\x60"+result.rows[0].public_key+"\\x60\\nBalance: *"+balance.toFixed(6)+" SOL*\\n\\nBalance checked from Solana RPC.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("🔄 REFRESH","wallet:refresh").row().text("⬅️ BACK",target).text("🏠 MAIN MENU","menu")});
  }catch(error){
    console.error("[wallet] balance refresh failed",(error as any)?.message||error);
    return show(ctx,"⚠️ *BALANCE CHECK FAILED*\\n\\nSolana RPC did not return a verified balance. Check the RPC endpoint and try again. No balance has been assumed.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 TRY AGAIN","wallet:refresh").row().text("⬅️ BACK",ctx.session.walletReturnTo==="setup"?"setup":"menu").text("🏠 MAIN MENU","menu")});
  }
});
async function readiness(ctx:Ctx){
  const u=await user(ctx.from!.id,ctx.from!.username);
  const wallet=await pool.query("SELECT id,name,public_key,is_active FROM public.trading_wallets WHERE telegram_id=$1 AND is_active=TRUE LIMIT 1",[ctx.from!.id]);
  const missing:string[]=[];
  if(u.buy_amount==null)missing.push("Buy amount");
  if(u.tp_config==null)missing.push("Take profit");
  if(u.sl_percent==null)missing.push("Stop loss");
  if(u.filters==null)missing.push("Filters");
  if(u.alerts==null)missing.push("Alerts");
  if(!wallet.rowCount)missing.push("Wallet");
  let balance=0;
  if(wallet.rowCount){
    try{balance=await readSolBalance(wallet.rows[0].public_key);await patch(ctx.from!.id,{wallet_balance:balance,...(balance>0?{funding_prompt_sent:false}:{})});}
    catch{missing.push("Verified wallet balance");}
  }
  if(wallet.rowCount && balance<=0 && !missing.includes("Verified wallet balance"))missing.push("Funded wallet");
  if(!missing.length || !missing.some(x=>x!=="Verified wallet balance"&&x!=="Funded wallet")){
    const f=u.filters||{},base=u.strategy_config||{};
    const marketTypes=f.type==="pre"?["pre_bond"]:f.type==="new"?["new_launch"]:["new_launch","pre_bond"];
    const cfg={
      ...base,profile:u.strategy_profile||base.profile||"balanced",customized:true,
      version:Number(base.version||u.strategy_version||1)+1,
      discovery:{...(base.discovery||{}),marketCapMin:Math.max(16000,Number(f.minMc||16000)),marketCapMax:f.maxMc==null?null:Number(f.maxMc),liquidityMin:Number(f.minLiquidity||5000),volume5mMin:Number(f.minVolume5m||2000),tokenAgeMinSec:Number(f.minAgeSec||30),tokenAgeMaxSec:f.maxAgeMin==null?1800:Number(f.maxAgeMin)*60,holderMin:Number(f.minHolders||50),top10Max:Number(f.maxTop10??35),devMax:Number(f.maxDev??5),marketTypes,smartFilters:f.smart!==false,strictData:f.strictData!==false},
      execution:{...(base.execution||{}),buyAmountSol:Number(u.buy_amount),maxBuyAmountSol:Number(u.buy_amount),takeProfit:u.tp_config?.targets||[],stopLossPct:Number(u.sl_percent),trailing:base.execution?.trailing||{enabled:false,activationPct:30,pullbackPct:15},maxOpenPositions:base.execution?.maxOpenPositions||3,dailySpendingLimitSol:base.execution?.dailySpendingLimitSol??null}
    };
    await patch(ctx.from!.id,{strategy_config:cfg,strategy_profile:cfg.profile,strategy_version:cfg.version});
  }
  return {u:await user(ctx.from!.id,ctx.from!.username),wallet:wallet.rows[0]||null,balance,missing};
}
bot.callbackQuery("review",async ctx=>{
  await ctx.answerCallbackQuery("Reviewing setup…");
  const r=await readiness(ctx),u=r.u,f=u.filters||{},tp=u.tp_config?.targets?.map((t:any)=>"+"+t.pct+"% → sell "+t.sellPct+"%").join(" / ")||"Not set";
  const optional=["newToken","liquidity","volume","bonding","watchlist"].filter(k=>u.alerts?.[k]).join(", ")||"None";
  const text="🎯 *FINAL REVIEW*\\n\\n"+
    "*TRADE*\\n💰 Buy: "+(u.buy_amount??"Not set")+" SOL\\n🎯 TP: "+tp+"\\n🛑 SL: "+(u.sl_percent??"Not set")+"%\\n\\n"+
    "*FILTERS*\\n💵 MC: $"+(f.minMc??"—")+" → "+(f.maxMc==null?"∞":"$"+f.maxMc)+"\\n💧 Liquidity: ≥ $"+(f.minLiquidity??"—")+"\\n📈 5M Volume: ≥ $"+(f.minVolume5m??"—")+"\\n👥 Holders: ≥ "+(f.minHolders??"—")+"\\n🐳 Top 10: ≤ "+(f.maxTop10??"—")+"%\\n👨‍💻 Dev: ≤ "+(f.maxDev??"—")+"%\\n🧠 Smart Filters: "+(f.smart===false?"OFF":"ON")+"\\n\\n"+
    "*ALERTS*\\n📡 Trade milestones: ON\\nOptional alerts: "+optional+"\\n\\n"+
    "💰 Wallet: "+(r.wallet?"🟢 "+r.wallet.name:"🔴 Not configured")+"\\nBalance: "+(r.balance>0?r.balance.toFixed(4)+" SOL":"🔴 0 / not verified")+"\\n\\n"+
    (r.missing.length?"⚠️ *NOT READY*\\n"+r.missing.map(x=>"❌ "+x).join("\\n"):"🟢 *SETUP COMPLETE*\\nReady to activate when the execution engine is available.");
  const k=r.missing.length
    ? new InlineKeyboard().text("⚙️ EDIT SETTINGS","setup").row().text("💰 WALLET","wallets").text("⬅️ BACK","setup")
    : new InlineKeyboard().text("🚀 ENABLE "+(u.mode==="manual"?"MANUAL FEED":"AUTOPILOT"),"activate").row().text("⚙️ EDIT SETTINGS","setup").text("🏠 MAIN MENU","menu");
  return show(ctx,text,{parse_mode:"Markdown",reply_markup:k});
});

bot.callbackQuery("activate",async ctx=>{
  await ctx.answerCallbackQuery("Checking setup…");
  const r=await readiness(ctx);
  if(r.missing.length)return show(ctx,"⚠️ *TRADING NOT READY*\\n\\n"+r.missing.map(x=>"❌ "+x).join("\\n"),{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ TRADE SETUP","setup").text("💰 WALLET","wallets").row().text("🏠 MAIN MENU","menu")});
  await patch(ctx.from!.id,{onboarding_complete:true,trading_active:true});
  await recordAdminEvent(pool,"trading_started",{telegram_id:ctx.from!.id,wallet_address:r.wallet.public_key,mode:r.u.mode||"autopilot"},"ACTION");
  if(r.balance<=0){
    await patch(ctx.from!.id,{trading_active:false});
    return show(ctx,"💰 *FUND YOUR WALLET*\\n\\nYour wallet currently has 0 SOL.\\n\\nFund your wallet to enable trading and receive qualified trading calls.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("💰 FUND WALLET","mw:deposit:"+r.wallet.id).text("🔄 REFRESH","wallets:refresh").row().text("🏠 MAIN MENU","menu")});
  }
  const executionReady=process.env.ENGINE_MODE==="enabled" && process.env.LIVE_TRADING==="true" && process.env.LIVE_TRADING_ACK==="I_ACCEPT_REAL_SOLANA_TRANSACTIONS";
  const state=executionReady?"ACTIVE":"ARMED — EXECUTION UNAVAILABLE";
  return show(ctx,(r.u.mode==="manual"?"✋":"🎯")+" *"+(r.u.mode==="manual"?"MANUAL FEED":"AUTOPILOT")+" "+state+"*\\n\\n"+(executionReady?"Qualified calls can now enter the execution path.":"Your configuration is saved, but live execution is not enabled. No order will be sent until the execution safety gate is enabled.")+"\\n\\n"+(r.u.mode==="manual"?"You will review each qualified call.":"Only qualified calls matching your rules will reach Telegram."),{parse_mode:"Markdown",reply_markup:mainKb(true,r.u.mode||"autopilot")});
});

bot.callbackQuery("trade:start",async ctx=>{
  await ctx.answerCallbackQuery("Checking setup…");
  const r=await readiness(ctx);
  if(r.missing.length){
    await patch(ctx.from!.id,{trading_active:false});
    if(r.missing.includes("Funded wallet") && r.wallet && !r.u.funding_prompt_sent){
      if(await once(ctx.from!.id,"funding_prompt")){
        await patch(ctx.from!.id,{funding_prompt_sent:true});
        await ctx.api.sendMessage(ctx.from!.id,"💰 *FUND YOUR WALLET*\\n\\nYour wallet currently has 0 SOL.\\n\\nFund your wallet to enable trading and receive qualified trading calls.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("💰 FUND WALLET","mw:deposit:"+r.wallet.id).text("🔄 REFRESH","wallets:refresh").row().text("🏠 MAIN MENU","menu")});
      }
    }
    return show(ctx,"⚠️ *TRADING NOT READY*\\n\\n"+r.missing.map(x=>"❌ "+x).join("\\n")+"\\n\\nComplete the missing items, then try Start again.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ TRADE SETUP","setup").text("💰 WALLET","wallets").row().text("🏠 MAIN MENU","menu")});
  }
  await patch(ctx.from!.id,{onboarding_complete:true,trading_active:true});
  await recordAdminEvent(pool,"trading_started",{telegram_id:ctx.from!.id,wallet_address:r.wallet.public_key,mode:r.u.mode||"autopilot"},"ACTION");
  const executionReady=process.env.ENGINE_MODE==="enabled" && process.env.LIVE_TRADING==="true" && process.env.LIVE_TRADING_ACK==="I_ACCEPT_REAL_SOLANA_TRANSACTIONS";
  return show(ctx,(r.u.mode==="manual"?"✋":"🎯")+" *"+(r.u.mode==="manual"?"MANUAL FEED":"AUTOPILOT")+" "+(executionReady?"ACTIVE":"ARMED")+"*\\n\\n"+(executionReady?"The configured qualification rules are active.":"The configuration is active, but live execution remains gated. No trade has been opened.")+"\\n\\nOnly qualified tokens can reach Telegram.",{parse_mode:"Markdown",reply_markup:mainKb(true,r.u.mode||"autopilot")});
});

bot.callbackQuery("trade:stop",async ctx=>{
  await ctx.answerCallbackQuery();
  return show(ctx,"⏹️ *"+(((await user(ctx.from!.id,ctx.from!.username)).mode==="manual")?"STOP FEED?":"STOP AUTOPILOT?")+"*\\n\\nStopping prevents new entries. Existing positions remain active and continue their configured management rules.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⏹️ YES, STOP","trade:stop:confirm").text("↩️ KEEP RUNNING","menu")});
});
bot.callbackQuery("trade:stop:confirm",async ctx=>{
  await ctx.answerCallbackQuery("Stopped");
  const u=await user(ctx.from!.id,ctx.from!.username);
  await patch(ctx.from!.id,{trading_active:false});
  await recordAdminEvent(pool,"trading_stopped",{telegram_id:ctx.from!.id,mode:u.mode||"autopilot"},"ACTION");
  await notifyAdmin(bot,"trading_stopped",{telegram_id:ctx.from!.id});
  return show(ctx,"⏹️ *"+(u.mode==="manual"?"MANUAL FEED STOPPED":"AUTOPILOT STOPPED")+"*\\n\\nNo new entries will be opened. Existing positions are not automatically closed.",{parse_mode:"Markdown",reply_markup:mainKb(false,u.mode||"autopilot")});
});

bot.callbackQuery(/^alert:watch$/,async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from!.id,ctx.from!.username);const old=u.alerts||{};const next={...old,milestones:true,watchlist:!old.watchlist};await patch(ctx.from!.id,{alerts:next});return show(ctx,"🔔 *OPTIONAL ALERTS*\\n\\nWatchlist activity: "+(next.watchlist?"ON":"OFF")+"\\n\\nTrade lifecycle milestones remain ALWAYS ON.",{parse_mode:"Markdown",reply_markup:alertKb(next)});});
bot.callbackQuery(/^call:details:([1-9A-HJ-NP-Za-km-z]{32,44})$/,async ctx=>{
  await ctx.answerCallbackQuery();
  const row=await getScannerToken(pool,ctx.from!.id,ctx.match[1]);
  if(!row)return show(ctx,"⚠️ *CALL EXPIRED*\\n\\nThis qualified call is no longer available.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("📡 ACTIVITY","activity").text("🏠 MAIN MENU","menu")});
  const m=scannerMarketData(row),u=await user(ctx.from!.id,ctx.from!.username);
  const text="📊 *CALL DETAILS*\\n\\n"+(row.symbol||"UNKNOWN")+"\\n\\nCA:\\n`"+row.address+"`\\n\\n💵 MC: "+scannerMoney(m.marketCap)+"\\n💧 Liquidity: "+scannerMoney(m.liquidity)+"\\n📈 5M Volume: "+scannerMoney(m.volume5m)+"\\n👥 Holders: "+scannerNum(m.holders)+"\\n🐳 Top 10: "+(m.top10==null?"—":m.top10+"%")+"\\n👨‍💻 Dev: "+(m.dev==null?"—":m.dev+"%")+"\\n\\nQualification: 🟢 PASSED";
  const k=new InlineKeyboard().text("📋 COPY CA","call:copy:"+row.address);
  if(u.mode==="manual")k.row().text("✅ APPROVE","call:approve:"+row.address).text("❌ REJECT","call:reject:"+row.address);
  k.row().text("🏠 MAIN MENU","menu");
  return show(ctx,text,{parse_mode:"Markdown",reply_markup:k});
});
bot.callbackQuery(/^call:copy:([1-9A-HJ-NP-Za-km-z]{32,44})$/,async ctx=>{await ctx.answerCallbackQuery("CA ready");return show(ctx,"📋 *TOKEN CA*\\n\\n`"+ctx.match[1]+"`\\n\\nCopy the address above.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⬅️ BACK","menu").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery(/^call:reject:([1-9A-HJ-NP-Za-km-z]{32,44})$/,async ctx=>{await ctx.answerCallbackQuery("Rejected");const u=await user(ctx.from!.id,ctx.from!.username);if(u.mode!=="manual")return show(ctx,"⚠️ Reject is available only in Manual mode.",{reply_markup:new InlineKeyboard().text("🏠 MAIN MENU","menu")});await pool.query("INSERT INTO public.engine_events(telegram_id,event_type,token_address,details) VALUES($1,$2,$3,$4)",[ctx.from!.id,"call_rejected",ctx.match[1],{mode:"manual"}]);return show(ctx,"❌ *CALL REJECTED*\\n\\n`"+ctx.match[1]+"`\\n\\nNo trade was opened. The call has been recorded in Activity.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("📡 NEXT CALL","menu").text("📜 ACTIVITY","activity").row().text("🏠 MAIN MENU","menu")});});
bot.callbackQuery(/^call:approve:([1-9A-HJ-NP-Za-km-z]{32,44})$/,async ctx=>{
  await ctx.answerCallbackQuery("Checking execution…");
  const u=await user(ctx.from!.id,ctx.from!.username);
  if(u.mode!=="manual")return show(ctx,"⚠️ Approve is available only in Manual mode.",{reply_markup:new InlineKeyboard().text("🏠 MAIN MENU","menu")});
  const r=await readiness(ctx);
  if(r.missing.length)return show(ctx,"⚠️ *TRADE NOT EXECUTED*\\n\\n"+r.missing.map(x=>"❌ "+x).join("\\n")+"\\n\\nNo position was opened.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ TRADE SETUP","setup").text("💰 WALLET","wallets").row().text("🏠 MAIN MENU","menu")});
  const live=process.env.ENGINE_MODE==="enabled"&&process.env.LIVE_TRADING==="true"&&process.env.LIVE_TRADING_ACK==="I_ACCEPT_REAL_SOLANA_TRANSACTIONS";
  if(!live)return show(ctx,"⚠️ *TRADE NOT EXECUTED*\\n\\nExecution is not enabled.\\n\\nNo position was opened.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("📊 VIEW DETAILS","call:details:"+ctx.match[1]).row().text("🏠 MAIN MENU","menu")});
  try{
    const strategy=Object.assign({},u.strategy_config||{}, {
      execution:Object.assign({},(u.strategy_config||{}).execution||{}, {
        buyAmountSol:Number(u.buy_amount),
        maxBuyAmountSol:Number((u.strategy_config||{}).execution?.maxBuyAmountSol ?? u.buy_amount),
        stopLossPct:Number(u.sl_percent),
        takeProfit:u.tp_config?.targets||[],
        dailySpendingLimitSol:(u.strategy_config||{}).execution?.dailySpendingLimitSol??null
      })
    });
    const tokenRow=await getScannerToken(pool,ctx.from!.id,ctx.match[1]);
    await executeQualifiedEntry(pool,bot,ctx.from!.id,ctx.match[1],tokenRow?.symbol||"UNKNOWN",strategy as any);
    return show(ctx,"🟢 *TRADE EXECUTED*\\n\\n`"+ctx.match[1]+"`\\n\\nEntry confirmed on-chain and position tracking started.\\nBuy: "+u.buy_amount+" SOL.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("📡 ACTIVITY","activity").text("🏠 MAIN MENU","menu")});
  }catch(error){const reason=String((error as any)?.message||error).slice(0,300);await pool.query("INSERT INTO public.engine_events(telegram_id,event_type,token_address,details) VALUES($1,$2,$3,$4)",[ctx.from!.id,"execution_failed",ctx.match[1],{reason}]);return show(ctx,"⚠️ *TRADE NOT EXECUTED*\\n\\nReason:\\n"+reason+"\\n\\nNo position was opened.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 TRY AGAIN","call:approve:"+ctx.match[1]).text("🏠 MAIN MENU","menu")});}
});
bot.callbackQuery("positions",async ctx=>{await ctx.answerCallbackQuery();const r=await pool.query("SELECT token_address,symbol,sol_spent,realized_pnl_sol,entry_price,remaining_amount,high_water_price,status,created_at FROM public.engine_positions WHERE telegram_id=$1 ORDER BY id DESC LIMIT 20",[ctx.from!.id]);if(!r.rowCount)return show(ctx,"📊 *POSITIONS*\n\nNo open or recorded positions yet.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 REFRESH","positions").text("🏠 MAIN MENU","menu")});const lines=r.rows.map((p:any)=>"• "+(p.symbol||"UNKNOWN")+"\n  "+p.status.toUpperCase()+" · Spent "+Number(p.sol_spent).toFixed(4)+" SOL\n  Realized PnL: "+Number(p.realized_pnl_sol).toFixed(6)+" SOL\n  CA: "+p.token_address);return show(ctx,"📊 *POSITIONS*\n\n"+lines.join("\n\n"),{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 REFRESH","positions").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("activity",async ctx=>{await ctx.answerCallbackQuery();const r=await pool.query("SELECT event_type,token_address,details,created_at FROM public.engine_events WHERE telegram_id=$1 ORDER BY id DESC LIMIT 12",[ctx.from!.id]);const lines=r.rows.map((e:any)=>"• "+e.event_type+" · "+(e.token_address||"system")+"\n  "+new Date(e.created_at).toISOString()+"\n  "+JSON.stringify(e.details||{}).slice(0,220));return show(ctx,"📡 *ACTIVITY*\n\n"+(lines.length?lines.join("\n\n"):"No execution events yet."),{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 REFRESH","activity").text("🏠 MAIN MENU","menu")});});

function scannerMarketData(row:any){
  const md=row?.market_data||{};
  const ov=md.overview||{};
  const listing=md.listing||{};
  const pick=(...keys:string[])=>{for(const k of keys){const v=ov?.[k]??listing?.[k];if(v!==undefined&&v!==null)return v;}return null;};
  return {price:pick("price","price_usd"),marketCap:pick("mc","market_cap","marketCap"),liquidity:pick("liquidity","liquidity_usd"),volume5m:pick("volume_5m_usd","v5m","volume5m"),holders:pick("holder","holders","holder_count"),top10:pick("top10_holder_percent","top10","top_10_holder_pct"),dev:pick("creator_percentage","creator_percent","dev_percent")};
}
function scannerMoney(v:any){const n=Number(v);return Number.isFinite(n)?"$"+Math.round(n).toLocaleString():"—";}
function scannerNum(v:any){const n=Number(v);return Number.isFinite(n)?n.toLocaleString():"—";}
function scannerKeyboard(status:"all"|"qualified"|"rejected",offset:number){
  const k=new InlineKeyboard().text("🟢 QUALIFIED","scanner:qualified:0").text("⚪ REJECTED","scanner:rejected:0")
    .row().text("🔄 REFRESH","scanner:refresh").text("🏠 MAIN MENU","menu")
    .row().text("⬅️ PREVIOUS","scanner:page:"+status+":"+Math.max(0,offset-5)).text("NEXT ➡️","scanner:page:"+status+":"+(offset+5));
  return k;
}
async function renderScanner(ctx:Ctx,status:"all"|"qualified"|"rejected"="all",offset=0){
  const data=await getScannerView(pool,ctx.from!.id,status,offset),c=data.counts;
  const lines=data.items.map((x:any,i:number)=>{
    const m=scannerMarketData(x),state=x.status==="qualified"?"🟢 QUALIFIED":"⚪ REJECTED";
    return (i+1)+". "+state+"  "+(x.symbol||"UNKNOWN")+"\n   MC "+scannerMoney(m.marketCap)+" · LP "+scannerMoney(m.liquidity)+" · 5m "+scannerMoney(m.volume5m)+"\n   "+(x.reject_reason||"Matches your saved strategy")+"\n   🔎 "+x.address;
  });
  const text="🔎 DISCOVER\n\nSCANNER: "+(process.env.SCANNER_MODE==="enabled"?"🟢 ACTIVE":"⚪ OFF")+"\nVIEW: "+status.toUpperCase()+"\n\n"+
    "Total evaluated: "+c.total+"\n🟢 Qualified: "+c.qualified+"\n⚪ Rejected: "+c.rejected+"\n\n"+
    (lines.length?lines.join("\n\n"):"No evaluated candidates yet.\n\nThe scanner only shows verified Birdeye discovery data; it does not create buy signals.");
  const keyboard=scannerKeyboard(status,offset);
  for(const item of data.items) keyboard.row().text("🔎 "+(item.symbol||"TOKEN"),"scanner:token:"+item.address);
  return show(ctx,text,{reply_markup:keyboard});
}
bot.callbackQuery("discover",async ctx=>{await ctx.answerCallbackQuery();return renderScanner(ctx);});
bot.callbackQuery("scanner:refresh",async ctx=>{await ctx.answerCallbackQuery("Refreshing scanner…");return renderScanner(ctx);});
bot.callbackQuery(/^scanner:(qualified|rejected):0$/,async ctx=>{await ctx.answerCallbackQuery();return renderScanner(ctx,ctx.match[1] as "qualified"|"rejected",0);});
bot.callbackQuery(/^scanner:page:(all|qualified|rejected):(\\d+)$/,async ctx=>{await ctx.answerCallbackQuery();return renderScanner(ctx,ctx.match[1] as "all"|"qualified"|"rejected",Number(ctx.match[2]));});
bot.callbackQuery(/^scanner:token:([1-9A-HJ-NP-Za-km-z]{32,44})$/,async ctx=>{
  await ctx.answerCallbackQuery();
  const row=await getScannerToken(pool,ctx.from!.id,ctx.match[1]);
  if(!row)return show(ctx,"🔎 TOKEN\n\nThis candidate is no longer in your scanner results.",{reply_markup:new InlineKeyboard().text("⬅️ DISCOVER","discover").text("🏠 MAIN MENU","menu")});
  const m=scannerMarketData(row);
  const text="🔎 "+(row.symbol||"UNKNOWN")+"\n\n"+(row.name||"Unknown token")+"\n\n"+
    "Status: "+(row.status==="qualified"?"🟢 QUALIFIED":"⚪ REJECTED")+"\nStrategy: "+(row.strategy_profile||"balanced")+"\nAddress:\n"+row.address+"\n\n"+
    "MC: "+scannerMoney(m.marketCap)+"\nLiquidity: "+scannerMoney(m.liquidity)+"\n5m Volume: "+scannerMoney(m.volume5m)+"\nHolders: "+scannerNum(m.holders)+"\nTop 10: "+(m.top10===null?"—":m.top10+"%")+"\nDev: "+(m.dev===null?"—":m.dev+"%")+"\nPrice: "+(m.price===null?"—":String(m.price))+"\n\n"+
    (row.reject_reason?"Reason: "+row.reject_reason:"Result: matches the saved discovery filters.")+"\n\nQualification is not a buy signal. Security fields are shown only when the upstream data provides them.";
  return show(ctx,text,{reply_markup:new InlineKeyboard().text("⬅️ DISCOVER","discover").text("🏠 MAIN MENU","menu")});
});


async function referralScreen(ctx:Ctx){
  const r=await pool.query(
    "SELECT COUNT(*)::int AS referrals, COALESCE(SUM(reward_sol),0) AS rewards FROM public.referrals WHERE referrer_telegram_id=$1 AND status='active'",
    [ctx.from!.id]
  );
  const stats=r.rows[0]||{referrals:0,rewards:0};
  const link=await referralLink(ctx);
  const text=[
    uiHeader("REFERRALS","🎁"),
    "",
    "Invite friends to AlphaTrade and earn eligible referral rewards.",
    "",
    uiSection("YOUR REFERRAL STATUS","📊"),
    "",
    "👥 Referrals       "+Number(stats.referrals||0),
    "💰 Rewards         "+Number(stats.rewards||0).toFixed(4)+" SOL",
    "",
    uiSection("YOUR LINK","🔗"),
    "",
    "`"+link+"`",
    "",
    "Share this link with a new user. Attribution is recorded when they start the bot with your referral link.",
    "",
    uiFooter()
  ].join("\n");
  const k=uiKeyboard([
    [["🔗 GET MY REFERRAL LINK","referral:link"]],
    [["📤 SHARE WITH FRIENDS","referral:share"]],
    [["📊 VIEW MY STATS","referral:stats"],["ℹ️ HOW IT WORKS","referral:info"]],
    [["⬅️ BACK","menu"],["🏠 MAIN MENU","menu"]]
  ]);
  return show(ctx,text,{parse_mode:"Markdown",reply_markup:k});
}

async function helpScreen(ctx:Ctx){
  const text=[
    uiHeader("HELP & SUPPORT","❓"),
    "",
    "Need help with LA-PRINT? Start with the topic that matches what you are trying to do.",
    "",
    uiSection("Support areas","📚"),
    "",
    "🚀 Trading — understand Manual and Autopilot execution.",
    "👛 Wallet — create, import, switch and fund a trading wallet.",
    "🎯 Strategy — configure entries, risk, TP and SL.",
    "📈 Positions — understand open positions and lifecycle updates.",
    "",
    "If the built-in guides do not answer your question, use Contact Support to reach the support channel.",
    "",
    uiFooter()
  ].join("\n");
  const k=new InlineKeyboard().text("🚀 TRADING GUIDE","help:trading").text("👛 WALLET HELP","help:wallet").row()
    .text("🎯 STRATEGY HELP","help:strategy").text("📈 POSITION HELP","help:positions").row()
    .text("💬 CONTACT SUPPORT","help:contact").text("🐛 REPORT A PROBLEM","help:report").row()
    .text("📚 DOCUMENTATION","docs").text("🏠 MAIN MENU","menu");
  return show(ctx,text,{parse_mode:"Markdown",reply_markup:k});
}
async function docsScreen(ctx:Ctx){
  const text=[
    uiHeader("DOCUMENTATION","📚"),
    "",
    "Learn how LA-PRINT works before enabling live trading.",
    "",
    uiSection("Guides","📖"),
    "",
    "🚀 Getting Started — onboarding, wallet and first setup.",
    "🤖 Autopilot — how qualified calls move through execution.",
    "✋ Manual Trading — review and approve calls yourself.",
    "🎯 Strategy & Risk — buy size, TP, SL and limits.",
    "👛 Wallets — wallet management and funding.",
    "",
    "Use the guide buttons below to open the relevant explanation.",
    "",
    uiFooter()
  ].join("\n");
  const k=new InlineKeyboard().text("🚀 GETTING STARTED","docs:start").text("🤖 AUTOPILOT","docs:auto").row()
    .text("✋ MANUAL","docs:manual").text("🎯 STRATEGY & RISK","docs:risk").row()
    .text("👛 WALLETS","docs:wallets").text("🏠 MAIN MENU","menu");
  return show(ctx,text,{parse_mode:"Markdown",reply_markup:k});
}
async function leaderboardScreen(ctx:Ctx){
  const text=[
    uiHeader("LEADERBOARD","🏆"),
    "",
    "See how traders are performing across the LA-PRINT community.",
    "",
    uiSection("Leaderboard","📊"),
    "",
    "🥇 #1   Coming soon",
    "🥈 #2   Coming soon",
    "🥉 #3   Coming soon",
    "",
    "The leaderboard will display verified trading performance once the community ranking system is enabled.",
    "",
    uiSection("Your standing","👤"),
    "",
    "🏅 Rank            —",
    "📈 Realized PnL     —",
    "🔥 Trades          —",
    "",
    uiFooter()
  ].join("\n");
  return show(ctx,text,{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 REFRESH","leaderboard").row().text("⬅️ BACK","menu").text("🏠 MAIN MENU","menu")});
}
bot.callbackQuery("referral",async ctx=>{await ctx.answerCallbackQuery();return referralScreen(ctx);});
bot.callbackQuery("referral:link",async ctx=>{
  await ctx.answerCallbackQuery("Referral link ready");
  const link=await referralLink(ctx);
  return show(ctx,[uiHeader("YOUR REFERRAL LINK","🔗"),"","Share this link with a new user:", "", "`"+link+"`","","When they start AlphaTrade from this link, the referral is attributed to you.","",uiFooter()].join("\n"),{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("📤 SHARE WITH FRIENDS","referral:share").row().text("⬅️ BACK","referral").text("🏠 MAIN MENU","menu")});
});
bot.callbackQuery("referral:share",async ctx=>{
  await ctx.answerCallbackQuery("Referral link ready");
  const link=await referralLink(ctx);
  return show(ctx,"🎁 *SHARE ALPHATRADE*\n\nInvite a friend to AlphaTrade:\n\n"+link+"\n\nSend this message to your friend in Telegram.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔗 VIEW MY LINK","referral:link").row().text("⬅️ BACK","referral").text("🏠 MAIN MENU","menu")});
});
bot.callbackQuery("referral:stats",async ctx=>{await ctx.answerCallbackQuery();return referralScreen(ctx);});
bot.callbackQuery("referral:info",async ctx=>{await ctx.answerCallbackQuery();return show(ctx,[uiHeader("REFERRAL PROGRAM","🎁"),"","The referral program is designed to reward users who bring new traders to LA-PRINT.","","Referral eligibility, attribution and rewards are recorded by the platform. Exact reward rules will be shown here when the program is active.","",uiFooter()].join("\n"),{parse_mode:"Markdown",reply_markup:navigationKeyboard("referral")});});
bot.callbackQuery("leaderboard",async ctx=>{await ctx.answerCallbackQuery();return leaderboardScreen(ctx);});
bot.callbackQuery("help",async ctx=>{await ctx.answerCallbackQuery();return helpScreen(ctx);});
bot.callbackQuery("docs",async ctx=>{await ctx.answerCallbackQuery();return docsScreen(ctx);});
bot.callbackQuery(/^help:(trading|wallet|strategy|positions)$/,async ctx=>{
  await ctx.answerCallbackQuery();
  const titles:{[key:string]:string}={trading:"TRADING GUIDE",wallet:"WALLET GUIDE",strategy:"STRATEGY GUIDE",positions:"POSITION GUIDE"};
  const body:{[key:string]:string}={
    trading:"LA-PRINT first evaluates a token against your configured rules. In Manual mode you review qualified calls before approval. In Autopilot mode qualifying calls can proceed automatically when all safety gates are satisfied.",
    wallet:"Your active wallet is the wallet used for new trades. Keep enough SOL available for the trade amount plus network fees. Refresh the balance whenever you fund the wallet.",
    strategy:"Your strategy controls entry size, maximum exposure, stop loss, take profit, position limits and other risk rules. Changes affect future entries.",
    positions:"Positions are monitored after entry. LA-PRINT can report take-profit milestones, stop-loss events, trailing exits and final closure as the position changes."
  };
  return show(ctx,[uiHeader(titles[ctx.match[1]],"📖"),"",body[ctx.match[1]],"","Use the buttons below to return to Help or the main menu.","",uiFooter()].join("\n"),{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("❓ HELP","help").text("📚 DOCS","docs").row().text("🏠 MAIN MENU","menu")});
});
bot.callbackQuery(/^docs:(start|auto|manual|risk|wallets)$/,async ctx=>{
  await ctx.answerCallbackQuery();
  const titles:{[key:string]:string}={start:"GETTING STARTED",auto:"AUTOPILOT",manual:"MANUAL TRADING",risk:"STRATEGY & RISK",wallets:"WALLETS"};
  const body:{[key:string]:string}={
    start:"Complete onboarding, accept the terms, create or import a wallet, configure your strategy, then review the setup before starting trading.",
    auto:"Autopilot watches for qualified calls and can execute according to your saved strategy when live execution is explicitly enabled.",
    manual:"Manual mode sends qualified calls to you first. Review the market and security information, then approve or reject the call.",
    risk:"Buy amount, stop loss, take-profit targets, maximum open positions and daily spending limits work together to control exposure.",
    wallets:"Manage the active trading wallet from Wallet. Fund it with SOL, refresh its RPC balance, and switch wallets when needed."
  };
  return show(ctx,[uiHeader(titles[ctx.match[1]],"📚"),"",body[ctx.match[1]],"","These guides explain the intended behavior; always review your configured values before enabling live execution.","",uiFooter()].join("\n"),{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("📚 DOCS","docs").text("❓ HELP","help").row().text("🏠 MAIN MENU","menu")});
});
registerAdminConsole({ bot, pool, show });

function isSolanaContractAddress(value:string){
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

async function renderManualScan(ctx:Ctx,address:string){
  const result=await manualScanToken(pool,ctx.from!.id,address);
  const c=result.candidate, r=result.result;
  const status=r.qualified?"🟢 QUALIFIED":"🔴 REJECTED";
  const reason=r.qualified?"Matches your saved strategy.":r.reasons.join(", ");
  const text=[
    uiHeader("MANUAL SCAN","🔎"),
    "",
    "Token contract scanned against your current LA-PRINT discovery and safety rules.",
    "",
    uiSection("TOKEN","🪙"),
    "",
    "🔥 *"+(c.symbol||"UNKNOWN")+"*",
    c.name||"Unknown token",
    "",
    "📍 CA",
    "`"+c.address+"`",
    "",
    uiSection("MARKET","📊"),
    "",
    "💵 Market Cap   "+(c.marketCap==null?"—":"$"+Math.round(c.marketCap).toLocaleString()),
    "💧 Liquidity    "+(c.liquidity==null?"—":"$"+Math.round(c.liquidity).toLocaleString()),
    "📈 5m Volume    "+(c.volume5m==null?"—":"$"+Math.round(c.volume5m).toLocaleString()),
    "👥 Holders      "+(c.holders==null?"—":c.holders.toLocaleString()),
    "🐳 Top 10       "+(c.top10==null?"—":c.top10+"%"),
    "👨‍💻 Dev          "+(c.devPct==null?"—":c.devPct+"%"),
    "💰 Price        "+(c.price==null?"—":String(c.price)),
    "",
    uiSection("SCAN RESULT","🛡️"),
    "",
    "Status: "+status,
    "Result: "+reason,
    "Mint: "+(c.security.mintAuthority==="REVOKED"?"✅ Disabled":c.security.mintAuthority),
    "Freeze: "+(c.security.freezeAuthority==="REVOKED"?"✅ Disabled":c.security.freezeAuthority),
    "Data: "+(c.security.verified?"✅ Verified":"⚠️ Unverified"),
    "",
    "⚠️ A manual scan is analysis only. No trade was opened automatically.",
    "",
    uiFooter()
  ].join("\n");
  const k=new InlineKeyboard().text("🔄 SCAN AGAIN","scan:again:"+address);
  if(r.qualified && result.mode==="manual"){
    k.row().text("🟢 APPROVE TRADE","call:approve:"+address).text("❌ REJECT","call:reject:"+address);
  }
  k.row().text("📡 DISCOVER","discover").text("🏠 MAIN MENU","menu");
  return show(ctx,text,{parse_mode:"Markdown",reply_markup:k});
}

bot.on("message:text",async ctx=>{
  const raw=ctx.message.text.trim();
  if(!ctx.session.input && isSolanaContractAddress(raw)){
    try{
      await ctx.reply("🔎 *LA-PRINT MANUAL SCAN*\n\nScanning the contract against your saved filters and safety checks…",{parse_mode:"Markdown"});
      return await renderManualScan(ctx,raw);
    }catch(error){
      const reason=String((error as any)?.message||error).slice(0,300);
      return ctx.reply("⚠️ *SCAN FAILED*\n\n"+reason+"\n\nNo trade was opened.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🏠 MAIN MENU","menu")});
    }
  }
});
bot.callbackQuery(/^scan:again:([1-9A-HJ-NP-Za-km-z]{32,44})$/,async ctx=>{
  await ctx.answerCallbackQuery("Scanning…");
  try{return await renderManualScan(ctx,ctx.match[1]);}
  catch(error){const reason=String((error as any)?.message||error).slice(0,300);return show(ctx,"⚠️ *SCAN FAILED*\\n\\n"+reason,{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🏠 MAIN MENU","menu")});}
});
bot.on("message:text",async ctx=>{
  if(!ctx.session.input)return;
  if(!ctx.session.input)return;
  const raw=ctx.message.text.trim();
  if(ctx.session.input==="wallet_import"){
    ctx.session.input=undefined;
    try{await ctx.deleteMessage();}catch{}
    try{
      const bytes=raw.startsWith("[")?Uint8Array.from(JSON.parse(raw)):bs58.decode(raw);
      const keypair=Keypair.fromSecretKey(bytes);
      const address=await saveWallet(ctx.from!.id,keypair);
      await recordAdminEvent(pool,"wallet_imported",{telegram_id:ctx.from!.id,wallet_address:address},"ACTION");
      return show(ctx,"✅ *WALLET IMPORTED*\n\nYour Solana private key was validated and encrypted before storage.\n\nAddress:\n\x60"+address+"\x60\n\nYour submitted message was deleted where Telegram permitted it.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔐 BACK UP WALLET","wallet:backup").row().text("↩️ RETURN TO WALLET","wallet")});
    }catch(error){
      console.error("[wallet] import failed",error);
      return show(ctx,"⚠️ *IMPORT FAILED*\n\nThe key was invalid, encryption is not configured, or a wallet already exists. No existing wallet was overwritten.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("📥 TRY AGAIN","wallet:import").row().text("↩️ RETURN","wallet")});
    }
  }
  if(ctx.session.input==="buy"){
    const v=Number(raw);if(!Number.isFinite(v)||v<=0)return show(ctx,"⚠️ Enter a valid positive SOL amount.");
    await patch(ctx.from!.id,{buy_amount:v});ctx.session.input=undefined;return show(ctx,"✅ BUY AMOUNT SAVED\n\nTrade size: "+v+" SOL",{reply_markup:setupKb()});
  }
  if(ctx.session.input==="sl"){
    const v=Number(raw);if(!Number.isFinite(v)||v>=0||v<-100)return show(ctx,"⚠️ Enter a stop loss between -1 and -100.");
    await patch(ctx.from!.id,{sl_percent:v});ctx.session.input=undefined;return show(ctx,"✅ STOP LOSS SAVED\n\nSL: "+v+"%",{reply_markup:setupKb()});
  }
  if(ctx.session.input?.startsWith("filter_")){
    const field=ctx.session.input.slice(7) as FilterField;const value=Number(raw);
    const valid=Number.isFinite(value)&&value>=0&&((field!=="maxTop10"&&field!=="maxDev")||value<=100)&&((field!=="minHolders"&&field!=="minAgeSec"&&field!=="maxAgeMin")||Number.isInteger(value));
    if(!valid)return show(ctx,"⚠️ Enter a valid non-negative number. Percentages must be 0–100; holder count and age values must be whole numbers.");
    const u=await user(ctx.from!.id,ctx.from!.username);const current=u.filters||{type:"both",minMc:3000,maxMc:50000,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30,smart:true};
    const next={...current,[field]:value};if(next.minMc>next.maxMc)return show(ctx,"⚠️ Minimum market cap cannot exceed maximum market cap.");
    await patch(ctx.from!.id,{filters:next});ctx.session.input=undefined;
    return show(ctx,"✅ FILTER SAVED\\n\\n"+field+": "+value+"\\n\\nYour other filter settings were preserved.",{reply_markup:filterKb()});
  }
  if(ctx.session.input==="tp"){
    const v=Number(raw);if(!Number.isFinite(v)||v<=0||v>1000)return show(ctx,"⚠️ Enter a positive take-profit target between 1% and 1000%.");
    await patch(ctx.from!.id,{tp_config:{type:"simple",targets:[{pct:v,sellPct:100}]}});ctx.session.input=undefined;return show(ctx,"✅ TAKE PROFIT SAVED\n\n+"+v+"% → sell 100%",{reply_markup:setupKb()});
  }
});
registerMultiWallets({ bot, pool, show, recordAdminEvent });
registerStrategySettings({ bot, pool, show, user, patch });

bot.catch(e=>console.error("BOT_ERROR",e.error));
await init();
await databaseSmokeTest();
await bot.api.setMyCommands([{command:"start",description:"Open LaPrint"},{command:"menu",description:"Main menu"},{command:"setup",description:"Trade Autopilot setup"},{command:"strategy",description:"Advanced strategy settings"},{command:"mode",description:"Switch mode"},{command:"wallets",description:"Manage trading wallets"},{command:"admin",description:"Open admin control center"}]);
console.log("LaPrint V2 starting. ENGINE_MODE="+(process.env.ENGINE_MODE||"disabled"));
const stopEngine = await startEngine(pool,bot);
const stopWebServer = startWebServer(pool,bot);
const pollingClient = await acquireTelegramPollingLock();
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[shutdown] received " + signal);
  bot.stop();
  stopEngine();
  stopWebServer();
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