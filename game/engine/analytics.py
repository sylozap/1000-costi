"""Вероятности бросков и аналитика решений игрока."""
from __future__ import annotations

import itertools
import json
from functools import lru_cache
from typing import TYPE_CHECKING

from ..scoring import score_roll

if TYPE_CHECKING:
    from .game import Game
    from .models import Player


@lru_cache(maxsize=32)
def roll_odds(n: int, scoring_json: str) -> tuple[float, float]:
    """(шанс пустого броска, ожидаемые очки) для n кубиков — для аналитики удачи и решений."""
    sc = json.loads(scoring_json)
    zero = total = 0
    for dice in itertools.product(range(1, 7), repeat=n):
        pts = score_roll(list(dice), sc)[0]
        zero += pts == 0
        total += pts
    count = 6 ** n
    return zero / count, total / count


def note_decision(game: Game, p: Player, rolled: bool) -> None:
    """Аналитика решения «бросать/записать»: сравниваем с выгодой одного броска по математике."""
    if game.quiet or game.rolls_in_turn == 0 or game.must_roll or not game.can_stop():
        return
    n = game.dice_left
    p0, mean = roll_odds(n, json.dumps(game.rules["scoring"], sort_keys=True))
    roll_better = mean - p0 * game.turn_points > 0
    a = p.an
    a["dec"] += 1
    a["dec_good"] += int(roll_better == rolled)
    if n <= 2:
        a["risky_opps"] += 1
        a["risky_rolls"] += int(rolled)


def note_roll(game: Game, p: Player, dice: list[int], points: int) -> None:
    """Аналитика удачи и честности кубиков."""
    if game.quiet:
        return
    a = p.an
    a["rolls"] += 1
    a["pts"] += points
    a["exp"] += roll_odds(len(dice), json.dumps(game.rules["scoring"], sort_keys=True))[1]
    for d in dice:
        a["faces"][d - 1] += 1
