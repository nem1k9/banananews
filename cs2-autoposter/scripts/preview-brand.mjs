import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [template, dataFile, output] = process.argv.slice(2);
if (
  !["news", "match", "player", "quote"].includes(template) ||
  !dataFile ||
  !output
) {
  throw new Error(
    "Usage: node scripts/preview-brand.mjs news data.json output.png",
  );
}
const root = fileURLToPath(new URL("../brand/", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
async function inline(value) {
  if (
    typeof value === "string" &&
    /\.(png|jpe?g|webp|svg)$/i.test(value) &&
    !/^(https?|data):/.test(value) &&
    existsSync(value)
  ) {
    return `data:${mime[path.extname(value).toLowerCase()] || "image/webp"};base64,${(await readFile(value)).toString("base64")}`;
  }
  if (Array.isArray(value)) return Promise.all(value.map(inline));
  if (value && typeof value === "object")
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, v]) => [key, await inline(v)]),
      ),
    );
  return value;
}
const data = await inline(JSON.parse(await readFile(dataFile, "utf8")));
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(
      root,
      "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
    );
    if (
      !file.startsWith(path.resolve(root) + path.sep) ||
      !(await stat(file)).isFile()
    )
      throw new Error("not found");
    res.writeHead(200, {
      "Content-Type": mime[path.extname(file)] || "application/octet-stream",
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const executablePath =
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({
    viewport: { width: 1080, height: 1350 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((d) => {
    window.DATA = d;
  }, data);
  await page.goto(
    `http://127.0.0.1:${server.address().port}/templates/${template}.html`,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((i) => i.decode().catch(() => {})),
    );
  });
  const checks = await page.evaluate(() => ({
    titleFont: document.fonts.check("italic 900 76px Montserrat"),
    brandFont: document.fonts.check("900 26px Montserrat"),
    width: document.querySelector("#card").offsetWidth,
    height: document.querySelector("#card").offsetHeight,
  }));
  if (errors.length || !checks.titleFont || !checks.brandFont)
    throw new Error(
      "Template/font validation failed: " +
        JSON.stringify({ errors, ...checks }),
    );
  await mkdir(path.dirname(output), { recursive: true });
  await page.locator("#card").screenshot({ path: output });
  console.log(JSON.stringify({ output, ...checks }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
