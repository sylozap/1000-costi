"""Аналитика профилей и рекордов по истории партий."""
from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .store import History

# Критическое значение хи-квадрат для пяти степеней свободы при уровне значимости 0.05.
CHI2_5_DOF_05 = 11.07
LUCK_MIN_ROLLS = 30


def _pct(a: float, b: float) -> int | None:
    return round(100 * a / b) if b else None


def _place(g: dict, uid: int) -> int:
    """Место игрока: победители первые, дальше по счёту (напарники делят место)."""
    me = next(p for p in g["players"] if p["uid"] == uid)
    if uid in g["winners"]:
        return 1
    better = {p["score"] for p in g["players"] if p["score"] > me["score"] and p["uid"] not in g["winners"]}
    return 2 + len(better)


def _comeback(g: dict) -> int:
    """На сколько очков победитель отставал от лидера в худший момент партии."""
    if not g["winners"] or not g["history"]:
        return 0
    w = str(g["winners"][0])
    return max((max(h["scores"].values()) - h["scores"][w] for h in g["history"] if w in h["scores"]), default=0)


def honesty(faces: list[int]) -> dict:
    """Распределение граней и проверка равномерности (хи-квадрат)."""
    n = sum(faces)
    if not n:
        return {"faces": faces, "n": 0, "share": [0] * 6, "chi2": 0, "fair": None}
    e = n / 6
    chi2 = sum((o - e) ** 2 / e for o in faces)
    return {"faces": faces, "n": n, "share": [round(100 * o / n, 1) for o in faces], "chi2": round(chi2, 2),
            "fair": chi2 <= CHI2_5_DOF_05 if n >= 60 else None}


def _style(risky_rate: int | None) -> str | None:
    if risky_rate is None:
        return None
    if risky_rate < 25:
        return "осторожный"
    if risky_rate <= 60:
        return "сбалансированный"
    return "азартный"


def profile(history: History, uid: int, viewer: int | None = None,
            filters: dict | None = None, chat_id=None) -> dict:
    """Профиль игрока по истории партий: итоги, удача и риск, честность кубиков, соперники, последние партии."""
    games = sorted(history.of_user(uid), key=lambda g: g["t1"])
    presets = sorted({g.get("preset") for g in games if g.get("preset")})
    filters = filters if isinstance(filters, dict) else {}
    valid = {
        "period": ("all", "30", "90"), "chat": ("all", "current") if chat_id is not None else ("all",),
        "mode": ("all", "solo", "teams"), "opponents": ("all", "human", "bot"), "preset": ("", *presets),
    }
    selected = {k: filters[k] if filters.get(k) in options else options[0] for k, options in valid.items()}
    cutoff = time.time() - int(selected["period"]) * 86400 if selected["period"] != "all" else 0
    games = [g for g in games if (
        g["t1"] >= cutoff
        and (selected["chat"] == "all" or g.get("chat") == chat_id)
        and (selected["mode"] == "all" or g["teams"] == (selected["mode"] == "teams"))
        and (selected["opponents"] == "all" or any(p["bot"] for p in g["players"]) == (selected["opponents"] == "bot"))
        and (not selected["preset"] or g.get("preset") == selected["preset"])
    )]
    detail = {k: 0 for k in ("games", "turns", "successful", "recorded", "pit_attempts", "pit_exits",
                             "barrel_entries", "barrel_wins")}
    detail.update(burned={}, deductions={})
    agg = {k: 0 for k in ("turns", "rolls", "pts", "commits", "commit_pts", "burned", "burned_pts",
                          "risky_opps", "risky_rolls", "dec", "dec_good", "samosvals", "overtakes")}
    exp = 0.0
    faces = [0] * 6
    best_turn = 0
    wins = streak = best_streak = 0
    maps: dict[str, int] = {}
    rivals: dict[int, dict] = {}
    recent = []
    for g in games:
        me = next(p for p in g["players"] if p["uid"] == uid)
        a, st = me["an"], me["st"]
        for k in ("turns", "rolls", "pts", "commits", "commit_pts", "burned", "burned_pts",
                  "risky_opps", "risky_rolls", "dec", "dec_good"):
            agg[k] += a.get(k, 0)
        agg["samosvals"] += st.get("samosvals", 0)
        agg["overtakes"] += st.get("overtakes", 0)
        exp += a.get("exp", 0)
        faces = [x + y for x, y in zip(faces, a.get("faces", [0] * 6))]
        best_turn = max(best_turn, st.get("best_turn", 0))
        won = uid in g["winners"]
        wins += won
        streak = streak + 1 if won else 0
        best_streak = max(best_streak, streak)
        maps[g.get("map") or "felt"] = maps.get(g.get("map") or "felt", 0) + 1
        for q in g["players"]:
            if q["uid"] == uid or q["bot"] or (g["teams"] and q["team"] == me["team"]):
                continue
            r = rivals.setdefault(q["uid"], {"uid": q["uid"], "name": q["name"], "games": 0, "wins": 0, "losses": 0,
                                             "hits": 0, "hit_by": 0})
            r["name"] = q["name"]
            r["games"] += 1
            r["wins"] += int(won and q["uid"] not in g["winners"])
            r["losses"] += int(q["uid"] in g["winners"] and not won)
            r["hits"] += a.get("overtook", {}).get(str(q["uid"]), 0) + a.get("zeroed", {}).get(str(q["uid"]), 0)
            qa = q["an"]
            r["hit_by"] += qa.get("overtook", {}).get(str(uid), 0) + qa.get("zeroed", {}).get(str(uid), 0)
        d = a.get("detail")
        if d is not None:
            detail["games"] += 1
            for key in ("turns", "successful", "recorded", "pit_attempts", "pit_exits", "barrel_entries", "barrel_wins"):
                detail[key] += d[key]
            for key in ("burned", "deductions"):
                for reason, amount in d[key].items():
                    detail[key][reason] = detail[key].get(reason, 0) + amount
        recent.append({"form_turn": round(d["recorded"] / d["turns"], 1) if d and d["turns"] else None,
                       "form_success": _pct(d["successful"], d["turns"]) if d else None,
                       "id": g["id"], "t": g["t1"], "won": won, "score": me["score"], "place": _place(g, uid),
                       "players": len(g["players"]), "map": g.get("map"), "teams": g["teams"]})
    risky_rate = _pct(agg["risky_rolls"], agg["risky_opps"])
    rival_list = sorted(rivals.values(), key=lambda r: -r["games"])
    nemesis = max((r for r in rival_list if r["losses"] > 0), key=lambda r: (r["losses"] - r["wins"], r["losses"]), default=None)
    victim = max((r for r in rival_list if r["hits"] > 0), key=lambda r: r["hits"], default=None)
    return {
        "uid": uid,
        "filters": selected, "presets": presets, "chat_filter": chat_id is not None,
        "detail": detail, "rolls_n": agg["rolls"], "risky_n": agg["risky_opps"],
        "form": recent[-20:],
        "games": len(games), "wins": wins, "win_rate": _pct(wins, len(games)),
        "streak": streak, "best_streak": best_streak, "best_turn": best_turn,
        "samosvals": agg["samosvals"], "overtakes": agg["overtakes"],
        # 100 — как в среднем по теории вероятностей; на малой выборке индекс бессмыслен
        "luck": _pct(agg["pts"], exp) if agg["rolls"] >= LUCK_MIN_ROLLS else None,
        "avg_turn": round(agg["commit_pts"] / agg["commits"]) if agg["commits"] else None,
        "burned_rate": _pct(agg["burned"], agg["turns"]),
        "burned_pts": agg["burned_pts"],
        "risky_rate": risky_rate, "style": _style(risky_rate),
        "decisions": _pct(agg["dec_good"], agg["dec"]), "decisions_n": agg["dec"],
        "honesty": honesty(faces),
        "maps": sorted(maps.items(), key=lambda kv: -kv[1]),
        "rivals": rival_list[:8],
        "nemesis": nemesis, "victim": victim,
        "vs_viewer": rivals.get(viewer) if viewer is not None and viewer != uid else None,
        "recent": recent[::-1][:10],
    }


def chat_records(history: History, chat_id) -> dict:
    """Зал славы чата и последние партии."""
    games = sorted(history.of_chat(chat_id), key=lambda g: g["t1"])
    rec: dict[str, dict] = {}

    def best(key, value, who, g, better=lambda a, b: a > b, **extra):
        if value and (key not in rec or better(value, rec[key]["value"])):
            rec[key] = {"value": value, "name": who, "id": g["id"], "t": g["t1"], **extra}

    faces = [0] * 6
    for g in games:
        humans = [p for p in g["players"] if not p["bot"]]
        for p in humans:
            best("best_turn", p["st"].get("best_turn", 0), p["name"], g)
            best("samosvals", p["st"].get("samosvals", 0), p["name"], g)
            best("overtakes", p["st"].get("overtakes", 0), p["name"], g)
            faces = [x + y for x, y in zip(faces, p["an"].get("faces", [0] * 6))]
        winners = [p["name"] for p in g["players"] if p["uid"] in g["winners"]]
        if winners:
            who = " и ".join(winners)
            best("comeback", _comeback(g), who, g)
            best("fastest", g["turns"], who, g, better=lambda a, b: a < b)
            best("quickest", round(g["t1"] - g["t0"]), who, g, better=lambda a, b: a < b)
        best("longest", round(g["t1"] - g["t0"]), ", ".join(p["name"] for p in humans), g)
    recent = [{
        "id": g["id"], "t": g["t1"], "map": g.get("map"), "turns": g["turns"], "teams": g["teams"],
        "duration": round(g["t1"] - g["t0"]),
        "players": [{"name": p["name"], "score": p["score"], "won": p["uid"] in g["winners"], "team": p["team"]}
                    for p in sorted(g["players"], key=lambda p: (p["uid"] not in g["winners"], -p["score"]))],
    } for g in games[::-1][:20]]
    return {"records": rec, "recent": recent, "games": len(games), "honesty": honesty(faces)}
