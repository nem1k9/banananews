#!/usr/bin/env python3
"""TikTok: каждая новая новость канала (с картинкой) -> отдельный пост в TikTok, одна картинка + музыка от TikTok.
Запускается в GitHub Actions каждый час; лимит DAILY_CAP постов в сутки (TikTok пускает ~15 через API).

  python3 tiktok.py build  <pages_dir>      # найти новые посты канала, нарисовать вертикальные картинки в <pages_dir>/tiktok/
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
DAILY_CAP = 12      # постов в TikTok в сутки (по Киеву)
PER_RUN = 3         # за один запуск
MAX_AGE_H = 6       # старые посты канала не берём
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


def kyiv_day(t=None):
    from zoneinfo import ZoneInfo
    return (t or dt.datetime.now(dt.timezone.utc)).astimezone(ZoneInfo("Europe/Kyiv")).strftime("%Y-%m-%d")


def posted_log(pages_dir):
    p = os.path.join(pages_dir, "tiktok", "posted.json")
    try:
        return json.load(open(p))
    except Exception:
        return []


def build(pages_dir):
    log = posted_log(pages_dir)
    done = {x["id"] for x in log}
    today = sum(1 for x in log if x.get("day") == kyiv_day())
    room = min(PER_RUN, DAILY_CAP - today)
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=MAX_AGE_H)
    fresh = [p for p in feed_posts() if p["time"] >= since and p["id"] not in done]
    pick = sorted(fresh, key=lambda p: (-p["views"], -p["id"]))[:max(room, 0)]
    pick.sort(key=lambda p: p["id"])
    out_dir = os.path.join(pages_dir, "tiktok")
    os.makedirs(out_dir, exist_ok=True)
    pending = []
    from PIL import Image
    for p in pick:
        src, data, png = (os.path.join(out_dir, f"_{p['id']}.{e}") for e in ("jpg", "json", "png"))
        open(src, "wb").write(requests.get(p["photo"], timeout=30).content)
        json.dump({"image": os.path.abspath(src), "title": headline(p["lead"]), "event": "CS2 NEWS"},
                  open(data, "w"), ensure_ascii=False)
        subprocess.run(["node", os.path.join(ROOT, "render.js"), "tiktok", data, png], check=True, capture_output=True)
        Image.open(png).convert("RGB").save(os.path.join(out_dir, f"{p['id']}.jpg"), "JPEG", quality=90, optimize=True)
        for f in (src, data, png):
            os.remove(f)
        pending.append({"id": p["id"], "image": f"tiktok/{p['id']}.jpg", "lead": headline(p["lead"])})
    json.dump(pending, open(os.path.join(out_dir, "pending.json"), "w"), ensure_ascii=False, indent=1)
    print(f"сегодня уже {today}/{DAILY_CAP}, новых к публикации: {len(pending)}")
    for x in pending:
        print(" ", x["id"], x["lead"])
    return pending


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
    pend_path = os.path.join(pages_dir, "tiktok", "pending.json")
    pending = json.load(open(pend_path)) if os.path.exists(pend_path) else []
    if not pending:
        print("NOTHING: новых постов для TikTok нет")
        return
    urls = {x["id"]: f"{PAGES_URL}/{x['image']}" for x in pending}
    for _ in range(30):  # ждём, пока GitHub Pages выкатит картинки
        if all(requests.head(u, timeout=15).status_code == 200 for u in urls.values()):
            break
        time.sleep(10)
    else:
        sys.exit("картинки так и не появились на GitHub Pages")
    at = access_token()
    hdr = {"Authorization": f"Bearer {at}", "Content-Type": "application/json; charset=UTF-8"}
    log = posted_log(pages_dir)
    try:
        runlog = json.load(open(os.path.join(pages_dir, "tiktok", "last_runs.json")))
    except Exception:
        runlog = []
    for i, x in enumerate(pending):
        info = requests.post(f"{API}/post/publish/creator_info/query/", headers=hdr, timeout=30).json().get("data", {})
        levels = info.get("privacy_level_options") or ["SELF_ONLY"]
        # после аудита TikTok: для всех; до аудита неодобренному приложению можно только SELF_ONLY
        privacy = "PUBLIC_TO_EVERYONE" if "PUBLIC_TO_EVERYONE" in levels else "SELF_ONLY"
        desc = (f"{x['lead']}\n\nБольше новостей и счёт матчей в Telegram: @BananNewws 🍌\n"
                "#cs2 #counterstrike #киберспорт #cs2news #ксго")[:4000]
        body = {"post_info": {"title": x["lead"][:90], "description": desc, "privacy_level": privacy,
                              "disable_comment": False, "auto_add_music": True},
                "source_info": {"source": "PULL_FROM_URL", "photo_cover_index": 0, "photo_images": [urls[x["id"]]]},
                "post_mode": "DIRECT_POST", "media_type": "PHOTO"}
        try:
            r = requests.post(f"{API}/post/publish/content/init/", headers=hdr, json=body, timeout=120).json()
        except requests.exceptions.RequestException as e:
            # мог дойти: помечаем как отправленный, чтобы не было дублей
            r = {"error": {"code": "uncertain", "message": str(type(e).__name__)}}
        err = (r.get("error") or {}).get("code")
        runlog.append({"id": x["id"], "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                       "privacy": privacy, "privacy_options": levels, "response": r})
        json.dump(runlog[-50:], open(os.path.join(pages_dir, "tiktok", "last_runs.json"), "w"), ensure_ascii=False, indent=1)
        if err and err not in ("ok", "uncertain"):
            print(f"TikTok отказал для поста {x['id']}: {r['error']}")
            if "spam" in err or "limit" in err or "frequency" in err:
                break
            continue
        log.append({"id": x["id"], "day": kyiv_day(), "publish_id": (r.get("data") or {}).get("publish_id"), "privacy": privacy})
        json.dump(log[-500:], open(os.path.join(pages_dir, "tiktok", "posted.json"), "w"), ensure_ascii=False, indent=0)
        print(f"ok: пост {x['id']} -> TikTok ({privacy}){' [без ответа, считаем отправленным]' if err == 'uncertain' else ''}")
        if i < len(pending) - 1:
            time.sleep(90)  # не постим очередью: TikTok режет частые публикации
    os.remove(pend_path)


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
