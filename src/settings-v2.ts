import { InlineKeyboard } from "grammy";
import { notifyAdmin } from "./admin-notifications.js";

type Deps = {
  bot: any;
  pool: any;
  show: (ctx: any, message: string, extra?: any) => Promise<any>;
  user: (id: number, username?: string) => Promise<any>;
  patch: (id: number, fields: Record<string, unknown>) => Promise<any>;
};

export type StrategyConfig = {
  profile: "conservative" | "balanced" | "aggressive" | "degen";
  customized: boolean;
  version: number;
  discovery: {
    marketCapMin: number;
    marketCapMax: number | null;
    liquidityMin: number;
    volume5mMin: number;
    tokenAgeMinSec: number;
    tokenAgeMaxSec: number | null;
    holderMin: number;
    top10Max: number;
    devMax: number;
    marketTypes: string[];
    smartFilters: boolean;
    strictData: boolean;
  };
  execution: {
    buyAmountSol: number;
    maxBuyAmountSol: number;
    maxOpenPositions: number;
    takeProfit: { pct: number; sellPct: number }[];
    stopLossPct: number;
    trailing: { enabled: boolean; activationPct: number; pullbackPct: number };
    dailySpendingLimitSol: number | null;
  };
};

const PRESETS: Record<string, Omit<StrategyConfig, "version">> = {
  conservative: {
    profile: "conservative", customized: false,
    discovery: { marketCapMin:16000, marketCapMax:null, liquidityMin:5000, volume5mMin:2000, tokenAgeMinSec:30, tokenAgeMaxSec:1800, holderMin:50, top10Max:35, devMax:5, marketTypes:["new_launch","pre_bond"], smartFilters:true, strictData:true },
    execution: { buyAmountSol:0.05, maxBuyAmountSol:0.05, maxOpenPositions:2, takeProfit:[{pct:20,sellPct:50},{pct:40,sellPct:25},{pct:60,sellPct:15}], stopLossPct:-10, trailing:{enabled:true,activationPct:20,pullbackPct:10}, dailySpendingLimitSol:null }
  },
  balanced: {
    profile: "balanced", customized: false,
    discovery: { marketCapMin:16000, marketCapMax:null, liquidityMin:5000, volume5mMin:2000, tokenAgeMinSec:30, tokenAgeMaxSec:1800, holderMin:50, top10Max:35, devMax:5, marketTypes:["new_launch","pre_bond"], smartFilters:true, strictData:true },
    execution: { buyAmountSol:0.10, maxBuyAmountSol:0.10, maxOpenPositions:3, takeProfit:[{pct:40,sellPct:50},{pct:100,sellPct:25},{pct:200,sellPct:15}], stopLossPct:-15, trailing:{enabled:true,activationPct:30,pullbackPct:12}, dailySpendingLimitSol:null }
  },
  aggressive: {
    profile: "aggressive", customized: false,
    discovery: { marketCapMin:16000, marketCapMax:null, liquidityMin:5000, volume5mMin:2000, tokenAgeMinSec:30, tokenAgeMaxSec:1800, holderMin:50, top10Max:35, devMax:5, marketTypes:["new_launch","pre_bond"], smartFilters:true, strictData:true },
    execution: { buyAmountSol:0.25, maxBuyAmountSol:0.25, maxOpenPositions:5, takeProfit:[{pct:50,sellPct:50},{pct:100,sellPct:25},{pct:200,sellPct:15}], stopLossPct:-20, trailing:{enabled:true,activationPct:30,pullbackPct:15}, dailySpendingLimitSol:null }
  },
  degen: {
    profile: "degen", customized: false,
    discovery: { marketCapMin:16000, marketCapMax:null, liquidityMin:3000, volume5mMin:1000, tokenAgeMinSec:30, tokenAgeMaxSec:1800, holderMin:50, top10Max:35, devMax:10, marketTypes:["new_launch","pre_bond"], smartFilters:true, strictData:true },
    execution: { buyAmountSol:0.50, maxBuyAmountSol:0.50, maxOpenPositions:8, takeProfit:[{pct:100,sellPct:50},{pct:200,sellPct:25},{pct:300,sellPct:15}], stopLossPct:-25, trailing:{enabled:true,activationPct:40,pullbackPct:20}, dailySpendingLimitSol:null }
  }
};

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function normalize(raw: any): StrategyConfig {
  if (raw?.profile && raw?.discovery && raw?.execution) {
    return {
      ...raw,
      version: Number(raw.version || 1),
      customized: Boolean(raw.customized)
    };
  }
  return { ...clone(PRESETS.balanced), version: 1, customized: false };
}

function fmtUsd(n: number | null) {
  return n == null ? "$∞" : "$" + n.toLocaleString("en-US");
}

function strategyName(p: string) {
  return ({conservative:"🛡️ Conservative",balanced:"⚖️ Balanced",aggressive:"🔥 Aggressive",degen:"☠️ Degen"} as any)[p] || p;
}

function profileKeyboard(current: string) {
  return new InlineKeyboard()
    .text(current === "conservative" ? "🛡️ SHIELD ✓" : "🛡️ SHIELD", "v2:profile:conservative")
    .text(current === "balanced" ? "⚖️ BALANCED ✓" : "⚖️ BALANCED", "v2:profile:balanced").row()
    .text(current === "aggressive" ? "🔥 MOMENTUM ✓" : "🔥 MOMENTUM", "v2:profile:aggressive")
    .text(current === "degen" ? "☠️ DEGEN ✓" : "☠️ DEGEN", "v2:profile:degen").row()
    .text("⬅️ SETTINGS", "v2:settings");
}

function settingsKeyboard(c: StrategyConfig) {
  const d = c.discovery;
  return new InlineKeyboard()
    .text("🎯 " + strategyName(c.profile) + (c.customized ? " · CUSTOM" : ""), "v2:profiles").row()
    .text("🔎 MARKET DISCOVERY", "v2:discovery").row()
    .text("🛡️ SAFETY FILTERS", "v2:safety").row()
    .text("🎯 TAKE PROFIT & STOP", "v2:exits").row()
    .text("💰 WALLET & BUY", "v2:wallet").row()
    .text("🔔 NOTIFICATIONS", "v2:notifications").row()
    .text("🧪 TEST SETTINGS", "v2:test").text("📝 CHANGES", "v2:changes").row()
    .text("⚙️ ADVANCED / CUSTOM", "v2:advanced").row()
    .text("⬅️ MAIN MENU", "menu");
}

function summary(c: StrategyConfig) {
  const d = c.discovery, e = c.execution;
  return [
    "⚡ *LA-PRINT V2*",
    "",
    "*ACTIVE SYSTEM*",
    strategyName(c.profile) + (c.customized ? " · CUSTOM" : ""),
    "",
    "🔎 *Discovery*",
    fmtUsd(d.marketCapMin) + " MC+",
    fmtUsd(d.liquidityMin) + " liquidity+",
    fmtUsd(d.volume5mMin) + " 5m volume+",
    Math.round(d.tokenAgeMinSec) + "s+ age",
    d.holderMin + "+ holders",
    "Top 10 <" + d.top10Max + "%",
    "Dev <" + d.devMax + "%",
    "",
    "🛡️ *Data*",
    "Smart filters " + (d.smartFilters ? "ON" : "OFF"),
    "Unknown data: " + (d.strictData ? "REJECT" : "FLAG"),
    "",
    "💰 *Execution*",
    e.buyAmountSol + " SOL / entry",
    e.takeProfit.map(t => "+" + t.pct + "% → " + t.sellPct + "%").join(" · "),
    "SL " + e.stopLossPct + "%",
    "Trailing " + (e.trailing.enabled ? "ON" : "OFF")
  ].join("\n");
}

export type CandidateMetrics = {
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  ageSec: number | null;
  holders: number | null;
  top10Pct: number | null;
  devPct: number | null;
  marketType: "new_launch" | "pre_bond" | null;
};

export type QualificationResult = {
  qualified: boolean;
  status: "PASS" | "FAIL" | "UNKNOWN";
  reasons: string[];
  unknown: string[];
};

export function evaluateCandidate(config: StrategyConfig, token: CandidateMetrics): QualificationResult {
  const d = config.discovery;
  const reasons: string[] = [];
  const unknown: string[] = [];

  const required = [
    ["market cap", token.marketCapUsd, (v:number) => v >= d.marketCapMin && (d.marketCapMax == null || v <= d.marketCapMax)],
    ["liquidity", token.liquidityUsd, (v:number) => v >= d.liquidityMin],
    ["5m volume", token.volume5mUsd, (v:number) => v >= d.volume5mMin],
    ["token age", token.ageSec, (v:number) => v >= d.tokenAgeMinSec],
    ["holders", token.holders, (v:number) => v >= d.holderMin],
    ["top 10 concentration", token.top10Pct, (v:number) => v <= d.top10Max],
    ["developer holdings", token.devPct, (v:number) => v <= d.devMax]
  ] as const;

  for (const [name, value, test] of required) {
    if (value == null || !Number.isFinite(value)) {
      unknown.push(name);
      continue;
    }
    if (!test(value)) reasons.push(name + " failed");
  }

  if (!token.marketType) unknown.push("market type");
  else if (!d.marketTypes.includes(token.marketType)) reasons.push("market type not allowed");

  if (d.strictData && unknown.length) {
    return { qualified: false, status: "UNKNOWN", reasons, unknown };
  }
  if (reasons.length) return { qualified: false, status: "FAIL", reasons, unknown };
  if (unknown.length) return { qualified: false, status: "UNKNOWN", reasons, unknown };
  return { qualified: true, status: "PASS", reasons: [], unknown: [] };
}

export async function getSavedStrategyConfig(pool: any, telegramId: number): Promise<StrategyConfig> {
  const r = await pool.query("SELECT strategy_config FROM public.users WHERE telegram_id=$1", [telegramId]);
  return normalize(r.rows[0]?.strategy_config);
}

async function load(deps: Deps, id: number) {
  const u = await deps.user(id);
  return normalize(u.strategy_config);
}

async function save(deps: Deps, id: number, c: StrategyConfig, customized = c.customized) {
  const current = await load(deps, id);
  const next: StrategyConfig = {
    ...c,
    customized,
    version: Math.max(Number(current.version || 1), Number(c.version || 1)) + 1
  };
  await deps.patch(id, {
    strategy_profile: next.profile,
    strategy_customized: next.customized,
    strategy_version: next.version,
    strategy_config: next,
    buy_amount: next.execution.buyAmountSol,
    tp_config: { type: "partial", targets: next.execution.takeProfit },
    sl_percent: next.execution.stopLossPct,
    filters: {
      type: next.discovery.marketTypes.length === 2 ? "both" : next.discovery.marketTypes[0],
      minMc: next.discovery.marketCapMin,
      maxMc: next.discovery.marketCapMax,
      minLiquidity: next.discovery.liquidityMin,
      minVolume5m: next.discovery.volume5mMin,
      minHolders: next.discovery.holderMin,
      maxTop10: next.discovery.top10Max,
      maxDev: next.discovery.devMax,
      minAgeSec: next.discovery.tokenAgeMinSec,
      smart: next.discovery.smartFilters,
      strictData: next.discovery.strictData
    }
  });
  await notifyAdmin(deps.bot, "strategy_changed", { telegram_id: id, profile: next.profile, customized: next.customized, version: next.version });
  return next;
}

export async function updateStrategyFromWeb(bot: any, pool: any, telegramId: number, input: any) {
  const allowedFields = new Set(["strategy_profile","strategy_customized","strategy_version","strategy_config","buy_amount","tp_config","sl_percent","filters"]);
  const deps: Deps = {
    bot,
    pool,
    show: async () => undefined,
    user: async (id: number) => {
      const result = await pool.query("SELECT * FROM public.users WHERE telegram_id=$1 LIMIT 1", [id]);
      if (!result.rowCount) throw new Error("La-Print account not found.");
      return result.rows[0];
    },
    patch: async (id: number, fields: Record<string, unknown>) => {
      const entries = Object.entries(fields).filter(([key]) => allowedFields.has(key));
      if (entries.length !== Object.keys(fields).length) throw new Error("Unsupported strategy fields.");
      if (!entries.length) return deps.user(id);
      const sets = entries.map(([key], index) => key + "=$" + (index + 2)).join(",");
      await pool.query("UPDATE public.users SET " + sets + ",updated_at=NOW() WHERE telegram_id=$1", [id, ...entries.map(([, value]) => value)]);
      return deps.user(id);
    }
  };
  const current = await load(deps, telegramId);
  let next: StrategyConfig = clone(current);
  let profileChanged = false;
  let customized = true;
  if (input.profile !== undefined) {
    if (typeof input.profile !== "string" || !Object.prototype.hasOwnProperty.call(PRESETS, input.profile)) {
      throw new Error("Choose a valid strategy profile.");
    }
    if (input.profile !== current.profile) {
      next = { ...clone(PRESETS[input.profile]), version: current.version + 1, customized: false };
      profileChanged = true;
      customized = false;
    }
  }
  let customizedChange = false;
  if (input.buyAmountSol !== undefined) {
    const amount = Number(input.buyAmountSol);
    if (![0.01, 0.05, 0.1, 0.25, 0.5, 1].includes(amount)) throw new Error("Choose a supported buy amount.");
    next.execution.buyAmountSol = amount;
    next.execution.maxBuyAmountSol = Math.max(Number(next.execution.maxBuyAmountSol || 0), amount);
    customizedChange = true;
  }
  if (input.stopLossPct !== undefined) {
    const stopLoss = Number(input.stopLossPct);
    if (![-10, -15, -20, -25].includes(stopLoss)) throw new Error("Choose a supported stop-loss value.");
    next.execution.stopLossPct = stopLoss;
    customizedChange = true;
  }
  if (input.trailingEnabled !== undefined) {
    if (typeof input.trailingEnabled !== "boolean") throw new Error("Trailing-stop value must be true or false.");
    next.execution.trailing.enabled = input.trailingEnabled;
    customizedChange = true;
  }
  if (!profileChanged && !customizedChange && input.profile === undefined) {
    throw new Error("No supported strategy changes were supplied.");
  }
  if (customizedChange) customized = true;
  return save(deps, telegramId, next, customized);
}

export async function openStrategySettings(ctx: any, deps: Deps) {
  const c = await load(deps, ctx.from.id);
  await deps.show(ctx, summary(c), {parse_mode:"Markdown", reply_markup:settingsKeyboard(c)});
}

export function registerStrategySettings(deps: Deps) {
  const { bot } = deps;

  bot.command("strategy", (ctx: any) => openStrategySettings(ctx, deps));
  bot.callbackQuery("settings:v2", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    ctx.session.input = undefined;
    await openStrategySettings(ctx, deps);
  });
  bot.callbackQuery("v2:settings", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    ctx.session.input = undefined;
    await openStrategySettings(ctx, deps);
  });

  bot.callbackQuery("v2:profiles", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id);
    const text = [
      "🎯 *TRADING STRATEGY*",
      "",
      "Choose a ready-made system.",
      "",
      "🛡️ *Shield* — selective, stronger safety filters.",
      "⚖️ *Balanced* — discovery + protection.",
      "🔥 *Momentum* — faster, broader discovery.",
      "☠️ *Degen* — maximum discovery and exposure.",
      "",
      "*Current:* " + strategyName(c.profile) + (c.customized ? " · CUSTOM" : "")
    ].join("\n");
    await deps.show(ctx, text, {parse_mode:"Markdown",reply_markup:profileKeyboard(c.profile)});
  });

  bot.callbackQuery(/^v2:profile:(conservative|balanced|aggressive|degen)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const profile = ctx.match[1];
    const current = await load(deps, ctx.from.id);
    const next = { ...clone(PRESETS[profile]), version: current.version + 1, customized: false };
    const saved = await save(deps, ctx.from.id, next, false);
    await deps.show(ctx,
      "✅ *" + strategyName(profile).toUpperCase() + " ACTIVATED*\n\n" +
      "The complete strategy configuration has been updated together.\n\n" +
      summary(saved),
      {parse_mode:"Markdown",reply_markup:settingsKeyboard(saved)}
    );
  });

  bot.callbackQuery("v2:discovery", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id), d = c.discovery;
    const k = new InlineKeyboard()
      .text((d.marketCapMin===16000?"✓ ":"") + "$16K+", "v2:mc:16000").text((d.marketCapMin===20000?"✓ ":"") + "$20K+", "v2:mc:20000").row()
      .text((d.marketCapMin===30000?"✓ ":"") + "$30K+", "v2:mc:30000").text((d.marketCapMin===50000?"✓ ":"") + "$50K+", "v2:mc:50000").row()
      .text((d.marketCapMin===100000?"✓ ":"") + "$100K+", "v2:mc:100000").text((d.marketCapMax==null?"✓ ":"") + "NO MAX", "v2:mc:unlimited").row()
      .text("💧 LIQUIDITY", "v2:liquidity").text("📈 5M VOLUME", "v2:volume").row()
      .text("⏱ TOKEN AGE", "v2:age").text("🏷 MARKET TYPE", "v2:market").row()
      .text("⬅️ SETTINGS", "v2:settings");
    await deps.show(ctx,
      "🔎 *MARKET DISCOVERY*\n\n" +
      "Current MC: " + fmtUsd(d.marketCapMin) + "+\n" +
      "Liquidity: " + fmtUsd(d.liquidityMin) + "+\n" +
      "5m volume: " + fmtUsd(d.volume5mMin) + "+\n" +
      "Age: " + d.tokenAgeMinSec + "s+\n" +
      "Market: " + d.marketTypes.join(" + ") + "\n\n" +
      "Verified market data only. A token below the selected minimum is ineligible.",
      {parse_mode:"Markdown",reply_markup:k}
    );
  });

  bot.callbackQuery(/^v2:mc:(16000|20000|30000|50000|100000|unlimited)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id);
    const min = ctx.match[1] === "unlimited" ? Math.max(16000,c.discovery.marketCapMin) : Math.max(16000,Number(ctx.match[1]));
    c.discovery.marketCapMin = min;
    c.discovery.marketCapMax = null;
    const saved = await save(deps, ctx.from.id, c, true);
    await deps.show(ctx, "✅ *MARKET CAP UPDATED*\n\nMinimum: " + fmtUsd(min) + "+\n\nThis is now a customized " + strategyName(saved.profile) + " system.", {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔎 MARKET DISCOVERY","v2:discovery").text("⚙️ SETTINGS","v2:settings")});
  });

  bot.callbackQuery("v2:liquidity", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id);
    const k = new InlineKeyboard().text("$3K+","v2:set:liq:3000").text("$5K+","v2:set:liq:5000").row().text("$10K+","v2:set:liq:10000").text("$20K+","v2:set:liq:20000").row().text("⬅️ DISCOVERY","v2:discovery");
    await deps.show(ctx, "💧 *LIQUIDITY*\n\nCurrent: " + fmtUsd(c.discovery.liquidityMin) + "+", {parse_mode:"Markdown",reply_markup:k});
  });
  bot.callbackQuery(/^v2:set:liq:(3000|5000|10000|20000)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id); c.discovery.liquidityMin = Number(ctx.match[1]);
    await deps.show(ctx, "Select saved: " + fmtUsd(c.discovery.liquidityMin) + "+", {reply_markup:new InlineKeyboard().text("💾 APPLY","v2:apply").text("↩️ DISCOVERY","v2:discovery")});
    ctx.session.v2pending = c;
  });

  bot.callbackQuery("v2:volume", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id);
    const k = new InlineKeyboard().text("$1K+","v2:set:vol:1000").text("$2K+","v2:set:vol:2000").row().text("$5K+","v2:set:vol:5000").text("$10K+","v2:set:vol:10000").row().text("⬅️ DISCOVERY","v2:discovery");
    await deps.show(ctx, "📈 *5-MINUTE VOLUME*\n\nCurrent: " + fmtUsd(c.discovery.volume5mMin) + "+", {parse_mode:"Markdown",reply_markup:k});
  });
  bot.callbackQuery(/^v2:set:vol:(1000|2000|5000|10000)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id); c.discovery.volume5mMin = Number(ctx.match[1]);
    const saved = await save(deps, ctx.from.id, c, true);
    await deps.show(ctx, "✅ *5M VOLUME SAVED*\n\nMinimum: " + fmtUsd(saved.discovery.volume5mMin) + "+", {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔎 DISCOVERY","v2:discovery").text("⚙️ SETTINGS","v2:settings")});
  });

    bot.callbackQuery("v2:apply", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const pending = ctx.session.v2pending;
    if (!pending) return openStrategySettings(ctx, deps);
    const saved = await save(deps, ctx.from.id, pending, true);
    ctx.session.v2pending = undefined;
    await deps.show(ctx, "✅ *LIQUIDITY SAVED*\n\nMinimum: " + fmtUsd(saved.discovery.liquidityMin) + "+", {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔎 DISCOVERY","v2:discovery").text("⚙️ SETTINGS","v2:settings")});
  });

  bot.callbackQuery("v2:age", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id);
    const k = new InlineKeyboard().text("30 SEC+","v2:set:age:30").text("1 MIN+","v2:set:age:60").row().text("5 MIN+","v2:set:age:300").text("15 MIN+","v2:set:age:900").row().text("⬅️ DISCOVERY","v2:discovery");
    await deps.show(ctx, "⏱ *TOKEN AGE*\n\nCurrent: " + c.discovery.tokenAgeMinSec + " seconds+", {parse_mode:"Markdown",reply_markup:k});
  });
  bot.callbackQuery(/^v2:set:age:(30|60|300|900)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id); c.discovery.tokenAgeMinSec = Number(ctx.match[1]);
    const saved = await save(deps, ctx.from.id, c, true);
    await deps.show(ctx, "✅ *TOKEN AGE SAVED*\n\nMinimum: " + saved.discovery.tokenAgeMinSec + " seconds+", {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔎 DISCOVERY","v2:discovery").text("⚙️ SETTINGS","v2:settings")});
  });

  bot.callbackQuery("v2:market", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id);
    const k = new InlineKeyboard().text("🚀 NEW LAUNCHES","v2:set:market:new").text("🟢 PRE-BOND","v2:set:market:pre").row().text("🔥 BOTH","v2:set:market:both").row().text("⬅️ DISCOVERY","v2:discovery");
    await deps.show(ctx, "🏷 *MARKET TYPE*\n\nCurrent: " + c.discovery.marketTypes.join(" + "), {parse_mode:"Markdown",reply_markup:k});
  });
  bot.callbackQuery(/^v2:set:market:(new|pre|both)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id);
    c.discovery.marketTypes = ctx.match[1] === "both" ? ["new_launch","pre_bond"] : [ctx.match[1] === "new" ? "new_launch" : "pre_bond"];
    const saved = await save(deps, ctx.from.id, c, true);
    await deps.show(ctx, "✅ *MARKET TYPE SAVED*\n\n" + saved.discovery.marketTypes.join(" + "), {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔎 DISCOVERY","v2:discovery").text("⚙️ SETTINGS","v2:settings")});
  });

  bot.callbackQuery("v2:safety", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id), d = c.discovery;
    const k = new InlineKeyboard().text("👥 HOLDERS","v2:holders").text("👨‍👩‍👧 TOP 10","v2:top10").row().text("🧑‍💻 DEV HOLDINGS","v2:dev").text("🧠 SMART FILTERS","v2:smart").row().text("🔒 DATA MODE","v2:data").row().text("⬅️ SETTINGS","v2:settings");
    await deps.show(ctx, "🛡️ *SAFETY FILTERS*\n\n" + d.holderMin + "+ holders\nTop 10 <" + d.top10Max + "%\nDev <" + d.devMax + "%\nSmart filters " + (d.smartFilters?"ON":"OFF") + "\nUnknown data: " + (d.strictData?"REJECT":"FLAG"), {parse_mode:"Markdown",reply_markup:k});
  });

  bot.callbackQuery("v2:holders", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c = await load(deps, ctx.from.id);
    await deps.show(ctx, "👥 *HOLDER COUNT*\n\nChoose minimum verified holders.", {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("50+","v2:set:holders:50").text("100+","v2:set:holders:100").row().text("250+","v2:set:holders:250").text("500+","v2:set:holders:500").row().text("⬅️ SAFETY","v2:safety")});
  });
  bot.callbackQuery(/^v2:set:holders:(50|100|250|500)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c = await load(deps, ctx.from.id); c.discovery.holderMin = Number(ctx.match[1]); const saved = await save(deps, ctx.from.id, c, true);
    await deps.show(ctx, "✅ HOLDERS SAVED\n\nMinimum: " + saved.discovery.holderMin + "+", {reply_markup:new InlineKeyboard().text("🛡️ SAFETY","v2:safety").text("⚙️ SETTINGS","v2:settings")});
  });
  bot.callbackQuery("v2:top10", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    await deps.show(ctx, "👥 *TOP 10 CONCENTRATION*\n\nMaximum allowed concentration.", {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("<20%","v2:set:top10:20").text("<25%","v2:set:top10:25").row().text("<30%","v2:set:top10:30").text("<35%","v2:set:top10:35").row().text("⬅️ SAFETY","v2:safety")});
  });
  bot.callbackQuery(/^v2:set:top10:(20|25|30|35)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c = await load(deps, ctx.from.id); c.discovery.top10Max = Number(ctx.match[1]); const saved = await save(deps, ctx.from.id, c, true);
    await deps.show(ctx, "✅ TOP 10 LIMIT SAVED\n\nMaximum: " + saved.discovery.top10Max + "%", {reply_markup:new InlineKeyboard().text("🛡️ SAFETY","v2:safety").text("⚙️ SETTINGS","v2:settings")});
  });
  bot.callbackQuery("v2:dev", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    await deps.show(ctx, "🧑‍💻 *DEVELOPER HOLDINGS*\n\nMaximum allowed developer allocation.", {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("<2%","v2:set:dev:2").text("<5%","v2:set:dev:5").row().text("<10%","v2:set:dev:10").row().text("⬅️ SAFETY","v2:safety")});
  });
  bot.callbackQuery(/^v2:set:dev:(2|5|10)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c = await load(deps, ctx.from.id); c.discovery.devMax = Number(ctx.match[1]); const saved = await save(deps, ctx.from.id, c, true);
    await deps.show(ctx, "✅ DEV LIMIT SAVED\n\nMaximum: " + saved.discovery.devMax + "%", {reply_markup:new InlineKeyboard().text("🛡️ SAFETY","v2:safety").text("⚙️ SETTINGS","v2:settings")});
  });
  bot.callbackQuery("v2:smart", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c = await load(deps, ctx.from.id); c.discovery.smartFilters = !c.discovery.smartFilters; const saved = await save(deps, ctx.from.id, c, true);
    await deps.show(ctx, "🧠 SMART FILTERS " + (saved.discovery.smartFilters?"ON":"OFF") + "\n\nUnknown data is never presented as a pass.", {reply_markup:new InlineKeyboard().text("🛡️ SAFETY","v2:safety").text("⚙️ SETTINGS","v2:settings")});
  });
  bot.callbackQuery("v2:data", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c = await load(deps, ctx.from.id);
    c.discovery.strictData = !c.discovery.strictData; const saved = await save(deps, ctx.from.id, c, true);
    await deps.show(ctx, "🔒 *DATA MODE*\n\nUnknown safety data: " + (saved.discovery.strictData ? "REJECT" : "FLAG") + "\n\nNo unavailable value is fabricated.", {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🛡️ SAFETY","v2:safety").text("⚙️ SETTINGS","v2:settings")});
  });

  bot.callbackQuery("v2:exits", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c = await load(deps, ctx.from.id), e = c.execution;
    const text = "🎯 *TAKE PROFIT & STOP*\n\n" + e.takeProfit.map(t => "+"+t.pct+"% → sell "+t.sellPct+"%").join("\n") + "\n\nSL: "+e.stopLossPct+"%\nTrailing: "+(e.trailing.enabled?"ON":"OFF")+"\nActivation: +"+e.trailing.activationPct+"%\nPullback: "+e.trailing.pullbackPct+"%";
    await deps.show(ctx, text, {parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚡ DEFAULT TP","v2:tp:default").text("🛑 STOP LOSS","v2:stop").row().text("〽️ TRAILING","v2:trail").row().text("⬅️ SETTINGS","v2:settings")});
  });
  bot.callbackQuery("v2:tp:default", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c = await load(deps, ctx.from.id); c.execution.takeProfit = [{pct:40,sellPct:50},{pct:100,sellPct:25},{pct:200,sellPct:15}]; const saved = await save(deps,ctx.from.id,c,true);
    await deps.show(ctx,"✅ *TAKE PROFIT UPDATED*\n\n+40% → 50%\n+100% → 25%\n+200% → 15%",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🎯 EXITS","v2:exits").text("⚙️ SETTINGS","v2:settings")});
  });
  bot.callbackQuery("v2:stop", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c=await load(deps,ctx.from.id);
    await deps.show(ctx,"🛑 *STOP LOSS*\n\nChoose maximum loss.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("-10%","v2:set:sl:-10").text("-15%","v2:set:sl:-15").row().text("-20%","v2:set:sl:-20").text("-25%","v2:set:sl:-25").row().text("⬅️ EXITS","v2:exits")});
  });
  bot.callbackQuery(/^v2:set:sl:(-10|-15|-20|-25)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c=await load(deps,ctx.from.id); c.execution.stopLossPct=Number(ctx.match[1]); const saved=await save(deps,ctx.from.id,c,true);
    await deps.show(ctx,"✅ STOP LOSS SAVED\n\nSL: "+saved.execution.stopLossPct+"%",{reply_markup:new InlineKeyboard().text("🎯 EXITS","v2:exits").text("⚙️ SETTINGS","v2:settings")});
  });
  bot.callbackQuery("v2:trail", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c=await load(deps,ctx.from.id); c.execution.trailing.enabled=!c.execution.trailing.enabled; const saved=await save(deps,ctx.from.id,c,true);
    await deps.show(ctx,"〽️ TRAILING STOP "+(saved.execution.trailing.enabled?"ON":"OFF"),{reply_markup:new InlineKeyboard().text("🎯 EXITS","v2:exits").text("⚙️ SETTINGS","v2:settings")});
  });

  bot.callbackQuery("v2:wallet", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c=await load(deps,ctx.from.id);
    await deps.show(ctx,"💰 *WALLET & BUY AMOUNT*\n\nBuy amount is part of the active strategy. Wallet selection remains separate.\n\nCurrent entry: *"+c.execution.buyAmountSol+" SOL*",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("0.01 SOL","v2:set:buy:0.01").text("0.05 SOL","v2:set:buy:0.05").row().text("0.10 SOL","v2:set:buy:0.10").text("0.25 SOL","v2:set:buy:0.25").row().text("0.50 SOL","v2:set:buy:0.50").text("1.00 SOL","v2:set:buy:1").row().text("💰 WALLET","wallet:setup").text("⬅️ SETTINGS","v2:settings")});
  });
  bot.callbackQuery(/^v2:set:buy:(0\.01|0\.05|0\.10|0\.25|0\.50|1)$/, async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c=await load(deps,ctx.from.id); c.execution.buyAmountSol=Number(ctx.match[1]); const saved=await save(deps,ctx.from.id,c,true);
    await deps.show(ctx,"✅ BUY AMOUNT SAVED\n\nEntry size: "+saved.execution.buyAmountSol+" SOL\n\nExisting positions keep their own trade snapshot.",{reply_markup:new InlineKeyboard().text("💰 WALLET & BUY","v2:wallet").text("⚙️ SETTINGS","v2:settings")});
  });

  bot.callbackQuery("v2:notifications", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    await deps.show(ctx,"🔔 *NOTIFICATIONS*\n\nTrade lifecycle milestones remain mandatory. Optional market alerts stay in the existing Alerts menu.\n\nCalls, entries, exits and risk events can be wired to this configuration without changing execution rules.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔔 OPEN ALERTS","alerts").row().text("⬅️ SETTINGS","v2:settings")});
  });

  bot.callbackQuery("v2:advanced", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c=await load(deps,ctx.from.id);
    await deps.show(ctx,"⚙️ *ADVANCED / CUSTOM*\n\nThis system is based on "+strategyName(c.profile)+".\n\nCustomized: "+(c.customized?"YES":"NO")+"\nConfig version: v"+c.version+"\n\nManual overrides mark the strategy as CUSTOM. Profile changes reset all overrides together.",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("🔎 DISCOVERY","v2:discovery").text("🛡️ SAFETY","v2:safety").row().text("🎯 EXITS","v2:exits").text("💰 BUY","v2:wallet").row().text("↩️ RESET TO PROFILE","v2:reset").row().text("⬅️ SETTINGS","v2:settings")});
  });
  bot.callbackQuery("v2:reset", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c=await load(deps,ctx.from.id); const next={...clone(PRESETS[c.profile]),version:c.version+1,customized:false}; const saved=await save(deps,ctx.from.id,next,false);
    await deps.show(ctx,"↩️ *PROFILE RESTORED*\n\nAll custom overrides were removed.\n\n"+summary(saved),{parse_mode:"Markdown",reply_markup:settingsKeyboard(saved)});
  });

  bot.callbackQuery("v2:changes", async (ctx: any) => {
    await ctx.answerCallbackQuery(); const c=await load(deps,ctx.from.id), base=PRESETS[c.profile];
    const diffs:string[]=[];
    const d=c.discovery, b=base.discovery, e=c.execution, be=base.execution;
    if(d.marketCapMin!==b.marketCapMin) diffs.push("MC: "+fmtUsd(b.marketCapMin)+" → "+fmtUsd(d.marketCapMin));
    if(d.liquidityMin!==b.liquidityMin) diffs.push("Liquidity: "+fmtUsd(b.liquidityMin)+" → "+fmtUsd(d.liquidityMin));
    if(d.volume5mMin!==b.volume5mMin) diffs.push("5m volume: "+fmtUsd(b.volume5mMin)+" → "+fmtUsd(d.volume5mMin));
    if(d.tokenAgeMinSec!==b.tokenAgeMinSec) diffs.push("Age: "+b.tokenAgeMinSec+"s → "+d.tokenAgeMinSec+"s");
    if(d.holderMin!==b.holderMin) diffs.push("Holders: "+b.holderMin+" → "+d.holderMin);
    if(d.top10Max!==b.top10Max) diffs.push("Top 10: "+b.top10Max+"% → "+d.top10Max+"%");
    if(d.devMax!==b.devMax) diffs.push("Dev: "+b.devMax+"% → "+d.devMax+"%");
    if(d.smartFilters!==b.smartFilters) diffs.push("Smart filters changed");
    if(d.strictData!==b.strictData) diffs.push("Data mode changed");
    if(e.buyAmountSol!==be.buyAmountSol) diffs.push("Buy: "+be.buyAmountSol+" → "+e.buyAmountSol+" SOL");
    if(e.stopLossPct!==be.stopLossPct) diffs.push("SL: "+be.stopLossPct+"% → "+e.stopLossPct+"%");
    if(JSON.stringify(e.takeProfit)!==JSON.stringify(be.takeProfit)) diffs.push("Take-profit ladder changed");
    if(!diffs.length) diffs.push("No custom overrides. You are using the profile defaults.");
    await deps.show(ctx,"📝 *CUSTOM CHANGES*\n\nBased on: "+strategyName(c.profile)+"\n\n"+diffs.map(x=>"• "+x).join("\n"),{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("↩️ RESET","v2:reset").text("⚙️ SETTINGS","v2:settings")});
  });

  bot.callbackQuery("v2:test", async (ctx: any) => {
    await ctx.answerCallbackQuery();
    const c=await load(deps,ctx.from.id);
    await deps.show(ctx,"🧪 *SETTINGS TEST*\n\nCurrent system:\n"+strategyName(c.profile)+(c.customized?" · CUSTOM":"")+"\n\nThe test harness is ready for the live scanner dataset. It must use verified historical discovery data; no synthetic pass rate is shown here.\n\nNext integration:\n• run current filters against recent discoveries\n• count each rejection reason\n• show qualified rate\n• never simulate an execution result as real",{parse_mode:"Markdown",reply_markup:new InlineKeyboard().text("⚙️ SETTINGS","v2:settings")});
  });
}
