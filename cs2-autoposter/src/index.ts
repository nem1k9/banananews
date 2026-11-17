import type { Env } from "./types";
import { categories } from "./types";
import {
  authorized,
  body,
  json,
  logError,
  settings,
  safeURL,
  binary,
} from "./util";
import { MockLiveProvider, ingestMatch } from "./matches";
import { recover, publish, enqueue } from "./posts";
import { scanNews, claimJob, completeJob } from "./news";
import { z } from "zod";
export { MatchMonitor } from "./matches";
export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/webhooks/live") {
        if (!(await authorized(req, env.PROVIDER_WEBHOOK_TOKEN)))
          return json({ error: "unauthorized" }, 401);
        if (req.method !== "POST") return json({ error: "method" }, 405);
        const e: any = await body(req);
        if (e.provider === "mock" && env.MODE === "production")
          return json({ error: "mock forbidden" }, 403);
        return ingestMatch(env, e);
      }
      if (!u.pathname.startsWith("/api/")) {
        const res = await env.ASSETS.fetch(req);
        const headers = new Headers(res.headers);
        headers.set(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        return new Response(res.body, { status: res.status, headers });
      }
      const runner = u.pathname.startsWith("/api/runner/");
      if (!(await authorized(req, runner ? env.RUNNER_TOKEN : env.ADMIN_TOKEN)))
        return json({ error: "unauthorized" }, 401);
      if (runner) {
        if (req.method !== "POST") return json({ error: "method" }, 405);
        if (u.pathname === "/api/runner/claim")
          return json(await claimJob(env));
        if (u.pathname === "/api/runner/complete") {
          const b = z
            .object({
              id: z.string(),
              claim_token: z.string(),
              result: z.unknown(),
            })
            .parse(await body(req));
          await completeJob(env, b.id, b.claim_token, b.result);
          return json({ ok: true });
        }
        return json({ error: "not found" }, 404);
      }
      if (req.method === "GET" && u.pathname === "/api/state") {
        const [posts, matches, sources, errors, config, articles] =
          await Promise.all([
            env.DB.prepare(
              "SELECT id,event_key,category,status,caption,created_at,received_at,occurred_at,sent_at,message_id,telegram_url,error,attempt,source_url,(received_at-occurred_at) AS detection_ms,(sent_at-received_at) AS processing_ms FROM posts ORDER BY created_at DESC LIMIT 100",
            ).all(),
            env.DB.prepare(
              "SELECT id,provider,status,payload,prepared,received_at FROM matches ORDER BY received_at DESC LIMIT 50",
            ).all(),
            env.DB.prepare("SELECT * FROM sources ORDER BY name").all(),
            env.DB.prepare(
              "SELECT * FROM errors ORDER BY id DESC LIMIT 30",
            ).all(),
            settings(env),
            env.DB.prepare(
              "SELECT id,title,category,status,published_at,created_at,url FROM articles ORDER BY created_at DESC LIMIT 30",
            ).all(),
          ]);
        return json({
          mode: env.MODE || "dry-run",
          posts: posts.results,
          matches: matches.results,
          sources: sources.results,
          errors: errors.results,
          articles: articles.results,
          settings: config,
          provider: env.PROVIDER || "mock",
          codex: env.CODEX_ENABLED === "true",
        });
      }
      const image = u.pathname.match(/^\/api\/posts\/([^/]+)\/image$/);
      if (req.method === "GET" && image) {
        const row = await env.DB.prepare("SELECT png FROM posts WHERE id=?")
          .bind(image[1])
          .first<{ png: ArrayBuffer }>();
        return row?.png
          ? new Response(binary(row.png), {
              headers: {
                "content-type": "image/png",
                "cache-control": "no-store",
              },
            })
          : json({ error: "not found" }, 404);
      }
      if (req.method !== "POST") return json({ error: "not found" }, 404);
      const b: any = await body(req);
      if (u.pathname === "/api/demo") {
        if (env.MODE === "production")
          return json({ error: "demo forbidden in production" }, 403);
        const d = z
          .object({
            type: z.enum(["started", "finished"]),
            id: z
              .string()
              .regex(/^[a-zA-Z0-9_-]{1,80}$/)
              .default("demo-navi-vitality"),
          })
          .parse(b);
        return ingestMatch(env, MockLiveProvider.event(d.type, d.id));
      }
      if (u.pathname === "/api/settings") {
        const d = z
          .object({
            autopost: z.boolean(),
            categories: z.array(
              z.enum([
                "TRANSFER",
                "MATCH_RESULT",
                "ROSTER",
                "UPDATE",
                "GENERAL_NEWS",
              ]),
            ),
            poll_seconds: z.number().int().min(5).max(3600),
            template: z.enum(["default", "violet"]).default("default"),
          })
          .strict()
          .parse(b);
        if (d.poll_seconds < Number(env.PROVIDER_MIN_POLL_SECONDS || 10))
          throw new Error("PROVIDER_RATE_LIMIT");
        await env.DB.prepare(
          "UPDATE settings SET autopost=?,categories=?,poll_seconds=?,template=? WHERE id=1",
        )
          .bind(
            d.autopost ? 1 : 0,
            JSON.stringify(d.categories),
            d.poll_seconds,
            d.template,
          )
          .run();
        return json({ ok: true });
      }
      if (u.pathname === "/api/sources/toggle") {
        const d = z.object({ id: z.string(), enabled: z.boolean() }).parse(b);
        await env.DB.prepare(
          "UPDATE sources SET enabled=?,failures=0,status='unread' WHERE id=?",
        )
          .bind(d.enabled ? 1 : 0, d.id)
          .run();
        return json({ ok: true });
      }
      if (u.pathname === "/api/scan") {
        ctx.waitUntil(scanNews(env));
        return json({ queued: true });
      }
      if (u.pathname === "/api/test-post") {
        if (env.MODE === "production")
          return json({ error: "test post forbidden in production" }, 403);
        const id = await enqueue(env, {
          key: `test:${crypto.randomUUID()}`,
          category: "GENERAL_NEWS",
          caption:
            "<b>Тест CS2 News Autoposter</b>\n\nПроверка оформления и доставки.",
          receivedAt: Date.now(),
          occurredAt: null,
          card: {
            category: "GENERAL_NEWS",
            title: "Тестовая публикация",
            subtitle: "Проверка системы",
          },
        });
        await publish(env, id, true);
        return json({ id });
      }
      if (u.pathname === "/api/posts/reconcile") {
        const d = z
          .object({ id: z.string(), message_id: z.number().int().positive() })
          .parse(b);
        await env.DB.prepare(
          "UPDATE posts SET status='published',message_id=?,error='MANUALLY_CONFIRMED' WHERE id=? AND status='uncertain'",
        )
          .bind(d.message_id, d.id)
          .run();
        return json({ ok: true });
      }
      if (u.pathname === "/api/watch") {
        if (
          env.PROVIDER !== "pandascore" ||
          env.PROVIDER_POLLING_APPROVED !== "true" ||
          !env.PANDASCORE_TOKEN
        )
          return json({ error: "licensed polling required" }, 409);
        const d = z.object({ id: z.string().regex(/^\d+$/) }).parse(b);
        return env.MATCHES.get(
          env.MATCHES.idFromName(`pandascore:${d.id}`),
        ).fetch("https://match/watch", {
          method: "POST",
          body: JSON.stringify(d),
        });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      const code =
        e instanceof z.ZodError
          ? "VALIDATION_FAILED"
          : e instanceof Error && /^[A-Z_]+$/.test(e.message)
            ? e.message
            : "REQUEST_FAILED";
      await logError(env, "api", code).catch(() => {});
      return json({ error: code }, 400);
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        const pending = await env.DB.prepare(
          "SELECT payload FROM events WHERE processed_at IS NULL ORDER BY received_at LIMIT 5",
        ).all<{ payload: string }>();
        for (const event of pending.results) {
          try {
            await ingestMatch(env, JSON.parse(event.payload));
          } catch {
            await logError(env, "live", "EVENT_RECOVERY_FAILED");
          }
        }
        await recover(env);
        await scanNews(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
