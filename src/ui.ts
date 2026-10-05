import { InlineKeyboard } from "grammy";

export const UI_DIVIDER = "━━━━━━━━━━━━━━━━━━━━";

export function uiHeader(screen:string, icon="⚡"){ return icon+" *LA-PRINT ┃ "+screen+"*\n"+UI_DIVIDER; }
export function uiSection(title:string, icon="▸"){ return icon+" *"+title.toUpperCase()+"*"; }
export function uiFooter(){ return UI_DIVIDER+"\nUse the buttons below to continue."; }

export function mainMenuKeyboard(active:boolean, mode:string){
  const k=new InlineKeyboard();
  k.text(active ? (mode==="manual"?"⏹️ STOP FEED":"⏹️ STOP AUTOPILOT") : (mode==="manual"?"▶️ START FEED":"🚀 START"), active?"trade:stop":"trade:start").row();
  k.text("🚀 TRADE","mode:auto").text("📈 POSITIONS","positions").row();
  k.text("👛 WALLET","wallets").text("🎯 STRATEGY","setup").row();
  k.text("🎁 REFERRAL","referral").text("🏆 LEADERBOARD","leaderboard").row();
  k.text("❓ HELP & SUPPORT","help").text("📚 DOCUMENTATION","docs").row();
  k.text("⚙️ SETTINGS","setup");
  return k;
}

export function navigationKeyboard(back="menu"){
  return new InlineKeyboard().text("⬅️ BACK",back).text("🏠 MAIN MENU","menu");
}

export function twoColumnNavigation(primary:[string,string], secondary:[string,string], back="menu"){
  return new InlineKeyboard().text(primary[0],primary[1]).text(secondary[0],secondary[1]).row()
    .text("⬅️ BACK",back).text("🏠 MAIN MENU","menu");
}
