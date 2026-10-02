
import { InlineKeyboard, type Bot } from "grammy";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

type Deps = { bot: Bot<any>; pool: any; show: (ctx:any,msg:string,extra?:any)=>Promise<any>; recordAdminEvent?: (pool:any,event:string,data:any,severity?:string)=>Promise<any> };
type WalletRow = { id:string; telegram_id:number; name:string; public_key:string; is_active:boolean; created_at:string; updated_at:string };

function key():Buffer {
  const v=process.env.WALLET_ENCRYPTION_KEY;
  if(!v || v.length<32) throw new Error("WALLET_ENCRYPTION_KEY must be configured with at least 32 characters.");
  return createHash("sha256").update(v,"utf8").digest();
}
function encrypt(secret:Uint8Array) {
  const iv=randomBytes(12), cipher=createCipheriv("aes-256-gcm",key(),iv);
  const encrypted=Buffer.concat([cipher.update(Buffer.from(secret)),cipher.final()]);
  return {encrypted:encrypted.toString("base64"),iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64")};
}
function decrypt(encrypted:string,iv:string,tag:string):Buffer {
  const decipher=createDecipheriv("aes-256-gcm",key(),Buffer.from(iv,"base64"));
  decipher.setAuthTag(Buffer.from(tag,"base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted,"base64")),decipher.final()]);
}
async function ensureUser(pool:any,id:number){await pool.query("INSERT INTO public.users(telegram_id) VALUES($1) ON CONFLICT(telegram_id) DO NOTHING",[id]);}

export async function ensureMultiWalletSchema(pool:any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.trading_wallets (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL UNIQUE,
      encrypted_secret TEXT NOT NULL,
      encryption_iv TEXT NOT NULL,
      encryption_tag TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS trading_wallets_user_name_uidx ON public.trading_wallets(telegram_id, lower(name));
    CREATE UNIQUE INDEX IF NOT EXISTS trading_wallets_one_active_uidx ON public.trading_wallets(telegram_id) WHERE is_active=TRUE;
    CREATE INDEX IF NOT EXISTS trading_wallets_user_created_idx ON public.trading_wallets(telegram_id,created_at DESC);
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS active_wallet_id BIGINT;
    ALTER TABLE public.trade_config_snapshots ADD COLUMN IF NOT EXISTS wallet_id BIGINT;
    ALTER TABLE public.trade_config_snapshots ADD COLUMN IF NOT EXISTS wallet_address TEXT;
  `);
  const legacy=await pool.query("SELECT w.telegram_id,w.public_key,w.encrypted_secret,w.encryption_iv,w.encryption_tag FROM public.wallets w LEFT JOIN public.trading_wallets tw ON tw.telegram_id=w.telegram_id AND tw.public_key=w.public_key WHERE tw.id IS NULL");
  for(const row of legacy.rows){
    const n=await pool.query("SELECT COUNT(*)::int AS n FROM public.trading_wallets WHERE telegram_id=$1",[row.telegram_id]);
    await pool.query("INSERT INTO public.trading_wallets(telegram_id,name,public_key,encrypted_secret,encryption_iv,encryption_tag,is_active) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(public_key) DO NOTHING",[row.telegram_id,n.rows[0].n?"Imported":"Main",row.public_key,row.encrypted_secret,row.encryption_iv,row.encryption_tag,!n.rows[0].n]);
  }
  await pool.query("UPDATE public.users u SET active_wallet_id=tw.id,wallet_address=tw.public_key,updated_at=NOW() FROM public.trading_wallets tw WHERE tw.telegram_id=u.telegram_id AND tw.is_active=TRUE AND (u.active_wallet_id IS NULL OR u.active_wallet_id<>tw.id)");
  console.log("[wallets] multi-wallet schema ready");
}

async function list(pool:any,id:number):Promise<WalletRow[]> {
  const r=await pool.query("SELECT id,telegram_id,name,public_key,is_active,created_at,updated_at FROM public.trading_wallets WHERE telegram_id=$1 ORDER BY is_active DESC,created_at ASC",[id]);
  return r.rows;
}
export async function getActiveTradingWallet(pool:any,id:number) {
  const r=await pool.query("SELECT id,telegram_id,name,public_key,encrypted_secret,encryption_iv,encryption_tag,is_active FROM public.trading_wallets WHERE telegram_id=$1 AND is_active=TRUE LIMIT 1",[id]);
  const w=r.rows[0]; if(!w)return null;
  return {id:String(w.id),telegramId:Number(w.telegram_id),name:w.name,publicKey:w.public_key,isActive:w.is_active,keypair:Keypair.fromSecretKey(decrypt(w.encrypted_secret,w.encryption_iv,w.encryption_tag))};
}
export async function getTradingWalletById(pool:any,telegramId:number,walletId:string) {
  const r=await pool.query("SELECT id,telegram_id,name,public_key,encrypted_secret,encryption_iv,encryption_tag,is_active FROM public.trading_wallets WHERE telegram_id=$1 AND id=$2",[telegramId,walletId]);
  const w=r.rows[0]; if(!w)return null;
  return {id:String(w.id),telegramId:Number(w.telegram_id),name:w.name,publicKey:w.public_key,isActive:w.is_active,keypair:Keypair.fromSecretKey(decrypt(w.encrypted_secret,w.encryption_iv,w.encryption_tag))};
}
async function setActive(pool:any,id:number,walletId:string){
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    const r=await c.query("SELECT id,name,public_key FROM public.trading_wallets WHERE telegram_id=$1 AND id=$2 FOR UPDATE",[id,walletId]);
    if(!r.rowCount)throw new Error("Wallet not found.");
    await c.query("UPDATE public.trading_wallets SET is_active=FALSE,updated_at=NOW() WHERE telegram_id=$1",[id]);
    await c.query("UPDATE public.trading_wallets SET is_active=TRUE,updated_at=NOW() WHERE telegram_id=$1 AND id=$2",[id,walletId]);
    await c.query("UPDATE public.users SET active_wallet_id=$2,wallet_address=$3,wallet_balance=0,updated_at=NOW() WHERE telegram_id=$1",[id,walletId,r.rows[0].public_key]);
    await c.query("COMMIT"); return r.rows[0];
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
async function nextName(pool:any,id:number){const rows=await list(pool,id),used=new Set(rows.map(x=>x.name.toLowerCase()));if(!used.has("main"))return "Main";let n=2;while(used.has("wallet "+n))n++;return "Wallet "+n;}
async function create(pool:any,id:number){
  await ensureUser(pool,id);const kp=Keypair.generate(),sec=encrypt(kp.secretKey),rows=await list(pool,id),active=!rows.length,name=await nextName(pool,id);
  const r=await pool.query("INSERT INTO public.trading_wallets(telegram_id,name,public_key,encrypted_secret,encryption_iv,encryption_tag,is_active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,public_key,is_active",[id,name,kp.publicKey.toBase58(),sec.encrypted,sec.iv,sec.tag,active]);
  if(active)await pool.query("UPDATE public.users SET active_wallet_id=$2,wallet_address=$3,wallet_balance=0,updated_at=NOW() WHERE telegram_id=$1",[id,r.rows[0].id,r.rows[0].public_key]);
  return r.rows[0];
}
async function importWallet(pool:any,id:number,raw:string){
  await ensureUser(pool,id);
  const bytes=raw.trim().startsWith("[")?Uint8Array.from(JSON.parse(raw.trim())):bs58.decode(raw.trim()),kp=Keypair.fromSecretKey(bytes),address=kp.publicKey.toBase58();
  const dup=await pool.query("SELECT id FROM public.trading_wallets WHERE telegram_id=$1 AND public_key=$2",[id,address]);if(dup.rowCount)throw new Error("Wallet already imported.");
  const rows=await list(pool,id),sec=encrypt(kp.secretKey),active=!rows.length,name=await nextName(pool,id);
  const r=await pool.query("INSERT INTO public.trading_wallets(telegram_id,name,public_key,encrypted_secret,encryption_iv,encryption_tag,is_active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,public_key,is_active",[id,name,address,sec.encrypted,sec.iv,sec.tag,active]);
  if(active)await pool.query("UPDATE public.users SET active_wallet_id=$2,wallet_address=$3,wallet_balance=0,updated_at=NOW() WHERE telegram_id=$1",[id,r.rows[0].id,address]);
  return r.rows[0];
}
async function bal(address:string):Promise<number|null>{try{const rpc=process.env.SOLANA_RPC_URL;if(!rpc)return null;return (await new Connection(rpc,{commitment:"confirmed"}).getBalance(new PublicKey(address),"confirmed"))/LAMPORTS_PER_SOL;}catch{return null;}}
const short=(a:string)=>a.length>12?a.slice(0,5)+"…"+a.slice(-4):a;

async function home(ctx:any,d:Deps){
  const rows=await list(d.pool,ctx.from.id);
  if(!rows.length)return d.show(ctx,"👛 *LA-PRINT ┃ Wallets*\n━━━━━━━━━━━━━━━━━━━━\n\nNo trading wallet is configured yet.\n\n▸ RECOMMENDED\n┣ Keep trading funds separate from long-term holdings\n┣ Use different wallets for different strategies\n┗ Only fund wallets you are prepared to trade\n\n⚠️ Never share a private key or recovery phrase.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔵 ⟪ ✨ Create wallet ⟫","mw:create").row().text("⟪ 📥 Import wallet ⟫","mw:import").row().text("⌂ Menu","menu")});
  const a=rows.find(x=>x.is_active)||rows[0],b=await bal(a.public_key);
  const text=["👛 *LA-PRINT ┃ Wallets*","━━━━━━━━━━━━━━━━━━━━","","▸ ACTIVE WALLET","┣ Name       "+a.name,"┣ Address    `"+short(a.public_key)+"`","┣ Balance    "+(b===null?"⚪ Unavailable":b.toFixed(4)+" SOL"),"┗ Status     🟢 Active","","▸ WALLETS  ("+rows.length+")",...rows.map((w,i)=>(i===rows.length-1?"┗ ":"┣ ")+(w.is_active?"🟢 ":"⚪ ")+w.name+"  "+short(w.public_key)),"","ℹ️ New trades use the active wallet only. Existing positions stay attached to their original wallet."].join("\n");
  const k=new InlineKeyboard();for(const w of rows)k.text((w.is_active?"🟢 ":"⚪ ")+w.name+" · "+short(w.public_key),"mw:view:"+w.id).row();k.text("➕ Create wallet","mw:create").text("📥 Import wallet","mw:import").row();k.text("🔄 Refresh","wallets").text("⌂ Menu","menu");return d.show(ctx,text,{parse_mode:"Markdown",reply_markup:k});
}
async function view(ctx:any,d:Deps,id:string){
  const r=await d.pool.query("SELECT id,name,public_key,is_active FROM public.trading_wallets WHERE telegram_id=$1 AND id=$2",[ctx.from.id,id]);if(!r.rowCount)return home(ctx,d);const w=r.rows[0],b=await bal(w.public_key),k=new InlineKeyboard();
  if(!w.is_active)k.text("🟢 ⟪ Use this wallet ⟫","mw:use:"+id).row();k.text("✏️ Rename","mw:rename:"+id).text("📋 Copy address","mw:copy:"+id).row();k.text("📷 Deposit","mw:deposit:"+id).text("🔄 Refresh","mw:view:"+id).row();k.text("🔐 Security","mw:security:"+id).row();if(!w.is_active)k.text("🔴 ⟪ Delete wallet ⟫","mw:delete:"+id).row();k.text("‹ Back","wallets").text("⌂ Menu","menu");
  return d.show(ctx,"👛 *LA-PRINT ┃ Wallet*\n━━━━━━━━━━━━━━━━━━━━\n\n▸ WALLET\n┣ Name       "+w.name+"\n┣ Address    `"+short(w.public_key)+"`\n┣ Balance    "+(b===null?"⚪ Unavailable":b.toFixed(4)+" SOL")+"\n┗ Status     "+(w.is_active?"🟢 Active":"⚪ Inactive")+"\n\n▸ EXECUTION\n┗ "+(w.is_active?"Selected for new trades.":"Not selected for new trades.")+"\n\n⚠️ Existing positions remain attached to the wallet that opened them.",{parse_mode:"Markdown",reply_markup:k});
}

export function registerMultiWallets(d:Deps){
  d.bot.command("wallets",async ctx=>home(ctx,d));
  d.bot.callbackQuery("wallets",async ctx=>{await ctx.answerCallbackQuery();return home(ctx,d);});
  d.bot.callbackQuery("mw:create",async ctx=>{await ctx.answerCallbackQuery();try{const w=await create(d.pool,ctx.from.id);await d.recordAdminEvent?.(d.pool,"wallet_created",{telegram_id:ctx.from.id,wallet_address:w.public_key,wallet_name:w.name,created_at:new Date().toLocaleString("en-US",{timeZone:"Africa/Lagos",month:"numeric",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",second:"2-digit"})},"ACTION");
      if (d.bot) { const { notifyAdmin } = await import("./admin-notifications.js"); await notifyAdmin(d.bot,"wallet_created",{telegram_id:ctx.from.id,wallet_address:w.public_key,wallet_name:w.name,created_at:new Date().toLocaleString("en-US",{timeZone:"Africa/Lagos",month:"numeric",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",second:"2-digit"})}); }return d.show(ctx,"✅ *LA-PRINT ┃ Wallet ready*\n━━━━━━━━━━━━━━━━━━━━\n\n┣ Name       "+w.name+"\n┣ Address    `"+w.public_key+"`\n┗ Status     "+(w.is_active?"🟢 Active":"⚪ Inactive")+"\n\nDeposit SOL before trading. Wallets are isolated from each other.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("💰 Deposit SOL","mw:deposit:"+w.id).row().text("📋 Copy address","mw:copy:"+w.id).text("👛 Wallets","wallets")});}catch(e){console.error("[wallets] create",e);return d.show(ctx,"❌ *WALLET CREATION FAILED*\n\nNo wallet was added.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔄 Try again","mw:create").row().text("‹ Back","wallets")});}});
  d.bot.callbackQuery("mw:import",async ctx=>{await ctx.answerCallbackQuery();(ctx.session as any).multiWalletInput="import";return d.show(ctx,"🔒 *LA-PRINT ┃ Import wallet*\n━━━━━━━━━━━━━━━━━━━━\n\nPaste the private key for this trading wallet.\n\n🔴 Never import a long-term/main wallet.\n🔴 Never send a seed phrase in a public group.\n\nAccepted: base58 secret key or JSON byte array. Your message will be deleted where Telegram permits it.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("✕ Cancel","mw:cancel")});});
  d.bot.callbackQuery("mw:cancel",async ctx=>{await ctx.answerCallbackQuery();(ctx.session as any).multiWalletInput=undefined;return home(ctx,d);});
  d.bot.callbackQuery(/^mw:view:(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();return view(ctx,d,ctx.match[1]);});
  d.bot.callbackQuery(/^mw:use:(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();try{const w=await setActive(d.pool,ctx.from.id,ctx.match[1]);return view(ctx,d,ctx.match[1]);}catch(e){return d.show(ctx,"⚠️ *WALLET SWITCH FAILED*\n\nThe active wallet was not changed.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("‹ Back","wallets")});}});
  d.bot.callbackQuery(/^mw:rename:(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();(ctx.session as any).multiWalletInput="rename:"+ctx.match[1];return d.show(ctx,"✏️ *LA-PRINT ┃ Rename wallet*\n━━━━━━━━━━━━━━━━━━━━\n\nEnter a short name.\nExample: Main · Sniper · Safe · Degen",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("✕ Cancel","mw:cancel")});});
  d.bot.callbackQuery(/^mw:copy:(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();const r=await d.pool.query("SELECT public_key FROM public.trading_wallets WHERE telegram_id=$1 AND id=$2",[ctx.from.id,ctx.match[1]]);if(!r.rowCount)return home(ctx,d);return d.show(ctx,"📋 *WALLET ADDRESS*\n\n`"+r.rows[0].public_key+"`\n\nSend only Solana-network assets to this address.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("‹ Back","mw:view:"+ctx.match[1]).text("⌂ Menu","menu")});});
  d.bot.callbackQuery(/^mw:deposit:(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();return d.bot.api.sendMessage(ctx.from.id,"💰 LA-PRINT · Deposit\n\nSend SOL to the wallet address shown in Wallet details.").then(()=>view(ctx,d,ctx.match[1]));});
  d.bot.callbackQuery(/^mw:security:(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();return d.show(ctx,"🔐 *LA-PRINT ┃ Wallet security*\n━━━━━━━━━━━━━━━━━━━━\n\n┣ Wallet secret  🟢 Encrypted\n┣ Private key    ⚪ Protected\n┗ Trading scope  🟢 Dedicated\n\nNever share your private key. Support will never ask for it.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("‹ Back","mw:view:"+ctx.match[1])});});
  d.bot.callbackQuery(/^mw:delete:(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();const r=await d.pool.query("SELECT name,public_key,is_active FROM public.trading_wallets WHERE telegram_id=$1 AND id=$2",[ctx.from.id,ctx.match[1]]);if(!r.rowCount)return home(ctx,d);if(r.rows[0].is_active)return d.show(ctx,"⚠️ *ACTIVE WALLET*\n\nSwitch to another wallet before deleting this one.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("👛 Wallets","wallets")});return d.show(ctx,"⚠️ *LA-PRINT ┃ Delete wallet?*\n━━━━━━━━━━━━━━━━━━━━\n\n┣ Wallet  "+r.rows[0].name+"\n┣ Address `"+short(r.rows[0].public_key)+"`\n┗ Status  ⚪ Inactive\n\nWithdraw funds first. Deleting removes the encrypted signing material from La-Print; blockchain funds are not moved automatically.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔴 ⟪ Confirm delete ⟫","mw:confirmdelete:"+ctx.match[1]).row().text("Keep wallet","mw:view:"+ctx.match[1])});});
  d.bot.callbackQuery(/^mw:confirmdelete:(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();const r=await d.pool.query("DELETE FROM public.trading_wallets WHERE telegram_id=$1 AND id=$2 AND is_active=FALSE RETURNING name,public_key",[ctx.from.id,ctx.match[1]]);return d.show(ctx,r.rowCount?"✅ *WALLET REMOVED*\n\n"+r.rows[0].name+" is no longer available.":"⚠️ *WALLET NOT REMOVED*\n\nThe wallet may be active or no longer exist.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("👛 Wallets","wallets")});});
  d.bot.on("message:text",async ctx=>{const mode=(ctx.session as any).multiWalletInput;if(!mode)return;const raw=ctx.message.text.trim();(ctx.session as any).multiWalletInput=undefined;try{await ctx.deleteMessage();}catch{}try{if(mode==="import"){const w=await importWallet(d.pool,ctx.from.id,raw);await d.recordAdminEvent?.(d.pool,"wallet_imported",{telegram_id:ctx.from.id,wallet_address:w.public_key,wallet_name:w.name},"ACTION");return d.show(ctx,"✅ *LA-PRINT ┃ Wallet imported*\n━━━━━━━━━━━━━━━━━━━━\n\n┣ Name       "+w.name+"\n┣ Address    `"+w.public_key+"`\n┗ Status     "+(w.is_active?"🟢 Active":"⚪ Inactive")+"\n\nThe wallet is encrypted and isolated from your other wallets.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("👛 Wallets","wallets").text("📋 Copy address","mw:copy:"+w.id).row().text("⌂ Menu","menu")});}if(mode.startsWith("rename:")){const id=mode.slice(7),name=raw.slice(0,40);if(!name)throw new Error("Name required");await d.pool.query("UPDATE public.trading_wallets SET name=$3,updated_at=NOW() WHERE telegram_id=$1 AND id=$2",[ctx.from.id,id,name]);return view(ctx,d,id);}}catch(e){console.error("[wallets] input",e);return d.show(ctx,"❌ *WALLET ACTION FAILED*\n\nThe wallet was not changed.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("👛 Wallets","wallets")});}});
}
