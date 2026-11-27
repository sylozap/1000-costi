"""Чтение и запись истории партий в JSONL."""
from __future__ import annotations

import json
import logging
from pathlib import Path

log = logging.getLogger(__name__)


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
        base, n = rec["id"], 2
        while any(g["id"] == rec["id"] for g in self.games):  # id — комната и секунда; бывают совпадения
            rec["id"], n = f"{base}-{n}", n + 1
        self.games.append(rec)
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            log.warning("не удалось записать историю партий")

    def save(self) -> None:
        """Переписывает файл целиком (после исключения, возврата или удаления партии)."""
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text("".join(json.dumps(g, ensure_ascii=False) + "\n" for g in self.games), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            log.warning("не удалось записать историю партий")

    def remove(self, gid: str) -> None:
        self.games = [g for g in self.games if g["id"] != gid]
        self.save()

    def get(self, gid: str, include_off: bool = False) -> dict | None:
        return next((g for g in self.games if g["id"] == gid and (include_off or not g.get("off"))), None)

    def counted(self) -> list[dict]:
        """Партии, которые учитываются в статистике (без исключённых админом)."""
        return [g for g in self.games if not g.get("off")]

    def of_user(self, uid: int) -> list[dict]:
        return [g for g in self.counted() if any(p["uid"] == uid for p in g["players"])]

    def of_chat(self, chat_id) -> list[dict]:
        return [g for g in self.counted() if g.get("chat") == chat_id]
