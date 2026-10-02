import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getActiveTradingWallet } from "./multi-wallets.js";

type Pool = any;
type BotLike = any;
type Strategy = {
  profile?: string;
  discovery?: {
    marketCapMin?: number; marketCapMax?: number | null; liquidityMin?: number;
    volume5mMin?: number; tokenAgeMinSec?: number; holderMin?: number;
    top10Max?: number; devMax?: number; smartFilters?: boolean; strictData?: boolean;
  };
  execution?: {
    buyAmountSol?: number;
    takeProfit?: {pct:number;sellPct:number}[];
    stopLossPct?: number;
    trailing?: {enabled:boolean;activationPct:number;pullbackPct:number};
  };
};
type Candidate = {
  address:string; symbol:string; name:string; price:number|null; marketCap:number|null;
  liquidity:number|null; volume5m:number|null; createdAt:number|null; holders:number|null;
  top10:number|null; devPct:number|null; source:any;
};
const SOL = "So11111111111111111111111111111111111111112";
const now = () => new Date();
const n = (v:any):number|null => { const x=Number(v); return Number.isFinite(x)&&x>=0?x:null; };
const pick = (o:any,...keys:string[]) => { for(const k of keys){const v=o?.[k];if(v!==undefined&&v!==null)return v;}return null; };
const authHeaders = (key:string) => ({ "X-API-KEY":key, "x-chain":"solana", accept:"application/json" });

export async function ensureEngineSchema(pool:Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.engine_candidates (
      address TEXT PRIMARY KEY, symbol TEXT, name TEXT, market_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'discovered', reject_reason TEXT, first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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
  `);
}

async function apiJson(url:string, headers:Record<string,string>) {
  const res=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error("API "+res.status+": "+JSON.stringify(body).slice(0,300));
  return body?.data ?? body;
}

async function discoverBirdeye():Promise<any[]> {
  const key=process.env.BIRDEYE_API_KEY;
  if(!key) throw new Error("BIRDEYE_API_KEY is not configured");
  const base=process.env.BIRDEYE_API_BASE || "https://public-api.birdeye.so";
  const data=await apiJson(base+"/defi/v2/tokens/new_listing?limit=50&meme_platform_enabled=true",authHeaders(key));
  return Array.isArray(data)?data:(data?.items||data?.tokens||[]);
}

async function overview(address:string):Promise<any> {
  const key=process.env.BIRDEYE_API_KEY!;
  const base=process.env.BIRDEYE_API_BASE || "https://public-api.birdeye.so";
  return apiJson(base+"/defi/token_overview?address="+encodeURIComponent(address),authHeaders(key));
}

function mapCandidate(raw:any,ov:any):Candidate {
  const address=String(pick(raw,"address","token_address","mint")||pick(ov,"address","token_address")||"");
  const created=pick(raw,"created_at","creation_time","listed_at","createdAt");
  const createdAt=created==null?null:(typeof created==="number"?(created<1e12?created*1000:created):Date.parse(String(created)));
  const v5=pick(ov,"volume_5m_usd","v5m","volume5m") ?? pick(raw,"volume_5m_usd","volume5m");
  return {
    address, symbol:String(pick(raw,"symbol")||pick(ov,"symbol")||"UNKNOWN"),
    name:String(pick(raw,"name")||pick(ov,"name")||"Unknown token"),
    price:n(pick(ov,"price","price_usd")), marketCap:n(pick(ov,"mc","market_cap","marketCap")),
    liquidity:n(pick(ov,"liquidity","liquidity_usd")), volume5m:n(v5),
    createdAt:Number.isFinite(createdAt as number)?createdAt:null,
    holders:n(pick(ov,"holder","holders","holder_count")), top10:n(pick(ov,"top10_holder_percent","top10","top_10_holder_pct")),
    devPct:n(pick(ov,"creator_percentage","creator_percent","dev_percent")), source:{listing:raw,overview:ov}
  };
}

export function evaluateCandidate(c:Candidate,s:Strategy) {
  const d=s.discovery||{};
  const checks:[string,boolean][]=[
    ["invalid mint",!!c.address && (()=>{try{new PublicKey(c.address);return true}catch{return false}})()],
    ["market cap unavailable",c.marketCap!==null],["market cap below minimum",c.marketCap!==null&&c.marketCap>=(d.marketCapMin??0)],
    ["market cap above maximum",d.marketCapMax==null||c.marketCap!==null&&c.marketCap<=d.marketCapMax],
    ["liquidity unavailable",c.liquidity!==null],["liquidity below minimum",c.liquidity!==null&&c.liquidity>=(d.liquidityMin??0)],
    ["5m volume unavailable",c.volume5m!==null],["5m volume below minimum",c.volume5m!==null&&c.volume5m>=(d.volume5mMin??0)],
    ["creation time unavailable",c.createdAt!==null],["token too young",c.createdAt!==null&&(Date.now()-c.createdAt)/1000>=(d.tokenAgeMinSec??0)],
    ["holder count unavailable",c.holders!==null],["holder count below minimum",c.holders!==null&&c.holders>=(d.holderMin??0)],
    ["top-10 concentration unavailable",c.top10!==null],["top-10 concentration too high",c.top10!==null&&c.top10<=(d.top10Max??100)],
    ["developer concentration unavailable",c.devPct!==null],["developer concentration too high",c.devPct!==null&&c.devPct<=(d.devMax??100)]
  ];
  const failures:string[]=[];
  for(let i=0;i<checks.length;i+=2){if(!checks[i][1])failures.push(checks[i][0]);else if(!checks[i+1][1])failures.push(checks[i+1][0]);}
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

async function scanOnce(pool:Pool) {
  const listings=await discoverBirdeye();
  let inspected=0,qualified=0;
  for(const item of listings.slice(0,50)){
    const address=String(pick(item,"address","token_address","mint")||"");
    if(!address) continue;
    try{
      const ov=await overview(address),c=mapCandidate(item,ov);
      if(!c.address)continue;
      const users=await pool.query("SELECT telegram_id,strategy_profile,strategy_config,buy_amount,sl_percent,tp_config,trading_active,mode FROM public.users WHERE trading_active=TRUE");
      let anyQualified=false,reasons:string[]=[];
      for(const u of users.rows){
        const strategy=await getStrategy(u),result=evaluateCandidate(c,strategy);
        if(result.qualified)anyQualified=true; else reasons=result.reasons;
      }
      await pool.query(`INSERT INTO public.engine_candidates(address,symbol,name,market_data,status,reject_reason,last_seen)
        VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(address) DO UPDATE SET symbol=EXCLUDED.symbol,name=EXCLUDED.name,market_data=EXCLUDED.market_data,status=EXCLUDED.status,reject_reason=EXCLUDED.reject_reason,last_seen=NOW()`,
        [c.address,c.symbol,c.name,c.source,anyQualified?"qualified":"rejected",anyQualified?null:reasons.join(", ")||"no active strategy"]);
      inspected++;if(anyQualified)qualified++;
    }catch(e){console.warn("[engine] token inspect failed",address,String(e).slice(0,180));}
  }
  console.log("[engine] scan complete",JSON.stringify({discovered:listings.length,inspected,qualified}));
}

async function monitorPositions(pool:Pool) {
  // Position monitoring deliberately does not fabricate marks or execute exits until token-account
  // balance reconciliation and a sell-transaction path are enabled.
  const open=await pool.query("SELECT COUNT(*)::int AS n FROM public.engine_positions WHERE status='open'");
  if(Number(open.rows[0]?.n||0)>0) console.log("[engine] open positions awaiting verified sell adapter",open.rows[0].n);
}

export function startEngine(pool:Pool,bot:BotLike) {
  let scanning=false;
  const enabled=process.env.ENGINE_MODE==="enabled";
  const tick=async()=>{
    if(scanning)return;scanning=true;
    try{await scanOnce(pool);await monitorPositions(pool);}
    catch(e){console.error("[engine] cycle failed",e);}
    finally{scanning=false;}
  };
  if(!enabled){console.log("[engine] disabled; scanner and execution remain locked");return ()=>{};}
  if(!process.env.BIRDEYE_API_KEY){console.error("[engine] ENGINE_MODE enabled but BIRDEYE_API_KEY missing; engine remains idle");return ()=>{};}
  console.log("[engine] scanner worker enabled; execution is locked pending Jupiter + token account verification");
  void tick();
  const timer=setInterval(()=>void tick(),Math.max(15000,Number(process.env.ENGINE_SCAN_INTERVAL_MS)||30000));
  return ()=>clearInterval(timer);
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
  const signature=await connection.sendTransaction(tx,{skipPreflight:false,maxRetries:2,preflightCommitment:"confirmed"});
  const latest=await connection.getLatestBlockhash("confirmed");
  const confirmation=await connection.confirmTransaction({signature,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight},"confirmed");
  if(confirmation.value.err)throw new Error("On-chain transaction failed: "+JSON.stringify(confirmation.value.err));
  await saveEvent(args.pool,args.telegramId,"swap_confirmed",args.outputMint,{side:args.side,signature,inputAmount:quote.inAmount,outputAmount:quote.outAmount,wallet:wallet.publicKey});
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
