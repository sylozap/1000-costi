"""Представление сыгранной партии и распределение банка."""
from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..rooms import Room


def bank_shares(stakes: dict, winners: list) -> dict[int, int]:
    """Сколько фишек банка получает каждый победитель-человек (в команде — поровну)."""
    bank = sum(stakes.values())
    people = [u for u in winners if u >= 0]
    if not bank or not people:
        return {}
    return {u: bank // len(people) for u in people}


def game_record(room: Room, now: float | None = None) -> dict:
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
        "rule_history": g.rule_history,
        "teams": g.teams,
        "winners": g.winners,
        "turns": g.turn_no,
        "players": [{
            "uid": p.uid, "name": p.name, "score": p.score, "team": p.side.team, "bot": p.uid < 0,
            "st": p.st, "an": p.an,
        } for p in g.players],
        "history": g.history,
        "winprob": room.winprob_hist,
        "chat_title": room.chat_title,
        # всё, что нужно, чтобы аннулировать партию: ачивки партии, ставки, вмешательства админа
        "ach": {str(u): sorted(ids) for u, ids in room._announced.items() if ids},
        "stakes": {str(u): v for u, v in room.stakes.items() if v},
        "rigged": room.rigged,
    }
