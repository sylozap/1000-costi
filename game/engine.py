"""Правила игры «1000» в кости. Чистая логика без сети."""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from .scoring import score_roll

TARGET = 1000
OPEN_MIN = 50
PITS = [(200, 300), (600, 700)]  # [нижняя, верхняя): на 300/700 игрок уже вне ямы
SAMOSVAL = 555
OVERTAKE_PENALTY = 50
BOLTS_LIMIT = 3
BOLT_PENALTY = 100
BARREL_START = 880
BARREL_ATTEMPTS = 3
BARREL_FALLS_LIMIT = 3
BARREL_PENALTY = 100
DOTS_LIMIT = 6
DOT_PENALTY = 100
DOT_PENALTIES_LIMIT = 3

BARREL_MODES = ("none", "points", "open")


class GameError(Exception):
    pass


def pit_top(score: int) -> int | None:
    """Верхняя граница ямы, если счёт в яме, иначе None."""
    for lo, hi in PITS:
        if lo <= score < hi:
            return hi
    return None


@dataclass
class Player:
    uid: int
    name: str
    score: int = 0
    opened: bool = False
    bolts: int = 0
    on_barrel: bool = False
    barrel_attempts: int = 0
    barrel_falls: int = 0
    dots: int = 0
    dot_penalties: int = 0
    order_rolls: list[int] = field(default_factory=list)
    # статистика за партию
    st: dict = field(default_factory=lambda: {
        "samosvals": 0, "bolt_penalties": 0, "barrel_falls": 0,
        "overtakes": 0, "best_turn": 0, "zeros": 0,
    })


class Game:
    def __init__(self, players: list[tuple[int, str]], barrel: str = "none",
                 rng: random.Random | None = None):
        if barrel not in BARREL_MODES:
            raise GameError("неизвестный режим бочки")
        if not players:
            raise GameError("нет игроков")
        self.barrel = barrel
        self.rng = rng or random.SystemRandom()
        self.players = [Player(uid, name) for uid, name in players]
        self.phase = "order"  # order -> play -> finished
        self.current = 0
        self.winner: int | None = None
        self.roll_seq = 0
        self.last_roll: dict | None = None
        self.log: list[dict] = []
        self._ev_seq = 0
        self._reset_turn()

    # ---------- вспомогательное ----------

    def _reset_turn(self):
        self.turn_points = 0
        self.dice_left = 5
        self.must_roll = False
        self.rolls_in_turn = 0
        self.kept: list[int] = []
        p = self.cur if self.phase == "play" else None
        self.turn_start_score = p.score if p else 0

    @property
    def cur(self) -> Player:
        return self.players[self.current]

    def player(self, uid: int) -> Player:
        for p in self.players:
            if p.uid == uid:
                return p
        raise GameError("вы не участник этой игры")

    def _ev(self, kind: str, text: str, uid: int | None = None, notable: bool = True, **extra):
        self._ev_seq += 1
        ev = {"id": self._ev_seq, "kind": kind, "text": text, "uid": uid, "notable": notable, **extra}
        self.log.append(ev)
        if len(self.log) > 200:
            self.log = self.log[-200:]
        self._new_events.append(ev)
        return ev

    def _begin(self) -> None:
        self._new_events: list[dict] = []

    def _roll_dice(self, n: int) -> list[int]:
        return [self.rng.randint(1, 6) for _ in range(n)]

    def _set_score(self, p: Player, value: int) -> None:
        """Устанавливает счёт с учётом нуля, самосвала и падения с бочки."""
        value = max(0, value)
        if value == SAMOSVAL:
            value = 0
            p.st["samosvals"] += 1
            self._ev("samosval", f"🚛 САМОСВАЛ! {p.name} попал(а) на 555 — счёт обнулён", p.uid)
        p.score = value
        if self.barrel == "points" and p.on_barrel and p.score < BARREL_START:
            p.on_barrel = False
            p.barrel_attempts = 0
            self._ev("barrel_off", f"🛢 {p.name} слетел(а) с бочки ({p.score})", p.uid)

    def _check_turn(self, uid: int) -> Player:
        if self.phase != "play":
            raise GameError("игра не идёт")
        if self.cur.uid != uid:
            raise GameError("сейчас не ваш ход")
        return self.cur

    # ---------- информация для интерфейса ----------

    def can_stop(self) -> bool:
        if self.phase != "play" or self.rolls_in_turn == 0 or self.must_roll:
            return False
        p = self.cur
        if self.barrel == "points" and p.on_barrel:
            return False
        if not p.opened and self.turn_points < OPEN_MIN:
            return False
        top = pit_top(self.turn_start_score)
        if top is not None and self.turn_start_score + self.turn_points < top:
            return False
        return True

    def hint(self) -> str:
        if self.phase != "play":
            return ""
        p = self.cur
        start = self.turn_start_score
        if self.barrel == "points" and p.on_barrel:
            left = BARREL_ATTEMPTS - p.barrel_attempts
            return f"На бочке: нужно {TARGET - start} за ход (попыток: {left})"
        parts = []
        if not p.opened:
            parts.append(f"открытие: нужно {OPEN_MIN}+ за ход")
        top = pit_top(start)
        if top is not None:
            parts.append(f"яма: нужно {top - start}+ чтобы выбраться")
        if self.barrel == "open" and start >= 700:
            parts.append(f"нужно ровно {TARGET - start}")
        if self.must_roll:
            parts.append("все кубики сыграли — бросай все 5 заново!")
        return "; ".join(parts)

    # ---------- розыгрыш очерёдности ----------

    def order_pending(self, p: Player) -> bool:
        if self.phase != "order":
            return False
        if not p.order_rolls:
            return True
        n = len(p.order_rolls)
        return any(q is not p and q.order_rolls[:n] == p.order_rolls for q in self.players)

    def order_roll(self, uid: int) -> list[dict]:
        self._begin()
        self._order_roll(uid)
        return self._new_events

    def _order_roll(self, uid: int) -> None:
        if self.phase != "order":
            raise GameError("очерёдность уже определена")
        p = self.player(uid)
        if not self.order_pending(p):
            raise GameError("вам пока не нужно бросать")
        dice = self._roll_dice(5)
        total = sum(dice)
        p.order_rolls.append(total)
        self.roll_seq += 1
        self.last_roll = {"id": self.roll_seq, "uid": uid, "dice": dice, "scoring": [],
                          "points": total, "kind": "order", "seed": self.rng.randint(1, 2**31)}
        again = " (переброс)" if len(p.order_rolls) > 1 else ""
        self._ev("order_roll", f"{p.name} выбросил(а) {total}{again}", uid, notable=False)
        self._check_order_done()

    def _check_order_done(self):
        if self.phase != "order" or any(self.order_pending(p) for p in self.players):
            return
        self.players.sort(key=lambda p: tuple(p.order_rolls), reverse=True)
        self.phase = "play"
        self.current = 0
        self._reset_turn()
        names = ", ".join(f"{i + 1}. {p.name}" for i, p in enumerate(self.players))
        self._ev("order_done", f"Порядок ходов: {names}")

    # ---------- ход ----------

    def roll(self, uid: int) -> list[dict]:
        self._begin()
        p = self._check_turn(uid)
        dice = self._roll_dice(self.dice_left)
        points, idx = score_roll(dice)
        self.roll_seq += 1
        self.rolls_in_turn += 1
        self.last_roll = {"id": self.roll_seq, "uid": uid, "dice": dice, "scoring": idx,
                          "points": points, "kind": "turn", "seed": self.rng.randint(1, 2**31)}
        if points == 0:
            self._ev("roll", f"{p.name}: {' '.join(map(str, dice))} — пусто", uid, notable=False)
            self._fail("zero")
            return self._new_events

        self.turn_points += points
        self.kept += [dice[i] for i in idx]
        self.dice_left -= len(idx)
        self.must_roll = False
        self._ev("roll", f"{p.name}: {' '.join(map(str, dice))} → +{points} (в ходу {self.turn_points})",
                 uid, notable=False)
        if self.dice_left == 0:
            self.dice_left = 5
            self.kept = []
            self.must_roll = True
            self._ev("hot", f"🔥 {p.name}: все кубики сыграли — бросает все 5 заново", uid, notable=False)

        total = p.score + self.turn_points
        if self.barrel == "none" and total >= TARGET:
            self._win(p, total)
        elif self.barrel == "points" and p.on_barrel and total >= TARGET:
            self._win(p, total)
        elif self.barrel == "open":
            if total == TARGET:
                self._win(p, total)
            elif total > TARGET:
                self._fail("over")
        return self._new_events

    def stop(self, uid: int) -> list[dict]:
        self._begin()
        p = self._check_turn(uid)
        if not self.can_stop():
            raise GameError("сейчас нельзя записать очки")
        old = p.score
        new = old + self.turn_points
        p.opened = True
        p.st["best_turn"] = max(p.st["best_turn"], self.turn_points)
        capped = False
        if self.barrel == "points" and new >= TARGET:
            new = BARREL_START
            capped = True
        self._ev("commit", f"✍️ {p.name} записал(а) +{self.turn_points} → {new}", uid, notable=False)
        self._set_score(p, new)
        if self.barrel == "points" and p.score >= BARREL_START and not p.on_barrel:
            p.on_barrel = True
            p.barrel_attempts = 0
            extra = " (перебор — сажаем на 880)" if capped else ""
            self._ev("barrel_sit", f"🛢 {p.name} сел(а) на бочку с {p.score}{extra}", uid)
        if p.score > old:
            for q in self.players:
                if q is not p and q.score > 0 and old <= q.score < p.score:
                    p.st["overtakes"] += 1
                    self._ev("overtake", f"🏎 {p.name} обогнал(а) {q.name}: у {q.name} −{OVERTAKE_PENALTY}",
                             q.uid, by=p.uid)
                    self._set_score(q, q.score - OVERTAKE_PENALTY)
        self._next_turn()
        return self._new_events

    def timeout(self) -> list[dict]:
        """Время на действие вышло: записываем, если можно, иначе ход сгорает."""
        self._begin()
        if self.phase == "order":
            for p in list(self.players):
                if self.phase == "order" and self.order_pending(p):
                    self._order_roll(p.uid)
            return self._new_events
        if self.phase != "play":
            return []
        p = self.cur
        if self.can_stop():
            self._ev("timeout", f"⏰ {p.name}: время вышло, очки записаны автоматически", p.uid)
            events = self._new_events
            return events + self.stop(p.uid)
        self._ev("timeout", f"⏰ {p.name}: время вышло, ход пропущен", p.uid)
        self._fail("timeout")
        return self._new_events

    def _fail(self, reason: str):
        """Ход сгорел: пустой бросок, перебор (открытая бочка) или таймаут."""
        p = self.cur
        burned = self.turn_points
        lost = f", сгорело {burned}" if burned else ""
        if reason == "zero":
            p.st["zeros"] += 1
        if self.barrel == "points" and p.on_barrel:
            p.barrel_attempts += 1
            if p.barrel_attempts >= BARREL_ATTEMPTS:
                p.barrel_falls += 1
                p.st["barrel_falls"] += 1
                p.on_barrel = False
                p.barrel_attempts = 0
                if p.barrel_falls >= BARREL_FALLS_LIMIT:
                    p.barrel_falls = 0
                    self._ev("barrel_zero", f"💥 {p.name} упал(а) с бочки в {BARREL_FALLS_LIMIT}-й раз — счёт обнулён!", p.uid)
                    self._set_score(p, 0)
                else:
                    self._ev("barrel_fall",
                             f"🛢💥 {p.name} упал(а) с бочки (падение {p.barrel_falls}/{BARREL_FALLS_LIMIT}): −{BARREL_PENALTY}",
                             p.uid)
                    self._set_score(p, p.score - BARREL_PENALTY)
            else:
                self._ev("barrel_attempt",
                         f"🛢 {p.name}: попытка на бочке не удалась ({p.barrel_attempts}/{BARREL_ATTEMPTS}){lost}", p.uid,
                         notable=False)
        elif reason == "over":
            p.dots += 1
            text = f"• {p.name}: перебор! Точка {p.dots}/{DOTS_LIMIT}{lost}"
            if p.dots >= DOTS_LIMIT:
                p.dots = 0
                p.dot_penalties += 1
                if p.dot_penalties >= DOT_PENALTIES_LIMIT:
                    p.dot_penalties = 0
                    self._ev("dot_zero", text + f" — {DOT_PENALTIES_LIMIT}-й штраф, счёт обнулён!", p.uid)
                    self._set_score(p, 0)
                else:
                    self._ev("dot_penalty", text + f" — штраф −{DOT_PENALTY}", p.uid)
                    self._set_score(p, p.score - DOT_PENALTY)
            else:
                self._ev("dot", text, p.uid, notable=False)
        elif reason == "zero" and p.opened and pit_top(self.turn_start_score) is None:
            p.bolts += 1
            if p.bolts >= BOLTS_LIMIT:
                p.bolts = 0
                p.st["bolt_penalties"] += 1
                self._ev("bolt_penalty", f"🔩 {p.name}: третий болт{lost} — штраф −{BOLT_PENALTY}", p.uid)
                self._set_score(p, p.score - BOLT_PENALTY)
            else:
                self._ev("bolt", f"🔩 {p.name}: болт {p.bolts}/{BOLTS_LIMIT}{lost}", p.uid, notable=False)
        elif reason == "zero":
            why = "в яме" if p.opened else "игра не открыта"
            self._ev("zero", f"💨 {p.name}: пусто ({why}){lost}", p.uid, notable=False)
        self._next_turn()

    def _win(self, p: Player, total: int):
        p.st["best_turn"] = max(p.st["best_turn"], self.turn_points)
        p.score = total
        p.opened = True
        self.phase = "finished"
        self.winner = p.uid
        self._ev("win", f"🏆 {p.name} набрал(а) {total} и ПОБЕДИЛ(А)!", p.uid)

    def _next_turn(self):
        if self.phase != "play":
            return
        self.current = (self.current + 1) % len(self.players)
        self._reset_turn()

    # ---------- состав ----------

    def remove_player(self, uid: int) -> list[dict]:
        self._begin()
        p = self.player(uid)
        idx = self.players.index(p)
        was_current = self.phase == "play" and idx == self.current
        self.players.pop(idx)
        self._ev("leave", f"🚪 {p.name} покинул(а) игру", uid)
        if not self.players:
            self.phase = "finished"
            return self._new_events
        if self.phase == "order":
            self._check_order_done()
        elif self.phase == "play":
            if idx < self.current:
                self.current -= 1
            if self.current >= len(self.players):
                self.current = 0
            if was_current:
                self._reset_turn()
        return self._new_events

    # ---------- сериализация ----------

    def to_dict(self) -> dict:
        return {
            "phase": self.phase,
            "barrel": self.barrel,
            "players": [{
                "uid": p.uid, "name": p.name, "score": p.score, "opened": p.opened,
                "bolts": p.bolts, "on_barrel": p.on_barrel, "barrel_attempts": p.barrel_attempts,
                "barrel_falls": p.barrel_falls, "dots": p.dots, "dot_penalties": p.dot_penalties,
                "order_rolls": p.order_rolls, "order_pending": self.order_pending(p),
                "in_pit": pit_top(p.score) is not None, "best_turn": p.st["best_turn"],
            } for p in self.players],
            "current_uid": self.cur.uid if self.phase == "play" else None,
            "turn_points": self.turn_points,
            "turn_start_score": self.turn_start_score,
            "dice_left": self.dice_left,
            "kept": self.kept,
            "must_roll": self.must_roll,
            "rolls_in_turn": self.rolls_in_turn,
            "can_stop": self.can_stop(),
            "hint": self.hint(),
            "last_roll": self.last_roll,
            "log": self.log[-40:],
            "winner_uid": self.winner,
        }
