import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.WORKER_URL || "http://127.0.0.1:8787",
  token = process.env.ADMIN_TOKEN;
if (!token) throw new Error("Set ADMIN_TOKEN to the same secret as .dev.vars");
async function api(p, b) {
  const r = await fetch(base + "/api/" + p, {
    method: b ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
const state = await api("state");
if (state.mode !== "dry-run")
  throw new Error(
    "Demo script only supports dry-run. Use the admin test button for explicit test-channel delivery.",
  );
await api("settings", {
  autopost: true,
  categories: ["TRANSFER", "MATCH_RESULT", "ROSTER", "UPDATE", "GENERAL_NEWS"],
  poll_seconds: 10,
});
const id = "demo-" + Date.now();
await api("demo", { type: "started", id });
await api("demo", { type: "finished", id });
await api("demo", { type: "finished", id });
const after = await api("state");
const posts = after.posts.filter((p) => p.event_key === `mock:${id}:final`);
if (posts.length !== 1 || posts[0].status !== "dry-run")
  throw new Error("Dedup or render failed: " + JSON.stringify(posts));
const p = posts[0];
const image = await fetch(base + `/api/posts/${p.id}/image`, {
  headers: { Authorization: "Bearer " + token },
});
if (!image.ok) throw new Error("Image missing");
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/demo.png", Buffer.from(await image.arrayBuffer()));
await writeFile("artifacts/demo.json", JSON.stringify(p, null, 2));
console.log(
  JSON.stringify(
    {
      status: p.status,
      posts: posts.length,
      processing_ms: p.processing_ms,
      detection_ms: p.detection_ms,
      caption: p.caption,
      image: "artifacts/demo.png",
    },
    null,
    2,
  ),
);
