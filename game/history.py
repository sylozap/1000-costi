"""История сыгранных партий (data/games.jsonl) и аналитика по ней: профиль, соперники, рекорды чата."""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

log = logging.getLogger(__name__)

# критическое значение хи-квадрат для 5 степеней свободы при уровне значимости 0.05
CHI2_5_DOF_05 = 11.07


class History:
    def __init__(self, path: Path | None):
        self.path = path
        self.games: list[dict] = []
        if path and path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    self.games.append(json.loads(line))
                except json.JSONDecodeError:
                    log.warning("битая строка в %s пропущена", path)

    def add(self, rec: dict) -> None:
        self.games.append(rec)
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            log.warning("не удалось записать историю партий")

    def get(self, gid: str) -> dict | None:
        return next((g for g in self.games if g["id"] == gid), None)

    def of_user(self, uid: int) -> list[dict]:
        return [g for g in self.games if any(p["uid"] == uid for p in g["players"])]

    def of_chat(self, chat_id) -> list[dict]:
        return [g for g in self.games if g.get("chat") == chat_id]


def game_record(room, now: float | None = None) -> dict:
    """Запись о законченной партии для истории (room — game.rooms.Room)."""
    g = room.game
    now = now or time.time()
    return {
        "id": f"{room.id}-{int(now)}",
        "chat": room.chat_id,
        "t0": room.started_at or now,
        "t1": now,
        "map": room.map,
        "preset": room.preset_name(),
        "teams": g.teams,
        "winners": g.winners,
        "turns": g.turn_no,
        "players": [{
            "uid": p.uid, "name": p.name, "score": p.score, "team": p.side.team, "bot": p.uid < 0,
            "st": p.st, "an": p.an,
        } for p in g.players],
        "history": g.history[-400:],
        "winprob": room.winprob_hist[-400:],
    }


# ---------- расчёты ----------

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
    return max((max(h["scores"].values()) - h["scores"].get(w, 0) for h in g["history"] if h["scores"]), default=0)


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


def profile(history: History, uid: int, viewer: int | None = None) -> dict:
    """Профиль игрока по истории партий: итоги, удача и риск, честность кубиков, соперники, последние партии."""
    games = sorted(history.of_user(uid), key=lambda g: g["t1"])
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
        recent.append({"id": g["id"], "t": g["t1"], "won": won, "score": me["score"], "place": _place(g, uid),
                       "players": len(g["players"]), "map": g.get("map"), "teams": g["teams"]})
    risky_rate = _pct(agg["risky_rolls"], agg["risky_opps"])
    rival_list = sorted(rivals.values(), key=lambda r: -r["games"])
    nemesis = max((r for r in rival_list if r["losses"] > 0), key=lambda r: (r["losses"] - r["wins"], r["losses"]), default=None)
    victim = max((r for r in rival_list if r["hits"] > 0), key=lambda r: r["hits"], default=None)
    return {
        "uid": uid,
        "games": len(games), "wins": wins, "win_rate": _pct(wins, len(games)),
        "streak": streak, "best_streak": best_streak, "best_turn": best_turn,
        "samosvals": agg["samosvals"], "overtakes": agg["overtakes"],
        "luck": _pct(agg["pts"], exp),  # 100 — как в среднем по теории вероятностей
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
