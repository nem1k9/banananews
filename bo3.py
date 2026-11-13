#!/usr/bin/env python3
"""Данные о матчах CS2 с bo3.gg.

  python3 bo3.py results [--date YYYY-MM-DD] [--all-tiers]   # завершённые матчи (по умолчанию: сегодня и вчера, тир S/A)
  python3 bo3.py upcoming [--date YYYY-MM-DD] [--all-tiers]  # предстоящие матчи
  python3 bo3.py match <slug> --out <dir>                     # всё по матчу + готовые JSON для карточек
"""
import argparse, datetime as dt, io, json, os, sys
import requests

API = "https://api.bo3.gg/api"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"}
MSK = dt.timezone(dt.timedelta(hours=3))
TOP_TIERS = {"s", "a"}
MAPS = {"de_dust2": "Dust2", "de_mirage": "Mirage", "de_inferno": "Inferno", "de_nuke": "Nuke", "de_ancient": "Ancient",
        "de_anubis": "Anubis", "de_vertigo": "Vertigo", "de_overpass": "Overpass", "de_train": "Train", "de_cache": "Cache"}


def get(path, **params):
    r = requests.get(f"{API}/{path}", params=params, headers=UA, timeout=30)
    r.raise_for_status()
    return r.json()


def day_list(kind, date, all_tiers):
    d = get(f"v2/matches/{kind}", date=date, utc_offset=10800, **{"filter[discipline_id][eq]": 1})["data"]
    out = []
    for tier in d.get("tiers", {}).values():
        for m in tier["matches"]:
            if not all_tiers and m.get("tier") not in TOP_TIERS:
                continue
            out.append({"slug": m["slug"], "tier": m["tier"], "start_utc": m["start_date"], "end_utc": m.get("end_date"),
                        "score": f'{m.get("team1_score")}:{m.get("team2_score")}', "bo": m.get("bo_type")})
    return out


def download(url, out_dir, name):
    """Скачивает картинку и сохраняет PNG (Chromium плохо дружит с прокси, поэтому всё локально)."""
    if not url:
        return None
    from PIL import Image
    path = os.path.join(out_dir, name + ".png")
    try:
        r = requests.get(url, headers=UA, timeout=30)
        r.raise_for_status()
        Image.open(io.BytesIO(r.content)).save(path)
        return os.path.abspath(path)
    except Exception as e:  # noqa
        print(f"warn: не скачал {url}: {e}", file=sys.stderr)
        return None


def match(slug, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    m = get(f"v1/matches/{slug}", **{"scope": "show-match", "prefer_locale": "ru", "with": "games,teams,tournament_deep,stage"})
    t1, t2 = m["team1"] or {}, m["team2"] or {}
    logo1 = download(t1.get("image_url"), out_dir, "team1")
    logo2 = download(t2.get("image_url"), out_dir, "team2")
    event = (m.get("tournament") or {}).get("name", "")
    games = sorted([g for g in m.get("games", []) if g.get("status") == "finished"], key=lambda g: g["number"])

    maps, per_map = [], []
    for g in games:
        w_is_1 = (g.get("winner_team_clan") or {}).get("team", {}).get("id") == t1.get("id")
        s1, s2 = (g["winner_clan_score"], g["loser_clan_score"]) if w_is_1 else (g["loser_clan_score"], g["winner_clan_score"])
        name = MAPS.get(g["map_name"], g["map_name"].replace("de_", "").title())
        maps.append({"name": name, "s1": s1, "s2": s2})
        try:
            ps = get(f"v1/games/{g['id']}/players_stats")
        except Exception:
            ps = []
        rows = []
        for p in ps:
            sp = p.get("steam_profile") or {}
            pl = sp.get("player") or {}
            rows.append({"nick": sp.get("nickname") or pl.get("nickname"), "team": p.get("clan_name"),
                         "team_id": (p.get("team_clan") or {}).get("team_id"),
                         "k": p["kills"], "d": p["death"], "a": p["assists"], "adr": round(p["adr"] or 0, 1),
                         "kast": round((p.get("kast") or 0) * 100), "hs": p.get("headshots"),
                         "rating": round(p.get("player_rating") or 0, 2), "multikills": p.get("multikills"),
                         "clutches": p.get("clutches"), "photo_url": pl.get("image_url")})
        rows.sort(key=lambda r: -r["rating"])
        per_map.append({"map": name, "score": f"{s1}:{s2}", "players": rows})

    info = {"slug": slug, "event": event, "stage": (m.get("stage") or {}).get("title"),
            "round": (m.get("round") or {}).get("name") if isinstance(m.get("round"), dict) else None,
            "bo": m.get("bo_type"), "status": m.get("status"), "tier": m.get("tier"),
            "team1": {"name": t1.get("name"), "score": m.get("team1_score"), "logo": logo1},
            "team2": {"name": t2.get("name"), "score": m.get("team2_score"), "logo": logo2},
            "maps": maps, "per_map": per_map, "url": f"https://bo3.gg/matches/{slug}"}

    # готовая карточка результата (stage можно перезаписать на русском: «Четвертьфинал»)
    card = {k: info[k] for k in ("event", "bo", "team1", "team2", "maps")}
    card["stage"] = info["stage"] or ""
    json.dump(card, open(os.path.join(out_dir, "card_match.json"), "w"), ensure_ascii=False, indent=1)

    # карточка лучшего игрока матча (MVP по сумме рейтингов) и лучшего на каждой карте
    if per_map and per_map[0]["players"]:
        best_map = max(per_map, key=lambda pm: pm["players"][0]["rating"] if pm["players"] else 0)
        p = best_map["players"][0]
        tid = p["team_id"]
        opp = t2 if tid == t1.get("id") else t1
        pcard = {"event": event, "player": {"nick": p["nick"], "photo": download(p["photo_url"], out_dir, "player_best"),
                                            "teamLogo": logo1 if tid == t1.get("id") else logo2},
                 "subtitle": f'vs {opp.get("name")} · {best_map["map"]}',
                 "stats": [{"label": "K-D", "value": f'{p["k"]}/{p["d"]}'}, {"label": "ADR", "value": str(p["adr"])},
                           {"label": "KAST", "value": f'{p["kast"]}%'}, {"label": "Рейтинг bo3", "value": str(p["rating"])}]}
        json.dump(pcard, open(os.path.join(out_dir, "card_player.json"), "w"), ensure_ascii=False, indent=1)

    json.dump(info, open(os.path.join(out_dir, "match.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in info.items() if k != "per_map"}, ensure_ascii=False, indent=1))
    for pm in per_map:
        print(f'\n{pm["map"]} {pm["score"]}')
        for r in pm["players"]:
            print(f'  {r["team"]:<12} {r["nick"]:<14} {r["k"]}-{r["d"]} ADR {r["adr"]} KAST {r["kast"]}% R {r["rating"]}')
    print(f"\nкарточки: {out_dir}/card_match.json, {out_dir}/card_player.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["results", "upcoming", "match"])
    ap.add_argument("slug", nargs="?")
    ap.add_argument("--date")
    ap.add_argument("--all-tiers", action="store_true")
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    if a.cmd == "match":
        match(a.slug, a.out)
    else:
        today = dt.datetime.now(MSK).date()
        dates = [a.date] if a.date else ([str(today - dt.timedelta(days=1)), str(today)] if a.cmd == "results"
                                         else [str(today), str(today + dt.timedelta(days=1))])
        for d in dates:
            print(f"== {d}")
            for m in day_list("finished" if a.cmd == "results" else "upcoming", d, a.all_tiers):
                print(json.dumps(m, ensure_ascii=False))
