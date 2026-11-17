import type { Env } from "./types";
export const json = (x: unknown, status = 200) =>
  Response.json(x, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
export const html = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const plain = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export async function hash(s: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
export async function authorized(req: Request, secret?: string) {
  if (!secret || secret.length < 24) return false;
  const h = req.headers.get("authorization") || "";
  return (await hash(h)) === (await hash("Bearer " + secret));
}
export async function body(req: Request) {
  if (Number(req.headers.get("content-length")) > 65536)
    throw new Error("PAYLOAD_TOO_LARGE");
  const text = await req.text();
  if (text.length > 65536) throw new Error("PAYLOAD_TOO_LARGE");
  return JSON.parse(text);
}
export async function logError(
  env: Env,
  component: string,
  code: string,
  detail = "",
) {
  await env.DB.prepare(
    "INSERT INTO errors(component,code,created_at,detail) VALUES(?,?,?,?)",
  )
    .bind(component, code, Date.now(), detail.slice(0, 240))
    .run();
}
export async function settings(env: Env) {
  return (await env.DB.prepare(
    "SELECT * FROM settings WHERE id=1",
  ).first())! as {
    autopost: number;
    categories: string;
    template: string;
    poll_seconds: number;
  };
}
export async function timedFetch(
  url: string,
  init: RequestInit = {},
  ms = 15000,
) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}
export function safeURL(s: string) {
  const u = new URL(s);
  if (u.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
  return u.href;
}

export function binary(value: ArrayBuffer | number[]) {
  return value instanceof ArrayBuffer ? value : new Uint8Array(value).buffer;
}
