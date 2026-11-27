"""Исключение, восстановление и удаление записей сыгранных партий."""
from __future__ import annotations

from typing import TYPE_CHECKING

from ..achievements import CAREER_IDS, career_ids
from .records import bank_shares

if TYPE_CHECKING:
    from ..profiles import Profiles
    from ..stats import Stats
    from .store import History


class GameArchive:
    def __init__(self, history: History, stats: Stats | None, profiles: Profiles):
        self.history = history
        self.stats = stats
        self.profiles = profiles

    def overview(self) -> list[dict]:
        titles = {g["chat"]: g["chat_title"] for g in self.history.games if g.get("chat_title")}
        res = []
        for g in sorted(self.history.games, key=lambda g: -g["t1"]):
            res.append({
                "id": g["id"], "t": g["t1"], "duration": round(g["t1"] - g["t0"]), "turns": g["turns"],
                "chat": g.get("chat"), "chat_title": titles.get(g.get("chat")), "teams": bool(g["teams"]),
                "off": bool(g.get("off")), "rigged": bool(g.get("rigged")),
                "bank": sum(g.get("stakes", {}).values()),
                "ach": sum(len(v) for v in g.get("ach", {}).values()),
                "players": [{"uid": p["uid"], "name": p["name"], "score": p["score"], "bot": p["bot"],
                             "won": p["uid"] in g["winners"], "best_turn": p["st"].get("best_turn", 0)}
                            for p in sorted(g["players"], key=lambda p: (p["uid"] not in g["winners"], -p["score"]))],
            })
        return res

    def exclude(self, gid: str) -> str:
        """Партия перестаёт учитываться: счётчики чата, лучший ход, ачивки этой партии и банк откатываются.
        Всё, что изменили, сохраняется в записи (undo), чтобы партию можно было вернуть."""
        g = self.history.get(gid, include_off=True)
        if g is None:
            raise ValueError("партия не найдена")
        if g.get("off"):
            raise ValueError("партия уже не учитывается")
        g["off"] = True  # дальше history.of_user/of_chat её уже не видят
        undo: dict = {"best": {}, "ach": {}, "chips": {}}
        humans = [p for p in g["players"] if not p["bot"]]
        chat = g.get("chat")
        if self.stats:
            if chat is not None:
                self.stats.adjust_game(chat, humans, g["winners"], -1)
                for p in humans:
                    row = self.stats.row(chat, p["uid"])
                    if row and p["st"].get("best_turn", 0) >= row["best_turn"]:
                        undo["best"][str(p["uid"])] = row["best_turn"]
                        rest = (q["st"].get("best_turn", 0) for x in self.history.of_chat(chat)
                                for q in x["players"] if q["uid"] == p["uid"])
                        self.stats.set_best_turn(chat, p["uid"], max(rest, default=0))
            for p in humans:
                changed = self._revoke_achievements(g, p["uid"])
                if changed:
                    undo["ach"][str(p["uid"])] = changed
        prof = self.profiles
        stakes = {int(u): v for u, v in g.get("stakes", {}).items()}
        delta = {u: v for u, v in stakes.items()}  # взносы возвращаем…
        for u, share in bank_shares(stakes, g["winners"]).items():  # …а выигрыш забираем
            delta[u] = delta.get(u, 0) - share
        for u, d in delta.items():
            if d:
                before = prof.chips(u)
                undo["chips"][str(u)] = prof.add_chips(u, d) - before  # фишек не бывает меньше нуля
        g["undo"] = undo
        self.history.save()
        return "Партия больше не учитывается"

    def _revoke_achievements(self, g: dict, uid: int) -> dict[str, float]:
        """Ачивки игрока, полученные в партии g: переносятся на другую учитываемую партию, где они тоже выпали,
        иначе забираются. Карьерные — забираются, если порог больше не выполнен. Возвращает {aid: старое время}."""
        mine = self.stats.achievements(uid)
        career = career_ids(self.stats.user_total(uid) or {})
        changed = {}
        for aid, ts in list(mine.items()):
            if aid in CAREER_IDS:
                if aid not in career:
                    changed[aid] = ts
                    self.stats.set_unlock(uid, aid, None)
                continue
            # итоговые ачивки выдаются через мгновение после записи партии — отсюда запас после t1
            if not g["t0"] - 1 <= ts <= g["t1"] + 60:
                continue
            changed[aid] = ts
            other = min((x["t1"] for x in self.history.of_user(uid) if aid in x.get("ach", {}).get(str(uid), [])),
                        default=None)
            self.stats.set_unlock(uid, aid, other)
        return changed

    def restore(self, gid: str) -> str:
        g = self.history.get(gid, include_off=True)
        if g is None:
            raise ValueError("партия не найдена")
        if not g.get("off"):
            raise ValueError("партия и так учитывается")
        undo = g.pop("undo", {})
        g.pop("off")
        humans = [p for p in g["players"] if not p["bot"]]
        chat = g.get("chat")
        if self.stats:
            if chat is not None:
                self.stats.adjust_game(chat, humans, g["winners"], 1)
                for p in humans:
                    row = self.stats.row(chat, p["uid"])
                    best = max(row["best_turn"], p["st"].get("best_turn", 0), undo["best"].get(str(p["uid"]), 0))
                    self.stats.set_best_turn(chat, p["uid"], best)
            for u, changed in undo.get("ach", {}).items():
                mine = self.stats.achievements(int(u))
                for aid, ts in changed.items():
                    self.stats.set_unlock(int(u), aid, min(ts, mine.get(aid, ts)))
        for u, d in undo.get("chips", {}).items():
            self.profiles.add_chips(int(u), -d)
        self.history.save()
        return "Партия снова учитывается"

    def purge(self, gid: str) -> str:
        g = self.history.get(gid, include_off=True)
        if g is None:
            raise ValueError("партия не найдена")
        if not g.get("off"):
            raise ValueError("сначала отметь партию как неучитываемую")
        self.history.remove(gid)
        return "Партия удалена навсегда"
