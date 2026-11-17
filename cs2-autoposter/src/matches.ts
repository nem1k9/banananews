import { DurableObject } from "cloudflare:workers";
import type { Env, Prepared } from "./types";
import {
  matchEvent,
  MockLiveProvider,
  PandaScoreProvider,
  type MatchEvent,
} from "./providers";
import { enqueue, publish } from "./posts";
import { renderCard } from "./render";
import { json, html, logError, settings } from "./util";
export class MatchMonitor extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  fetch(req: Request): Promise<Response> {
    const next = this.queue.then(() => this.handle(req));
    this.queue = next.catch(() => {});
    return next;
  }
  private async handle(req: Request) {
    const u = new URL(req.url);
    if (u.pathname === "/watch") {
      const { id } = (await req.json()) as { id: string };
      await this.ctx.storage.put("watch", id);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json({ watching: id });
    }
    return this.ingest(matchEvent.parse(await req.json()));
  }
  async ingest(e: MatchEvent) {
    const db = this.env.DB,
      received = Date.now(),
      key = `${e.provider}:${e.matchId}`;
    const existing = await db
      .prepare("SELECT * FROM matches WHERE id=?")
      .bind(key)
      .first<{
        revision: number;
        status: string;
        prepared: string;
        payload: string;
      }>();
    const pending = await db
      .prepare("SELECT processed_at FROM events WHERE id=?")
      .bind(`${e.provider}:${e.id}`)
      .first<{ processed_at: number | null }>();
    const resuming =
      !!pending &&
      pending.processed_at === null &&
      existing?.revision === e.revision;
    if (existing && e.revision <= existing.revision && !resuming)
      return json({ duplicate: true });
    if (
      existing &&
      JSON.stringify(JSON.parse(existing.payload).teams) !==
        JSON.stringify(e.teams)
    )
      throw new Error("MATCH_TEAMS_CHANGED");
    if (
      existing?.status === "cancelled" &&
      !["corrected", "cancelled"].includes(e.type)
    )
      throw new Error("CANCELLED_MATCH_REQUIRES_CORRECTION");
    if (
      existing?.status === "finished" &&
      !resuming &&
      !["corrected", "cancelled"].includes(e.type)
    )
      return json({ ignored: "terminal state" });
    await db
      .prepare(
        "INSERT OR IGNORE INTO events(id,match_id,revision,type,received_at,payload) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        `${e.provider}:${e.id}`,
        key,
        e.revision,
        e.type,
        received,
        JSON.stringify(e),
      )
      .run();
    let prepared: Prepared = existing?.prepared
      ? JSON.parse(existing.prepared)
      : {};
    if (e.type === "started") {
      prepared = Object.fromEntries(
        e.teams.map((t) => [
          t.id,
          {
            title: `${t.name} побеждает в серии`,
            body: `Команда выиграла матч на турнире ${e.tournament}.`,
            graphics: { accent: "#b8ff71", background: "#101018" },
          },
        ]),
      );
      for (const t of e.teams) {
        const png = await renderCard({
          category: "MATCH_RESULT",
          title: prepared[t.id].title,
          subtitle: e.tournament,
        });
        await db
          .prepare(
            "INSERT OR IGNORE INTO prepared_assets(match_id,winner_id,png) VALUES(?,?,?)",
          )
          .bind(key, t.id, png.buffer)
          .run();
      }
      if (this.env.CODEX_ENABLED === "true")
        await db
          .prepare(
            "INSERT OR IGNORE INTO generation_jobs(id,kind,payload) VALUES(?,'match',?)",
          )
          .bind(
            key,
            JSON.stringify({
              matchId: key,
              teams: e.teams,
              tournament: e.tournament,
            }),
          )
          .run();
    }
    if (e.type === "finished" && existing) {
      const old = JSON.parse(existing.payload) as MatchEvent;
      if (old.bo !== e.bo || old.score.some((n, i) => n > e.score[i]))
        throw new Error("NON_MONOTONIC_RESULT");
    }
    await db
      .prepare(
        "INSERT INTO matches(id,provider,revision,status,payload,prepared,received_at,finished_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,payload=excluded.payload,prepared=excluded.prepared,received_at=excluded.received_at,finished_at=excluded.finished_at",
      )
      .bind(
        key,
        e.provider,
        e.revision,
        e.type,
        JSON.stringify(e),
        JSON.stringify(prepared),
        received,
        e.type === "finished" ? e.occurredAt : null,
      )
      .run();
    if (e.type === "cancelled" || e.type === "corrected") {
      await db
        .prepare(
          "UPDATE posts SET status='cancelled' WHERE event_key=? AND status='ready'",
        )
        .bind(`${key}:final`)
        .run();
      const sent = await db
        .prepare(
          "SELECT id FROM posts WHERE event_key=? AND status IN ('published','uncertain','sending')",
        )
        .bind(`${key}:final`)
        .first();
      if (sent)
        await logError(
          this.env,
          "provider",
          "RESULT_CORRECTION_REQUIRES_REVIEW",
          key,
        );
    }
    let postId: string | undefined;
    if (e.type === "finished") {
      const win = e.teams.find((t) => t.id === e.winnerId)!;
      const title = prepared[win.id]?.title || `${win.name} побеждает в серии`;
      const score = e.score.join(":");
      const caption = `<b>${html(title)}</b>\n\n${html(e.teams[0].name)} ${score} ${html(e.teams[1].name)}. Турнир: ${html(e.tournament)}.\n${e.maps.map((m) => `${html(m.name)} ${m.score.join(":")}`).join(" · ")}`;
      postId = await enqueue(this.env, {
        key: `${key}:final`,
        category: "MATCH_RESULT",
        caption,
        receivedAt: received,
        occurredAt: e.occurredAt,
        card: {
          category: "MATCH_RESULT",
          title: `${e.teams[0].name} — ${e.teams[1].name}`,
          score,
          subtitle: e.tournament,
        },
      });
      await publish(this.env, postId);
      await this.ctx.storage.deleteAlarm();
    }
    await db
      .prepare("UPDATE events SET processed_at=? WHERE id=?")
      .bind(Date.now(), `${e.provider}:${e.id}`)
      .run();
    return json({ accepted: true, postId });
  }
  async alarm() {
    const id = await this.ctx.storage.get<string>("watch");
    if (!id) return;
    try {
      if (
        this.env.PROVIDER !== "pandascore" ||
        this.env.PROVIDER_POLLING_APPROVED !== "true" ||
        !this.env.PANDASCORE_TOKEN
      )
        throw new Error("LICENSED_POLLING_NOT_CONFIGURED");
      const provider = new PandaScoreProvider(
        this.env.PANDASCORE_TOKEN,
        Number(this.env.PROVIDER_MIN_POLL_SECONDS) || 10,
      );
      const event = await provider.read(id);
      if (event) {
        await this.ingest(event);
        if (["finished", "cancelled"].includes(event.type)) return;
      }
      await this.ctx.storage.put("failures", 0);
    } catch {
      const failures =
        ((await this.ctx.storage.get<number>("failures")) || 0) + 1;
      await this.ctx.storage.put("failures", failures);
      await logError(this.env, "live", "PROVIDER_POLL_FAILED", id);
      await this.ctx.storage.setAlarm(
        Date.now() + Math.min(300000, 10000 * 2 ** Math.min(failures, 5)),
      );
      return;
    }
    const s = await settings(this.env);
    const seconds = Math.max(
      5,
      s.poll_seconds,
      Number(this.env.PROVIDER_MIN_POLL_SECONDS) || 10,
    );
    await this.ctx.storage.setAlarm(Date.now() + seconds * 1000);
  }
}
export async function ingestMatch(env: Env, event: unknown) {
  const e = matchEvent.parse(event);
  const id = env.MATCHES.idFromName(`${e.provider}:${e.matchId}`);
  return env.MATCHES.get(id).fetch("https://match/event", {
    method: "POST",
    body: JSON.stringify(e),
  });
}
export { MockLiveProvider };
