"""Статистика игроков, ачивки и пресеты — JSON-файлы, переживают перезапуск."""
import json
import os
import secrets
import time
from pathlib import Path

FIELDS = ("games", "wins", "samosvals", "bolt_penalties", "barrel_falls", "overtakes", "best_turn")
RATING_MIN_GAMES = 3


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        path.replace(path.with_suffix(".broken.json"))
        return {}


def _save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


class Stats:
    def __init__(self, path: Path):
        self.path = path
        data = _load(path)
        if "chats" not in data:  # старый формат: {chat_id: {uid: row}}
            data = {"chats": data, "achievements": {}}
        data.setdefault("achievements", {})
        self.data = data

    def _save(self) -> None:
        _save(self.path, self.data)

    # ---------- партии ----------

    def record_game(self, chat_id, players: list, winner_uid: int | None) -> None:
        chat = self.data["chats"].setdefault(str(chat_id), {})
        for p in players:
            row = chat.setdefault(str(p.uid), {f: 0 for f in FIELDS})
            for f in FIELDS:
                row.setdefault(f, 0)
            row["name"] = p.name
            row["games"] += 1
            row["wins"] += int(p.uid == winner_uid)
            for f in ("samosvals", "bolt_penalties", "barrel_falls", "overtakes"):
                row[f] += p.st[f]
            row["best_turn"] = max(row["best_turn"], p.st["best_turn"])
        self._save()

    def chat_table(self, chat_id) -> list[dict]:
        """Игроки чата: сначала рейтинг по проценту побед (от 3 партий), затем остальные."""
        rows = [dict(r, uid=int(uid)) for uid, r in self.data["chats"].get(str(chat_id), {}).items()]
        for r in rows:
            r["rate"] = r["wins"] / r["games"] if r["games"] else 0.0
            r["rated"] = r["games"] >= RATING_MIN_GAMES
        rows.sort(key=lambda r: (not r["rated"], -r["rate"], -r["wins"], -r["games"]))
        return rows

    def user_total(self, uid: int) -> dict | None:
        total = {f: 0 for f in FIELDS}
        found = False
        for chat in self.data["chats"].values():
            row = chat.get(str(uid))
            if not row:
                continue
            found = True
            total["name"] = row.get("name", "")
            for f in FIELDS:
                if f == "best_turn":
                    total[f] = max(total[f], row.get(f, 0))
                else:
                    total[f] += row.get(f, 0)
        return total if found else None

    # ---------- ачивки ----------

    def achievements(self, uid: int) -> dict[str, float]:
        return self.data["achievements"].get(str(uid), {})

    def unlock(self, uid: int, aid: str) -> bool:
        """Выдаёт ачивку; True, если она новая."""
        mine = self.data["achievements"].setdefault(str(uid), {})
        if aid in mine:
            return False
        mine[aid] = time.time()
        self._save()
        return True


class Presets:
    """Сохранённые пресеты правил: общий каталог по коду + списки «мои» у игроков."""

    def __init__(self, path: Path):
        self.path = path
        data = _load(path)
        data.setdefault("presets", {})
        data.setdefault("saved", {})
        self.data = data

    def create(self, name: str, rules: dict, author: int) -> str:
        for pid, p in self.data["presets"].items():  # одинаковые правила от того же автора — тот же код
            if p["author"] == author and p["rules"] == rules and p["name"] == name:
                self.add_to(author, pid)
                return pid
        pid = secrets.token_hex(3).upper()
        while pid in self.data["presets"]:
            pid = secrets.token_hex(3).upper()
        self.data["presets"][pid] = {"name": name[:40], "rules": rules, "author": author, "created": time.time()}
        self.add_to(author, pid)
        _save(self.path, self.data)
        return pid

    def get(self, pid: str) -> dict | None:
        return self.data["presets"].get((pid or "").upper())

    def add_to(self, uid: int, pid: str) -> None:
        mine = self.data["saved"].setdefault(str(uid), [])
        if pid not in mine:
            mine.append(pid)
            _save(self.path, self.data)

    def of_user(self, uid: int) -> list[dict]:
        res = []
        for pid in self.data["saved"].get(str(uid), []):
            p = self.data["presets"].get(pid)
            if p:
                res.append({"id": pid, "name": p["name"]})
        return res
