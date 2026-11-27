"""Состояние игрока и общий счёт команды."""
from __future__ import annotations

from dataclasses import dataclass, field


TEAM_NAMES = ["🔴 Красные", "🔵 Синие", "🟢 Зелёные", "🟡 Жёлтые"]


class GameError(Exception):
    pass


# общее состояние стороны: у одиночного игрока своё, у команды — одно на двоих
SIDE_FIELDS = ("score", "opened", "bolts", "debt", "on_barrel", "barrel_attempts", "barrel_falls", "dots", "dot_penalties")


@dataclass
class Side:
    score: int = 0
    opened: bool = False
    bolts: int = 0
    debt: int = 0  # штраф за болты до открытия: гасится из записанных очков, пока не выплачен
    on_barrel: bool = False
    barrel_attempts: int = 0
    barrel_falls: int = 0
    dots: int = 0
    dot_penalties: int = 0
    barrel_entered_by: int | None = None
    team: int | None = None  # номер команды (None — одиночный игрок)


def new_analytics() -> dict:
    """Счётчики игрока за партию для аналитики (удача, риск, решения, соперники, честность кубиков)."""
    return {
        "turns": 0, "rolls": 0, "pts": 0, "exp": 0.0, "faces": [0] * 6,
        "commits": 0, "commit_pts": 0, "burned": 0, "burned_pts": 0,
        "risky_opps": 0, "risky_rolls": 0, "dec": 0, "dec_good": 0,
        "overtook": {}, "zeroed": {},
        "detail": {
            "turns": 0, "successful": 0, "recorded": 0, "burned": {},
            "deductions": {}, "pit_attempts": 0, "pit_exits": 0, "barrel_entries": 0,
            "barrel_wins": 0,
        },
    }


@dataclass
class Player:
    uid: int
    name: str
    side: Side = field(default_factory=Side)
    order_rolls: list[int] = field(default_factory=list)
    # статистика за партию
    st: dict = field(default_factory=lambda: {
        "samosvals": 0, "bolt_penalties": 0, "barrel_falls": 0,
        "overtakes": 0, "overtaken": 0, "best_turn": 0, "zeros": 0,
    })
    # факты для ачивок (game/achievements.py)
    facts: set = field(default_factory=set)
    an: dict = field(default_factory=new_analytics)


def _side_prop(name: str) -> property:
    return property(lambda self: getattr(self.side, name), lambda self, v: setattr(self.side, name, v))


for _f in SIDE_FIELDS:
    setattr(Player, _f, _side_prop(_f))
