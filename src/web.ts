import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

type Pool = { query: (sql: string, params?: unknown[]) => Promise<any> };

const SESSION_COOKIE = "laprint_web_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_TELEGRAM_AUTH_AGE_SECONDS = 60 * 60 * 24;

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
function send(res: ServerResponse, status: number, body: string, contentType = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self' https://telegram.org 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://*.telegram.org data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(body);
}
function cookieValue(req: IncomingMessage, name: string) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const entry of cookies) {
    const i = entry.indexOf("=");
    if (i >= 0 && entry.slice(0, i).trim() === name) return decodeURIComponent(entry.slice(i + 1).trim());
  }
  return null;
}
async function readJson(req: IncomingMessage, maxBytes = 16_384): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > maxBytes) throw new Error("Request too large");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function validTelegramLogin(payload: Record<string, unknown>, botToken: string) {
  const hash = String(payload.hash || "");
  const authDate = Number(payload.auth_date);
  if (!/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > MAX_TELEGRAM_AUTH_AGE_SECONDS) return false;
  const dataCheck = Object.keys(payload)
    .filter((key) => key !== "hash" && payload[key] !== undefined && payload[key] !== null)
    .sort()
    .map((key) => key + "=" + String(payload[key]))
    .join("\n");
  const secretKey = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheck).digest("hex");
  return safeEqual(hash.toLowerCase(), expected.toLowerCase());
}
function sessionSecret() {
  const configured = process.env.WEB_SESSION_SECRET;
  if (configured && configured.length >= 32) return configured;
  return null;
}
function makeSession(telegramId: string, secret: string) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(telegramId + ":" + expires).toString("base64url");
  return payload + "." + sign(payload, secret);
}
function readSession(req: IncomingMessage, secret: string): string | null {
  const raw = cookieValue(req, SESSION_COOKIE);
  if (!raw) return null;
  const [payload, signature, extra] = raw.split(".");
  if (!payload || !signature || extra) return null;
  if (!safeEqual(signature, sign(payload, secret))) return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const i = decoded.lastIndexOf(":");
    const id = decoded.slice(0, i);
    const expires = Number(decoded.slice(i + 1));
    if (!/^\d{1,20}$/.test(id) || !Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return null;
    return id;
  } catch {
    return null;
  }
}
function setSessionCookie(res: ServerResponse, value: string, secure: boolean) {
  res.setHeader("Set-Cookie", SESSION_COOKIE + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_TTL_SECONDS + (secure ? "; Secure" : ""));
}
function clearSessionCookie(res: ServerResponse, secure: boolean) {
  res.setHeader("Set-Cookie", SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (secure ? "; Secure" : ""));
}
function isSecure(req: IncomingMessage) {
  return req.headers["x-forwarded-proto"] === "https" || (req.socket as any).encrypted === true;
}
function json(res: ServerResponse, status: number, value: unknown) {
  send(res, status, JSON.stringify(value));
}
function page(botUsername: string, configured: boolean) {
  const login = configured
    ? '<div id="telegram-login"><p class="muted">Sign in with the same Telegram account you use with La-Print.</p><div id="tg-widget"></div></div>'
    : '<div class="notice">Web sign-in is not configured yet. Set BOT_USERNAME and WEB_SESSION_SECRET in the service environment. Your Telegram bot continues to work normally.</div>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LA-PRINT — Trading Terminal</title>
<style>
:root{color-scheme:dark;--bg:#090b10;--panel:#11151e;--line:#242b38;--muted:#8e9aaf;--text:#eef2fa;--green:#48e0a4;--blue:#83a9ff;--amber:#f4c66b;--red:#ff8585}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 15% 0%,#172033 0,transparent 45%),var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}button{font:inherit;cursor:pointer;border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:#1a2231;color:var(--text)}button:hover{border-color:#5d76a8}.shell{max-width:1240px;margin:auto;padding:24px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:26px}.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:.12em}.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#83a9ff,#48e0a4);color:#081018;display:grid;place-items:center;font-size:18px}.eyebrow{font-size:11px;color:var(--muted);letter-spacing:.16em;text-transform:uppercase}.pill{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:99px;padding:6px 10px;color:var(--muted);font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--green)}h1{font-size:clamp(26px,4vw,38px);line-height:1.12;margin:8px 0}h2{font-size:15px;margin:0 0 15px}.muted{color:var(--muted)}.layout{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{border:1px solid var(--line);border-radius:16px;background:linear-gradient(145deg,rgba(22,28,40,.96),rgba(14,17,25,.96));padding:20px;min-width:0}.wide{grid-column:1/-1}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:22px 0}.stat{background:#0c1018;border:1px solid var(--line);border-radius:12px;padding:14px}.stat .value{font-size:22px;font-weight:750;margin-top:5px;overflow-wrap:anywhere}.value.green{color:var(--green)}.value.blue{color:var(--blue)}.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(36,43,56,.8)}.row:last-child{border-bottom:0}.row span:first-child{color:var(--muted)}.empty{padding:20px;text-align:center;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}.notice{padding:14px;border:1px solid #65522c;background:#2b2415;border-radius:12px;color:#f4dba8}.signin{max-width:540px;margin:10vh auto}.signin .panel{padding:30px}.error{color:var(--red);margin-top:12px}.token{font-family:ui-monospace,monospace;overflow-wrap:anywhere}.tablewrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:520px}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.badge{font-size:11px;border:1px solid var(--line);padding:3px 8px;border-radius:99px}.foot{margin-top:22px;color:var(--muted);font-size:12px;text-align:center}.hidden{display:none!important}@media(max-width:760px){.shell{padding:16px}.layout{grid-template-columns:1fr}.wide{grid-column:auto}.stats{grid-template-columns:1fr 1fr}.top{align-items:flex-start}.top .pill{display:none}.panel{padding:16px}.signin{margin:5vh auto}.signin .panel{padding:22px}}
</style>
</head>
<body><main class="shell">
<header class="top"><div class="brand"><div class="logo">L</div><div>LA-PRINT <div class="eyebrow">V2 · Solana terminal</div></div></div><div class="pill"><span class="dot"></span><span id="connection">Shared bot · awaiting sign-in</span></div></header>
<section id="login-view" class="signin"><div class="panel"><div class="eyebrow">Your existing account</div><h1>One bot. Two ways to use it.</h1><p class="muted">Sign in with Telegram to view the same La-Print profile, wallet addresses, strategy and positions used by your bot. No separate trading account is created.</p>${login}<div id="login-error" class="error"></div><p class="muted" style="font-size:12px;margin-top:24px">Your private keys and seed phrases are never sent to this website.</p></div></section>
<section id="app-view" class="hidden">
<div class="eyebrow">Account overview</div><h1>Trading terminal</h1><div class="muted" id="identity">Loading your La-Print account…</div>
<div class="stats"><div class="stat"><div class="eyebrow">Wallet balance</div><div class="value green" id="balance">—</div><div class="muted">SOL · active wallet</div></div><div class="stat"><div class="eyebrow">Trading mode</div><div class="value blue" id="mode">—</div><div class="muted" id="trading-status">—</div></div><div class="stat"><div class="eyebrow">Open positions</div><div class="value" id="positions-count">—</div><div class="muted">From shared bot database</div></div></div>
<div class="layout">
<div class="panel"><h2>Active wallet</h2><div id="wallets"><div class="empty">Loading wallet…</div></div></div>
<div class="panel"><h2>Saved strategy</h2><div id="strategy"><div class="empty">Loading strategy…</div></div></div>
<div class="panel wide"><h2>Open positions</h2><div class="tablewrap" id="positions"><div class="empty">Loading positions…</div></div></div>
<div class="panel"><h2>Recent activity</h2><div id="activity"><div class="empty">Loading activity…</div></div></div>
<div class="panel"><h2>Account settings</h2><div id="settings"><div class="empty">Loading settings…</div></div></div>
</div><div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px"><button id="refresh">Refresh data</button><button id="logout">Sign out</button></div>
<div class="notice" style="margin-top:16px">Live account data is connected. Trading actions are intentionally not enabled in this first web pass because the repository documents execution and position reconciliation as incomplete. No simulated trade success is shown.</div>
</section>
<div class="foot">LA-PRINT V2 · Uses your existing Telegram identity and shared PostgreSQL records.</div></main>
<script>
const botUsername = ${JSON.stringify(botUsername)};
const loginConfigured = ${JSON.stringify(configured)};
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "—").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (v, digits=4) => v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("en-US",{maximumFractionDigits:digits});
function row(label,value,cls=""){return '<div class="row"><span>'+esc(label)+'</span><strong class="'+cls+'">'+value+'</strong></div>'}
function shortAddress(v){v=String(v||"");return v.length>18?v.slice(0,8)+"…"+v.slice(-6):v||"—"}
function showError(s){$("login-error").textContent=s||""}
window.onTelegramAuth = async (user) => {
 try {
  showError("");
  const r=await fetch("/api/auth/telegram",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(user),credentials:"same-origin"});
  const body=await r.json();
  if(!r.ok) throw new Error(body.error||"Sign-in failed");
  await loadDashboard();
 } catch(e){showError(e.message||"Could not sign in. Try again.");}
};
async function loadDashboard(){
 const r=await fetch("/api/dashboard",{credentials:"same-origin",cache:"no-store"});
 if(r.status===401){$("login-view").classList.remove("hidden");$("app-view").classList.add("hidden");return}
 const d=await r.json(); if(!r.ok)throw new Error(d.error||"Could not load account");
 $("login-view").classList.add("hidden");$("app-view").classList.remove("hidden");
 $("connection").textContent="Connected to La-Print database";
 $("identity").textContent=(d.user.firstName||d.user.username||("Telegram ID "+d.user.telegramId))+" · Telegram account";
 $("balance").textContent=d.wallet.active&&d.wallet.active.balanceSol!=null?fmt(d.wallet.active.balanceSol,6)+" SOL":"Unavailable";
 $("mode").textContent=d.user.mode||"Not configured";
 $("trading-status").textContent=d.user.tradingActive?"Trading marked active":"Trading stopped";
 $("positions-count").textContent=d.positions.filter(p=>p.status==="open").length;
 $("wallets").innerHTML=d.wallets.length?d.wallets.map(w=>row(esc(w.name)+(w.active?' <span class="badge">ACTIVE</span>':""),'<div class="token">'+esc(shortAddress(w.address))+'</div><div class="muted">'+(w.balanceSol==null?'Balance unavailable':fmt(w.balanceSol,6)+' SOL')+'</div>')).join(""):'<div class="empty">No wallet is configured in this account.</div>';
 const c=d.user.strategy||{};
 $("strategy").innerHTML=row("Profile",esc(c.profile||d.user.strategyProfile||"balanced"))+row("Buy size",esc(c.execution?.buyAmountSol??d.user.buyAmount??"—")+" SOL")+row("Stop loss",esc(c.execution?.stopLossPct??d.user.slPercent??"—")+"%")+row("Take-profit targets",esc((c.execution?.takeProfit||[]).map(t=>"+"+t.pct+"% / "+t.sellPct+"%").join(", ")||"See Telegram settings"))+row("Max open positions",esc(c.execution?.maxOpenPositions??"—"));
 $("positions").innerHTML=d.positions.length?'<table><thead><tr><th>Token</th><th>Status</th><th>Amount remaining</th><th>Realized PnL</th><th>Opened</th></tr></thead><tbody>'+d.positions.map(p=>'<tr><td><strong>'+esc(p.symbol||"Unknown")+'</strong><div class="muted token">'+esc(shortAddress(p.tokenAddress))+'</div></td><td>'+esc(p.status)+'</td><td>'+esc(fmt(p.remainingAmount,6))+'</td><td>'+esc(fmt(p.realizedPnlSol,6))+' SOL</td><td>'+esc(p.createdAt?new Date(p.createdAt).toLocaleString():"—")+'</td></tr>').join("")+'</tbody></table>':'<div class="empty">No recorded positions for this account.</div>';
 $("activity").innerHTML=d.activity.length?d.activity.map(e=>row(esc(e.type.replaceAll("_"," ")), '<div>'+esc(e.symbol||shortAddress(e.tokenAddress)||"—")+'</div><div class="muted">'+esc(e.createdAt?new Date(e.createdAt).toLocaleString():"")+'</div>')).join(""):'<div class="empty">No recent engine activity.</div>';
 $("settings").innerHTML=row("Autopilot",d.user.tradingActive?'<span style="color:var(--green)">Marked active</span>':'Stopped')+row("Onboarding",d.user.onboardingComplete?"Complete":"Incomplete")+row("Strategy version",esc(c.version||d.user.strategyVersion||1))+row("Account created",esc(d.user.createdAt?new Date(d.user.createdAt).toLocaleDateString():"—"))+'<p class="muted">Change settings in Telegram for now; web edits are not enabled yet.</p>';
}
$("refresh").addEventListener("click",()=>loadDashboard().catch(e=>showError(e.message)));
$("logout").addEventListener("click",async()=>{await fetch("/api/logout",{method:"POST",credentials:"same-origin"});$("app-view").classList.add("hidden");$("login-view").classList.remove("hidden");});
if(loginConfigured){const s=document.createElement("script");s.async=true;s.src="https://telegram.org/js/telegram-widget.js?22";s.setAttribute("data-telegram-login",botUsername);s.setAttribute("data-size","large");s.setAttribute("data-radius","10");s.setAttribute("data-userpic","false");s.setAttribute("data-onauth","onTelegramAuth(user)");s.setAttribute("data-request-access","write");$("tg-widget").appendChild(s);}
loadDashboard().catch(e=>showError(e.message));
</script></body></html>`;
}

export function startWebServer(pool: Pool) {
  const port = Number(process.env.PORT || process.env.WEB_PORT || 3000);
  const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const botUsername = String(process.env.BOT_USERNAME || "").replace(/^@/, "");
  const secret = sessionSecret();
  const configured = Boolean(botToken && botUsername && secret);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { ok: true, service: "laprint-web", authConfigured: configured });
      }
      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, page(botUsername, configured), "text/html; charset=utf-8");
      }
      if (req.method === "POST" && url.pathname === "/api/auth/telegram") {
        if (!configured) return json(res, 503, { error: "Telegram web sign-in is not configured." });
        const payload = await readJson(req);
        if (!validTelegramLogin(payload, botToken)) return json(res, 401, { error: "Telegram sign-in could not be verified. Please try again." });
        const telegramId = String(payload.id || "");
        if (!/^\d{1,20}$/.test(telegramId)) return json(res, 400, { error: "Invalid Telegram account." });
        const account = await pool.query("SELECT telegram_id,COALESCE(admin_blocked,FALSE) AS admin_blocked FROM public.users WHERE telegram_id=$1 LIMIT 1", [telegramId]);
        if (!account.rowCount) return json(res, 403, { error: "This Telegram account is not registered with La-Print yet. Open the bot and complete onboarding first." });
        if (account.rows[0].admin_blocked) return json(res, 403, { error: "This La-Print account is disabled. Contact support." });
        setSessionCookie(res, makeSession(telegramId, secret!), isSecure(req));
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/logout") {
        clearSessionCookie(res, isSecure(req));
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/dashboard") {
        if (!secret) return json(res, 503, { error: "Web session signing is not configured." });
        const telegramId = readSession(req, secret);
        if (!telegramId) return json(res, 401, { error: "Sign in with Telegram to continue." });
        const u = await pool.query(`SELECT telegram_id,username,mode,onboarding_complete,trading_active,buy_amount,sl_percent,tp_config,
          strategy_profile,strategy_customized,strategy_version,strategy_config,created_at,admin_blocked
          FROM public.users WHERE telegram_id=$1 LIMIT 1`, [telegramId]);
        if (!u.rowCount || u.rows[0].admin_blocked) return json(res, 401, { error: "La-Print account unavailable." });
        const wallets = await pool.query(`SELECT id,name,public_key,is_active,created_at FROM public.trading_wallets
          WHERE telegram_id=$1 ORDER BY is_active DESC,created_at ASC`, [telegramId]);
        const positions = await pool.query(`SELECT id,token_address,symbol,remaining_amount,realized_pnl_sol,status,created_at,closed_at
          FROM public.engine_positions WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 50`, [telegramId]);
        const events = await pool.query(`SELECT event_type,token_address,details,created_at FROM public.engine_events
          WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 12`, [telegramId]);
        let walletRows = wallets.rows.map((w: any) => ({
          id: String(w.id), name: w.name, address: w.public_key, active: Boolean(w.is_active),
          balanceSol: null as number | null, createdAt: w.created_at
        }));
        const active = walletRows.find((w: any) => w.active);
        const rpc = process.env.SOLANA_RPC_URL;
        if (active && rpc) {
          try {
            const connection = new Connection(rpc, { commitment: "confirmed", confirmTransactionInitialTimeout: 8000 });
            const lamports = await Promise.race([
              connection.getBalance(new PublicKey(active.address), "confirmed"),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 8000))
            ]);
            active.balanceSol = lamports / LAMPORTS_PER_SOL;
          } catch { /* Keep the public wallet address visible; balance is marked unavailable. */ }
        }
        const strategy = typeof u.rows[0].strategy_config === "string"
          ? JSON.parse(u.rows[0].strategy_config)
          : u.rows[0].strategy_config;
        return json(res, 200, {
          user: {
            telegramId, username: u.rows[0].username,
            firstName: "", mode: u.rows[0].mode,
            onboardingComplete: Boolean(u.rows[0].onboarding_complete),
            tradingActive: Boolean(u.rows[0].trading_active),
            buyAmount: u.rows[0].buy_amount == null ? null : Number(u.rows[0].buy_amount),
            slPercent: u.rows[0].sl_percent == null ? null : Number(u.rows[0].sl_percent),
            tpConfig: u.rows[0].tp_config,
            strategyProfile: u.rows[0].strategy_profile,
            strategyCustomized: Boolean(u.rows[0].strategy_customized),
            strategyVersion: Number(u.rows[0].strategy_version || 1),
            strategy, createdAt: u.rows[0].created_at
          },
          wallet: { active: active || null },
          wallets: walletRows,
          positions: positions.rows.map((p: any) => ({
            id: String(p.id), tokenAddress: p.token_address, symbol: p.symbol,
            remainingAmount: String(p.remaining_amount ?? "0"),
            realizedPnlSol: Number(p.realized_pnl_sol || 0), status: p.status,
            createdAt: p.created_at, closedAt: p.closed_at
          })),
          activity: events.rows.map((e: any) => ({
            type: e.event_type, tokenAddress: e.token_address,
            symbol: e.details?.symbol || e.details?.tokenSymbol || null, createdAt: e.created_at
          }))
        });
      }
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      console.error("[web] request failed", req.method, url.pathname, String(error).slice(0, 240));
      return json(res, 500, { error: "The request could not be completed. Please try again." });
    }
  });
  server.listen(port, "0.0.0.0", () => {
    const address = server.address() as AddressInfo;
    console.log("[web] La-Print web terminal listening on " + address.port + "; Telegram login " + (configured ? "configured" : "awaiting BOT_USERNAME and WEB_SESSION_SECRET"));
  });
  return () => server.close();
}
