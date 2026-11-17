import { z } from "zod";
import { timedFetch } from "./util";
export const team = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(100),
});
export const matchEvent = z
  .object({
    id: z.string().min(1).max(180),
    provider: z.enum(["mock", "pandascore", "grid"]),
    matchId: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    type: z.enum([
      "started",
      "map_finished",
      "finished",
      "cancelled",
      "corrected",
    ]),
    confirmed: z.boolean(),
    occurredAt: z.number().int().positive().nullable(),
    tournament: z.string().min(1).max(160),
    bo: z.union([z.literal(1), z.literal(3), z.literal(5)]),
    teams: z.tuple([team, team]),
    score: z.tuple([
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
    ]),
    maps: z
      .array(
        z.object({
          name: z.string().max(80),
          score: z.tuple([
            z.number().int().nonnegative(),
            z.number().int().nonnegative(),
          ]),
        }),
      )
      .max(5),
    winnerId: z.string().nullable(),
  })
  .strict()
  .superRefine((e, c) => {
    const fail = (message: string) =>
      c.addIssue({ code: z.ZodIssueCode.custom, message });
    if (e.teams[0].id === e.teams[1].id) fail("Distinct teams required");
    const target = Math.floor(e.bo / 2) + 1;
    if (e.score.some((s) => s > target)) fail("Invalid series score");
    if (e.occurredAt && e.occurredAt > Date.now() + 300000)
      fail("Future event");
    if (e.maps.some((m) => m.score[0] === m.score[1]))
      fail("Completed maps cannot be tied");
    const mapWins = [
      e.maps.filter((m) => m.score[0] > m.score[1]).length,
      e.maps.filter((m) => m.score[1] > m.score[0]).length,
    ];
    if (mapWins.some((v, i) => v !== e.score[i]))
      fail("Maps must match series score");
    if (e.type === "finished") {
      if (!e.confirmed) fail("Final result must be confirmed");
      const i = e.teams.findIndex((t) => t.id === e.winnerId);
      if (i < 0 || e.score[i] !== target || e.score[1 - i] >= target)
        fail("Winner does not match score");
    } else if (e.type === "started" && e.score.some(Boolean))
      fail("Start score must be zero");
  });
export type MatchEvent = z.infer<typeof matchEvent>;
export interface LiveProvider {
  name: string;
  minimumPollSeconds: number;
  read(matchId: string): Promise<MatchEvent | null>;
}
export class MockLiveProvider implements LiveProvider {
  name = "mock";
  minimumPollSeconds = 1;
  async read() {
    return null;
  }
  static event(
    type: "started" | "finished",
    id = "demo-navi-vitality",
  ): MatchEvent {
    return matchEvent.parse({
      id: `mock:${id}:${type}`,
      provider: "mock",
      matchId: id,
      revision: type === "started" ? 1 : 2,
      type,
      confirmed: true,
      occurredAt: Date.now(),
      tournament: "DEMO • CS2 Invitational",
      bo: 3,
      teams: [
        { id: "navi", name: "NAVI" },
        { id: "vitality", name: "Vitality" },
      ],
      score: type === "started" ? [0, 0] : [2, 1],
      maps:
        type === "started"
          ? []
          : [
              { name: "Mirage", score: [13, 8] },
              { name: "Inferno", score: [9, 13] },
              { name: "Nuke", score: [13, 10] },
            ],
      winnerId: type === "started" ? null : "navi",
    });
  }
}
// REST adapter. Production polling requires an explicit licensed allowance.
export class PandaScoreProvider implements LiveProvider {
  name = "pandascore";
  minimumPollSeconds: number;
  constructor(
    private token: string,
    minimum = 10,
  ) {
    this.minimumPollSeconds = minimum;
  }
  async read(id: string) {
    if (!/^\d+$/.test(id)) throw new Error("INVALID_PROVIDER_ID");
    const r = await timedFetch(`https://api.pandascore.co/csgo/matches/${id}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) throw new Error(`PROVIDER_HTTP_${r.status}`);
    const d = z
      .object({
        id: z.number(),
        modified_at: z.string(),
        status: z.string(),
        number_of_games: z.number(),
        end_at: z.string().nullable(),
        name: z.string(),
        tournament: z.object({ name: z.string() }),
        opponents: z
          .array(
            z.object({
              opponent: z.object({ id: z.number(), name: z.string() }),
            }),
          )
          .length(2),
        results: z
          .array(z.object({ team_id: z.number(), score: z.number() }))
          .length(2),
        winner_id: z.number().nullable(),
        games: z.array(
          z.object({
            status: z.string(),
            winner: z.object({ id: z.number().nullable() }).nullable(),
            position: z.number(),
          }),
        ),
      })
      .parse(await r.json());
    if (!["running", "finished", "canceled"].includes(d.status)) return null;
    const teams = d.opponents.map((o) => ({
      id: String(o.opponent.id),
      name: o.opponent.name,
    })) as MatchEvent["teams"];
    // This endpoint does not guarantee per-map round scores. Do not fabricate them.
    // A licensed webhook with complete map scores must supply final events.
    if (d.status === "finished")
      throw new Error("FINAL_REQUIRES_LICENSED_MAP_SCORE_EVENT");
    if (d.status === "running" && d.results.some((x) => x.score !== 0))
      return null;
    return matchEvent.parse({
      id: `pandascore:${d.id}:${d.modified_at}`,
      provider: "pandascore",
      matchId: String(d.id),
      revision: Date.parse(d.modified_at),
      type: d.status === "canceled" ? "cancelled" : "started",
      confirmed: true,
      occurredAt: null,
      tournament: d.tournament.name,
      bo: d.number_of_games,
      teams,
      score: [0, 0],
      maps: [],
      winnerId: null,
    });
  }
}
