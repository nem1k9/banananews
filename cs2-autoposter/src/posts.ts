import type { Env, Post, Category } from "./types";
import { renderCard, type Card } from "./render";
import { liveTarget, sendPhoto, validateCaption } from "./telegram";
import { settings, logError, binary } from "./util";
export async function enqueue(
  env: Env,
  input: {
    key: string;
    category: Category;
    caption: string;
    card: Card;
    receivedAt: number;
    occurredAt: number | null;
    sourceUrl?: string;
  },
) {
  validateCaption(input.caption);
  const design = await settings(env);
  const card = {
    ...input.card,
    theme:
      design.template === "violet" ? ("violet" as const) : ("default" as const),
  };
  // Unique key is claimed before rendering. Duplicate ingestion never makes a second post.
  const id = crypto.randomUUID();
  const r = await env.DB.prepare(
    "INSERT OR IGNORE INTO posts(id,event_key,category,status,caption,card,created_at,received_at,occurred_at,source_url) VALUES(?,?,?,'ready',?,?,?,?,?,?)",
  )
    .bind(
      id,
      input.key,
      input.category,
      input.caption,
      JSON.stringify(card),
      Date.now(),
      input.receivedAt,
      input.occurredAt,
      input.sourceUrl || null,
    )
    .run();
  const current = await env.DB.prepare(
    "SELECT id,png,status FROM posts WHERE event_key=?",
  )
    .bind(input.key)
    .first<{ id: string; png: ArrayBuffer | null; status: string }>();
  const postId = current!.id;
  if (!r.meta.changes && (current!.png || current!.status !== "ready"))
    return postId;
  try {
    const png = await renderCard(card);
    await env.DB.prepare("UPDATE posts SET png=? WHERE id=?")
      .bind(png.buffer, postId)
      .run();
  } catch {
    await env.DB.prepare(
      "UPDATE posts SET status='rejected',error='RENDER_FAILED' WHERE id=?",
    )
      .bind(postId)
      .run();
    await logError(env, "render", "RENDER_FAILED", postId);
  }
  return postId;
}
export async function publish(env: Env, id: string, force = false) {
  const s = await settings(env);
  if (!force && !s.autopost) return;
  let target: string | null;
  try {
    target = liveTarget(env);
  } catch {
    await logError(env, "telegram", "CONFIGURATION_BLOCKED");
    return;
  }
  const p = await env.DB.prepare("SELECT * FROM posts WHERE id=?")
    .bind(id)
    .first<Post>();
  if (!p || p.status !== "ready" || !p.png) return;
  if (!JSON.parse(s.categories).includes(p.category)) return;
  if (env.MODE === "production" && p.event_key.startsWith("mock:")) {
    await logError(env, "telegram", "MOCK_PRODUCTION_BLOCKED");
    return;
  }
  const claimed = await env.DB.prepare(
    "UPDATE posts SET status='sending',attempt=attempt+1,attempted_at=? WHERE id=? AND status='ready' AND next_attempt_at<=?",
  )
    .bind(Date.now(), id, Date.now())
    .run();
  if (!claimed.meta.changes) return;
  if (!target) {
    await env.DB.prepare(
      "UPDATE posts SET status='dry-run',sent_at=? WHERE id=?",
    )
      .bind(Date.now(), id)
      .run();
    return;
  }
  const result = await sendPhoto(env, binary(p.png), p.caption);
  if (result.status === "published") {
    await env.DB.prepare(
      "UPDATE posts SET status='published',sent_at=?,message_id=?,telegram_url=?,error=NULL WHERE id=?",
    )
      .bind(Date.now(), result.messageId, result.url, id)
      .run();
  } else if (result.status === "retry" && p.attempt < 4) {
    await env.DB.prepare(
      "UPDATE posts SET status='ready',next_attempt_at=?,error=? WHERE id=?",
    )
      .bind(Date.now() + result.retryAfter * 1000, result.code, id)
      .run();
  } else {
    const status = result.status === "retry" ? "rejected" : result.status;
    await env.DB.prepare("UPDATE posts SET status=?,error=? WHERE id=?")
      .bind(status, result.code, id)
      .run();
    await logError(env, "telegram", result.code, id);
  }
}
export async function recover(env: Env) {
  const missing = await env.DB.prepare(
    "SELECT id,card FROM posts WHERE status='ready' AND png IS NULL AND card IS NOT NULL LIMIT 3",
  ).all<{ id: string; card: string }>();
  for (const row of missing.results) {
    try {
      const png = await renderCard(JSON.parse(row.card));
      await env.DB.prepare(
        "UPDATE posts SET png=? WHERE id=? AND status='ready'",
      )
        .bind(png.buffer, row.id)
        .run();
    } catch {
      await logError(env, "render", "RECOVERY_RENDER_FAILED", row.id);
    }
  }

  // A killed process may already have sent a message. Never automatically reclaim it.
  await env.DB.prepare(
    "UPDATE posts SET status='uncertain',error='INTERRUPTED_SEND' WHERE status='sending' AND attempted_at<?",
  )
    .bind(Date.now() - 120000)
    .run();
  const rows = await env.DB.prepare(
    "SELECT id FROM posts WHERE status='ready' AND png IS NOT NULL AND next_attempt_at<=? ORDER BY created_at LIMIT 8",
  )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const r of rows.results) await publish(env, r.id);
}
