#!/usr/bin/env python3
"""Быстрый автопостер без ИИ (GitHub Actions, каждые 5 минут).

  python3 auto.py --check   # печатает has_work=true|false (для GitHub Actions), ничего не публикует
  python3 auto.py --post    # публикует: результаты только что закончившихся матчей и опросы перед матчами

Повторы отсекаются по ленте канала (невидимые метки постов и текст вопросов опросов), поэтому окно с запасом.
"""
import datetime as dt, json, os, random, subprocess, sys
import bo3, tg

MSK = bo3.MSK
NOW = dt.datetime.now(dt.timezone.utc)
FINISHED_WINDOW = dt.timedelta(minutes=45)     # матч закончился не раньше, чем 45 мин назад
POLL_FROM, POLL_TO = dt.timedelta(minutes=60), dt.timedelta(minutes=150)  # опрос за 1–2.5 ч до начала
ROOT = os.path.dirname(os.path.abspath(__file__))
STAGES = {"final": "Финал", "grand final": "Гранд-финал", "semifinal": "Полуфинал", "semi-final": "Полуфинал",
          "quarterfinal": "Четвертьфинал", "quarter-final": "Четвертьфинал", "group": "Групповой этап",
          "playoff": "Плей-офф", "swiss": "Швейцарка", "stage": "Стадия"}
HYPE = ["🔥", "⚡", "💥", "😱", "🤯", "👀"]
QUESTIONS = ["Заслуженная победа? 🤔", "Кто был MVP по-вашему? 👇", "Ожидали такой результат? 👀", "Ваша оценка игры — в комменты 👇"]


def iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def tag(name):
    return "{{" + name + "}}"


def find_work():
    finished, upcoming = [], []
    today = NOW.astimezone(MSK).date()
    for d in (today - dt.timedelta(days=1), today):
        for m in bo3.day_list("finished", str(d), False):
            end = iso(m.get("end_utc"))
            if end and NOW - FINISHED_WINDOW <= end <= NOW:
                finished.append(m)
    for d in (today, today + dt.timedelta(days=1)):
        for m in bo3.day_list("upcoming", str(d), False):
            st = iso(m["start_utc"])
            if st and POLL_FROM <= st - NOW <= POLL_TO:
                upcoming.append(m)
    feed = tg.channel_html()
    finished = [m for m in finished if f"?k=match-{m['slug']}" not in feed]
    return finished, upcoming, feed


def ru_stage(info):
    s = (info.get("round") or info.get("stage") or "").lower()
    for k in sorted(STAGES, key=len, reverse=True):
        if k in s:
            return STAGES[k]
    return info.get("stage") or ""


def render(tpl, data, path):
    json.dump(data, open(path + ".json", "w"), ensure_ascii=False)
    subprocess.run(["node", os.path.join(ROOT, "render.js"), tpl, path + ".json", path], check=True, capture_output=True)


def post_result(m):
    out = os.path.join(ROOT, "out", m["slug"])
    import contextlib, io
    with contextlib.redirect_stdout(io.StringIO()):
        bo3.match(m["slug"], out)
    info = json.load(open(os.path.join(out, "match.json")))
    t1, t2 = info["team1"], info["team2"]
    w, l = (t1, t2) if t1["score"] > t2["score"] else (t2, t1)
    card = json.load(open(os.path.join(out, "card_match.json")))
    card["stage"] = ru_stage(info)
    render("match", card, os.path.join(out, "match.png"))
    imgs = [os.path.join(out, "match.png")]

    best = None
    for pm in info["per_map"]:
        for p in pm["players"]:
            if not best or p["rating"] > best[0]["rating"]:
                best = (p, pm["map"])
    mvp_line = ""
    if best:
        p, mp = best
        mvp_line = f"\n⭐ <b>{p['nick']}</b>: {p['k']}/{p['d']}, ADR {p['adr']} на {mp}"
        if p["rating"] >= 7.5 or p["k"] - p["d"] >= 10:
            render("player", json.load(open(os.path.join(out, "card_player.json"))), os.path.join(out, "player.png"))
            imgs.append(os.path.join(out, "player.png"))

    maps = " · ".join(f"{x['name']} {x['s1']}:{x['s2']}" for x in info["maps"])
    sweep = abs(t1["score"] - t2["score"]) >= 2
    head = (f"{random.choice(HYPE)} {tag(w['name'])} <b>{w['name']}</b> "
            f"{'без шансов для' if sweep else 'дожимают'} {tag(l['name'])} <b>{l['name']}</b> — {w['score']}:{l['score']}!")
    stage = ru_stage(info)
    text = (f"{head}\n🏆 {info['event']}{' · ' + stage if stage else ''}\n🗺 {maps}{mvp_line}\n\n{random.choice(QUESTIONS)}")
    path = os.path.join(out, "post.html")
    open(path, "w").write(text)
    cmd = ["python3", os.path.join(ROOT, "tg.py"), "album" if len(imgs) > 1 else "photo", *imgs,
           "--file", path, "--key", f"match-{m['slug']}"]
    print(subprocess.run(cmd, capture_output=True, text=True).stdout.strip() or f"skip {m['slug']}")


def post_poll(m, feed):
    info = bo3.get(f"v1/matches/{m['slug']}", **{"scope": "show-match", "with": "teams,tournament_deep"})
    t1, t2 = (info.get("team1") or {}).get("name"), (info.get("team2") or {}).get("name")
    if not t1 or not t2:
        return
    st = iso(m["start_utc"]).astimezone(MSK)
    q = f"{t1} vs {t2} в {st:%H:%M} МСК — кто победит?"
    if q[:60] in feed:
        return
    ev = (info.get("tournament") or {}).get("name", "")
    opts = [f"{tag(t1)} {t1}", f"{tag(t2)} {t2}"]
    if m.get("bo") == 3:
        opts = [f"{tag(t1)} {t1} 2:0", f"{tag(t1)} {t1} 2:1", f"{tag(t2)} {t2} 2:1", f"{tag(t2)} {t2} 2:0"]
    cmd = ["python3", os.path.join(ROOT, "tg.py"), "poll", "--question", q[:250] + (f" ({ev})" if ev and len(q) + len(ev) < 280 else "")]
    for o in opts:
        cmd += ["-o", o]
    cmd += ["--key", f"poll-{m['slug']}"]
    print(subprocess.run(cmd, capture_output=True, text=True).stdout.strip() or f"skip poll {m['slug']}")


def main():
    finished, upcoming, feed = find_work()
    if "--check" in sys.argv:
        has = bool(finished or upcoming)
        print(f"has_work={'true' if has else 'false'}")
        if os.environ.get("GITHUB_OUTPUT"):
            open(os.environ["GITHUB_OUTPUT"], "a").write(f"has_work={'true' if has else 'false'}\n")
        for m in finished:
            print("finished:", m["slug"], file=sys.stderr)
        for m in upcoming:
            print("upcoming:", m["slug"], file=sys.stderr)
        return
    for m in upcoming:
        post_poll(m, feed)
    for m in finished:
        post_result(m)


if __name__ == "__main__":
    main()
