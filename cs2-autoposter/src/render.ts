import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import font from "../assets/NotoSans.ttf";
import template from "../templates/default.json";
import type { Category } from "./types";
import { html } from "./util";
let initialized: Promise<void> | undefined;
export interface Card {
  theme?: "default" | "violet";
  category: Category;
  title: string;
  subtitle?: string;
  score?: string;
  teams?: string[];
  photo?: string;
  logos?: string[];
}
// Conservative width estimate; Cyrillic/CJK are given generous budgets.
export function wrap(text: string, size: number, width: number) {
  const measure = (s: string) =>
    [...s].reduce(
      (n, c) =>
        n +
        (/\s/.test(c)
          ? 0.34
          : /[ilI1.,:!]/.test(c)
            ? 0.32
            : /[MWЖШЩЮФ]/.test(c)
              ? 0.95
              : 0.66) *
          size,
      0,
    );
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (measure(word) > width) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (const char of word) {
        if (measure(line + char) > width) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    } else if (measure(line + " " + word) > width) {
      lines.push(line);
      line = word;
    } else line += (line ? " " : "") + word;
  }
  if (line) lines.push(line);
  return lines;
}
function inlineImage(src: string | null | undefined) {
  if (!src) return null;
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src))
    throw new Error("INLINE_IMAGE_REQUIRED");
  return src;
}
export async function renderCard(c: Card): Promise<Uint8Array> {
  initialized ??= initWasm(wasm);
  await initialized;
  const t = template,
    accent = c.theme === "violet" ? t.accent : t.categories[c.category].accent;
  let size = t.titleSize,
    lines = wrap(c.title.slice(0, 240), size, 952);
  while (size > t.minTitleSize && lines.length * size * 1.3 > 300) {
    size -= 2;
    lines = wrap(c.title.slice(0, 240), size, 952);
  }
  const title = lines
    .slice(0, 8)
    .map(
      (s, i) =>
        `<text x="64" y="${590 + i * size * 1.3}" font-size="${size}">${html(s)}</text>`,
    )
    .join("");
  const background = inlineImage(t.backgroundLayer),
    photo = inlineImage(c.photo);
  const logos = (c.logos || [])
    .slice(0, 2)
    .map(
      (src, i) =>
        `<image href="${inlineImage(src)}" x="${64 + i * 90}" y="430" width="72" height="72"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}" height="${t.height}" viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="${t.background}"/>${background ? `<image href="${background}" width="1080" height="1080"/>` : ""}<g font-family="Noto Sans" fill="${t.foreground}"><text x="64" y="94" font-size="24" fill="${accent}">${html(t.categories[c.category].label)}</text><text x="1016" y="94" text-anchor="end" font-size="24" fill="${accent}">CS2 • NEWS</text><rect x="64" y="150" width="952" height="300" rx="24" fill="${t.panel}"/>${photo ? `<image href="${photo}" x="64" y="150" width="952" height="300" preserveAspectRatio="xMidYMid slice"/>` : `<text x="540" y="345" text-anchor="middle" font-size="${c.score ? 140 : 65}" fill="${accent}">${html(c.score || (c.category === "UPDATE" ? "COUNTER-STRIKE 2" : "CS2"))}</text>`}${logos}${title}<text x="64" y="970" font-size="28" fill="#b5b4ca">${html((c.subtitle || "Counter-Strike 2").slice(0, 60))}</text><rect x="64" y="1010" width="952" height="6" fill="${accent}"/></g></svg>`;
  const r = new Resvg(svg, {
    font: {
      fontBuffers: [new Uint8Array(font)],
      defaultFontFamily: "Noto Sans",
    },
  });
  try {
    const image = r.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    r.free();
  }
}
export { template };
