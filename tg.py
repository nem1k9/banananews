#!/usr/bin/env python3
"""Публикация в Telegram-канал. Токен: TELEGRAM_BOT_TOKEN, канал: TELEGRAM_CHANNEL (по умолчанию @BananNewws).

  python3 tg.py check                                       # проверить токен и права в канале
  python3 tg.py seen <key> [--question "..."]               # печатает seen/new (смотрит ленту t.me/s/канала)
  python3 tg.py text  --file post.html --key K
  python3 tg.py photo card.png --file post.html --key K      # подпись до 1024 символов
  python3 tg.py album a.png b.png --file post.html --key K   # подпись к первому фото
  python3 tg.py poll --question "..." -o "A" -o "B" [--quiz 0 --explanation "..."] --key K
  python3 tg.py emoji "Falcons"                              # эмодзи команды для текста
  python3 tg.py pack <имя_пака>                               # ID кастомных эмодзи из пака t.me/addemoji/<имя>

Текст поста: HTML (<b>, <i>, <a href>, <blockquote>, <tg-spoiler>). Метка {{Falcons}} заменяется на эмодзи команды.
"""
import argparse, datetime as dt, html, json, os, re, sys
import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(ROOT, "state", "posted.json")
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT = os.environ.get("TELEGRAM_CHANNEL", "@BananNewws")
EMOJI = json.load(open(os.path.join(ROOT, "emoji.json")))
TEAM_EMOJI = False  # обычные эмодзи команд (🦅 ⚔️ …) выключены; кастомные (custom_id) работают всегда


def api(method, files=None, **data):
    if not TOKEN:
        sys.exit("нет TELEGRAM_BOT_TOKEN")
    r = requests.post(f"https://api.telegram.org/bot{TOKEN}/{method}", data=data, files=files, timeout=60)
    j = r.json()
    if not j.get("ok"):
        raise RuntimeError(f"{method}: {j.get('description')}")
    return j["result"]


def find_team(name):
    n = name.lower()
    for k, v in EMOJI.items():
        if k.startswith("_"):
            continue
        if n == k.lower() or n in [a.lower() for a in v.get("aliases", [])]:
            return v
    return None


def emojify(text, custom=True):
    def rep(m):
        t = find_team(m.group(1))
        if not t:
            return ""
        if custom and t.get("custom_id"):
            return f'<tg-emoji emoji-id="{t["custom_id"]}">{t["emoji"]}</tg-emoji>'
        return t["emoji"] if TEAM_EMOJI else ""
    out = re.sub(r"\{\{(.+?)\}\}", rep, text)
    return re.sub(r"(?m)^ +| {2,}", lambda m: "" if m.group(0).startswith(" ") and m.start() == 0 or m.group(0)[0] == " " and len(m.group(0)) == m.end() - m.start() and (m.start() == 0 or out[m.start() - 1] == "\n") else " ", out)


def strip_custom(text):
    return re.sub(r'<tg-emoji emoji-id="\d+">(.+?)</tg-emoji>', r"\1", text)


def send_html(fn, text):
    """Отправка с откатом: кастомные эмодзи -> обычные -> без HTML."""
    for variant, mode in ((emojify(text), "HTML"), (emojify(text, custom=False), "HTML"),
                          (re.sub(r"<[^>]+>", "", emojify(text, custom=False)), None)):
        try:
            return fn(variant, mode)
        except RuntimeError as e:
            print(f"warn: {e}", file=sys.stderr)
            last = e
    raise last


def channel_html():
    """Публичная лента канала (последние ~20 постов) — общая «память» всех запусков."""
    try:
        return requests.get(f"https://t.me/s/{CHAT.lstrip('@')}", headers={"User-Agent": "Mozilla/5.0"}, timeout=20).text
    except Exception:
        return ""


def key_tag(key):
    return f'<a href="https://t.me/{CHAT.lstrip("@")}?k={key}">\u200b</a>'


def already(key, question=None):
    if any(x["key"] == key for x in state()):
        return True
    h = channel_html()
    if f"?k={key}" in h:
        return True
    if question and html.escape(question[:60]) in h:
        return True
    return False


def state():
    try:
        return json.load(open(STATE))
    except Exception:
        return []


# эмодзи, которые Telegram разрешает ставить реакцией (стандартный набор)
REACTIONS = ["👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌",
             "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐",
             "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍",
             "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾",
             "🤷‍♂", "🤷", "🤷‍♀", "😡"]
ALIASES = {"❤️": "❤", "🤍": "❤", "💀": "😭", "✍️": "✍", "☃️": "☃", "🕊️": "🕊"}


def reaction_from(text):
    """Эмодзи из концовки вида «👍 — если …» (последняя строка с « — »)."""
    plain = re.sub(r"<[^>]+>", "", text)
    lines = plain.strip().splitlines()
    opts = []
    for line in reversed(lines):  # блок «эмодзи — если …» в конце поста
        m = re.match(r"\s*(\S+)\s+[—-]\s", line)
        if not m:
            break
        opts.insert(0, m.group(1))
    for e in opts:  # бот может поставить одну реакцию — первую подходящую
        e = ALIASES.get(e, e).replace("\ufe0f", "")
        if e in REACTIONS:
            return e
    return None


def react(msg, emoji):
    try:
        api("setMessageReaction", chat_id=CHAT, message_id=msg["message_id"],
            reaction=json.dumps([{"type": "emoji", "emoji": emoji}]))
        print(f"reaction {emoji}")
    except Exception as e:
        print(f"warn: реакция не поставилась: {e}", file=sys.stderr)


def remember(key, kind, text, res):
    s = state()
    msg = res[0] if isinstance(res, list) else res
    s.append({"key": key, "type": kind, "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
              "message_id": msg.get("message_id"), "text": re.sub(r"<[^>]+>", "", text)[:200]})
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(s[-300:], open(STATE, "w"), ensure_ascii=False, indent=1)
    print(f"ok: {kind} message_id={msg.get('message_id')} https://t.me/{CHAT.lstrip('@')}/{msg.get('message_id')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["check", "seen", "text", "photo", "album", "poll", "emoji", "pack"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--file"); ap.add_argument("--key")
    ap.add_argument("--question"); ap.add_argument("-o", "--option", action="append", default=[])
    ap.add_argument("--quiz", type=int); ap.add_argument("--explanation", default="")
    ap.add_argument("--public-votes", action="store_true")
    a = ap.parse_args()

    if a.cmd == "emoji":
        t = find_team(" ".join(a.args)); print(t["emoji"] if t else "🎮"); return
    if a.cmd == "pack":  # список кастомных эмодзи пака: t.me/addemoji/<имя>
        for st in api("getStickerSet", name=a.args[0])["stickers"]:
            print(st.get("custom_emoji_id"), st.get("emoji"))
        return
    if a.cmd == "seen":
        hit = already(a.args[0], a.question)
        print("seen" if hit else "new"); sys.exit(0 if hit else 1)
    if a.cmd == "check":
        me = api("getMe"); ch = api("getChat", chat_id=CHAT)
        mem = api("getChatMember", chat_id=CHAT, user_id=me["id"])
        print(f'бот @{me["username"]}, канал {ch.get("title")}, статус {mem["status"]}, может постить: {mem.get("can_post_messages")}')
        return
    if a.key and already(a.key, a.question if a.cmd == "poll" else None):
        sys.exit(f"skip: ключ {a.key} уже публиковался")
    text = open(a.file).read().strip() if a.file else ""
    if a.key and a.cmd != "poll":
        text += key_tag(a.key)  # невидимая метка: по ней следующие запуски видят, что пост уже был

    if a.cmd == "text":
        res = send_html(lambda t, m: api("sendMessage", chat_id=CHAT, text=t, parse_mode=m or "",
                                         link_preview_options=json.dumps({"is_disabled": True})), text)
    elif a.cmd == "photo":
        def f(t, m):
            with open(a.args[0], "rb") as fh:
                return api("sendPhoto", files={"photo": fh}, chat_id=CHAT, caption=t, parse_mode=m or "")
        res = send_html(f, text)
    elif a.cmd == "album":
        def f(t, m):
            files = {f"p{i}": open(p, "rb") for i, p in enumerate(a.args)}
            media = [{"type": "photo", "media": f"attach://p{i}"} for i in range(len(a.args))]
            media[0].update({"caption": t, **({"parse_mode": m} if m else {})})
            return api("sendMediaGroup", files=files, chat_id=CHAT, media=json.dumps(media))
        res = send_html(f, text)
    elif a.cmd == "poll":
        q = emojify(a.question, custom=False)
        data = dict(chat_id=CHAT, question=q, options=json.dumps([{"text": emojify(o, custom=False)} for o in a.option]),
                    is_anonymous=str(not a.public_votes).lower())
        if a.quiz is not None:
            data.update(type="quiz", correct_option_id=a.quiz, explanation=a.explanation)
        res = api("sendPoll", **data); text = q
    remember(a.key or f"{a.cmd}-{dt.datetime.now().timestamp():.0f}", a.cmd, text, res)
    emoji = reaction_from(text) if a.cmd != "poll" else None
    if emoji:
        react(res[0] if isinstance(res, list) else res, emoji)


if __name__ == "__main__":
    main()
