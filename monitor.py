#!/usr/bin/env python3
"""Мониторинг источников без хранения состояния: смотрит, что появилось с прошлого запуска по расписанию.

  python3 monitor.py              # JSON с новым или строка NOTHING_NEW
  python3 monitor.py --hours 6    # окно вручную (например, для первого/пробного запуска)

Расписание (МСК, минута :23) задано в SLOTS; окно = от прошлого слота до сейчас.
Разделы ответа:
  news      — материалы о CS2, опубликованные в окне
  finished  — матчи S/A-тира, закончившиеся в окне (пост с результатом)
  upcoming  — матчи S/A-тира, до начала которых ~1.5–2.5 часа (опрос «кто победит?»)
Повторы дополнительно отсекаются по ленте канала: `python3 tg.py seen <key>`.
"""
import datetime as dt, email.utils, html, json, re, sys, xml.etree.ElementTree as ET
import requests
import bo3

UA = bo3.UA
MSK = bo3.MSK
NOW = dt.datetime.now(dt.timezone.utc)
SLOT_MINUTE = 23
SLOT_HOURS = [0, 1, 2] + list(range(9, 24))  # должно совпадать с расписанием задачи
POLL_LEAD = dt.timedelta(minutes=90)          # опрос минимум за 1.5 часа до матча
POLL_MAX_LEAD = dt.timedelta(hours=8)

GNEWS = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q="
FEEDS = [
    ("cybersport.ru", "https://www.cybersport.ru/rss/materials", lambda it: "/tags/cs2/" in it["link"]),
    ("dust2.us", "https://www.dust2.us/rss", None),
    ("HLTV", GNEWS + "site:hltv.org+when:1d",
     lambda it: not re.search(r"Player Profile|The home of competitive|Prediction| vs\. .+ at ", it["title"])),
    ("Steam (Valve)", "https://store.steampowered.com/feeds/news/app/730/?l=russian", None),
]


def slots_around(now):
    """Времена запусков (UTC) за ±2 суток."""
    out = []
    base = now.astimezone(MSK).replace(minute=SLOT_MINUTE, second=0, microsecond=0)
    for day in range(-2, 3):
        for h in SLOT_HOURS:
            out.append((base + dt.timedelta(days=day)).replace(hour=h).astimezone(dt.timezone.utc))
    return sorted(out)


def window(hours=None):
    if hours:
        return NOW - dt.timedelta(hours=hours), NOW + dt.timedelta(hours=1)
    s = slots_around(NOW)
    cur = max(t for t in s if t <= NOW + dt.timedelta(minutes=10))  # текущий запуск (с запасом на задержку)
    prev = max(t for t in s if t < cur)
    nxt = min(t for t in s if t > cur)
    return prev, nxt


def parse_date(s):
    try:
        d = email.utils.parsedate_to_datetime(s)
        return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
    except Exception:
        return None


def iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def rss(source, url, keep, start):
    out = []
    try:
        root = ET.fromstring(requests.get(url, headers=UA, timeout=25).content)
    except Exception as e:
        print(f"warn: {source}: {e}", file=sys.stderr)
        return out
    for it in root.findall(".//item"):
        d = parse_date(it.findtext("pubDate") or "")
        if not d or d <= start or d > NOW + dt.timedelta(minutes=5):
            continue
        enc = it.find("enclosure")
        item = {"source": source, "title": html.unescape(it.findtext("title") or "").strip(),
                "link": it.findtext("link") or "", "date_msk": d.astimezone(MSK).strftime("%H:%M"),
                "image": enc.attrib.get("url") if enc is not None else None,
                "summary": re.sub(r"<[^>]+>", "", html.unescape(it.findtext("description") or ""))[:300]}
        if keep and not keep(item):
            continue
        out.append(item)
    return out


def main():
    hours = None
    if "--hours" in sys.argv:
        hours = float(sys.argv[sys.argv.index("--hours") + 1])
    start, nxt = window(hours)

    news = []
    for src, url, keep in FEEDS:
        news += rss(src, url, keep, start)

    finished, upcoming = [], []
    today = NOW.astimezone(MSK).date()
    for d in (today - dt.timedelta(days=1), today):
        try:
            for m in bo3.day_list("finished", str(d), False):
                end = iso(m.get("end_utc"))
                if end and start < end <= NOW:
                    finished.append(m)
        except Exception as e:
            print(f"warn: bo3 finished: {e}", file=sys.stderr)
    # опрос делает тот запуск, после которого до матча останется меньше POLL_LEAD
    lo, hi = (NOW, NOW + dt.timedelta(hours=3)) if hours else (NOW + POLL_LEAD, nxt + POLL_LEAD)
    for d in (today, today + dt.timedelta(days=1)):
        try:
            for m in bo3.day_list("upcoming", str(d), False):
                st = iso(m["start_utc"])
                if st and lo < st <= hi and st - NOW <= POLL_MAX_LEAD:
                    m["starts_msk"] = st.astimezone(MSK).strftime("%d.%m %H:%M")
                    m["starts_in_min"] = int((st - NOW).total_seconds() // 60)
                    upcoming.append(m)
        except Exception as e:
            print(f"warn: bo3 upcoming: {e}", file=sys.stderr)

    if not (news or finished or upcoming):
        print(f"NOTHING_NEW (окно с {start.astimezone(MSK):%H:%M} МСК)")
        return
    print(json.dumps({"now_msk": NOW.astimezone(MSK).strftime("%Y-%m-%d %H:%M"),
                      "window_from_msk": start.astimezone(MSK).strftime("%Y-%m-%d %H:%M"),
                      "news": news, "finished": finished, "upcoming": upcoming}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
