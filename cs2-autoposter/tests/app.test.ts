import { env, SELF, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockLiveProvider, matchEvent } from "../src/providers";
import { ingestMatch } from "../src/matches";
import { renderCard } from "../src/render";
import { publish, enqueue, recover } from "../src/posts";
import { sendPhoto, liveTarget, validateCaption } from "../src/telegram";
import {
  claimJob,
  completeJob,
  normalize,
  related,
  canonicalURL,
  scanNews,
} from "../src/news";
const headers = {
  Authorization: "Bearer test-admin-token-with-32-characters",
  "Content-Type": "application/json",
};
const request = (path: string, b?: unknown) =>
  SELF.fetch("https://example.com/api/" + path, {
    method: b ? "POST" : "GET",
    headers,
    body: b ? JSON.stringify(b) : undefined,
  });
beforeEach(async () => {
  await env.DB.batch(
    [
      "prepared_assets",
      "posts",
      "matches",
      "events",
      "articles",
      "generation_jobs",
      "errors",
    ].map((t) => env.DB.prepare("DELETE FROM " + t)),
  );
  await env.DB.prepare("UPDATE settings SET autopost=0 WHERE id=1").run();
  await env.DB.prepare("DELETE FROM sources WHERE id!='steam'").run();
  await env.DB.prepare(
    "UPDATE sources SET enabled=1,failures=0,status='unread' WHERE id='steam'",
  ).run();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
});
describe("access and configuration", () => {
  it("protects APIs and never returns secret values", async () => {
    expect((await SELF.fetch("https://example.com/api/state")).status).toBe(
      401,
    );
    const r = await request("state");
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain("test-admin-token");
  });
  it("defaults to dry-run and refuses ambiguous test targets", () => {
    expect(liveTarget({ ...env, MODE: "dry-run" })).toBe(null);
    expect(() =>
      liveTarget({
        ...env,
        MODE: "test",
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_CHANNEL_ID: "@real",
      }),
    ).toThrow("TEST_CHANNEL");
    expect(() =>
      liveTarget({
        ...env,
        MODE: "production",
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_CHANNEL_ID: "@real",
      }),
    ).toThrow("PRODUCTION");
  });
  it("rejects an invalid settings payload", async () => {
    expect(
      (
        await request("settings", {
          autopost: true,
          categories: ["UNKNOWN"],
          poll_seconds: 1,
        })
      ).status,
    ).toBe(400);
  });
});
describe("match lifecycle and graphics", () => {
  it("rejects inconsistent winners, map counts and unconfirmed results", () => {
    const e = MockLiveProvider.event("finished");
    expect(() => matchEvent.parse({ ...e, winnerId: "vitality" })).toThrow();
    expect(() => matchEvent.parse({ ...e, confirmed: false })).toThrow();
    expect(() => matchEvent.parse({ ...e, maps: [] })).toThrow();
  });
  it("renders real Cyrillic PNG with long headline", async () => {
    const p = await renderCard({
      category: "TRANSFER",
      title:
        "Подтверждённый переход игрока в новый состав профессиональной команды Counter-Strike 2",
      subtitle: "Трансферы",
    });
    expect([...p.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const d = new DataView(p.buffer);
    expect(d.getUint32(16)).toBe(1080);
    expect(d.getUint32(20)).toBe(1080);
    expect(p.length).toBeGreaterThan(10000);
  });
  it("prepares both winners, finishes 2:1, stores metrics and deduplicates concurrent replay", async () => {
    await env.DB.prepare("UPDATE settings SET autopost=1 WHERE id=1").run();
    const start = MockLiveProvider.event("started", "integration");
    expect((await ingestMatch(env, start)).status).toBe(200);
    const m = await env.DB.prepare("SELECT prepared FROM matches WHERE id=?")
      .bind("mock:integration")
      .first();
    expect(Object.keys(JSON.parse(m.prepared))).toEqual(["navi", "vitality"]);
    const final = MockLiveProvider.event("finished", "integration");
    await Promise.all([ingestMatch(env, final), ingestMatch(env, final)]);
    const posts = (await env.DB.prepare("SELECT * FROM posts").all()).results;
    expect(posts).toHaveLength(1);
    expect(posts[0].status).toBe("dry-run");
    expect(posts[0].caption).toContain("NAVI 2:1 Vitality");
    expect(posts[0].sent_at).toBeGreaterThanOrEqual(posts[0].received_at);
    expect(new Uint8Array(posts[0].png).byteLength).toBeGreaterThan(10000);
  });
  it("cancels a queued result and records correction of published outcome", async () => {
    await ingestMatch(env, MockLiveProvider.event("started", "cancel"));
    const e = MockLiveProvider.event("finished", "cancel");
    await ingestMatch(env, e);
    await ingestMatch(env, {
      ...e,
      id: "correction",
      revision: 3,
      type: "cancelled",
    });
    expect(
      (await env.DB.prepare("SELECT status FROM posts").first()).status,
    ).toBe("cancelled");
  });
  it("stale and duplicate starts cannot roll back a final result", async () => {
    await ingestMatch(env, MockLiveProvider.event("finished", "terminal"));
    await ingestMatch(env, MockLiveProvider.event("started", "terminal"));
    expect(
      (await env.DB.prepare("SELECT status FROM matches").first()).status,
    ).toBe("finished");
  });
});
async function seed() {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO posts(id,event_key,category,status,caption,png,created_at,received_at) VALUES(?,?,'GENERAL_NEWS','ready','Test',?,?,?)",
  )
    .bind(
      id,
      id,
      new Uint8Array([137, 80, 78, 71]).buffer,
      Date.now(),
      Date.now(),
    )
    .run();
  return id;
}
const testEnv = () => ({
  ...env,
  MODE: "test",
  TELEGRAM_BOT_TOKEN: "test-secret",
  TELEGRAM_CHANNEL_ID: "-100123",
  TELEGRAM_TEST_CHANNEL_ID: "-100123",
});
describe("Telegram outbox", () => {
  it("one sender wins a concurrent claim and persists message_id", async () => {
    const id = await seed();
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: "/bottest-secret/sendPhoto", method: "POST" })
      .reply(200, { ok: true, result: { message_id: 77 } });
    await Promise.all([
      publish(testEnv(), id, true),
      publish(testEnv(), id, true),
    ]);
    const row = await env.DB.prepare(
      "SELECT status,message_id,attempt FROM posts WHERE id=?",
    )
      .bind(id)
      .first();
    expect(row).toMatchObject({
      status: "published",
      message_id: 77,
      attempt: 1,
    });
  });
  it("429 schedules a bounded retry without an immediate duplicate", async () => {
    const id = await seed();
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: "/bottest-secret/sendPhoto", method: "POST" })
      .reply(429, { ok: false, parameters: { retry_after: 20 } });
    await publish(testEnv(), id, true);
    const row = await env.DB.prepare(
      "SELECT status,next_attempt_at FROM posts WHERE id=?",
    )
      .bind(id)
      .first();
    expect(row.status).toBe("ready");
    expect(row.next_attempt_at).toBeGreaterThan(Date.now());
  });
  it("500 outcome is uncertain and never retried by recovery", async () => {
    const id = await seed();
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: "/bottest-secret/sendPhoto", method: "POST" })
      .reply(500, { ok: false });
    await publish(testEnv(), id, true);
    await recover(testEnv());
    expect(
      (
        await env.DB.prepare("SELECT status FROM posts WHERE id=?")
          .bind(id)
          .first()
      ).status,
    ).toBe("uncertain");
  });
  it("interrupted send is quarantined", async () => {
    const id = await seed();
    await env.DB.prepare(
      "UPDATE posts SET status='sending',attempted_at=? WHERE id=?",
    )
      .bind(Date.now() - 180000, id)
      .run();
    await recover(env);
    expect(
      (await env.DB.prepare("SELECT status FROM posts").first()).status,
    ).toBe("uncertain");
  });
  it("checks Telegram caption limits before sending", () => {
    expect(() => validateCaption("x".repeat(1025))).toThrow();
    expect(() => validateCaption("<script>bad</script>")).toThrow();
  });
});
describe("news and generation leases", () => {
  it("normalizes aliases and strips tracking URLs", () => {
    expect(normalize("Natus Vincere / Team Vitality")).toBe("navi vitality");
    expect(canonicalURL("https://example.org/a?utm_source=x#foo")).toBe(
      "https://example.org/a",
    );
    expect(
      related(
        "Natus Vincere sign player Alice today",
        "NAVI sign player Alice today",
      ),
    ).toBe(true);
  });
  it("a failing source does not stop Steam and disables itself after five failures", async () => {
    await env.DB.prepare(
      "INSERT INTO sources(id,name,kind,url,failures) VALUES('bad','Bad RSS','rss','https://broken.example/rss',4)",
    ).run();
    fetchMock
      .get("https://broken.example")
      .intercept({ path: "/rss" })
      .reply(503, "Unavailable");
    fetchMock
      .get("https://api.steampowered.com")
      .intercept({ path: /\/ISteamNews/ })
      .reply(200, {
        appnews: {
          appid: 730,
          newsitems: [
            {
              gid: "123",
              title: "Counter-Strike 2 Update",
              url: "https://store.steampowered.com/news/app/730/view/123",
              contents: "Official update contains verified fixes.",
              date: Math.floor(Date.now() / 1000),
              feedname: "steam_community_announcements",
            },
          ],
        },
      });
    await scanNews(env);
    expect(
      (
        await env.DB.prepare(
          "SELECT enabled FROM sources WHERE id='bad'",
        ).first()
      ).enabled,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM articles").first()).n,
    ).toBe(1);
  });
  it("concurrent job claim returns one lease only and completion rejects wrong token", async () => {
    await env.DB.prepare(
      "INSERT INTO articles(id,source_id,url,title,body,published_at,category,entity_key,fingerprint,created_at) VALUES('a','steam','https://example.org/a','Update','Official update contains verified fixes',?,'UPDATE','x','fp',?)",
    )
      .bind(Date.now(), Date.now())
      .run();
    const jobs = await Promise.all([claimJob(env), claimJob(env)]);
    expect(jobs.filter(Boolean)).toHaveLength(1);
    await expect(completeJob(env, "a", "wrong", {})).rejects.toThrow(
      "LEASE_EXPIRED",
    );
  });
});

describe("recovery and factual gates", () => {
  it("resumes interrupted final event after match row was already committed", async () => {
    const event = MockLiveProvider.event("finished", "interrupted");
    await env.DB.prepare(
      "INSERT INTO events(id,match_id,revision,type,received_at,payload) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        `mock:${event.id}`,
        "mock:interrupted",
        2,
        "finished",
        Date.now(),
        JSON.stringify(event),
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO matches(id,provider,revision,status,payload,received_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        "mock:interrupted",
        "mock",
        2,
        "finished",
        JSON.stringify(event),
        Date.now(),
      )
      .run();
    await ingestMatch(env, event);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first()).n,
    ).toBe(1);
    expect(
      (await env.DB.prepare("SELECT processed_at FROM events").first())
        .processed_at,
    ).not.toBeNull();
  });
  it("requires webhook authentication before accepting events", async () => {
    const r = await SELF.fetch("https://example.com/webhooks/live", {
      method: "POST",
      body: JSON.stringify(MockLiveProvider.event("finished")),
    });
    expect(r.status).toBe(401);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first()).n,
    ).toBe(0);
  });
  it("rejects generation evidence absent from original source", async () => {
    await env.DB.prepare(
      "INSERT INTO articles(id,source_id,url,title,body,published_at,category,entity_key,fingerprint,created_at) VALUES('facts','steam','https://example.org/facts','Update','Official update contains verified fixes',?,'UPDATE','x','facts',?)",
    )
      .bind(Date.now(), Date.now())
      .run();
    const job = await claimJob(env);
    await expect(
      completeJob(env, "facts", job.claim_token, {
        headline: "Обновление игры",
        sentences: ["Valve выпустила обновление игры."],
        evidence: ["This quote is entirely fabricated"],
      }),
    ).rejects.toThrow("EVIDENCE_NOT_IN_SOURCE");
  });
  it("renders every configured category", async () => {
    for (const category of [
      "TRANSFER",
      "MATCH_RESULT",
      "ROSTER",
      "UPDATE",
      "GENERAL_NEWS",
    ] as const) {
      const png = await renderCard({
        category,
        title: "Проверка русскоязычного шаблона",
      });
      expect(png[0]).toBe(137);
    }
  });
  it("recovers PNG rendering interrupted before publication", async () => {
    const id = await enqueue(env, {
      key: "recover-png",
      category: "UPDATE",
      caption: "Обновление",
      card: { category: "UPDATE", title: "Обновление Counter-Strike 2" },
      receivedAt: Date.now(),
      occurredAt: null,
    });
    await env.DB.prepare("UPDATE posts SET png=NULL WHERE id=?").bind(id).run();
    await recover(env);
    expect(
      (
        await env.DB.prepare("SELECT length(png) AS n FROM posts WHERE id=?")
          .bind(id)
          .first()
      ).n,
    ).toBeGreaterThan(10000);
  });
});

it("completes a leased news job into a rendered dry-run publication", async () => {
  await env.DB.prepare(
    "INSERT INTO articles(id,source_id,url,title,body,published_at,category,entity_key,fingerprint,created_at) VALUES('news-success','steam','https://example.org/official','CS2 Update','Official update contains verified fixes',?,'UPDATE','update','success',?)",
  )
    .bind(Date.now(), Date.now())
    .run();
  const job = await claimJob(env);
  await completeJob(env, "news-success", job.claim_token, {
    headline: "Вышло обновление игры",
    sentences: ["Разработчики выпустили исправления игры."],
    evidence: ["Official update contains verified fixes"],
  });
  const post = await env.DB.prepare(
    "SELECT id,caption,length(png) AS n FROM posts",
  ).first();
  expect(post.caption).toContain("Источник");
  expect(post.n).toBeGreaterThan(10000);
  await publish(env, post.id, true);
  expect(
    (await env.DB.prepare("SELECT status FROM posts").first()).status,
  ).toBe("dry-run");
});
