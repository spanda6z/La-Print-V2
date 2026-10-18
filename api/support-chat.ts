import { supportChatReply, type SupportMessage } from "../src/support-chat.js";

const recentByIp = new Map<string, number[]>();

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST to send a support message." });
  }

  const origin = req.headers.origin;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  if (origin) {
    try {
      if (!host || new URL(origin).host !== host) return res.status(403).json({ error: "Cross-origin chat requests are not allowed." });
    } catch {
      return res.status(403).json({ error: "Invalid request origin." });
    }
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now();
  const recent = (recentByIp.get(ip) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 12) return res.status(429).json({ error: "You’ve sent several messages. Please wait a minute and try again." });
  recent.push(now);
  recentByIp.set(ip, recent);
  if (recentByIp.size > 5000) {
    for (const [key, times] of recentByIp) if (!times.some((time) => now - time < 60_000)) recentByIp.delete(key);
  }

  try {
    let input = req.body;
    if (typeof input === "string") input = JSON.parse(input);
    if (!input || typeof input !== "object") return res.status(400).json({ error: "Send a valid JSON message." });
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message || message.length > 1200) return res.status(400).json({ error: "Please enter a message up to 1,200 characters." });
    const history: SupportMessage[] = Array.isArray(input.history)
      ? input.history.slice(-8)
          .filter((item: any) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
          .map((item: any) => ({ role: item.role, content: item.content.slice(0, 1000) }))
      : [];
    const result = await supportChatReply(message, history);
    return res.status(200).json({ answer: result.answer, mode: result.mode });
  } catch {
    return res.status(500).json({ error: "Support chat is temporarily unavailable. Please try again." });
  }
}
