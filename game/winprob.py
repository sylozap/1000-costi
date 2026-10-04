"""Шансы на победу: партию доигрывают много раз из текущей позиции и считают, кто сколько раз выиграл.

Все стороны в симуляции играют «сбалансированно» (как бот Счетовод); броски — случайные, правила партии — те же.
"""
from __future__ import annotations

import copy
import random
import time
from typing import TYPE_CHECKING

from .ai import wants_stop

if TYPE_CHECKING:
    from .engine import Game

MAX_STEPS = 3000  # защита от бесконечной партии (например, все сидят в яме)


def sim_clone(game: Game, rng: random.Random) -> Game:
    """Лёгкая копия партии для симуляции: без журнала, истории и подкруток."""
    memo = {id(game.rng): rng, id(game.log): [], id(game.history): [], id(game._new_events): [], id(game.rigs): {}}
    g = copy.deepcopy(game, memo)
    g.quiet = True
    g.forced = None
    g.last_roll = None
    return g


def playout(g: Game) -> list[int]:
    """Доигрывает партию до конца; возвращает uid победителей (пусто — не доиграли)."""
    for _ in range(MAX_STEPS):
        if g.phase != "play":
            break
        uid = g.cur.uid
        if g.rolls_in_turn > 0 and wants_stop(g, "balanced"):
            g.stop(uid)
        else:
            g.roll(uid)
    return g.winners if g.phase == "finished" else []


def win_chances(game: Game, budget: float = 0.6, seed: int | None = None) -> dict[str, float]:
    """Шанс на победу каждого игрока (uid → 0..1); у напарников по команде шансы общие."""
    if game.phase == "finished":
        return {str(p.uid): float(p.uid in game.winners) for p in game.players}
    if game.phase != "play":
        return {}
    return chances_from_clone(sim_clone(game, random.Random(seed)), [p.uid for p in game.players], budget)


def chances_from_clone(base: Game, uids: list[int], budget: float = 0.6, min_runs: int = 40,
                       max_runs: int = 400) -> dict[str, float]:
    """То же по готовой копии (её можно снять в основном потоке, а считать в фоновом)."""
    rng = base.rng
    wins: dict[int, int] = {}
    runs = 0
    t0 = time.perf_counter()
    while runs < max_runs and (runs < min_runs or time.perf_counter() - t0 < budget):
        g = copy.deepcopy(base, {id(rng): rng})
        for uid in playout(g):
            wins[uid] = wins.get(uid, 0) + 1
        runs += 1
    return {str(u): round(wins.get(u, 0) / runs, 3) for u in uids}
