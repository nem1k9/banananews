#!/usr/bin/env python3
"""HLTV напрямую (без Google News): архив новостей + текст статей через браузер Camoufox.

  python3 hltv.py [N]     # JSON: N последних новостей (по умолчанию 8) с временем публикации и текстом
"""
import json, os, sys

CAMOUFOX = os.environ.get("CAMOUFOX_BIN", "/workspace/camoufox/camoufox-bin")
PROFILE = os.environ.get("CAMOUFOX_PROFILE", "/workspace/cfprofile")


def fetch(limit=8):
    from playwright.sync_api import sync_playwright
    out = []
    with sync_playwright() as p:
        ctx = p.firefox.launch_persistent_context(PROFILE, executable_path=CAMOUFOX, headless=True)
        try:
            pg = ctx.new_page()
            pg.goto("https://www.hltv.org/news/archive", timeout=60000)
            pg.wait_for_timeout(3000)
            links = pg.eval_on_selector_all("a.newsline", "els=>els.map(e=>({href:e.href,title:e.innerText.split('\\n')[0]}))")
            for l in links[:limit]:
                try:
                    pg.goto(l["href"], timeout=60000)
                    pg.wait_for_timeout(1200)
                    d = pg.query_selector(".date[data-unix]")
                    og = pg.query_selector('meta[property="og:image"]')
                    body = pg.query_selector(".newsdsl")
                    out.append({"title": l["title"].strip(), "link": l["href"],
                                "unix": int(d.get_attribute("data-unix")) // 1000 if d else None,
                                "image": og.get_attribute("content") if og else None,
                                "text": (body.inner_text() if body else "")[:2500]})
                except Exception as e:
                    print(f"warn: hltv {l['href']}: {e}", file=sys.stderr)
        finally:
            ctx.close()
    return out


if __name__ == "__main__":
    print(json.dumps(fetch(int(sys.argv[1]) if len(sys.argv) > 1 else 8), ensure_ascii=False))
