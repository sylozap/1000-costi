"""Статистика игроков, хранится в JSON-файле и переживает перезапуск."""
import json
import os
from pathlib import Path

FIELDS = ("games", "wins", "samosvals", "bolt_penalties", "barrel_falls", "overtakes", "best_turn")


class Stats:
    def __init__(self, path: Path):
        self.path = path
        self.data: dict = {}
        if path.exists():
            try:
                self.data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                backup = path.with_suffix(".broken.json")
                path.replace(backup)
                self.data = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    def record_game(self, chat_id: int, players: list, winner_uid: int | None) -> None:
        chat = self.data.setdefault(str(chat_id), {})
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

    def chat_table(self, chat_id: int) -> list[dict]:
        rows = [dict(r, uid=int(uid)) for uid, r in self.data.get(str(chat_id), {}).items()]
        rows.sort(key=lambda r: (-r["wins"], -r["games"]))
        return rows

    def user_total(self, uid: int) -> dict | None:
        total = {f: 0 for f in FIELDS}
        found = False
        for chat in self.data.values():
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
