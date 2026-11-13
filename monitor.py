#!/usr/bin/env python3
"""Мониторинг источников: что нового с прошлой проверки.

  python3 monitor.py            # печатает JSON с новым; если нечего делать — строку NOTHING_NEW
  python3 monitor.py --dry      # то же, но не помечает новости как просмотренные

Разделы ответа:
  news      — новые материалы о CS2 (заголовок, ссылка, источник, фото). Помечаются просмотренными сразу.
  finished  — завершённые матчи S/A-тира, по которым ещё не было поста (ключ match-<slug>).
  upcoming  — матчи S/A-тира, которые начнутся через 1–3 часа и по которым не было опроса (ключ poll-<slug>).
"""
import datetime as dt, email.utils, html, json, os, re, sys, xml.etree.ElementTree as ET
import requests
import bo3

ROOT = os.path.dirname(os.path.abspath(__file__))
SEEN = os.path.join(ROOT, "state", "seen.json")
POSTED = os.path.join(ROOT, "state", "posted.json")
UA = bo3.UA
NOW = dt.datetime.now(dt.timezone.utc)
MAX_AGE = dt.timedelta(hours=12)  # старше — не новость

GNEWS = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q="
FEEDS = [
    ("cybersport.ru", "https://www.cybersport.ru/rss/materials", lambda it: "/tags/cs2/" in it["link"]),
    ("dust2.us", "https://www.dust2.us/rss", None),
    ("HLTV", GNEWS + "site:hltv.org+when:1d", lambda it: not re.search(r"Player Profile|The home of competitive|Prediction| vs\. .+ at ", it["title"])),
    ("Steam (Valve)", "https://store.steampowered.com/feeds/news/app/730/?l=russian", None),
]


def load(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


def parse_date(s):
    try:
        d = email.utils.parsedate_to_datetime(s)
        return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
    except Exception:
        return NOW


def rss(source, url, keep):
    out = []
    try:
        root = ET.fromstring(requests.get(url, headers=UA, timeout=25).content)
    except Exception as e:
        print(f"warn: {source}: {e}", file=sys.stderr)
        return out
    for it in root.findall(".//item"):
        enc = it.find("enclosure")
        item = {"source": source, "title": html.unescape(it.findtext("title") or "").strip(),
                "link": it.findtext("link") or "", "id": it.findtext("guid") or it.findtext("link"),
                "date": parse_date(it.findtext("pubDate") or ""),
                "image": enc.attrib.get("url") if enc is not None else None,
                "summary": re.sub(r"<[^>]+>", "", html.unescape(it.findtext("description") or ""))[:300]}
        if NOW - item["date"] > MAX_AGE:
            continue
        if keep and not keep(item):
            continue
        out.append(item)
    return out


def sports_ru():
    """cyber.sports.ru/cs/news — HTML без RSS."""
    out = []
    try:
        t = requests.get("https://cyber.sports.ru/cs/news/", headers=UA, timeout=25).text
    except Exception as e:
        print(f"warn: sports.ru: {e}", file=sys.stderr)
        return out
    for href, title in re.findall(r'class="short-text" href="(/cs/\d+[^"]+)" title="([^"]+)"', t)[:15]:
        out.append({"source": "cyber.sports.ru", "title": html.unescape(title), "link": "https://cyber.sports.ru" + href,
                    "id": href, "date": NOW - dt.timedelta(hours=6), "image": None, "summary": ""})
    return out


def main():
    dry = "--dry" in sys.argv
    seen = load(SEEN, {})
    posted_keys = {p["key"] for p in load(POSTED, [])}
    first_run = not seen

    news = []
    for src, url, keep in FEEDS:
        news += rss(src, url, keep)
    news += sports_ru()
    fresh = [n for n in news if n["id"] not in seen]
    for n in fresh:
        seen[n["id"]] = NOW.isoformat(timespec="minutes")
    # первый запуск: только запоминаем, чтобы не вывалить в канал всё за 12 часов
    if first_run:
        fresh = sorted(fresh, key=lambda n: n["date"], reverse=True)[:5]

    finished, upcoming = [], []
    today = NOW.astimezone(bo3.MSK).date()
    for d in (today - dt.timedelta(days=1), today):
        try:
            for m in bo3.day_list("finished", str(d), False):
                if f"match-{m['slug']}" not in posted_keys:
                    end_age = NOW - dt.datetime.fromisoformat(m["start_utc"].replace("Z", "+00:00"))
                    if end_age < dt.timedelta(hours=10):
                        finished.append(m)
        except Exception as e:
            print(f"warn: bo3 finished: {e}", file=sys.stderr)
    for d in (today, today + dt.timedelta(days=1)):
        try:
            for m in bo3.day_list("upcoming", str(d), False):
                start = dt.datetime.fromisoformat(m["start_utc"].replace("Z", "+00:00"))
                if dt.timedelta(minutes=50) <= start - NOW <= dt.timedelta(hours=3) and f"poll-{m['slug']}" not in posted_keys:
                    m["starts_in_min"] = int((start - NOW).total_seconds() // 60)
                    upcoming.append(m)
        except Exception as e:
            print(f"warn: bo3 upcoming: {e}", file=sys.stderr)

    if not dry:
        cutoff = (NOW - dt.timedelta(days=4)).isoformat()
        seen = {k: v for k, v in seen.items() if v >= cutoff}
        os.makedirs(os.path.dirname(SEEN), exist_ok=True)
        json.dump(seen, open(SEEN, "w"), ensure_ascii=False, indent=0)

    if not (fresh or finished or upcoming):
        print("NOTHING_NEW")
        return
    for n in fresh:
        n["date"] = n["date"].isoformat(timespec="minutes")
    print(json.dumps({"now_msk": NOW.astimezone(bo3.MSK).strftime("%Y-%m-%d %H:%M"), "first_run": first_run,
                      "news": fresh, "finished": finished, "upcoming": upcoming}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
