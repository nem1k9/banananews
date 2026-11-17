import { timedFetch } from "./util";
import type { Env } from "./types";
export type SendResult =
  | { status: "published"; messageId: number; url: string }
  | { status: "retry"; retryAfter: number; code: string }
  | { status: "uncertain" | "rejected"; code: string };
export function validateCaption(caption: string) {
  if (caption.length > 1024) throw new Error("CAPTION_TOO_LONG");
  if (/<(?!\/?(?:b|i|u|s|blockquote|a)(?:\s|>))/.test(caption))
    throw new Error("INVALID_HTML");
}
export function liveTarget(env: Env) {
  if (!env.MODE || env.MODE === "dry-run") return null;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID)
    throw new Error("TELEGRAM_NOT_CONFIGURED");
  if (env.MODE === "test") {
    if (
      !env.TELEGRAM_TEST_CHANNEL_ID ||
      env.TELEGRAM_TEST_CHANNEL_ID !== env.TELEGRAM_CHANNEL_ID
    )
      throw new Error("TEST_CHANNEL_ALLOWLIST_REQUIRED");
  } else if (env.MODE === "production") {
    if (env.PRODUCTION_CONFIRM !== "I_UNDERSTAND_LIVE_POSTING")
      throw new Error("PRODUCTION_NOT_CONFIRMED");
  } else throw new Error("INVALID_MODE");
  return env.TELEGRAM_CHANNEL_ID;
}
export async function sendPhoto(
  env: Env,
  png: ArrayBuffer,
  caption: string,
): Promise<SendResult> {
  validateCaption(caption);
  const chat = liveTarget(env);
  if (!chat) throw new Error("DRY_RUN_SEND_FORBIDDEN");
  const f = new FormData();
  f.set("chat_id", chat);
  f.set("caption", caption);
  f.set("parse_mode", "HTML");
  f.set("photo", new Blob([png], { type: "image/png" }), "card.png");
  let r: Response;
  try {
    r = await timedFetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
      { method: "POST", body: f },
      15000,
    );
  } catch {
    return { status: "uncertain", code: "NETWORK_OUTCOME_UNKNOWN" };
  }
  let d: any;
  try {
    d = await r.json();
  } catch {
    return { status: "uncertain", code: "INVALID_TELEGRAM_RESPONSE" };
  }
  if (
    r.status === 429 &&
    d.ok === false &&
    Number.isFinite(d.parameters?.retry_after)
  )
    return {
      status: "retry",
      retryAfter: Math.max(1, Math.min(3600, d.parameters.retry_after)),
      code: "RATE_LIMIT",
    };
  if (r.ok && d.ok === true && Number.isInteger(d.result?.message_id)) {
    const id = d.result.message_id;
    const url = chat!.startsWith("@")
      ? `https://t.me/${chat!.slice(1)}/${id}`
      : chat!.startsWith("-100")
        ? `https://t.me/c/${chat!.slice(4)}/${id}`
        : "";
    return { status: "published", messageId: id, url };
  }
  if (r.status >= 500 || d.ok !== false)
    return { status: "uncertain", code: "SERVER_OUTCOME_UNKNOWN" };
  return { status: "rejected", code: `TELEGRAM_${r.status}` };
}
