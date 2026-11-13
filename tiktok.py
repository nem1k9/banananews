#!/usr/bin/env python3
"""TikTok: раз в день карусель из самых просматриваемых постов канала за сутки (запускается в GitHub Actions).

  python3 tiktok.py build  <pages_dir>      # выбрать посты, нарисовать вертикальные картинки в <pages_dir>/tiktok/<дата>/
  python3 tiktok.py publish <pages_dir>     # опубликовать нарисованное (картинки уже на GitHub Pages)
  python3 tiktok.py auth <code>             # однократно: обменять код авторизации TikTok на токены

Секреты (GitHub → Settings → Secrets → Actions): TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_STATE_KEY (любой длинный пароль).
Токены TikTok хранятся в репозитории зашифрованными (tiktok_state.enc, ключ — TIKTOK_STATE_KEY) и обновляются при каждом запуске.
"""
import datetime as dt, html, json, os, re, subprocess, sys, time
import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
CHANNEL = os.environ.get("TELEGRAM_CHANNEL", "@BananNewws").lstrip("@")
PAGES_URL = os.environ.get("PAGES_URL", "https://nem1k9.github.io/banananews").rstrip("/")
REDIRECT_URI = f"{PAGES_URL}/tiktok-callback.html"
STATE = os.path.join(ROOT, "tiktok_state.enc")
TOP_N = 3
API = "https://open.tiktokapis.com/v2"


# ---------- выбор постов ----------
def views(v):
    v = (v or "0").strip().upper().replace(",", ".")
    mul = 1000 if v.endswith("K") else 1_000_000 if v.endswith("M") else 1
    try:
        return int(float(v.rstrip("KM")) * mul)
    except ValueError:
        return 0


def feed_posts():
    h = requests.get(f"https://t.me/s/{CHANNEL}", headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
    out = []
    for b in re.split(r'(?=<div class="tgme_widget_message_wrap)', h)[1:]:
        pid = re.search(r'data-post="[^/]+/(\d+)"', b)
        ph = re.findall(r"tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)", b)
        t = re.search(r'<time datetime="([^"]+)"', b)
        txt = re.search(r'js-message_text[^>]*>(.*?)</div>', b, re.S)
        if not (pid and ph and t and txt):
            continue
        text = html.unescape(re.sub(r"<[^>]+>", "", re.sub(r"<br\s*/?>", "\n", txt.group(1)))).strip()
        out.append({"id": int(pid.group(1)), "photo": ph[0], "time": dt.datetime.fromisoformat(t.group(1)),
                    "views": views((re.search(r'tgme_widget_message_views">([^<]+)<', b) or [None, "0"])[1]),
                    "lead": text.split("\n")[0].strip()})
    return out


def headline(lead):
    """Первая строка поста без эмодзи в начале, первое слово-имя подсвечено."""
    t = re.sub(r"^[^\w«\"]+", "", lead).strip()
    t = re.sub(r"\s*[—–]\s*", " - ", t)
    return t[:110] + ("..." if len(t) > 110 else "")


def build(pages_dir):
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=24)
    posts = [p for p in feed_posts() if p["time"] >= since]
    top = sorted(posts, key=lambda p: (-p["views"], -p["id"]))[:TOP_N]
    top.sort(key=lambda p: p["id"])
    if not top:
        print("NOTHING: за сутки нет постов с картинками")
        return []
    day = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
    out_dir = os.path.join(pages_dir, "tiktok", day)
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for i, p in enumerate(top, 1):
        src = os.path.join(out_dir, f"src{i}.jpg")
        open(src, "wb").write(requests.get(p["photo"], timeout=30).content)
        data = os.path.join(out_dir, f"s{i}.json")
        json.dump({"image": os.path.abspath(src), "title": headline(p["lead"]), "event": "CS2 NEWS"},
                  open(data, "w"), ensure_ascii=False)
        png = os.path.join(out_dir, f"s{i}.png")
        subprocess.run(["node", os.path.join(ROOT, "render.js"), "tiktok", data, png], check=True, capture_output=True)
        jpg = os.path.join(out_dir, f"{i}.jpg")
        from PIL import Image
        Image.open(png).convert("RGB").save(jpg, "JPEG", quality=90, optimize=True)
        for f in (src, data, png):
            os.remove(f)
        files.append(f"tiktok/{day}/{i}.jpg")
    meta = {"day": day, "images": files, "leads": [headline(p["lead"]) for p in top], "posts": [p["id"] for p in top]}
    json.dump(meta, open(os.path.join(out_dir, "meta.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(meta, ensure_ascii=False, indent=1))
    return files


# ---------- токены ----------
def _crypt(data, decrypt=False):
    key = os.environ["TIKTOK_STATE_KEY"]
    cmd = ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-a", "-A", "-pass", "env:TIKTOK_STATE_KEY"] + (["-d"] if decrypt else [])
    r = subprocess.run(cmd, input=data, capture_output=True, env={**os.environ, "TIKTOK_STATE_KEY": key})
    if r.returncode:
        sys.exit("не удалось (рас)шифровать состояние TikTok — проверьте TIKTOK_STATE_KEY")
    return r.stdout


def save_state(tok):
    open(STATE, "wb").write(_crypt(json.dumps({"refresh_token": tok["refresh_token"], "open_id": tok.get("open_id")}).encode()))


def token_request(**data):
    r = requests.post(f"{API}/oauth/token/", data={"client_key": os.environ["TIKTOK_CLIENT_KEY"],
                                                    "client_secret": os.environ["TIKTOK_CLIENT_SECRET"], **data},
                      headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30).json()
    if "access_token" not in r:
        sys.exit(f"TikTok не выдал токен: {r.get('error')} {r.get('error_description')}")
    return r


def auth(code):
    tok = token_request(code=code, grant_type="authorization_code", redirect_uri=REDIRECT_URI)
    save_state(tok)
    print("ok: TikTok подключён, токены сохранены (зашифрованы)")


def access_token():
    if not os.path.exists(STATE):
        sys.exit("TikTok ещё не подключён: выполните шаг авторизации (README, раздел TikTok)")
    st = json.loads(_crypt(open(STATE, "rb").read(), decrypt=True))
    tok = token_request(grant_type="refresh_token", refresh_token=st["refresh_token"])
    save_state(tok)  # refresh_token мог обновиться
    return tok["access_token"]


# ---------- публикация ----------
def publish(pages_dir):
    day = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
    meta_path = os.path.join(pages_dir, "tiktok", day, "meta.json")
    if not os.path.exists(meta_path):
        print("NOTHING: сегодня нечего публиковать")
        return
    meta = json.load(open(meta_path))
    urls = [f"{PAGES_URL}/{f}" for f in meta["images"]]
    for _ in range(30):  # ждём, пока GitHub Pages выкатит картинки
        if all(requests.head(u, timeout=15).status_code == 200 for u in urls):
            break
        time.sleep(10)
    else:
        sys.exit("картинки так и не появились на GitHub Pages")
    at = access_token()
    hdr = {"Authorization": f"Bearer {at}", "Content-Type": "application/json; charset=UTF-8"}
    info = requests.post(f"{API}/post/publish/creator_info/query/", headers=hdr, timeout=30).json().get("data", {})
    levels = info.get("privacy_level_options") or ["SELF_ONLY"]
    privacy = "PUBLIC_TO_EVERYONE" if "PUBLIC_TO_EVERYONE" in levels else levels[0]
    title = "Главные новости CS2 за день 🍌"
    desc = ("\n".join(f"▪️ {l}" for l in meta["leads"]) +
            "\n\nБольше новостей и счёт матчей в Telegram: @BananNewws\n#cs2 #counterstrike #киберспорт #cs2news #ксго")[:4000]
    body = {"post_info": {"title": title, "description": desc, "privacy_level": privacy,
                          "disable_comment": False, "auto_add_music": True},
            "source_info": {"source": "PULL_FROM_URL", "photo_cover_index": 0, "photo_images": urls},
            "post_mode": "DIRECT_POST", "media_type": "PHOTO"}
    r = requests.post(f"{API}/post/publish/content/init/", headers=hdr, json=body, timeout=60).json()
    err = (r.get("error") or {}).get("code")
    if err and err != "ok":
        sys.exit(f"TikTok отказал: {r['error']}")
    print(f"ok: карусель отправлена в TikTok ({len(urls)} фото, видимость {privacy}), publish_id={r.get('data', {}).get('publish_id')}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "build":
        build(sys.argv[2])
    elif cmd == "publish":
        publish(sys.argv[2])
    elif cmd == "auth":
        auth(sys.argv[2])
    else:
        print(__doc__)
