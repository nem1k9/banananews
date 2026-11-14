#!/usr/bin/env python3
"""Клипы с трансляции (Twitch blastpremier) для канала.
  python3 clips.py list [--hours 3] [--min-views 0]   # кандидаты (≤60 с, свежие, ещё не разобранные) + контекст матчей
  python3 clips.py post <id> --file post.html           # скачать, отправить видео, запомнить
  python3 clips.py skip <id> [<id>...]                  # пометить как разобранные (не подходят/повтор момента)
Состояние: /home/user/clips/seen.json (разобранные клипы); повторы дополнительно отсекаются по ключу clip-<id> в ленте канала.
Скрипт копируют из репозитория в /home/user/clips/clips.py каждый прогон (ветка с ним может отличаться от main)."""
import argparse, datetime as dt, json, os, subprocess, sys, time
ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT if os.path.exists(os.path.join(ROOT, "tg.py")) else "/home/user/banananews")
import bo3, tg

D = "/home/user/clips"
os.makedirs(D, exist_ok=True)
SEEN = f"{D}/seen.json"
URL = "https://www.twitch.tv/blastpremier/clips?range=24hr"

def seen():
    try: return json.load(open(SEEN))
    except Exception: return {}

def save(s): json.dump(s, open(SEEN, "w"), indent=1)

def fetch():
    r = subprocess.run(["yt-dlp", "--flat-playlist", "--playlist-end", "40", "-J", URL], capture_output=True, text=True, timeout=120)
    return json.loads(r.stdout)["entries"]

def context():
    out = []
    try:
        out += [m["slug"] + " LIVE " + m["score"] for m in bo3.live_list()]
    except Exception as e: out.append(f"live error {e}")
    try:
        today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
        out += [m["slug"] + " finished " + m["score"] for m in bo3.day_list("finished", today, False)]
    except Exception as e: out.append(f"finished error {e}")
    return out

def live_start():
    """Начало самого раннего идущего сейчас матча (unix). Клипы старше этого времени относятся к прошедшим матчам."""
    try:
        st = [dt.datetime.fromisoformat(m["start_utc"].replace("Z", "+00:00")).timestamp() for m in bo3.live_list() if m.get("start_utc") and m.get("tier") in ("s", "a")]
        return min(st) if st else None
    except Exception:
        return None

def cmd_list(a):
    s = seen(); now = time.time(); res = []
    ls = live_start()
    if ls is None:
        print("NO_LIVE_MATCH"); return
    for e in fetch():
        age = (now - (e.get("timestamp") or 0)) / 3600
        if (e.get("timestamp") or 0) < ls or e["id"] in s or (e.get("duration") or 999) > 60 or age > a.hours or (e.get("view_count") or 0) < a.min_views:
            continue
        res.append({"id": e["id"], "title": e.get("title"), "views": e.get("view_count"), "dur": e.get("duration"),
                    "age_min": round(age * 60), "url": e["url"]})
    res.sort(key=lambda x: -x["views"])
    print(json.dumps({"context": context(), "clips": res}, ensure_ascii=False, indent=1) if res else "NO_CLIPS")

def dims(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path], capture_output=True, text=True)
    j = json.loads(r.stdout)
    return {"width": j["streams"][0]["width"], "height": j["streams"][0]["height"], "duration": int(float(j["format"]["duration"]))}

def blur(path):
    """Размыть зону, где Twitch вшивает субтитры (низ по центру), чтобы текст не читался."""
    out = path[:-4] + "_b.mp4"
    flt = "[0:v]split[a][b];[b]crop=480:70:400:640,boxblur=16:3:8:2[c];[a][c]overlay=400:640"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-filter_complex", flt, "-c:a", "copy", "-crf", "20", out], check=True)
    os.replace(out, path)

def cmd_post(a):
    s = seen()
    if a.id in s: sys.exit("skip: уже разобран")
    if tg.already("clip-" + a.id): sys.exit("skip: клип уже в канале")
    e = next((x for x in fetch() if x["id"] == a.id), None)
    if not e: sys.exit("нет такого клипа")
    s[a.id] = "posting"; save(s)  # помечаем заранее: повторов не будет, даже если отправка упадёт
    path = f"{D}/{a.id}.mp4"
    for fmt in ("1080", "720", "480"):  # лучшее качество, которое влезает в лимит бота (50 МБ)
        subprocess.run(["yt-dlp", "-q", "-f", fmt, "-o", path, "--force-overwrites", e["url"]], check=True, timeout=180)
        if os.path.getsize(path) <= 49_000_000: break
    else:
        sys.exit("файл больше 49 МБ даже в 480p")
    if a.blur: blur(path)
    text = tg.humanize(open(a.file).read().strip()) + tg.key_tag("clip-" + a.id)
    def f(t, m):
        with open(path, "rb") as fh:
            return tg.api("sendVideo", files={"video": fh}, chat_id=tg.CHAT, caption=t, parse_mode=m or "", supports_streaming="true", **dims(path))
    res = tg.send_html(f, text)
    s[a.id] = "posted"; save(s)
    print("ok: video message_id=%s https://t.me/%s/%s" % (res["message_id"], tg.CHAT.lstrip("@"), res["message_id"]))

def cmd_skip(a):
    s = seen()
    for i in a.ids: s[i] = "skipped"
    save(s)

ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="c", required=True)
p = sub.add_parser("list"); p.add_argument("--hours", type=float, default=3); p.add_argument("--min-views", type=int, default=0)
p = sub.add_parser("post"); p.add_argument("id"); p.add_argument("--file", required=True); p.add_argument("--blur", action="store_true")
p = sub.add_parser("skip"); p.add_argument("ids", nargs="+")
a = ap.parse_args(); {"list": cmd_list, "post": cmd_post, "skip": cmd_skip}[a.c](a)
