"""Боты-соперники: решают, бросать дальше или записать. Бросают честно, по правилам партии."""
from __future__ import annotations

from typing import TYPE_CHECKING

from .rules import TARGET

if TYPE_CHECKING:
    from .engine import Game

# характер: (имя, порог записи по числу кубиков для следующего броска)
# Порог — сколько очков в ходу достаточно, чтобы остановиться, когда в руке n кубиков.
BOT_STYLES = {
    "careful": ("🤖 Тихоня", {5: 1000, 4: 100, 3: 50, 2: 25, 1: 0}),
    "balanced": ("🤖 Счетовод", {5: 1000, 4: 200, 3: 100, 2: 50, 1: 20}),
    "risky": ("🤖 Азартный", {5: 1000, 4: 350, 3: 200, 2: 100, 1: 50}),
}


def is_bot(uid: int) -> bool:
    return uid < 0


def wants_stop(g: Game, style: str) -> bool:
    """True — записать очки, False — бросать дальше."""
    if not g.can_stop():
        return False
    r = g.rules
    p = g.cur
    real = p.score + g.turn_points - p.debt
    if r["samosval_on"] and real == r["samosval"]:
        return False  # запись на самосвал обнулит счёт
    if g.barrel == "open" and real == TARGET:
        return True
    _, table = BOT_STYLES.get(style, BOT_STYLES["balanced"])
    need = table[g.dice_left]
    # в конце партии рискуем больше, если соперник вот-вот победит
    leader = max((q.score for q in g.players if q is not p), default=0)
    if leader >= 880 and real < leader:
        need = int(need * 1.5)
    return g.turn_points >= need
