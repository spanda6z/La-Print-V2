import "dotenv/config";
import { Bot, Context, InlineKeyboard, session, SessionFlavor } from "grammy";
import pg from "pg";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { notifyAdmin } from "./admin-notifications.js";
import { registerAdminConsole, recordAdminEvent } from "./admin-console.js";
import { registerStrategySettings } from "./settings-v2.js";
import { registerMultiWallets, ensureMultiWalletSchema } from "./multi-wallets.js";
import { ensureEngineSchema, startEngine, getScannerView, getScannerToken, executeJupiterSwap } from "./engine.js";

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

const modeKb = () => new InlineKeyboard()
  .text("🎯 AUTOPILOT","mode:auto").text("✋ MANUAL","mode:manual")
  .row().text("⬅️ BACK","menu").text("🏠 MAIN MENU","menu");

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

const buyKb=()=>new InlineKeyboard()
  .text("0.01 SOL","buy:0.01").text("0.05 SOL","buy:0.05").row()
  .text("0.10 SOL","buy:0.10").text("0.25 SOL","buy:0.25").row()
  .text("✏️ CUSTOM","buy:custom").row().text("⬅️ BACK","setup");

const tpKb=()=>new InlineKeyboard()
  .text("⚡ SIMPLE TP","tp:simple").text("🧠 PARTIAL EXITS","tp:partial").row()
  .text("⬅️ BACK","setup");

const slKb=()=>new InlineKeyboard()
  .text("-10%","sl:-10").text("-15%","sl:-15").row()
  .text("-20%","sl:-20").text("-25%","sl:-25").row()
  .text("✏️ CUSTOM","sl:custom").row().text("⬅️ BACK","setup");

const filterKb=()=>new InlineKeyboard()
  .text("🟢 PRE-BOND","filter:pre").text("🚀 NEW LAUNCHES","filter:new").row()
  .text("🔥 BOTH","filter:both").row()
  .text("⚙️ FILTER SETTINGS","filter:settings").text("🧠 SMART FILTERS","filter:smart").row()
  .text("⬅️ BACK","setup");

const walletKb=(target="menu")=>new InlineKeyboard().text("➕ CREATE WALLET","mw:create").text("📥 IMPORT WALLET","mw:import").row().text("🔄 REFRESH","wallets:refresh").row().text("⬅️ BACK",target).text("🏠 MAIN MENU","menu");
const alertKb=(a:any={})=>new InlineKeyboard()
  .text("🟢 MILESTONES: ALWAYS ON","noop").row()
  .text((a.newToken?"☑":"☐")+" NEW TOKEN","alert:new").text((a.liquidity?"☑":"☐")+" LIQUIDITY","alert:liq").row()
  .text((a.volume?"☑":"☐")+" VOLUME","alert:vol").text((a.bonding?"☑":"☐")+" BONDING","alert:bond").row()
  .text((a.watchlist?"☑":"☐")+" WATCHLIST","alert:watch").row()
  .text("💾 SAVE ALERTS","alert:save").row().text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu");

async function menu(ctx:Ctx){
  const u=await user(ctx.from!.id,ctx.from!.username);
  const active=Boolean(u.trading_active);
  const wallet=await pool.query("SELECT name,public_key,is_active FROM public.trading_wallets WHERE telegram_id=$1 AND is_active=TRUE LIMIT 1",[ctx.from!.id]);
  let balance=Number(u.wallet_balance||0);
  if(wallet.rowCount){
    try { balance=await readSolBalance(wallet.rows[0].public_key); await patch(ctx.from!.id,{wallet_balance:balance,...(balance>0?{funding_prompt_sent:false}:{})}); } catch {}
  }
  const configured=Boolean(u.buy_amount&&u.tp_config&&u.sl_percent&&u.filters&&u.alerts&&wallet.rowCount);
  const mode=u.mode==="manual"?"✋ MANUAL":u.mode==="autopilot"?"🎯 AUTOPILOT":"⚪ NOT CONFIGURED";
  const text="🚀 LAPrINT TRADE\\n\\n"+
    "Your trading dashboard.\\n\\n"+
    "💰 Balance: "+(Number.isFinite(balance)?balance.toFixed(4):"—")+" SOL\\n"+
    "🎯 Trading mode: "+mode+"\\n"+
    "📊 Open positions: 0\\n"+
    "📈 Realized PnL: 0 SOL\\n\\n"+
    (configured?"Your trading setup is ready.":"Set up your trading rules before starting. ");
  const k=new InlineKeyboard();
  if(!configured) k.text("⚙️ CONFIGURE TRADING","setup").row();
  else k.text(active?(u.mode==="manual"?"⏹️ STOP FEED":"⏹️ STOP AUTOPILOT"):(u.mode==="manual"?"▶️ START FEED":"🚀 START"),active?"trade:stop":"trade:start").row();
  k.text("🎯 AUTOPILOT","mode:auto").text("✋ MANUAL","mode:manual").row();
  k.text("💰 WALLET","wallets").text("📊 POSITIONS","positions").row();
  k.text("📡 ACTIVITY","activity").text("⚙️ SETTINGS","setup").row();
  k.text("🔎 DISCOVER","discover");
  await show(ctx,text,{reply_markup:k});
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
  const missing=[
    !u.buy_amount?"Buy amount":null,!u.tp_config?"Take profit":null,!u.sl_percent?"Stop loss":null,
    !u.filters?"Filters":null,!u.alerts?"Alerts":null,!wallet.rowCount?"Wallet":null
  ].filter(Boolean) as string[];
  const text="⚙️ Trade Setup\\n\\n"+
    "Choose a ready-made trading setup, or customize everything yourself.\\n\\n"+
    "The ready-made setups automatically configure your buy amount, take profit, stop loss, token filters, Smart Filters and alerts.\\n\\n"+
    (missing.length?"Next: "+missing[0]:"Your current setup is complete.");
  const k=new InlineKeyboard()
    .text("🛡️ BALANCED","preset:balanced").text("⚡ AGGRESSIVE","preset:aggressive").row()
    .text("✏️ CUSTOM SETUP","preset:custom").row()
    .text("🧾 REVIEW","review").row()
    .text("⬅️ BACK","menu");
  await show(ctx,text,{reply_markup:k});
}

async function manualSetupScreen(ctx:Ctx){
  const u=await user(ctx.from!.id,ctx.from!.username);
  const wallet=await pool.query("SELECT id FROM public.trading_wallets WHERE telegram_id=$1 AND is_active=TRUE",[ctx.from!.id]);
  await show(ctx,"⚙️ Custom Trading Setup\\n\\n"+
    "Change any trading rule yourself.\\n\\n"+
    "💰 Buy amount: "+(u.buy_amount?"✅ "+u.buy_amount+" SOL":"❌ Required")+"\\n"+
    "🎯 Take profit: "+(u.tp_config?"✅ Saved":"❌ Required")+"\\n"+
    "🛑 Stop loss: "+(u.sl_percent?"✅ "+u.sl_percent+"%":"❌ Required")+"\\n"+
    "🔎 Filters: "+(u.filters?"✅ Saved":"❌ Required")+"\\n"+
    "🔔 Alerts: "+(u.alerts?"✅ Saved":"❌ Required")+"\\n"+
    "💰 Wallet: "+(wallet.rowCount?"✅ Ready":"❌ Required"),
    {reply_markup:new InlineKeyboard()
      .text("💰 BUY AMOUNT","setup:buy").text("🎯 TAKE PROFIT","setup:tp").row()
      .text("🛑 STOP LOSS","setup:sl").text("🔎 FILTERS","setup:filters").row()
      .text("🔔 ALERTS","setup:alerts").text("💰 WALLET","wallets").row()
      .text("🧾 REVIEW","review").row()
      .text("⬅️ BACK","setup").text("🏠 MAIN MENU","menu")});
}

async function setupDetails(ctx:Ctx){
  const u=await user(ctx.from!.id,ctx.from!.username),f=u.filters||{};
  const tp=u.tp_config?.targets?.map((t:any)=>"+"+t.pct+"% → sell "+t.sellPct+"%").join(" / ")||"Not set";
  const text="⚙️ Trading Configuration\\n\\n"+
    "💰 Buy amount: "+(u.buy_amount??"Not set")+" SOL\\n"+
    "🎯 Take profit: "+tp+"\\n"+
    "🛑 Stop loss: "+(u.sl_percent??"Not set")+"%\\n\\n"+
    "🔎 Market cap: $"+(f.minMc??"—")+"+\\n"+
    "💧 Liquidity: $"+(f.minLiquidity??"—")+"+\\n"+
    "📈 5M volume: $"+(f.minVolume5m??"—")+"+\\n"+
    "⏱️ Token age: "+(f.minAgeSec??"—")+"–"+(f.maxAgeMin??"—")+" minutes\\n"+
    "👥 Holders: "+(f.minHolders??"—")+"+\\n"+
    "🐳 Top 10: ≤ "+(f.maxTop10??"—")+"%\\n"+
    "👨‍💻 Developer: ≤ "+(f.maxDev??"—")+"%\\n"+
    "🧠 Smart Filters: "+(f.smart===false?"OFF":"ON")+"\\n"+
    "🔔 Alerts: "+(u.alerts?"Configured":"Not set");
  await show(ctx,text,{reply_markup:new InlineKeyboard().text("✏️ EDIT SETTINGS","setup").row().text("🎯 AUTOPILOT","mode:auto").text("✋ MANUAL","mode:manual").row().text("🧾 REVIEW","review").text("🏠 MAIN MENU","menu")});
}

async function introScreen(ctx:Ctx){
  await show(ctx,"🚀 LAPrINT TRADE\\n\\n"+
    "Trade qualified Solana tokens using your own trading rules.\\n\\n"+
    "LAPrINT can find tokens that match your filters and either send them to you for approval or execute them automatically when your setup allows it.\\n\\n"+
    "Before using the bot, you need to read and accept the bot terms.",{
      reply_markup:new InlineKeyboard().text("➡️ CONTINUE","onboarding:terms")
    });
}

async function termsScreen(ctx:Ctx){
  await show(ctx,"📜 Bot Terms & Conditions\\n\\n"+
    "LAPrINT can interact with your Solana trading wallet and submit blockchain transactions when trading is enabled.\\n\\n"+
    "Trading involves the risk of losing some or all of the SOL used in a trade. Token data can be incomplete or change quickly. A qualified call is not a guarantee of profit.\\n\\n"+
    "You are responsible for the wallet you create or import, the trading settings you choose, and the transactions you authorize through the bot.\\n\\n"+
    "Read and understand these terms before continuing.",{
      reply_markup:new InlineKeyboard().text("📖 READ FULL TERMS","terms:full").row()
        .text("✅ ACCEPT","terms:accept").text("❌ DECLINE","terms:decline")
        .row().text("⬅️ BACK","onboarding:intro")
    });
}

async function walletOnboardingScreen(ctx:Ctx){
  ctx.session.onboardingWallet=true;
  await show(ctx,"💰 Trading Wallet\\n\\n"+
    "LAPrINT needs a trading wallet before you can configure trading.\\n\\n"+
    "Create a new Solana trading wallet or import an existing wallet.\\n\\n"+
    "Your wallet is used for the trades you choose to execute.",{
      reply_markup:new InlineKeyboard()
        .text("🆕 CREATE WALLET","mw:create").text("📥 IMPORT WALLET","mw:import")
        .row().text("⬅️ BACK","onboarding:terms")
    });
}

async function termsFull(ctx:Ctx){
  await show(ctx,"📖 Full Bot Terms\\n\\n"+
    "By using LAPrINT, you acknowledge that cryptocurrency trading is high risk and that blockchain transactions may be irreversible.\\n\\n"+
    "You are responsible for protecting your wallet credentials and choosing your trading settings. Never share your private key or recovery information with another person.\\n\\n"+
    "LAPrINT does not guarantee that a token will increase in value, that an execution will succeed, or that a configured strategy will be profitable. Market data may be delayed, incomplete or unavailable.\\n\\n"+
    "You may stop automated trading at any time. Stopping new entries does not automatically close existing positions.\\n\\n"+
    "If you do not agree to these terms, do not use the trading features.",{
      reply_markup:new InlineKeyboard().text("⬅️ BACK TO TERMS","onboarding:terms")
    });
}

bot.command("start", async ctx => {
  const u=await user(ctx.from!.id,ctx.from!.username);
  if(u.onboarding_complete) return menu(ctx);
  if(!u.terms_accepted) return introScreen(ctx);
  const wallet=await pool.query("SELECT id FROM public.trading_wallets WHERE telegram_id=$1 AND is_active=TRUE",[ctx.from!.id]);
  if(!wallet.rowCount) return walletOnboardingScreen(ctx);
  return menu(ctx);
});
bot.callbackQuery("onboarding:intro",async ctx=>{await ctx.answerCallbackQuery();return introScreen(ctx);});
bot.callbackQuery("onboarding:terms",async ctx=>{await ctx.answerCallbackQuery();return termsScreen(ctx);});
bot.callbackQuery("terms:full",async ctx=>{await ctx.answerCallbackQuery();return termsFull(ctx);});
bot.callbackQuery("terms:accept",async ctx=>{
  await ctx.answerCallbackQuery("Terms accepted");
  await patch(ctx.from!.id,{terms_accepted:true});
  return walletOnboardingScreen(ctx);
});
bot.callbackQuery("terms:decline",async ctx=>{
  await ctx.answerCallbackQuery("Terms declined");
  return show(ctx,"❌ Terms declined\\n\\nYou must accept the bot terms before using LAPrINT trading features.",{
    reply_markup:new InlineKeyboard().text("📜 VIEW TERMS","onboarding:terms")
  });
});
bot.callbackQuery("onboarding:dashboard",async ctx=>{await ctx.answerCallbackQuery("Dashboard");return menu(ctx);});

}