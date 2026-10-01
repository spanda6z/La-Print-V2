import "dotenv/config";
import { Bot, Context, InlineKeyboard, session } from "grammy";
import pg from "pg";

const { Pool } = pg;
const token = process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
type Session = { input?: "buy"|"sl" };
type Ctx = Context & { session: Session };
const bot = new Bot<Ctx>(token);
bot.use(session({ initial: (): Session => ({}) }));

async function init() {
  await pool.query("CREATE TABLE IF NOT EXISTS users (telegram_id BIGINT PRIMARY KEY, username TEXT, mode TEXT, onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE, buy_amount NUMERIC, tp_config JSONB, sl_percent NUMERIC, filters JSONB, alerts JSONB, wallet_address TEXT, wallet_balance NUMERIC NOT NULL DEFAULT 0, funding_prompt_sent BOOLEAN NOT NULL DEFAULT FALSE, trading_active BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())");
  await pool.query("CREATE TABLE IF NOT EXISTS notification_events (telegram_id BIGINT NOT NULL, event_key TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (telegram_id,event_key))");
}
async function user(id:number, username?:string) {
  await pool.query("INSERT INTO users(telegram_id,username) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,updated_at=NOW()",[id,username||null]);
  const r=await pool.query("SELECT * FROM users WHERE telegram_id=$1",[id]); return r.rows[0];
}
async function patch(id:number, fields:Record<string,unknown>) {
  const e=Object.entries(fields); if(!e.length) return user(id);
  const set=e.map((x,i)=>x[0]+"=$"+(i+2)).join(",");
  await pool.query("UPDATE users SET "+set+",updated_at=NOW() WHERE telegram_id=$1",[id,...e.map(x=>x[1])]);
  return user(id);
}
async function once(id:number,key:string) {
  const r=await pool.query("INSERT INTO notification_events(telegram_id,event_key) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,key]); return r.rowCount===1;
}

const back = (target="setup") => new InlineKeyboard().text("⬅️ BACK",target).text("🏠 MAIN MENU","menu");
const modeKb = () => new InlineKeyboard().text("🎯 AUTOPILOT","mode:auto").text("✋ MANUAL","mode:manual");
const setupKb = () => new InlineKeyboard().text("💰 BUY AMOUNT","setup:buy").text("🎯 TAKE PROFIT","setup:tp").row().text("🛑 STOP LOSS","setup:sl").text("🔎 FILTERS","setup:filters").row().text("🔔 ALERTS","setup:alerts").text("💰 WALLET","wallet").row().text("👀 REVIEW","review").text("🏠 MAIN MENU","menu");
const mainKb = (active:boolean,mode:string) => { const k=new InlineKeyboard().text(mode==="manual"?"▶️ START FEED":"🚀 START","trade:start").text("📊 POSITIONS","positions").row().text("📡 ACTIVITY","activity").text("🔔 ALERTS","alerts").row().text("⚙️ SETTINGS","setup").text("💰 WALLET","wallet").row(); if(active) k.text(mode==="manual"?"⏹️ STOP FEED":"⏹️ STOP AUTOPILOT","trade:stop"); return k; };
const buyKb=()=>new InlineKeyboard().text("0.01 SOL","buy:0.01").text("0.05 SOL","buy:0.05").row().text("0.10 SOL","buy:0.10").text("0.25 SOL","buy:0.25").row().text("✏️ CUSTOM","buy:custom").row().text("⬅️ BACK","setup");
const tpKb=()=>new InlineKeyboard().text("⚡ SIMPLE TP","tp:simple").text("🧠 PARTIAL EXITS","tp:partial").row().text("⬅️ BACK","setup");
const slKb=()=>new InlineKeyboard().text("-10%","sl:-10").text("-15%","sl:-15").row().text("-20%","sl:-20").text("-25%","sl:-25").row().text("✏️ CUSTOM","sl:custom").row().text("⬅️ BACK","setup");
const filterKb=()=>new InlineKeyboard().text("🟢 PRE-BOND","filter:pre").text("🚀 NEW LAUNCHES","filter:new").row().text("🔥 BOTH","filter:both").row().text("⚙️ FILTER SETTINGS","filter:settings").text("🧠 SMART","filter:smart").row().text("⬅️ BACK","setup");
const alertKb=()=>new InlineKeyboard().text("🟢 MILESTONES: ALWAYS ON","noop").row().text("☐ NEW TOKEN","alert:new").text("☐ LIQUIDITY","alert:liq").row().text("☐ VOLUME","alert:vol").text("☐ BONDING","alert:bond").row().text("💾 SAVE","alert:save").text("⬅️ BACK","setup");
const walletKb=()=>new InlineKeyboard().text("🔗 CONNECT","wallet:connect").text("🆕 CREATE","wallet:create").row().text("📥 IMPORT","wallet:import").text("🔄 REFRESH","wallet:refresh").row().text("🏠 MAIN MENU","menu");

async function menu(ctx:Ctx){ const u=await user(ctx.from!.id,ctx.from!.username); const balance=Number(u.wallet_balance||0); await ctx.reply("🤖 *TRADE AUTOPILOT*\n\n🟢 Engine: "+(process.env.ENGINE_MODE==="live"?"ONLINE":"OFFLINE")+"\n🎯 Mode: "+(u.mode==="manual"?"MANUAL":"AUTOPILOT")+"\n💰 Balance: "+balance.toFixed(3)+" SOL\n📊 Positions: 0\n📈 PnL: 0.000 SOL\n\nChoose an action:",{parse_mode:"Markdown",reply_markup:mainKb(!!u.trading_active,u.mode)}); }
async function setup(ctx:Ctx){ const u=await user(ctx.from!.id,ctx.from!.username); await ctx.reply("⚙️ *TRADE SETUP*\n\nConfigure your rules before receiving trading calls.\n\n💰 Buy Amount "+(u.buy_amount?"✅":"❌")+"\n🎯 Take Profit "+(u.tp_config?"✅":"❌")+"\n🛑 Stop Loss "+(u.sl_percent?"✅":"❌")+"\n🔎 Filters "+(u.filters?"✅":"❌")+"\n🔔 Alerts "+(u.alerts?"✅":"❌")+"\n💰 Wallet "+(Number(u.wallet_balance||0)>0?"✅":"❌"),{parse_mode:"Markdown",reply_markup:setupKb()}); }

bot.command("start",async ctx=>{if(!ctx.from)return;const u=await user(ctx.from.id,ctx.from.username); if(u.onboarding_complete) return menu(ctx); await ctx.reply("🤖 *TRADE AUTOPILOT*\n\nYour Telegram trading assistant for qualified calls and automated execution.\n\n🎯 *AUTOPILOT* — qualified calls can be executed automatically.\n\n✋ *MANUAL* — review each call before execution.\n\nSet your trade rules, filters and alerts before trading begins.\n\nChoose your mode:",{parse_mode:"Markdown",reply_markup:modeKb()});});
bot.command("menu",menu); bot.command("setup",setup);
bot.command("mode",async ctx=>ctx.reply("🎯 *TRADING MODE*\n\nChoose how you want the bot to operate.",{parse_mode:"Markdown",reply_markup:modeKb()}));

bot.callbackQuery("mode:auto",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{mode:"autopilot"});await ctx.reply("🎯 *AUTOPILOT*\n\nQualified calls that pass your filters and safety checks can be executed automatically.\n\nNothing starts until your setup is complete.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ SET UP AUTOPILOT","setup").row().text("⬅️ BACK","start")});});
bot.callbackQuery("mode:manual",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{mode:"manual"});await ctx.reply("✋ *MANUAL*\n\nYou will receive qualified calls that match your filters and decide whether each trade executes.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ SET UP MANUAL","setup").row().text("⬅️ BACK","start")});});
bot.callbackQuery("start",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("🤖 *TRADE AUTOPILOT*\n\nChoose your mode:",{parse_mode:"Markdown",reply_markup:modeKb()});});
bot.callbackQuery("setup",async ctx=>{await ctx.answerCallbackQuery();await setup(ctx);}); bot.callbackQuery("menu",async ctx=>{await ctx.answerCallbackQuery();await menu(ctx);});

bot.callbackQuery("setup:buy",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("💰 *BUY AMOUNT*\n\nHow much SOL should each trade use?",{parse_mode:"Markdown",reply_markup:buyKb()});});
bot.callbackQuery(/^buy:(.+)$/,async ctx=>{await ctx.answerCallbackQuery();const v=ctx.match[1];if(v==="custom"){ctx.session.input="buy";return ctx.reply("✏️ Enter the SOL amount. Example: 0.05");}await patch(ctx.from.id,{buy_amount:Number(v)});await ctx.reply("✅ *BUY AMOUNT SAVED*\n\nTrade size: "+v+" SOL",{parse_mode:"Markdown",reply_markup:setupKb()});});
bot.callbackQuery("setup:tp",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("🎯 *TAKE PROFIT*\n\nChoose how profits should be taken.",{parse_mode:"Markdown",reply_markup:tpKb()});});
bot.callbackQuery("tp:simple",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{tp_config:{type:"simple",targets:[{pct:40,sellPct:100}]}});await ctx.reply("✅ *TP SAVED*\n\n+40% → sell 100%",{parse_mode:"Markdown",reply_markup:setupKb()});});
bot.callbackQuery("tp:partial",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{tp_config:{type:"partial",targets:[{pct:40,sellPct:50},{pct:100,sellPct:25},{pct:200,sellPct:15}]}});await ctx.reply("✅ *TP SAVED*\n\n+40% → 50%\n+100% → 25%\n+200% → 15%\nRemaining: 10%",{parse_mode:"Markdown",reply_markup:setupKb()});});
bot.callbackQuery("setup:sl",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("🛑 *STOP LOSS*\n\nSet the maximum loss per position.",{parse_mode:"Markdown",reply_markup:slKb()});});
bot.callbackQuery(/^sl:(.+)$/,async ctx=>{await ctx.answerCallbackQuery();const v=ctx.match[1];if(v==="custom"){ctx.session.input="sl";return ctx.reply("✏️ Enter the stop loss. Example: -20");}await patch(ctx.from.id,{sl_percent:Number(v)});await ctx.reply("✅ *STOP LOSS SAVED*\n\nSL: "+v+"%",{parse_mode:"Markdown",reply_markup:setupKb()});});

bot.callbackQuery("setup:filters",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("🔎 *TOKEN FILTERS*\n\nOnly tokens that pass your filters can generate a trading call.\n\nA low market cap alone never qualifies a token.",{parse_mode:"Markdown",reply_markup:filterKb()});});
bot.callbackQuery(/^filter:(pre|new|both)$/,async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{filters:{type:ctx.match[1],minMc:3000,maxMc:50000,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30,smart:true}});await ctx.reply("✅ *FILTERS SAVED*\n\nMC: $3K → $50K\nLiquidity: ≥ $5K\n5M Volume: ≥ $2K\nHolders: ≥ 50\nTop 10: ≤ 35%\nDev: ≤ 5%\nSmart filters: ON",{parse_mode:"Markdown",reply_markup:setupKb()});});
bot.callbackQuery("filter:settings",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("🔎 *FILTER SETTINGS*\n\nCurrent smart defaults:\nMC $3K → $50K\nLiquidity ≥ $5K\n5M Volume ≥ $2K\nHolders ≥ 50\nTop 10 ≤ 35%\nDev ≤ 5%\nAge 30s → 30m",{parse_mode:"Markdown",reply_markup:filterKb()});});
bot.callbackQuery("filter:smart",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{filters:{type:"both",minMc:3000,maxMc:50000,minLiquidity:5000,minVolume5m:2000,minHolders:50,maxTop10:35,maxDev:5,minAgeSec:30,maxAgeMin:30,smart:true}});await ctx.reply("🧠 *SMART FILTERS ON*\n\nLiquidity, volume, holder distribution, concentration, dev exposure and safety checks must pass before a token qualifies.",{parse_mode:"Markdown",reply_markup:filterKb()});});

bot.callbackQuery("setup:alerts",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("🔔 *ALERT SETTINGS*\n\nTrade milestones are always delivered. Optional market alerts can be enabled separately.\n\nNo random scanner DMs.",{parse_mode:"Markdown",reply_markup:alertKb()});});
bot.callbackQuery(/^alert:(new|liq|vol|bond)$/,async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("🔔 Optional alert selected. Save when finished.",{reply_markup:alertKb()});});
bot.callbackQuery("alert:save",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{alerts:{milestones:true,newToken:false,liquidity:false,volume:false,bonding:false}});await ctx.reply("✅ *ALERTS SAVED*\n\nTrade lifecycle milestones are always on. Optional scanner alerts remain controlled separately.",{parse_mode:"Markdown",reply_markup:setupKb()});});
bot.callbackQuery("alerts",async ctx=>{await ctx.answerCallbackQuery();return ctx.reply("🔔 *ALERTS*\n\nTrade milestones: ALWAYS ON\nOptional market alerts: configurable.",{parse_mode:"Markdown",reply_markup:alertKb()});});
bot.callbackQuery("noop",async ctx=>ctx.answerCallbackQuery("Trade milestones are mandatory."));

bot.callbackQuery("wallet",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);const b=Number(u.wallet_balance||0);await ctx.reply("💰 *WALLET*\n\nStatus: "+(b>0?"🟢 FUNDED":"🔴 NOT FUNDED")+"\nBalance: "+b.toFixed(3)+" SOL\n\nA funded wallet is required before execution.",{parse_mode:"Markdown",reply_markup:walletKb()});});
bot.callbackQuery(/^wallet:(connect|create|import)$/,async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("🔐 Wallet adapter is not connected yet. No wallet has been created, imported, or connected. Live execution stays disabled until the adapter is integrated.");});
bot.callbackQuery("wallet:refresh",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("🔄 No wallet adapter is connected, so no balance is fabricated.",{reply_markup:walletKb()});});

bot.callbackQuery("review",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);const missing:string[]=[];if(!u.buy_amount)missing.push("Buy Amount");if(!u.tp_config)missing.push("Take Profit");if(!u.sl_percent)missing.push("Stop Loss");if(!u.filters)missing.push("Filters");if(!u.alerts)missing.push("Alerts");if(Number(u.wallet_balance||0)<=0)missing.push("Funded Wallet");const txt=missing.length?"⚠️ *SETUP INCOMPLETE*\n\nMissing:\n"+missing.map(x=>"❌ "+x).join("\n"):"🎯 *FINAL REVIEW*\n\n💰 Buy: "+u.buy_amount+" SOL\n🎯 TP: configured\n🛑 SL: "+u.sl_percent+"%\n🔎 Filters: smart\n🔔 Milestones: ON\n\nNothing executes until activation.";await ctx.reply(txt,{parse_mode:"Markdown",reply_markup:missing.length?setupKb():new InlineKeyboard().text("🚀 ENABLE","activate").row().text("⚙️ EDIT","setup").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("activate",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);const missing:string[]=[];if(!u.buy_amount)missing.push("Buy Amount");if(!u.tp_config)missing.push("Take Profit");if(!u.sl_percent)missing.push("Stop Loss");if(!u.filters)missing.push("Filters");if(!u.alerts)missing.push("Alerts");if(Number(u.wallet_balance||0)<=0)missing.push("Funded Wallet");if(missing.length)return ctx.reply("⚠️ *TRADING NOT READY*\n\n"+missing.map(x=>"❌ "+x).join("\n"),{parse_mode:"Markdown",reply_markup:setupKb()});await patch(ctx.from.id,{onboarding_complete:true,trading_active:true});await ctx.reply("🎯 *AUTOPILOT ACTIVE*\n\n🟢 Filters active\n🟢 Safety active\n🟢 Trade milestones active\n\nWaiting for qualified calls.",{parse_mode:"Markdown",reply_markup:mainKb(true,u.mode)});});

bot.callbackQuery("trade:start",async ctx=>{await ctx.answerCallbackQuery();const u=await user(ctx.from.id,ctx.from.username);const b=Number(u.wallet_balance||0);const missing:string[]=[];if(!u.buy_amount)missing.push("Buy Amount");if(!u.tp_config)missing.push("Take Profit");if(!u.sl_percent)missing.push("Stop Loss");if(!u.filters)missing.push("Filters");if(!u.alerts)missing.push("Alerts");if(b<=0)missing.push("Funded Wallet");if(missing.length){if(b<=0 && await once(ctx.from.id,"funding:zero"))await ctx.reply("💰 *FUND YOUR WALLET*\n\nYour wallet currently has 0 SOL. This reminder will not repeat until the wallet state changes.",{parse_mode:"Markdown",reply_markup:walletKb()});return ctx.reply("⚠️ *TRADING NOT READY*\n\n"+missing.map(x=>"❌ "+x).join("\n"),{parse_mode:"Markdown",reply_markup:setupKb()});}await patch(ctx.from.id,{trading_active:true,onboarding_complete:true});await menu(ctx);});
bot.callbackQuery("trade:stop",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("⏹️ *STOP TRADING?*\n\nNew entries will stop. Existing positions are not automatically closed.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⏹️ YES, STOP","trade:stop:confirm").text("↩️ KEEP RUNNING","menu")});});
bot.callbackQuery("trade:stop:confirm",async ctx=>{await ctx.answerCallbackQuery();await patch(ctx.from.id,{trading_active:false});await ctx.reply("⏹️ *TRADING STOPPED*\n\nNo new entries will be opened.",{parse_mode:"Markdown",reply_markup:mainKb(false,"autopilot")});});
bot.callbackQuery("positions",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("📊 *POSITIONS*\n\nNo live position adapter is connected. No fake positions are shown.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 REFRESH","positions").text("🏠 MAIN MENU","menu")});});
bot.callbackQuery("activity",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("📡 *ACTIVITY*\n\nNo live execution events are connected yet.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 REFRESH","activity").text("🏠 MAIN MENU","menu")});});

bot.on("message:text",async ctx=>{if(!ctx.session.input)return;const raw=ctx.message.text.trim();if(ctx.session.input==="buy"){const v=Number(raw);if(!Number.isFinite(v)||v<=0)return ctx.reply("⚠️ Enter a valid positive SOL amount.");await patch(ctx.from.id,{buy_amount:v});ctx.session.input=undefined;return ctx.reply("✅ BUY AMOUNT SAVED\n\nTrade size: "+v+" SOL",{reply_markup:setupKb()});}if(ctx.session.input==="sl"){const v=Number(raw);if(!Number.isFinite(v)||v>=0||v<-100)return ctx.reply("⚠️ Enter a stop loss between -1 and -100.");await patch(ctx.from.id,{sl_percent:v});ctx.session.input=undefined;return ctx.reply("✅ STOP LOSS SAVED\n\nSL: "+v+"%",{reply_markup:setupKb()});}});

bot.catch(e=>console.error("BOT_ERROR",e.error));
await init();
await bot.api.setMyCommands([{command:"start",description:"Open LaPrint"},{command:"menu",description:"Main menu"},{command:"setup",description:"Trading setup"},{command:"mode",description:"Switch mode"}]);
console.log("LaPrint V2 starting. ENGINE_MODE="+(process.env.ENGINE_MODE||"disabled"));
await bot.start({onStart:i=>console.log("Bot @"+i.username+" running")});