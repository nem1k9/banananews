import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { Env, Category } from "./types";
import { plain, safeURL, hash, timedFetch, logError, html } from "./util";
import { enqueue, publish } from "./posts";
export const aliases: Record<string, string> = {
  "natus vincere": "navi",
  "team vitality": "vitality",
  "virtus.pro": "vp",
  "virtus pro": "vp",
  "team spirit": "spirit",
  "counter-strike 2": "cs2",
  "counter strike 2": "cs2",
};
export function normalize(s: string) {
  let t = plain(s).normalize("NFKC").toLowerCase();
  for (const [a, b] of Object.entries(aliases)) t = t.split(a).join(b);
  return t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
export function canonicalURL(s: string) {
  const u = new URL(safeURL(s));
  for (const k of [...u.searchParams.keys()])
    if (k.startsWith("utm_") || k === "ref") u.searchParams.delete(k);
  u.hash = "";
  return u.href;
}
function category(title: string): Category {
  if (/update|release notes|patch|обновлен|патч/i.test(title)) return "UPDATE";
  if (/sign|transfer|трансфер/i.test(title)) return "TRANSFER";
  if (/roster|состав/i.test(title)) return "ROSTER";
  return "GENERAL_NEWS";
}
export function related(a: string, b: string) {
  const x = new Set(
      normalize(a)
        .split(" ")
        .filter((x) => x.length > 2),
    ),
    y = new Set(
      normalize(b)
        .split(" ")
        .filter((x) => x.length > 2),
    );
  const n = [...x].filter((x) => y.has(x)).length;
  return n >= 4 && n / Math.max(x.size, y.size) > 0.82;
}
export interface Article {
  id: string;
  url: string;
  title: string;
  body: string;
  publishedAt: number;
}
export interface NewsAdapter {
  read(url: string): Promise<Article[]>;
}
export class SteamAdapter implements NewsAdapter {
  async read(url: string) {
    const r = await timedFetch(url);
    if (!r.ok) throw new Error("STEAM_HTTP_" + r.status);
    const d = z
      .object({
        appnews: z.object({
          appid: z.literal(730),
          newsitems: z.array(
            z.object({
              gid: z.string(),
              title: z.string(),
              url: z.string(),
              contents: z.string(),
              date: z.number(),
              feedname: z.string(),
            }),
          ),
        }),
      })
      .parse(await r.json());
    return d.appnews.newsitems
      .filter((n) => n.feedname === "steam_community_announcements")
      .map((n) => ({
        id: "steam:" + n.gid,
        url: canonicalURL(n.url),
        title: plain(n.title),
        body: plain(n.contents).slice(0, 12000),
        publishedAt: n.date * 1000,
      }));
  }
}
export class RSSAdapter implements NewsAdapter {
  async read(url: string) {
    const r = await timedFetch(safeURL(url));
    if (!r.ok) throw new Error("RSS_HTTP_" + r.status);
    const text = await r.text();
    if (text.length > 2000000) throw new Error("RSS_TOO_LARGE");
    const d = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
    }).parse(text);
    const raw = d.rss?.channel?.item ?? d.feed?.entry ?? [];
    const items = Array.isArray(raw) ? raw : [raw];
    return items
      .map((n: any) => {
        const url = canonicalURL(
          typeof n.link === "string" ? n.link : n.link?.["@_href"],
        );
        return {
          id: String(n.guid?.["#text"] || n.guid || n.id || url),
          url,
          title: plain(String(n.title?.["#text"] || n.title || "")),
          body: plain(
            String(
              n.description ||
                n.summary ||
                n.content?.["#text"] ||
                n.content ||
                "",
            ),
          ),
          publishedAt: Date.parse(n.pubDate || n.published || n.updated),
        };
      })
      .filter((n) => n.title && Number.isFinite(n.publishedAt));
  }
}
export async function scanNews(env: Env) {
  const sources = await env.DB.prepare(
    "SELECT * FROM sources WHERE enabled=1",
  ).all<{
    id: string;
    kind: string;
    url: string;
    official: number;
    failures: number;
  }>();
  for (const source of sources.results) {
    try {
      if (!source.official) throw new Error("UNVERIFIED_SOURCE");
      const rows = await (
        source.kind === "steam" ? new SteamAdapter() : new RSSAdapter()
      ).read(source.url);
      for (const n of rows) {
        if (
          n.publishedAt < Date.now() - 6 * 3600000 ||
          n.publishedAt > Date.now() + 300000 ||
          /rumou?r|слух|reportedly/i.test(n.title)
        )
          continue;
        const fingerprint = await hash(
          normalize(n.title) + "|" + normalize(n.body).slice(0, 1200),
        );
        const cat = category(n.title);
        const tokens = normalize(n.title)
          .split(" ")
          .filter((x) => x.length > 2)
          .sort();
        const entityKey = tokens.join("|").slice(0, 250);
        const recent = await env.DB.prepare(
          "SELECT title FROM articles WHERE category=? AND published_at>?",
        )
          .bind(cat, Date.now() - 86400000)
          .all<{ title: string }>();
        if (recent.results.some((r) => related(r.title, n.title))) continue;
        await env.DB.prepare(
          "INSERT OR IGNORE INTO articles(id,source_id,url,title,body,published_at,category,entity_key,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
          .bind(
            `${source.id}:${n.id}`,
            source.id,
            n.url,
            n.title.slice(0, 300),
            n.body,
            n.publishedAt,
            cat,
            entityKey,
            fingerprint,
            Date.now(),
          )
          .run();
      }
      await env.DB.prepare(
        "UPDATE sources SET failures=0,last_checked=?,last_success=?,status='ok' WHERE id=?",
      )
        .bind(Date.now(), Date.now(), source.id)
        .run();
    } catch (error) {
      await env.DB.prepare(
        "UPDATE sources SET failures=failures+1,last_checked=?,status='error',enabled=CASE WHEN failures>=4 THEN 0 ELSE enabled END WHERE id=?",
      )
        .bind(Date.now(), source.id)
        .run();
      const reason =
        error instanceof z.ZodError
          ? "RESPONSE_SCHEMA"
          : error instanceof Error
            ? /^[A-Z_0-9]+$/.test(error.message)
              ? error.message
              : /^[A-Za-z0-9_ .:()-]{1,120}$/.test(error.message)
                ? error.message
                : error.name
            : "UNKNOWN";
      await logError(env, "source", "FETCH_FAILED", source.id + ":" + reason);
    }
  }
}
export const editorial = z
  .object({
    headline: z.string().min(5).max(170),
    sentences: z.array(z.string().min(10).max(300)).min(1).max(4),
    evidence: z.array(z.string().min(12).max(1000)).min(1).max(6),
  })
  .strict();
export async function claimJob(env: Env) {
  // Atomic lease acquisition: only the returned claim_token can complete this work.
  for (const table of ["generation_jobs", "articles"] as const) {
    await env.DB.prepare(
      `UPDATE ${table} SET status='failed' WHERE status='claimed' AND lease_until<? AND attempts>=3`,
    )
      .bind(Date.now())
      .run();
    const token = crypto.randomUUID();
    const row = await env.DB.prepare(
      `UPDATE ${table} SET status='claimed',claim_token=?,lease_until=?,attempts=attempts+1 WHERE id=(SELECT id FROM ${table} WHERE attempts<3 AND (status='pending' OR (status='claimed' AND lease_until<?)) ORDER BY id LIMIT 1) RETURNING *`,
    )
      .bind(token, Date.now() + 180000, Date.now())
      .first<Record<string, unknown>>();
    if (row) return { kind: table === "articles" ? "news" : "match", ...row };
  }
  return null;
}
export async function completeJob(
  env: Env,
  id: string,
  token: string,
  result: unknown,
) {
  const job = await env.DB.prepare(
    "SELECT * FROM generation_jobs WHERE id=? AND status='claimed' AND claim_token=? AND lease_until>?",
  )
    .bind(id, token, Date.now())
    .first<{ payload: string }>();
  if (job) {
    const p = JSON.parse(job.payload);
    const schema = z
      .object({ titles: z.record(z.string().min(5).max(140)) })
      .strict();
    const data = schema.parse(result);
    const m = await env.DB.prepare(
      "SELECT prepared,status FROM matches WHERE id=?",
    )
      .bind(id)
      .first<{ prepared: string; status: string }>();
    if (m && m.status === "started") {
      const prepared = JSON.parse(m.prepared);
      for (const t of p.teams) {
        const title = data.titles[t.id];
        if (
          !title ||
          !title.includes(t.name) ||
          !title.includes("побеждает") ||
          /[0-9<>]/.test(title)
        )
          throw new Error("UNSAFE_PREPARATION");
        prepared[t.id].title = title;
      }
      await env.DB.prepare(
        "UPDATE matches SET prepared=? WHERE id=? AND status='started'",
      )
        .bind(JSON.stringify(prepared), id)
        .run();
    }
    await env.DB.prepare(
      "UPDATE generation_jobs SET status='done',result=? WHERE id=? AND claim_token=?",
    )
      .bind(JSON.stringify(data), id, token)
      .run();
    return;
  }
  const a = await env.DB.prepare(
    "SELECT * FROM articles WHERE id=? AND status='claimed' AND claim_token=? AND lease_until>?",
  )
    .bind(id, token, Date.now())
    .first<{
      title: string;
      body: string;
      url: string;
      category: Category;
      created_at: number;
      published_at: number;
    }>();
  if (!a) throw new Error("LEASE_EXPIRED");
  const data = editorial.parse(result);
  const source = normalize(a.title + " " + a.body);
  if (!data.evidence.every((e) => source.includes(normalize(e))))
    throw new Error("EVIDENCE_NOT_IN_SOURCE");
  const text = data.headline + " " + data.sentences.join(" ");
  const numbers = text.match(/\d+(?:[.:]\d+)*/g) || [];
  if (numbers.some((n) => !source.includes(n)))
    throw new Error("UNSUPPORTED_NUMBER");
  if (/[<>]|https?:|[«»“”"]/.test(text))
    throw new Error("PLAIN_TEXT_NO_UNVERIFIED_QUOTES");
  const caption = `<b>${html(data.headline)}</b>\n\n${data.sentences.map(html).join(" ")}\n\n<a href="${html(a.url)}">Источник</a>`;
  const postId = await enqueue(env, {
    key: `news:${id}`,
    category: a.category,
    caption,
    receivedAt: a.created_at,
    occurredAt: a.published_at,
    sourceUrl: a.url,
    card: {
      category: a.category,
      title: data.headline,
      subtitle: "Counter-Strike 2",
    },
  });
  await env.DB.prepare(
    "UPDATE articles SET status='done' WHERE id=? AND claim_token=?",
  )
    .bind(id, token)
    .run();
  await publish(env, postId);
}
