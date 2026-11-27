"""Представление партии для клиента и итоговая сводка."""
from __future__ import annotations

from typing import TYPE_CHECKING

from ..rules import risk_table

if TYPE_CHECKING:
    from .game import Game


def game_snapshot(game: Game) -> dict:
    return {
        "phase": game.phase,
        "barrel": game.barrel,
        "players": [{
            "uid": p.uid, "name": p.name, "score": p.score, "opened": p.opened,
            "bolts": p.bolts, "debt": p.debt, "on_barrel": p.on_barrel,
            "barrel_attempts": p.barrel_attempts, "barrel_falls": p.barrel_falls,
            "dots": p.dots, "dot_penalties": p.dot_penalties,
            "order_rolls": p.order_rolls, "order_pending": game.order_pending(p),
            "in_pit": game.pit_top(p.score) is not None, "best_turn": p.st["best_turn"],
            "team": p.side.team,
        } for p in game.players],
        "teams": game.teams,
        "order": game.order if game.phase == "play" else [],
        "current_uid": game.cur.uid if game.phase == "play" else None,
        "turn_points": game.turn_points,
        "turn_start_score": game.turn_start_score,
        "dice_left": game.dice_left,
        "kept": game.kept,
        "must_roll": game.must_roll,
        "rolls_in_turn": game.rolls_in_turn,
        "can_stop": game.can_stop(),
        "hint": game.hint(),
        "risk": risk_table(game.rules),
        "last_roll": game.last_roll,
        "log": game.log[-40:],
        "winner_uid": game.winner,
        "winners": game.winners,
        "summary": game_summary(game) if game.phase == "finished" else None,
    }

def game_summary(game: Game) -> dict:
    """Итоги партии: таблица по игрокам, история счёта и яркие моменты."""
    rows = []
    for p in game.players:
        st = p.st
        rows.append({"uid": p.uid, "name": p.name, "score": p.score, "team": p.side.team, "best_turn": st["best_turn"],
                     "detail": p.an["detail"], "samosvals": st["samosvals"], "bolt_penalties": st["bolt_penalties"],
                     "overtakes": st["overtakes"], "zeros": st["zeros"], "barrel_falls": st["barrel_falls"]})
    rows.sort(key=lambda r: (r["uid"] not in game.winners, r["uid"] != game.winner, -r["score"], r["team"] or 0))
    highlights = []
    if rows:
        best = max(rows, key=lambda r: r["best_turn"])
        if best["best_turn"]:
            highlights.append(f"💥 Лучший ход: {best['name']} — {best['best_turn']}")
        for key, text in (("samosvals", "🚛 Самосвалов"), ("bolt_penalties", "🔩 Штрафов за болты"),
                          ("overtakes", "🏎 Обгонов")):
            top = max(rows, key=lambda r: r[key])
            if top[key]:
                highlights.append(f"{text} больше всех: {top['name']} ({top[key]})")
    gap = 0
    if game.winner is not None and game.history:
        w = str(game.winner)
        gap = max((max(h["scores"].values()) - h["scores"][w] for h in game.history if w in h["scores"]), default=0)
        if gap >= 200:
            name = next((r["name"] for r in rows if r["uid"] == game.winner), "?")
            highlights.append(f"🔄 Камбэк: {name} отставал(а) на {gap} и победил(а)")
    return {"rows": rows, "history": game.history[-400:], "highlights": highlights,
            "turns": game.turn_no, "comeback": gap}
