#!/usr/bin/env python3
"""Быстрый автопостер без ИИ (GitHub Actions): live-счёт по картам, результат сразу после матча, опросы перед матчем.

  python3 auto.py --check          # has_work=true|false: идёт/закончился/скоро начнётся известный матч
  python3 auto.py --post           # один проход
  python3 auto.py --loop 19800     # проходы каждые 20 с, пока идут известные матчи (+15 мин), но не дольше N секунд

Только матчи с популярными командами из teams.json (топ-сцена + известные СНГ тир-2).
Повторы отсекаются по ленте канала (невидимые метки постов и текст вопросов опросов).
"""
import contextlib, datetime as dt, io, json, os, random, subprocess, sys, time
import bo3, tg

MSK = bo3.MSK
FINISHED_WINDOW = dt.timedelta(minutes=45)
POLL_FROM, POLL_TO = dt.timedelta(minutes=60), dt.timedelta(minutes=150)  # опрос за 1–2.5 ч до начала
TOP_RANK = 30
STEP = 20
TAIL = 15 * 60   # после конца последнего live-матча ещё 15 мин держим проверку (результат, следующий матч)
ROOT = os.path.dirname(os.path.abspath(__file__))
STAGES = {"grand final": "Гранд-финал", "final": "Финал", "semifinal": "Полуфинал", "semi-final": "Полуфинал",
          "quarterfinal": "Четвертьфинал", "quarter-final": "Четвертьфинал", "group": "Групповой этап",
          "playoff": "Плей-офф", "swiss": "Швейцарская система"}
NICK = {"Vitality": "Пчёлы", "Falcons": "Соколы", "Spirit": "Драконы", "MOUZ": "Мыши", "FURIA": "Пантеры",
        "Natus Vincere": "NAVI", "Virtus.pro": "Медведи", "The MongolZ": "Монголы"}
_rank_cache, _done = {}, set()


def now():
    return dt.datetime.now(dt.timezone.utc)


def iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def tag(name):
    return "{{" + name + "}}"


def details(slug):
    return bo3.get(f"v1/matches/{slug}", **{"scope": "show-match", "with": "games,teams,tournament_deep,stage"})


_T = json.load(open(os.path.join(ROOT, "teams.json")))
POPULAR = {n.lower() for k in ("tier1", "cis_tier2") for n in _T[k]}


def popular(name):
    n = (name or "").lower().strip()
    return n in POPULAR or any(n == p or n.startswith(p + " ") for p in POPULAR)


def notable(m):
    """Постим только матчи, где играет популярная команда (teams.json) и турнир не тир-3."""
    if m.get("tier") not in ("s", "a", "b"):
        return False
    if m["slug"] not in _rank_cache:
        try:
            d = details(m["slug"])
            _rank_cache[m["slug"]] = any(popular((d.get(t) or {}).get("name")) for t in ("team1", "team2"))
        except Exception:
            _rank_cache[m["slug"]] = False
    return _rank_cache[m["slug"]]


def ru_stage(info):
    s = " ".join(x for x in [(info.get("round") or {}).get("name") if isinstance(info.get("round"), dict) else info.get("round"),
                             (info.get("stage") or {}).get("title") if isinstance(info.get("stage"), dict) else info.get("stage")] if x).lower()
    for k in sorted(STAGES, key=len, reverse=True):
        if k in s:
            return STAGES[k]
    return ""


def send(kind, args, text, key):
    path = os.path.join(ROOT, "out", key + ".html")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write(text)
    r = subprocess.run(["python3", os.path.join(ROOT, "tg.py"), kind, *args, "--file", path, "--key", key],
                       capture_output=True, text=True, env={**os.environ, "TG_NO_TOPIC_CHECK": "1"})
    _done.add(key)
    print((r.stdout.strip() or r.stderr.strip())[:200])


def render(tpl, data, path):
    json.dump(data, open(path + ".json", "w"), ensure_ascii=False)
    subprocess.run(["node", os.path.join(ROOT, "render.js"), tpl, path + ".json", path], check=True, capture_output=True)


# ---------- live: пост после каждой сыгранной карты (кроме последней — там будет результат) ----------
def map_posts(m, feed):
    d = details(m["slug"])
    t1, t2 = d.get("team1") or {}, d.get("team2") or {}
    games = sorted([g for g in d.get("games", []) if g.get("status") == "finished"], key=lambda g: g["number"])
    s1 = s2 = 0
    for g in games:
        w1 = (g.get("winner_team_clan") or {}).get("team", {}).get("id") == t1.get("id")
        s1, s2 = s1 + w1, s2 + (not w1)
        key = f"map-{m['slug']}-{g['number']}"
        need = (m.get("bo") or 1) // 2 + 1
        if key in _done or f"?k={key}" in feed or max(s1, s2) >= need:
            continue  # последняя карта → вместо неё пост с результатом матча
        W, L = (t1, t2) if w1 else (t2, t1)
        mp = bo3.MAPS.get(g["map_name"], g["map_name"].replace("de_", "").title())
        lead = f"⚡ {tag(W['name'])} <b>{W['name']}</b> забирают {mp} {g['winner_clan_score']}:{g['loser_clan_score']}"
        score = f"{t1.get('name')} {s1}:{s2} {t2.get('name')}"
        wn, ln = NICK.get(W['name'], W['name']), NICK.get(L['name'], L['name'])
        end = (f"🔥 {wn} закроют серию\n👀 {ln} утащат решающую" if (s1 if w1 else s2) > (s2 if w1 else s1)
               else f"🔥 {wn} дожмут\n🤯 {ln} ответят")
        text = f"{lead}\n\n<blockquote>{score} · {(d.get('tournament') or {}).get('name', '')}</blockquote>\n\n{end}"
        try:
            img = map_card(m["slug"], d, t1, t2, games[:g["number"]] if g["number"] <= len(games) else games, s1, s2, g["number"])
            send("photo", [img], text, key)
        except Exception as e:  # картинка не получилась — пост всё равно выходит, без задержки
            print(f"warn: map card: {e}", file=sys.stderr)
            send("text", [], text, key)


def map_card(slug, d, t1, t2, played, s1, s2, n):
    out = os.path.join(ROOT, "out", slug)
    os.makedirs(out, exist_ok=True)
    logos = {}
    for i, t in ((1, t1), (2, t2)):
        f = os.path.join(out, f"team{i}.png")
        logos[i] = f if os.path.exists(f) else bo3.download(t.get("image_url"), out, f"team{i}")
    maps = []
    for g in played:
        w1 = (g.get("winner_team_clan") or {}).get("team", {}).get("id") == t1.get("id")
        a, b = (g["winner_clan_score"], g["loser_clan_score"]) if w1 else (g["loser_clan_score"], g["winner_clan_score"])
        maps.append({"name": bo3.MAPS.get(g["map_name"], g["map_name"].replace("de_", "").title()), "s1": a, "s2": b})
    card = {"event": (d.get("tournament") or {}).get("name", ""), "stage": f"После {n}-й карты", "bo": d.get("bo_type"),
            "kind": "Live", "team1": {"name": t1.get("name"), "logo": logos[1], "score": s1},
            "team2": {"name": t2.get("name"), "logo": logos[2], "score": s2}, "maps": maps}
    path = os.path.join(out, f"map{n}.png")
    render("match", card, path)
    return path


# ---------- результат матча ----------
def post_result(m):
    key = f"match-{m['slug']}"
    out = os.path.join(ROOT, "out", m["slug"])
    with contextlib.redirect_stdout(io.StringIO()):
        bo3.match(m["slug"], out)
    info = json.load(open(os.path.join(out, "match.json")))
    t1, t2 = info["team1"], info["team2"]
    if t1["score"] == t2["score"]:
        return
    w, l = (t1, t2) if t1["score"] > t2["score"] else (t2, t1)
    stage = next((v for k, v in sorted(STAGES.items(), key=lambda x: -len(x[0])) if k in f"{info.get('round') or ''} {info.get('stage') or ''}".lower()), "")
    card = json.load(open(os.path.join(out, "card_match.json")))
    card["stage"] = stage
    render("match", card, os.path.join(out, "match.png"))
    imgs = [os.path.join(out, "match.png")]
    best = None
    for pm in info["per_map"]:
        for p in pm["players"]:
            if not best or p["rating"] > best["rating"]:
                best = p
    if best and (best["rating"] >= 7.5 or best["k"] - best["d"] >= 10) and os.path.exists(os.path.join(out, "card_player.json")):
        render("player", json.load(open(os.path.join(out, "card_player.json"))), os.path.join(out, "player.png"))
        imgs.append(os.path.join(out, "player.png"))

    W, L, sc = w["name"], l["name"], f"{w['score']}:{l['score']}"
    nick = NICK.get(W, W)
    if stage in ("Финал", "Гранд-финал"):
        lead = f"🏆 {tag(W)} <b>{W}</b> чемпионы {info['event']}!"
        end = f"🏆 {nick} заслужили трофей\n🤔 Ждал другого чемпиона"
    elif abs(w["score"] - l["score"]) >= 2:
        lead = f"💀 {tag(W)} <b>{W}</b> не оставили шансов {tag(L)} <b>{L}</b> {sc}"
        end = f"🔥 {nick} берут турнир\n😭 {L} пора что-то менять"
    else:
        lead = f"🔥 {tag(W)} <b>{W}</b> дожали {tag(L)} <b>{L}</b> {sc}"
        end = f"🔥 {nick} берут турнир\n🤡 {L} просто не повезло"
    detail = f"{info['event']}{' · ' + stage if stage else ''}"
    if best:
        detail += f"\nMVP: {best['nick']}, {best['k']}/{best['d']}"
    send("album" if len(imgs) > 1 else "photo", imgs, f"{lead}\n\n<blockquote>{detail}</blockquote>\n\n{end}", key)


# ---------- опрос перед матчем ----------
def post_poll(m, feed):
    key = f"poll-{m['slug']}"
    _done.add(key)
    d = details(m["slug"])
    t1, t2 = (d.get("team1") or {}).get("name"), (d.get("team2") or {}).get("name")
    if not t1 or not t2:
        return
    st = iso(m["start_utc"]).astimezone(MSK)
    q = f"{t1} vs {t2}: кто победит? Старт в {st:%H:%M} МСК"
    if q[:40] in feed:
        return
    r = subprocess.run(["python3", os.path.join(ROOT, "tg.py"), "poll", "--question", q,
                        "-o", f"{tag(t1)} {t1}", "-o", f"{tag(t2)} {t2}", "--key", key], capture_output=True, text=True)
    print((r.stdout.strip() or r.stderr.strip())[:200])


def scan():
    t = now()
    finished, upcoming, live = [], [], []
    today = t.astimezone(MSK).date()
    for d in (today - dt.timedelta(days=1), today):
        for m in bo3.day_list("finished", str(d), True):
            end = iso(m.get("end_utc"))
            if end and t - FINISHED_WINDOW <= end <= t and notable(m):
                finished.append(m)
    for d in (today, today + dt.timedelta(days=1)):
        for m in bo3.day_list("upcoming", str(d), True):
            st = iso(m["start_utc"])
            if st and POLL_FROM <= st - t <= POLL_TO and notable(m):
                upcoming.append(m)
    try:
        live = [m for m in bo3.live_list() if notable(m)]
    except Exception as e:
        print(f"warn: live: {e}", file=sys.stderr)
    return finished, upcoming, live


def one_pass():
    finished, upcoming, live = scan()
    feed = tg.channel_html()
    for m in upcoming:
        if f"poll-{m['slug']}" not in _done:
            post_poll(m, feed)
    for m in live:
        try:
            map_posts(m, feed)
        except Exception as e:
            print(f"warn: map {m['slug']}: {e}", file=sys.stderr)
    for m in finished:
        if f"match-{m['slug']}" not in _done and f"?k=match-{m['slug']}" not in feed:
            try:
                post_result(m)
            except Exception as e:
                print(f"warn: result {m['slug']}: {e}", file=sys.stderr)
    return live


def main():
    if "--check" in sys.argv:
        finished, upcoming, live = scan()
        feed = tg.channel_html()
        finished = [m for m in finished if f"?k=match-{m['slug']}" not in feed]
        has = bool(finished or upcoming or live)
        print(f"has_work={'true' if has else 'false'} (live={len(live)}, finished={len(finished)}, polls={len(upcoming)})")
        if os.environ.get("GITHUB_OUTPUT"):
            open(os.environ["GITHUB_OUTPUT"], "a").write(f"has_work={'true' if has else 'false'}\n")
        return
    if "--loop" in sys.argv:
        # держим задачу живой, пока идут известные матчи: без зависимости от задержек расписания GitHub
        hard = time.time() + float(sys.argv[sys.argv.index("--loop") + 1])
        last_live = time.time()
        while time.time() + STEP < hard:
            try:
                live = one_pass()
            except Exception as e:
                print(f"warn: pass: {e}", file=sys.stderr)
                live = [1]
            if live:
                last_live = time.time()
            elif time.time() - last_live > TAIL:
                break
            time.sleep(STEP)
        return
    one_pass()


if __name__ == "__main__":
    main()
