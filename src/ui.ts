import { InlineKeyboard } from "grammy";

export const UI_DIVIDER = "━━━━━━━━━━━━━━━━━━━━";

export function uiHeader(screen:string, icon="⚡"){ return icon+" *LA-PRINT ┃ "+screen+"*\n"+UI_DIVIDER; }
export function uiSection(title:string, icon="▸"){ return icon+" *"+title.toUpperCase()+"*"; }
export function uiFooter(){ return UI_DIVIDER+"\nUse the buttons below to continue."; }

export type UIRow = Array<[string,string]>;

export function uiKeyboard(rows:UIRow[]){
  const k=new InlineKeyboard();
  rows.forEach((row,index)=>{
    row.forEach(([label,data])=>k.text(label,data));
    if(index<rows.length-1) k.row();
  });
  return k;
}

export function mainMenuKeyboard(active:boolean, mode:string){
  return uiKeyboard([
    [[active ? (mode==="manual"?"⏹️ STOP FEED":"⏹️ STOP AUTOPILOT") : (mode==="manual"?"▶️ START FEED":"🚀 START"), active?"trade:stop":"trade:start"]],
    [["🚀 TRADE","mode:auto"],["📈 POSITIONS","positions"]],
    [["👛 WALLET","wallets"],["🎯 STRATEGY","setup"]],
    [["🎁 REFERRAL","referral"],["🏆 LEADERBOARD","leaderboard"]],
    [["❓ HELP & SUPPORT","help"],["📚 DOCUMENTATION","docs"]],
    [["⚙️ SETTINGS","setup"]]
  ]);
}

export function navigationKeyboard(back="menu"){
  return new InlineKeyboard().text("⬅️ BACK",back).text("🏠 MAIN MENU","menu");
}

export function twoColumnNavigation(primary:[string,string], secondary:[string,string], back="menu"){
  return new InlineKeyboard().text(primary[0],primary[1]).text(secondary[0],secondary[1]).row()
    .text("⬅️ BACK",back).text("🏠 MAIN MENU","menu");
}
