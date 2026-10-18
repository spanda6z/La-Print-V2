export type SupportMessage = { role: "user" | "assistant"; content: string };

const SYSTEM_PROMPT = `You are La-Print V2 Support, a friendly support assistant for the La-Print Telegram-based Solana trading bot and its web dashboard.

Only answer using this product information:
- Getting started: open the Telegram bot, use /start, complete onboarding and terms, create/import a wallet, configure strategy, and review setup.
- Modes: Manual mode lets the user review qualified token calls before approval. Autopilot follows the saved strategy only when all execution and safety gates are explicitly enabled.
- Wallets: users can create/import, switch, and fund trading wallets. Keep enough SOL for network fees. Never ask for private keys or seed phrases in support chat.
- Strategy and risk: settings include buy amount, take-profit (TP), stop-loss (SL), filters, max positions, and alerts. Changes apply to future entries.
- Positions: the bot may report position milestones and events, but this repository's automated entry scheduling, automated sell execution, and PnL reconciliation are incomplete. Do not say that a trade was executed or a position is fully reconciled unless the user verifies it in the app.
- Web dashboard: sign in using the same Telegram account after configuring BOT_USERNAME and WEB_SESSION_SECRET. It shows account/wallet/strategy/position data and supports limited strategy edits.
- Help: the Telegram bot has Help & Support and Documentation menus. If unresolved, tell the user to use Contact Support in Telegram and include a concise summary of the issue.
- Referral and leaderboard screens exist; some leaderboard information is marked coming soon.
Safety: never request or reveal passwords, API keys, private keys, seed phrases, session cookies, or personal account records. Never execute transactions or claim to change account settings. This chat is informational only. Do not give personalized investment advice or promise returns. Be transparent about limitations. If asked about a print shop or printing orders, explain that the current repository is a trading-bot product, not a print-order system.`;

const FAQ: Array<{ test: RegExp; answer: string }> = [
  { test: /start|onboard|setup|begin/i, answer: "To get started, open the La-Print Telegram bot and send /start. Complete onboarding and the terms, create or import a wallet, configure your strategy and risk limits, then review the setup before starting." },
  { test: /manual|autopilot|mode/i, answer: "Manual mode lets you review qualified calls before approving them. Autopilot follows your saved strategy only when the required execution and safety gates are enabled. Keep live trading disabled until the execution and reconciliation modules are complete and tested." },
  { test: /wallet|private key|seed phrase|fund|sol balance/i, answer: "Use Wallet or Wallets in Telegram to create/import and switch wallets. Fund the active wallet with SOL and leave some SOL for network fees. Never share a private key or seed phrase with support or in this chat." },
  { test: /strategy|buy amount|stop.?loss|take.?profit|filter|risk/i, answer: "Strategy settings cover buy size, take-profit targets, stop loss, filters, position limits and alerts. Changes are intended for future entries. Review the values carefully; this assistant cannot change your settings for you." },
  { test: /position|pnl|profit|loss|sell|trade executed|transaction/i, answer: "The bot can show position and engine activity updates, but automated entry scheduling, automated sell execution and PnL reconciliation are not yet complete. I can't confirm a transaction from this chat. Check the bot and on-chain transaction details, and contact support if they disagree." },
  { test: /web|dashboard|login|sign in|telegram account/i, answer: "The web dashboard uses the same Telegram account as the bot. Configure BOT_USERNAME and a WEB_SESSION_SECRET of at least 32 characters, set the Telegram Login Widget domain in BotFather, then sign in with your existing account." },
  { test: /referral|invite|leaderboard|rank/i, answer: "The bot includes a Referral screen for your referral link and stats. The leaderboard is a placeholder until verified community ranking data is enabled." },
  { test: /error|bug|problem|failed|support|human|contact/i, answer: "For account-specific help, open Help & Support in the Telegram bot and choose Contact Support or Report a Problem. Include what you were trying to do, the exact error, and the approximate time. Never include private keys, seed phrases, passwords, or API tokens." },
  { test: /print|printing|order|delivery|printer/i, answer: "The current La-Print V2 repository is a Telegram-based Solana trading bot and dashboard; it does not currently manage printing orders or deliveries. If you meant a separate printing product, send the correct product details to support." },
];

function localAnswer(message: string): string {
  const match = FAQ.find((item) => item.test.test(message));
  if (match) return match.answer;
  return "I can help with onboarding, Manual vs Autopilot, wallets, strategy and risk settings, positions, the web dashboard, referrals, and troubleshooting. What are you trying to do? For account-specific issues, use Help & Support → Contact Support in the Telegram bot. Never share a private key or seed phrase.";
}

export async function supportChatReply(message: string, history: SupportMessage[] = []): Promise<{ answer: string; mode: "ai" | "faq" }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { answer: localAnswer(message), mode: "faq" };

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-8).map((item) => ({ role: item.role, content: item.content.slice(0, 1000) })),
    { role: "user", content: message },
  ];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 350 }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("AI provider request failed");
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const answer = data.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error("AI provider returned no answer");
      return { answer, mode: "ai" };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return { answer: localAnswer(message), mode: "faq" };
  }
}
