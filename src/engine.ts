import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getActiveTradingWallet } from "./multi-wallets.js";
import { InlineKeyboard } from "grammy";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

type Pool = any;
type BotLike = any;
type Strategy = {
  profile?: string;
  discovery?: {
    marketCapMin?: number; marketCapMax?: number | null; liquidityMin?: number;
    volume5mMin?: number; tokenAgeMinSec?: number; tokenAgeMaxSec?: number | null; holderMin?: number;
    top10Max?: number; devMax?: number; smartFilters?: boolean; strictData?: boolean;
  };
  execution?: {
    buyAmountSol?: number; maxBuyAmountSol?: number;
    takeProfit?: {pct:number;sellPct:number}[]; maxOpenPositions?: number; dailySpendingLimitSol?: number | null;
    stopLossPct?: number;
    trailing?: {enabled:boolean;activationPct:number;pullbackPct:number};
  };
};
type SecurityState = "ACTIVE" | "REVOKED" | "UNKNOWN";
type Security = { mintAuthority: SecurityState; freezeAuthority: SecurityState; verified: boolean; source: string };
type Candidate = {
  address:string; symbol:string; name:string; price:number|null; marketCap:number|null;
  liquidity:number|null; volume5m:number|null; createdAt:number|null; holders:number|null;
  top10:number|null; devPct:number|null; security:Security; source:any;
};
const SOL = "So11111111111111111111111111111111111111112";
const now = () => new Date();
const n = (v:any):number|null => { const x=Number(v); return Number.isFinite(x)&&x>=0?x:null; };
const pick = (o:any,...keys:string[]) => { for(const k of keys){const v=o?.[k];if(v!==undefined&&v!==null)return v;}return null; };
const authHeaders = (key:string) => ({ "X-API-KEY":key, "x-chain":"solana", accept:"application/json" });

async function withUserTradeLock<T>(pool:Pool,telegramId:number,fn:()=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try{
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,734221))",["laprint-trade:"+telegramId]);
    return await fn();
  }finally{
    try{await client.query("SELECT pg_advisory_unlock(hashtextextended($1,734221))",["laprint-trade:"+telegramId]);}catch{}
    client.release();
  }
}

export async function ensureEngineSchema(pool:Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.engine_candidates (
      address TEXT PRIMARY KEY, symbol TEXT, name TEXT, market_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'discovered', reject_reason TEXT, first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS public.engine_candidate_users (
      telegram_id BIGINT NOT NULL, address TEXT NOT NULL REFERENCES public.engine_candidates(address) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'rejected', reject_reason TEXT, strategy_profile TEXT,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (telegram_id,address)
    );
    CREATE INDEX IF NOT EXISTS engine_candidate_users_user_status_idx
      ON public.engine_candidate_users(telegram_id,status,evaluated_at DESC);
    CREATE INDEX IF NOT EXISTS engine_candidate_users_address_idx
      ON public.engine_candidate_users(address,evaluated_at DESC);
    CREATE TABLE IF NOT EXISTS public.engine_events (
      id BIGSERIAL PRIMARY KEY, telegram_id BIGINT, event_type TEXT NOT NULL, token_address TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS engine_events_user_created_idx ON public.engine_events(telegram_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS public.engine_positions (
      id BIGSERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL, wallet_id BIGINT, wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL, symbol TEXT, entry_signature TEXT, entry_price NUMERIC,
      token_amount NUMERIC NOT NULL DEFAULT 0, remaining_amount NUMERIC NOT NULL DEFAULT 0,
      sol_spent NUMERIC NOT NULL DEFAULT 0, realized_pnl_sol NUMERIC NOT NULL DEFAULT 0,
      high_water_price NUMERIC, status TEXT NOT NULL DEFAULT 'open', exit_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), closed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS engine_positions_open_idx ON public.engine_positions(telegram_id,status);
    CREATE UNIQUE INDEX IF NOT EXISTS engine_positions_entry_sig_uidx ON public.engine_positions(entry_signature) WHERE entry_signature IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS engine_positions_open_wallet_token_uidx ON public.engine_positions(wallet_id,token_address) WHERE status='open';
    CREATE TABLE IF NOT EXISTS public.trade_intents (
      id UUID PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      wallet_id BIGINT,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL,
      amount_atomic NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      signature TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS trade_intents_recovery_idx
      ON public.trade_intents(status,updated_at DESC);
  `);
}

async function apiJson(url:string, headers:Record<string,string>) {
  const res=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error("API "+res.status+": "+JSON.stringify(body).slice(0,300));
  return body?.data ?? body;
}

const pumpQueue:any[]=[];
const pumpSeen=new Map<string,number>();
let pumpSocket:WebSocket|null=null;
let pumpReconnectTimer:ReturnType<typeof setTimeout>|null=null;
let pumpStarting=false;

function pumpNativeConfigured(){
  return Boolean(process.env.PUMPPORTAL_WS_URL || "wss://pumpportal.fun/api/data");
}

function startPumpNativeStream(){
  if(pumpStarting || pumpSocket) return;
  pumpStarting=true;
  const url=process.env.PUMPPORTAL_WS_URL || "wss://pumpportal.fun/api/data";
  try{
    const ws=new WebSocket(url);
    pumpSocket=ws;
    ws.addEventListener("open",()=>{
      pumpStarting=false;
      ws.send(JSON.stringify({method:"subscribeNewToken"}));
      console.log("[scanner] Pump.fun-native discovery stream connected");
    });
    ws.addEventListener("message",(event)=>{
      try{
        const raw=JSON.parse(String(event.data));
        const address=String(pick(raw,"mint","address","token_address")||"");
        if(!address)return;
        const ts=Date.now();
        if(pumpSeen.has(address) && ts-(pumpSeen.get(address)||0)<10*60_000)return;
        pumpSeen.set(address,ts);
        pumpQueue.push({...raw,address,__pumpNative:true,__discoveredAt:ts});
        while(pumpQueue.length>200)pumpQueue.shift();
      }catch(e){console.warn("[scanner] invalid Pump.fun stream event",String(e).slice(0,120));}
    });
    const reconnect=()=>{
      pumpSocket=null;
      pumpStarting=false;
      if(pumpReconnectTimer)return;
      pumpReconnectTimer=setTimeout(()=>{pumpReconnectTimer=null;startPumpNativeStream();},5000);
    };
    ws.addEventListener("close",reconnect);
    ws.addEventListener("error",reconnect);
  }catch(e){
    pumpSocket=null;
    pumpStarting=false;
    console.error("[scanner] Pump.fun-native stream failed",String(e).slice(0,180));
  }
}

function takePumpCandidates(limit=20){
  const out:any[]=[];
  while(out.length<limit && pumpQueue.length)out.push(pumpQueue.shift());
  return out;
}

async function mintSecurity(address:string):Promise<Security> {
  const rpc=process.env.SOLANA_RPC_URL;
  if(!rpc) return {mintAuthority:"UNKNOWN",freezeAuthority:"UNKNOWN",verified:false,source:"rpc_unconfigured"};
  try {
    const res=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      jsonrpc:"2.0",id:1,method:"getAccountInfo",params:[address,{encoding:"jsonParsed",commitment:"confirmed"}]
    }),signal:AbortSignal.timeout(10000)});
    const body=await res.json().catch(()=>({}));
    const info=body?.result?.value?.data?.parsed?.info;
    if(body?.error || !info) return {mintAuthority:"UNKNOWN",freezeAuthority:"UNKNOWN",verified:false,source:"solana_rpc"};
    const state=(v:any):SecurityState=>v===null?"REVOKED":typeof v==="string"&&v.length>0?"ACTIVE":"UNKNOWN";
    const mintAuthority=state(info.mintAuthority);
    const freezeAuthority=state(info.freezeAuthority);
    return {mintAuthority,freezeAuthority,verified:mintAuthority!=="UNKNOWN"&&freezeAuthority!=="UNKNOWN",source:"solana_rpc"};
  } catch {
    return {mintAuthority:"UNKNOWN",freezeAuthority:"UNKNOWN",verified:false,source:"solana_rpc"};
  }
}

async function overview(address:string):Promise<any> {
  const key=process.env.BIRDEYE_API_KEY!;
  const base=process.env.BIRDEYE_API_BASE || "https://public-api.birdeye.so";
  return apiJson(base+"/defi/token_overview?address="+encodeURIComponent(address),authHeaders(key));
}

function mapCandidate(raw:any,ov:any,security:Security):Candidate {
  const address=String(pick(raw,"address","token_address","mint")||pick(ov,"address","token_address")||"");
  const created=pick(raw,"created_at","creation_time","listed_at","createdAt","__discoveredAt");
  const createdAt=created==null?null:(typeof created==="number"?(created<1e12?created*1000:created):Date.parse(String(created)));
  const v5=pick(ov,"volume_5m_usd","v5m","volume5m") ?? pick(raw,"volume_5m_usd","volume5m");
  return {
    address, symbol:String(pick(raw,"symbol")||pick(ov,"symbol")||"UNKNOWN"),
    name:String(pick(raw,"name")||pick(ov,"name")||"Unknown token"),
    price:n(pick(ov,"price","price_usd")), marketCap:n(pick(ov,"mc","market_cap","marketCap")),
    liquidity:n(pick(ov,"liquidity","liquidity_usd")), volume5m:n(v5),
    createdAt:Number.isFinite(createdAt as number)?createdAt:null,
    holders:n(pick(ov,"holder","holders","holder_count")), top10:n(pick(ov,"top10_holder_percent","top10","top_10_holder_pct")),
    devPct:n(pick(ov,"creator_percentage","creator_percent","dev_percent")), security, source:{listing:raw,overview:ov,security}
  };
}

export function evaluateCandidate(c:Candidate,s:Strategy) {
  const d=s.discovery||{};
  const checks:[string,boolean][]=[
    ["invalid mint",!!c.address && (()=>{try{new PublicKey(c.address);return true}catch{return false}})()],
    ["market cap unavailable",c.marketCap!==null],["market cap below minimum",c.marketCap!==null&&c.marketCap>=Math.max(16000,d.marketCapMin??0)],
    ["market cap above maximum",d.marketCapMax==null||c.marketCap!==null&&c.marketCap<=d.marketCapMax],
    ["liquidity unavailable",c.liquidity!==null],["liquidity below minimum",c.liquidity!==null&&c.liquidity>=(d.liquidityMin??0)],
    ["5m volume unavailable",c.volume5m!==null],["5m volume below minimum",c.volume5m!==null&&c.volume5m>=(d.volume5mMin??0)],
    ["creation time unavailable",c.createdAt!==null],["token too young",c.createdAt!==null&&(Date.now()-c.createdAt)/1000>=(d.tokenAgeMinSec??0)],
    ["token age unavailable",c.createdAt!==null],["token too old",c.createdAt!==null&&d.tokenAgeMaxSec!=null&&(Date.now()-c.createdAt)/1000<=d.tokenAgeMaxSec],
    ["holder count unavailable",c.holders!==null],["holder count below minimum",c.holders!==null&&c.holders>=(d.holderMin??0)],
    ["top-10 concentration unavailable",c.top10!==null],["top-10 concentration too high",c.top10!==null&&c.top10<=(d.top10Max??100)],
    ["developer concentration unavailable",c.devPct!==null],["developer concentration too high",c.devPct!==null&&c.devPct<=(d.devMax??100)]
  ];
  const failures:string[]=[];
  for(let i=0;i<checks.length;i+=2){if(!checks[i][1])failures.push(checks[i][0]);else if(!checks[i+1][1])failures.push(checks[i+1][0]);}
  if(d.strictData!==false){
    if(c.security.mintAuthority==="UNKNOWN") failures.push("mint authority unavailable");
    else if(c.security.mintAuthority==="ACTIVE") failures.push("mint authority active");
    if(c.security.freezeAuthority==="UNKNOWN") failures.push("freeze authority unavailable");
    else if(c.security.freezeAuthority==="ACTIVE") failures.push("freeze authority active");
  }
  return {qualified:failures.length===0,reasons:failures};
}

async function getStrategy(row:any):Promise<Strategy> {
  if(row.strategy_config) return row.strategy_config;
  const profile=String(row.strategy_profile||"balanced");
  const defaults:any={
    shield:{marketCapMin:30000,marketCapMax:100000,liquidityMin:10000,volume5mMin:5000,tokenAgeMinSec:300,holderMin:250,top10Max:20,devMax:2},
    balanced:{marketCapMin:16000,liquidityMin:5000,volume5mMin:2000,tokenAgeMinSec:60,holderMin:100,top10Max:30,devMax:5},
    momentum:{marketCapMin:16000,liquidityMin:5000,volume5mMin:5000,tokenAgeMinSec:60,holderMin:100,top10Max:30,devMax:5},
    degen:{marketCapMin:16000,liquidityMin:3000,volume5mMin:1000,tokenAgeMinSec:30,holderMin:50,top10Max:35,devMax:10}
  };
  return {profile,discovery:defaults[profile]||defaults.balanced,execution:{buyAmountSol:Number(row.buy_amount)||0.1,stopLossPct:Number(row.sl_percent)||-20,takeProfit:row.tp_config?.targets||[],trailing:{enabled:false,activationPct:30,pullbackPct:15}}};
}

async function saveEvent(pool:Pool,id:number|null,type:string,address:string|null,details:any) {
  await pool.query("INSERT INTO public.engine_events(telegram_id,event_type,token_address,details) VALUES($1,$2,$3,$4)",[id,type,address,details]);
}

async function scanOnce(pool:Pool, bot?:BotLike) {
  const listings=takePumpCandidates(20);
  const users=await pool.query("SELECT telegram_id,strategy_profile,strategy_config,buy_amount,sl_percent,tp_config FROM public.users");
  let inspected=0,qualified=0,evaluated=0;
  for(const item of listings){
    const address=String(pick(item,"address","token_address","mint")||"");
    if(!address) continue;
    try{
      if(!item.__pumpNative) continue;
      const nativeMcSol=n(pick(item,"marketCapSol","market_cap_sol"));
      const solUsd=n(pick(item,"solPriceUsd","sol_price_usd"));
      const roughMcUsd=nativeMcSol!==null&&solUsd!==null?nativeMcSol*solUsd:null;
      if(roughMcUsd!==null && roughMcUsd<16000) continue;
      const ov=await overview(address),security=await mintSecurity(address),candidate=mapCandidate(item,ov,security);
      if(!candidate.address)continue;
      const c={...candidate,marketCap:candidate.marketCap!==null&&candidate.marketCap>=0?candidate.marketCap:null};
      for(const u of users.rows){
        const strategy=await getStrategy(u),result=evaluateCandidate(c,strategy);
        await pool.query(
          "INSERT INTO public.engine_candidates(address,symbol,name,market_data,status,reject_reason,last_seen) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(address) DO UPDATE SET symbol=EXCLUDED.symbol,name=EXCLUDED.name,market_data=EXCLUDED.market_data,last_seen=NOW()",
          [c.address,c.symbol,c.name,c.source,result.qualified?"qualified":"rejected",result.qualified?null:result.reasons.join(", ")]
        );
        await pool.query(
          "INSERT INTO public.engine_candidate_users(telegram_id,address,status,reject_reason,strategy_profile,evaluated_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(telegram_id,address) DO UPDATE SET status=EXCLUDED.status,reject_reason=EXCLUDED.reject_reason,strategy_profile=EXCLUDED.strategy_profile,evaluated_at=NOW()",
          [u.telegram_id,c.address,result.qualified?"qualified":"rejected",result.qualified?null:result.reasons.join(", "),strategy.profile||u.strategy_profile||"balanced"]
        );
        evaluated++;
        if(result.qualified){
  qualified++;
  if(bot && u.trading_active){
    const eventKey="qualified_call:"+c.address;
    const dedupe=await pool.query("INSERT INTO public.notification_events(telegram_id,event_key) VALUES($1,$2) ON CONFLICT DO NOTHING",[u.telegram_id,eventKey]);
    if(dedupe.rowCount===1){
      const tp=(strategy.execution?.takeProfit||[]).map((t:any)=>"+"+t.pct).join(" / ")||"—";
      const sl=strategy.execution?.stopLossPct ?? "—";
      const msg=["📡 *QUALIFIED CALL*","","🪙 *"+c.symbol+"*","","CA:","`"+c.address+"`","","💵 MC: $"+(c.marketCap??"—"),"💧 Liquidity: $"+(c.liquidity??"—"),"📈 5M Volume: $"+(c.volume5m??"—"),"","🎯 Buy: "+(strategy.execution?.buyAmountSol??"—")+" SOL","🎯 TP: "+tp+"%","🛑 SL: "+sl+"%","",""+(u.mode==="manual"?"Review this call before execution.":"Qualified and ready for the configured execution path.")].join("\n");
      const k=new InlineKeyboard().text("📊 VIEW DETAILS","call:details:"+c.address);
      if(u.mode==="manual") k.row().text("✅ APPROVE","call:approve:"+c.address).text("❌ REJECT","call:reject:"+c.address);
      if(u.mode!=="manual" && u.trading_active && process.env.ENGINE_MODE==="enabled"){
        try{
          await executeQualifiedEntry(pool,bot,u.telegram_id,c.address,c.symbol,strategy);
        }catch(e){ console.warn("[engine] autopilot entry failed",u.telegram_id,c.address,String(e).slice(0,220)); }
      }
      await bot.api.sendMessage(u.telegram_id,msg,{parse_mode:"Markdown",reply_markup:k});
      await saveEvent(pool,u.telegram_id,"qualified_call",c.address,{mode:u.mode||"autopilot",strategy:strategy.profile||"balanced"});
    }
  }
}
      }
      inspected++;
    }catch(e){console.warn("[scanner] token inspect failed",address,String(e).slice(0,180));}
  }
  console.log("[scanner] scan complete",JSON.stringify({discovered:listings.length,inspected,qualified,evaluated,source:"pump.fun-native"}));
}
async function tokenBalance(pool:Pool,telegramId:number,token:string) {
  const wallet=await getActiveTradingWallet(pool,telegramId);
  if(!wallet) throw new Error("No active trading wallet.");
  const connection=new Connection(process.env.SOLANA_RPC_URL!,"confirmed");
  const accounts=await connection.getParsedTokenAccountsByOwner(wallet.keypair.publicKey,{mint:new PublicKey(token)},"confirmed");
  let raw=0n,decimals=0;
  for(const a of accounts.value){
    const ui=a.account.data.parsed.info.tokenAmount;
    decimals=Number(ui.decimals||0);
    raw+=BigInt(ui.amount||"0");
  }
  return {wallet,raw,decimals};
}

export async function openVerifiedPosition(pool:Pool,telegramId:number,token:string,symbol:string,buyAmountSol:number,result:SwapResult,strategy:Strategy) {
  const wallet=await getActiveTradingWallet(pool,telegramId);
  if(!wallet) throw new Error("No active trading wallet.");
  const amount=BigInt(result.outputAmount);
  if(amount<=0n) throw new Error("Buy confirmed but token output was zero.");
  const existing=await pool.query("SELECT id FROM public.engine_positions WHERE telegram_id=$1 AND wallet_id=$2 AND token_address=$3 AND status='open' LIMIT 1",[telegramId,wallet.id,token]);
  if(existing.rowCount) return existing.rows[0].id;
  const solSpent=Number(result.inputAmount)/LAMPORTS_PER_SOL;
  const entryPrice=solSpent/Number(amount);
  const inserted=await pool.query(
    "INSERT INTO public.engine_positions(telegram_id,wallet_id,wallet_address,token_address,symbol,entry_signature,entry_price,token_amount,remaining_amount,sol_spent,high_water_price,status,exit_config) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$7,'open',$10) RETURNING id",
    [telegramId,wallet.id,wallet.publicKey,token,symbol,result.signature,entryPrice,amount.toString(),solSpent,{takeProfit:strategy.execution?.takeProfit||[],stopLossPct:strategy.execution?.stopLossPct??-20,trailing:strategy.execution?.trailing||{enabled:false}}]
  );
  await saveEvent(pool,telegramId,"entry_executed",token,{signature:result.signature,inputAmount:result.inputAmount,outputAmount:result.outputAmount,positionId:inserted.rows[0].id});
  return inserted.rows[0].id;
}



export async function revalidateEntry(pool:Pool,address:string,strategy:Strategy){
  const stored=await pool.query("SELECT market_data FROM public.engine_candidates WHERE address=$1 LIMIT 1",[address]);
  if(!stored.rowCount) throw new Error("Candidate is no longer available.");
  const md=stored.rows[0].market_data||{};
  const ov=await overview(address);
  const security=await mintSecurity(address);
  const candidate=mapCandidate(md.listing||{address},ov,security);
  candidate.address=address;
  const result=evaluateCandidate(candidate,strategy);
  if(!result.qualified) throw new Error("Candidate no longer qualifies: "+result.reasons.join(", "));
  return candidate;
}

export async function executeQualifiedEntry(pool:Pool,bot:BotLike,telegramId:number,address:string,symbol:string,strategy:Strategy){
  return withUserTradeLock(pool,telegramId,async()=>{
  const live=process.env.ENGINE_MODE==="enabled"&&process.env.LIVE_TRADING==="true"&&process.env.LIVE_TRADING_ACK==="I_ACCEPT_REAL_SOLANA_TRANSACTIONS";
  if(!live) throw new Error("Live execution safety gate is not enabled.");
  await revalidateEntry(pool,address,strategy);
  const wallet=await getActiveTradingWallet(pool,telegramId);
  if(!wallet) throw new Error("No active trading wallet.");
  const open=await pool.query("SELECT COUNT(*)::int AS n FROM public.engine_positions WHERE telegram_id=$1 AND status='open'",[telegramId]);
  const maxOpen=Number(strategy.execution?.maxOpenPositions||3);
  if(Number(open.rows[0]?.n||0)>=maxOpen) throw new Error("Maximum open positions reached.");
  const buySol=Number(strategy.execution?.buyAmountSol||0);
  const maxBuySol=Number(strategy.execution?.maxBuyAmountSol ?? buySol);
  const dailyLimit=strategy.execution?.dailySpendingLimitSol;
  if(!Number.isFinite(buySol)||buySol<=0) throw new Error("Invalid configured buy amount.");
  if(Number.isFinite(maxBuySol) && buySol>maxBuySol) throw new Error("Configured buy amount exceeds strategy maximum.");
  if(dailyLimit!=null){
    const spent=await pool.query(`
      SELECT (
        COALESCE((SELECT SUM(amount_atomic)
          FROM public.trade_intents
          WHERE telegram_id=$1 AND side='buy' AND status IN ('created','broadcast','confirmed') AND created_at>=CURRENT_DATE),0)
        + COALESCE((SELECT SUM((details->>'inputAmount')::numeric)
          FROM public.engine_events
          WHERE telegram_id=$1 AND event_type='swap_confirmed' AND details->>'side'='buy'
            AND details->>'intentId' IS NULL AND created_at>=CURRENT_DATE),0)
      )::numeric AS atomic
    `,[telegramId]);
    const spentSol=Number(spent.rows[0]?.atomic||0)/LAMPORTS_PER_SOL;
    if(spentSol+buySol>Number(dailyLimit)) throw new Error("Daily spending limit would be exceeded.");
  }
  const amount=Math.floor(buySol*LAMPORTS_PER_SOL);
  if(!Number.isFinite(amount)||amount<=0) throw new Error("Invalid configured buy amount.");
  try{
    const result=await executeJupiterSwap({pool,telegramId,inputMint:SOL,outputMint:address,amountAtomic:String(amount),side:"buy"});
    const positionId=await openVerifiedPosition(pool,telegramId,address,symbol,Number(strategy.execution?.buyAmountSol||0),result,strategy);
    await bot.api.sendMessage(telegramId,"🟢 ENTRY EXECUTED\\n\\n"+symbol+"\\n\\nCA:\\n"+address+"\\n\\nBuy: "+strategy.execution?.buyAmountSol+" SOL\\nTransaction:\\n"+result.signature);
    return {result,positionId};
  }catch(error){
    const message=String((error as any)?.message||error);
    const unknown=message.startsWith("TRANSACTION_STATUS_UNKNOWN:");
    await saveEvent(pool,telegramId,unknown?"execution_status_unknown":"execution_failed",address,{reason:message.slice(0,400),side:"buy"});
    await bot.api.sendMessage(telegramId,unknown
      ?"⚠️ TRANSACTION STATUS UNKNOWN\\n\\n"+address+"\\n\\nThe transaction was broadcast but confirmation could not be verified. Check the transaction before retrying."
      :"⚠️ EXECUTION FAILED\\n\\n"+address+"\\n\\n"+message.slice(0,300));
    throw error;
  }
  });
}

async function executePositionExit(pool:Pool,position:any,rawAmount:bigint,reason:string) {
  const trackedRemaining=BigInt(String(position.remaining_amount||"0"));
  if(trackedRemaining<=0n) return null;
  const walletBalance=await tokenBalance(pool,Number(position.telegram_id),position.token_address);
  const sellAmount=rawAmount<trackedRemaining?rawAmount:trackedRemaining;
  const bounded=sellAmount<walletBalance.raw?sellAmount:walletBalance.raw;
  if(bounded<=0n) return null;
  const result=await executeJupiterSwap({pool,telegramId:Number(position.telegram_id),inputMint:position.token_address,outputMint:SOL,amountAtomic:bounded.toString(),side:"sell"});
  const proceeds=Number(result.outputAmount)/LAMPORTS_PER_SOL;
  const fraction=Number(bounded)/Number(trackedRemaining);
  const cost=Number(position.sol_spent)*Math.min(1,Math.max(0,fraction));
  const pnl=proceeds-cost;
  const left=trackedRemaining-bounded;
  if(left<=0n){
    await pool.query("UPDATE public.engine_positions SET remaining_amount=0,realized_pnl_sol=realized_pnl_sol+$2,status='closed',closed_at=NOW() WHERE id=$1",[position.id,pnl]);
    await saveEvent(pool,Number(position.telegram_id),"position_closed",position.token_address,{signature:result.signature,reason,proceedsSol:proceeds,pnlSol:pnl});
  }else{
    await pool.query("UPDATE public.engine_positions SET remaining_amount=$2,realized_pnl_sol=realized_pnl_sol+$3 WHERE id=$1",[position.id,left.toString(),pnl]);
    await saveEvent(pool,Number(position.telegram_id),"tp_executed",position.token_address,{signature:result.signature,reason,proceedsSol:proceeds,pnlSol:pnl,remainingAmount:left.toString()});
  }
  return {result,pnl};
}

async function positionMark(pool:Pool,position:any) {
  const rpc=process.env.SOLANA_RPC_URL;
  const apiKey=process.env.JUPITER_API_KEY;
  if(!rpc||!apiKey) return null;
  const b=await tokenBalance(pool,Number(position.telegram_id),position.token_address);
  if(b.raw<=0n) return {raw:0n,priceSol:0,closedExternally:true};
  const base=process.env.JUPITER_API_BASE||"https://api.jup.ag";
  const probe=10n**BigInt(b.decimals);
  const res=await fetch(base+"/swap/v1/quote?inputMint="+encodeURIComponent(position.token_address)+"&outputMint="+SOL+"&amount="+probe.toString()+"&slippageBps=100&restrictIntermediateTokens=true",{headers:{"x-api-key":apiKey,accept:"application/json"},signal:AbortSignal.timeout(15000)});
  const q=await res.json().catch(()=>({}));
  if(!res.ok||!q?.outAmount) return null;
  return {raw:b.raw,priceSol:Number(q.outAmount)/LAMPORTS_PER_SOL};
}

async function reconcileTradeIntents(pool:Pool){
  const rows=await pool.query("SELECT id,telegram_id,token_address,side,signature FROM public.trade_intents WHERE status='broadcast' AND signature IS NOT NULL AND updated_at < NOW()-INTERVAL '5 seconds' ORDER BY updated_at ASC LIMIT 100");
  if(!rows.rowCount)return;
  const connection=new Connection(process.env.SOLANA_RPC_URL!,"confirmed");
  const statuses=await connection.getSignatureStatuses(rows.rows.map((r:any)=>r.signature),{searchTransactionHistory:true});
  for(let i=0;i<rows.rows.length;i++){
    const row=rows.rows[i], status=statuses.value[i];
    if(!status)continue;
    if(status.err){
      await pool.query("UPDATE public.trade_intents SET status='failed',error=$2,updated_at=NOW() WHERE id=$1",[row.id,JSON.stringify(status.err)]);
      await saveEvent(pool,Number(row.telegram_id),"swap_reconciled_failed",row.token_address,{signature:row.signature,side:row.side});
    }else if(status.confirmationStatus==="confirmed"||status.confirmationStatus==="finalized"){
      await pool.query("UPDATE public.trade_intents SET status='confirmed',updated_at=NOW() WHERE id=$1",[row.id]);
      await saveEvent(pool,Number(row.telegram_id),"swap_reconciled_confirmed",row.token_address,{signature:row.signature,side:row.side});
    }
  }
}

async function monitorPositions(pool:Pool,bot?:BotLike) {
  const open=await pool.query("SELECT * FROM public.engine_positions WHERE status='open' ORDER BY id ASC LIMIT 50");
  for(const position of open.rows){
    try{
      const mark=await positionMark(pool,position);
      if(!mark) continue;
      if(mark.closedExternally){
        await pool.query("UPDATE public.engine_positions SET remaining_amount=0,status='closed',closed_at=NOW() WHERE id=$1",[position.id]);
        await saveEvent(pool,Number(position.telegram_id),"position_closed",position.token_address,{reason:"balance_reconciled_zero"});
        if(bot) await bot.api.sendMessage(position.telegram_id,"⚠️ POSITION CLOSED\\n\\n"+position.token_address+"\\n\\nThe token balance is now zero. Position state was reconciled from the wallet.");
        continue;
      }
      const entry=Number(position.entry_price||0);
      if(entry<=0) continue;
      const gain=((mark.priceSol-entry)/entry)*100;
      const high=Math.max(Number(position.high_water_price||entry),mark.priceSol);
      await pool.query("UPDATE public.engine_positions SET high_water_price=$2 WHERE id=$1",[position.id,high]);
      const cfg=position.exit_config||{};
      let target:any=null;
      for(const t of (cfg.takeProfit||[])){
        const pct=Number(t.pct);
        if(gain>=pct && Number(t.sellPct)>0){
          const marker="tp_"+pct;
          const done=await pool.query("SELECT 1 FROM public.engine_events WHERE telegram_id=$1 AND token_address=$2 AND event_type=$3 AND (details->>'positionId')=$4 LIMIT 1",[position.telegram_id,position.token_address,marker,String(position.id)]);
          if(!done.rowCount) { target={...t,marker}; break; }
        }
      }
      let reason=target?"TP +"+target.pct+"%":null;
      if(!target && Number(cfg.stopLossPct)<0 && gain<=Number(cfg.stopLossPct)) reason="SL "+cfg.stopLossPct+"%";
      if(!target && !reason && cfg.trailing?.enabled && gain>=Number(cfg.trailing.activationPct)){
        const pullback=((mark.priceSol-high)/high)*100;
        if(pullback<=-Math.abs(Number(cfg.trailing.pullbackPct))) reason="TRAILING STOP";
      }
      if(reason){
        const sellPct=target?Math.min(100,Number(target.sellPct)):100;
        const remainingRaw=BigInt(String(position.remaining_amount||"0"));
        const rawToSell=target
          ? (remainingRaw*BigInt(Math.max(1,Math.floor(sellPct)))/100n)
          : remainingRaw;
        const exit=await executePositionExit(pool,position,rawToSell,reason);
        if(target && exit) await saveEvent(pool,Number(position.telegram_id),target.marker,position.token_address,{gainPct:gain,positionId:position.id});
        if(bot && exit) await bot.api.sendMessage(position.telegram_id,"🟢 "+(reason.startsWith("SL")?"SL TRIGGERED":reason.startsWith("TRAILING")?"TRAILING STOP":"TP MILESTONE")+"\\n\\n"+position.token_address+"\\n\\nMove: "+gain.toFixed(2)+"%\\nRealized PnL: "+exit.pnl.toFixed(6)+" SOL");
      }
    }catch(e){console.warn("[engine] position reconciliation failed",position.id,String(e).slice(0,240));}
  }
}

export async function startEngine(pool:Pool,bot:BotLike) {
  void bot;
  let scanning=false;
  const scannerEnabled=process.env.SCANNER_MODE==="enabled";
  const engineEnabled=process.env.ENGINE_MODE==="enabled";
  const enabled=scannerEnabled || engineEnabled;
  if(!enabled){console.log("[scanner] disabled; set SCANNER_MODE=enabled to run discovery");return ()=>{};}
  if(!pumpNativeConfigured()){console.error("[scanner] Pump.fun-native discovery is not configured; scanner remains idle");return ()=>{};}
  const lockClient=await pool.connect();
  const lockKey=734221;
  const lock=await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked",[lockKey]);
  if(!lock.rows[0]?.locked){
    lockClient.release();
    console.warn("[engine] another instance owns the engine lock; scanner/position manager disabled on this instance");
    return ()=>{};
  }
  if(!process.env.BIRDEYE_API_KEY){console.error("[scanner] Pump.fun discovery enabled but Birdeye enrichment key is missing; required enrichment will fail closed");}
  const tick=async()=>{
    if(scanning)return;scanning=true;
    try{await reconcileTradeIntents(pool);await scanOnce(pool,bot);if(engineEnabled)await monitorPositions(pool,bot);}
    catch(e){console.error("[scanner] cycle failed",e);}
    finally{scanning=false;}
  };
  startPumpNativeStream();
  console.log("[scanner] Pump.fun-native discovery worker enabled; Birdeye is enrichment only; live execution remains independently gated");
  void tick();
  const timer=setInterval(()=>void tick(),Math.max(15000,Number(process.env.SCANNER_SCAN_INTERVAL_MS||process.env.ENGINE_SCAN_INTERVAL_MS)||30000));
  return ()=>{
    clearInterval(timer);
    try{pumpSocket?.close();}catch{}
    void lockClient.query("SELECT pg_advisory_unlock($1)",[lockKey]).finally(()=>lockClient.release());
  };
}
export async function getScannerView(pool:Pool,telegramId:number,status:"all"|"qualified"|"rejected"="all",offset=0) {
  const condition=status==="all"?"":" AND ecu.status=$2";
  const limitParam=status==="all"?"$2":"$3";
  const offsetParam=status==="all"?"$3":"$4";
  const params=status==="all"?[telegramId,5,Math.max(0,offset)]:[telegramId,status,5,Math.max(0,offset)];
  const list=await pool.query(
    "SELECT ecu.address,ecu.status,ecu.reject_reason,ecu.strategy_profile,ecu.evaluated_at,ec.symbol,ec.name,ec.market_data FROM public.engine_candidate_users ecu JOIN public.engine_candidates ec ON ec.address=ecu.address WHERE ecu.telegram_id=$1"+condition+" ORDER BY ecu.evaluated_at DESC LIMIT "+limitParam+" OFFSET "+offsetParam,
    params
  );
  const counts=await pool.query(
    "SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='qualified')::int AS qualified,COUNT(*) FILTER(WHERE status='rejected')::int AS rejected FROM public.engine_candidate_users WHERE telegram_id=$1",
    [telegramId]
  );
  return {counts:counts.rows[0]||{total:0,qualified:0,rejected:0},items:list.rows};
}

export async function getScannerToken(pool:Pool,telegramId:number,address:string) {
  const r=await pool.query(
    "SELECT ecu.status,ecu.reject_reason,ecu.strategy_profile,ecu.evaluated_at,ec.symbol,ec.name,ec.market_data FROM public.engine_candidate_users ecu JOIN public.engine_candidates ec ON ec.address=ecu.address WHERE ecu.telegram_id=$1 AND ecu.address=$2 LIMIT 1",
    [telegramId,address]
  );
  return r.rows[0]||null;
}

export async function getEngineSnapshot(pool:Pool,telegramId:number) {
  const [c,p,e]=await Promise.all([
    pool.query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='qualified')::int AS qualified FROM public.engine_candidates WHERE last_seen>NOW()-INTERVAL '1 hour'"),
    pool.query("SELECT COUNT(*)::int AS open FROM public.engine_positions WHERE telegram_id=$1 AND status='open'",[telegramId]),
    pool.query("SELECT event_type,details,created_at FROM public.engine_events WHERE telegram_id=$1 ORDER BY id DESC LIMIT 8",[telegramId])
  ]);
  return {candidates:c.rows[0],positions:p.rows[0],events:e.rows};
}


export type SwapResult = { signature:string; inputAmount:string; outputAmount:string; quote:any };

export async function executeJupiterSwap(args:{
  pool:Pool; telegramId:number; inputMint:string; outputMint:string;
  amountAtomic:string; slippageBps?:number; side:"buy"|"sell";
}):Promise<SwapResult>{
  if(process.env.ENGINE_MODE!=="enabled" || process.env.LIVE_TRADING!=="true" ||
     process.env.LIVE_TRADING_ACK!=="I_ACCEPT_REAL_SOLANA_TRANSACTIONS")
    throw new Error("Live execution safety gate is not enabled.");
  const apiKey=process.env.JUPITER_API_KEY;
  const rpcUrl=process.env.SOLANA_RPC_URL;
  if(!apiKey||!rpcUrl)throw new Error("JUPITER_API_KEY and SOLANA_RPC_URL are required.");
  const wallet=await getActiveTradingWallet(args.pool,args.telegramId);
  if(!wallet)throw new Error("No active trading wallet.");
  const connection=new Connection(rpcUrl,"confirmed");
  const amount=BigInt(args.amountAtomic);
  if(amount<=0n)throw new Error("Swap amount must be positive.");
  if(args.side==="buy"){
    const maxSol=Number(process.env.MAX_BUY_SOL||"0.1");
    if(args.inputMint!==SOL || Number(amount)/LAMPORTS_PER_SOL>maxSol)
      throw new Error("Buy exceeds configured SOL cap or does not use SOL as input.");
    const balance=await connection.getBalance(wallet.keypair.publicKey,"confirmed");
    if(balance<Number(amount)+10_000_000)throw new Error("Insufficient SOL for trade plus network fees.");
  }
  const base=process.env.JUPITER_API_BASE||"https://api.jup.ag";
  const headers={"x-api-key":apiKey,accept:"application/json","content-type":"application/json"};
  const quoteUrl=base+"/swap/v1/quote?inputMint="+encodeURIComponent(args.inputMint)+
    "&outputMint="+encodeURIComponent(args.outputMint)+"&amount="+amount.toString()+
    "&slippageBps="+String(args.slippageBps??100)+"&restrictIntermediateTokens=true";
  const quoteRes=await fetch(quoteUrl,{headers,signal:AbortSignal.timeout(15000)});
  const quote=await quoteRes.json().catch(()=>({}));
  if(!quoteRes.ok||!quote?.outAmount)throw new Error("Jupiter quote failed: "+JSON.stringify(quote).slice(0,300));
  const swapRes=await fetch(base+"/swap/v1/swap",{method:"POST",headers,body:JSON.stringify({
    quoteResponse:quote,userPublicKey:wallet.keypair.publicKey.toBase58(),
    wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true,prioritizationFeeLamports:"auto"
  }),signal:AbortSignal.timeout(20000)});
  const swap=await swapRes.json().catch(()=>({}));
  if(!swapRes.ok||!swap?.swapTransaction)throw new Error("Jupiter transaction build failed: "+JSON.stringify(swap).slice(0,300));
  const tx=VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction,"base64"));
  tx.sign([wallet.keypair]);
  const sim=await connection.simulateTransaction(tx,{sigVerify:true,commitment:"processed"});
  if(sim.value.err)throw new Error("Transaction simulation failed: "+JSON.stringify(sim.value.err));
  if(process.env.LIVE_TRADING_SIMULATION_ONLY==="true")throw new Error("Simulation-only mode: transaction was not broadcast.");
  const intentId=randomUUID();
  await args.pool.query("INSERT INTO public.trade_intents(id,telegram_id,wallet_id,token_address,side,amount_atomic,status) VALUES($1,$2,$3,$4,$5,$6,'created')",[intentId,args.telegramId,wallet.id,args.outputMint,args.side,amount.toString()]);
  let signature:string;
  try {
    signature=await connection.sendTransaction(tx,{skipPreflight:false,maxRetries:2,preflightCommitment:"confirmed"});
    await args.pool.query("UPDATE public.trade_intents SET signature=$2,status='broadcast',updated_at=NOW() WHERE id=$1",[intentId,signature]);
  } catch(error) {
    await args.pool.query("UPDATE public.trade_intents SET status='failed',error=$2,updated_at=NOW() WHERE id=$1",[intentId,String((error as any)?.message||error).slice(0,500)]);
    throw error;
  }
  let confirmation:any;
  try{
    confirmation=await connection.confirmTransaction(signature,"confirmed");
  }catch(error){
    throw new Error("TRANSACTION_STATUS_UNKNOWN: "+String((error as any)?.message||error));
  }
  if(confirmation.value.err){
    await args.pool.query("UPDATE public.trade_intents SET status='failed',error=$2,updated_at=NOW() WHERE id=$1",[intentId,JSON.stringify(confirmation.value.err)]);
    throw new Error("On-chain transaction failed: "+JSON.stringify(confirmation.value.err));
  }
  await args.pool.query("UPDATE public.trade_intents SET status='confirmed',updated_at=NOW() WHERE id=$1",[intentId]);
  await saveEvent(args.pool,args.telegramId,"swap_confirmed",args.outputMint,{side:args.side,signature,inputAmount:quote.inAmount,outputAmount:quote.outAmount,wallet:wallet.publicKey,intentId});
  return {signature,inputAmount:String(quote.inAmount),outputAmount:String(quote.outAmount),quote};
}

export function engineReadiness() {
  return {
    mode:process.env.ENGINE_MODE||"disabled",
    birdeye:Boolean(process.env.BIRDEYE_API_KEY),
    jupiter:Boolean(process.env.JUPITER_API_KEY),
    rpc:Boolean(process.env.SOLANA_RPC_URL),
    liveTrading:process.env.LIVE_TRADING==="true",
    executionReady:false
  };
}
