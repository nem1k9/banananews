import { spawn } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const origin = process.env.WORKER_URL;
const token = process.env.RUNNER_TOKEN;
if (
  !origin ||
  !token ||
  (new URL(origin).protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
)
  throw new Error("Set WORKER_URL and RUNNER_TOKEN");
const once = process.argv.includes("--once");
async function api(route, data) {
  const r = await fetch(new URL("/api/runner/" + route, origin), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("WORKER_HTTP_" + r.status);
  return r.json();
}
async function generate(job) {
  const dir = await mkdtemp(path.join(tmpdir(), "cs2-codex-"));
  try {
    const schema =
      job.kind === "match"
        ? {
            type: "object",
            properties: {
              titles: {
                type: "object",
                properties: Object.fromEntries(
                  JSON.parse(job.payload).teams.map((t) => [
                    t.id,
                    { type: "string" },
                  ]),
                ),
                required: JSON.parse(job.payload).teams.map((t) => t.id),
                additionalProperties: false,
              },
            },
            required: ["titles"],
            additionalProperties: false,
          }
        : {
            type: "object",
            properties: {
              headline: { type: "string" },
              sentences: { type: "array", items: { type: "string" } },
              evidence: { type: "array", items: { type: "string" } },
            },
            required: ["headline", "sentences", "evidence"],
            additionalProperties: false,
          };
    await writeFile(path.join(dir, "schema.json"), JSON.stringify(schema));
    const instructions = await readFile(
      new URL("../prompts/editor.md", import.meta.url),
      "utf8",
    );
    const input =
      job.kind === "match"
        ? { kind: "match", data: JSON.parse(job.payload) }
        : { kind: "news", title: job.title, body: job.body };
    const prompt =
      instructions +
      "\n<UNTRUSTED_SOURCE_JSON>\n" +
      JSON.stringify(input) +
      "\n</UNTRUSTED_SOURCE_JSON>";
    const out = path.join(dir, "result.json");
    // No shell, no inherited Worker/Telegram/API secrets, isolated empty working directory.
    const childEnv = Object.fromEntries(
      [
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "CODEX_HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
        "NODE_EXTRA_CA_CERTS",
      ]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    await new Promise((resolve, reject) => {
      const child = spawn(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--output-schema",
          path.join(dir, "schema.json"),
          "--output-last-message",
          out,
          "-",
        ],
        { cwd: dir, env: childEnv, stdio: ["pipe", "ignore", "ignore"] },
      );
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
        reject(new Error("CODEX_TIMEOUT"));
      }, 120000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error("CODEX_UNAVAILABLE"));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error("CODEX_FAILED"));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
    const text = await readFile(out, "utf8");
    if (text.length > 12000) throw new Error("CODEX_OUTPUT_TOO_LARGE");
    return JSON.parse(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
do {
  try {
    const job = await api("claim", {});
    if (job) {
      const result = await generate(job);
      await api("complete", {
        id: job.id,
        claim_token: job.claim_token,
        result,
      });
      console.log("job completed");
    } else if (once) console.log("no pending jobs");
  } catch {
    console.error(
      "generation cycle failed; no secrets logged; lease will expire",
    );
    if (once) process.exitCode = 1;
  }
  if (!once && !stopped) await new Promise((r) => setTimeout(r, 5000));
} while (!once && !stopped);
