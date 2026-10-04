"""Правила игры «1000» в кости. Чистая логика без сети; все числа берутся из словаря правил."""
from __future__ import annotations

import copy
import random
from dataclasses import dataclass, field

from .rules import BARREL_MODES, TARGET, normalize, risk_table
from .scoring import score_roll

__all__ = ["Game", "GameError", "Player", "TARGET", "BARREL_MODES"]


class GameError(Exception):
    pass


@dataclass
class Player:
    uid: int
    name: str
    score: int = 0
    opened: bool = False
    bolts: int = 0
    debt: int = 0  # штраф за болты до открытия: гасится из записанных очков, пока не выплачен
    on_barrel: bool = False
    barrel_attempts: int = 0
    barrel_falls: int = 0
    dots: int = 0
    dot_penalties: int = 0
    order_rolls: list[int] = field(default_factory=list)
    # статистика за партию
    st: dict = field(default_factory=lambda: {
        "samosvals": 0, "bolt_penalties": 0, "barrel_falls": 0,
        "overtakes": 0, "overtaken": 0, "best_turn": 0, "zeros": 0,
    })
    # факты для ачивок (game/achievements.py)
    facts: set = field(default_factory=set)


class Game:
    def __init__(self, players: list[tuple[int, str]], rules: dict | None = None,
                 rng: random.Random | None = None, barrel: str | None = None):
        if not players:
            raise GameError("нет игроков")
        self.rules = normalize(rules)
        if barrel is not None:  # короткий способ задать бочку (тесты, старые вызовы)
            if barrel not in BARREL_MODES:
                raise GameError("неизвестный режим бочки")
            self.rules["barrel"] = barrel
            if barrel == "knock" and rules is None:
                self.rules["barrel_start"] = 850
        self.rng = rng or random.SystemRandom()
        self.players = [Player(uid, name) for uid, name in players]
        self.phase = "order"  # order -> play -> finished
        self.current = 0
        self.winner: int | None = None
        self.roll_seq = 0
        self.turn_no = 0
        self.last_roll: dict | None = None
        self.forced: list[int] | None = None  # значения следующего броска (админ)
        self.log: list[dict] = []
        self.history: list[dict] = []  # счёт всех игроков после каждого хода — для графика итогов
        self._ev_seq = 0
        self._new_events: list[dict] = []
        self._reset_turn()

    # ---------- правила ----------

    @property
    def barrel(self) -> str:
        return self.rules["barrel"]

    @property
    def barrel_mode(self) -> bool:
        """Бочка, на которую садятся (по очкам или со сбросом)."""
        return self.rules["barrel"] in ("points", "knock")

    def set_rules(self, rules: dict) -> None:
        self.rules = normalize(rules)
        start = self.rules["barrel_start"]
        for p in self.players:
            if not self.barrel_mode or p.score < start:
                p.on_barrel = False
                p.barrel_attempts = 0

    def pit_top(self, score: int) -> int | None:
        """Верхняя граница ямы, если счёт в яме, иначе None."""
        if not self.rules["pits_on"]:
            return None
        for lo, hi in self.rules["pits"]:
            if lo <= score < hi:
                return hi
        return None

    # ---------- вспомогательное ----------

    def _reset_turn(self):
        self.turn_points = 0
        self.dice_left = 5
        self.must_roll = False
        self.rolls_in_turn = 0
        self.hot_in_turn = 0
        self.kept: list[int] = []
        p = self.cur if self.phase == "play" else None
        self.turn_start_score = p.score if p else 0
        self.turn_start_attempts = p.barrel_attempts if p else 0
        if self.phase == "play":
            self.turn_no += 1

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
        self._new_events = []

    def _roll_dice(self, n: int) -> tuple[list[int], bool]:
        if self.forced:
            dice = [v for v in self.forced[:n]]
            dice += [self.rng.randint(1, 6) for _ in range(n - len(dice))]
            self.forced = None
            return dice, True
        return [self.rng.randint(1, 6) for _ in range(n)], False

    def _set_score(self, p: Player, value: int) -> None:
        """Устанавливает счёт с учётом нуля, самосвала и падения с бочки."""
        r = self.rules
        value = max(0, value)
        if r["samosval_on"] and value == r["samosval"]:
            value = 0
            p.st["samosvals"] += 1
            p.facts.add("samosval")
            self._ev("samosval", f"🚛 САМОСВАЛ! {p.name} попал(а) на {r['samosval']} — счёт обнулён", p.uid)
        p.score = value
        if self.barrel_mode and p.on_barrel and p.score < r["barrel_start"]:
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

    def can_stop(self, ignore_must_roll: bool = False) -> bool:
        if self.phase != "play" or self.rolls_in_turn == 0:
            return False
        if self.must_roll and not ignore_must_roll:
            return False
        p = self.cur
        if self.barrel_mode and p.on_barrel:
            return False
        if not p.opened and self.turn_points < self.rules["open_min"]:
            return False
        top = self.pit_top(self.turn_start_score)
        if top is not None and self.turn_start_score + self.turn_points < top:
            return False
        return True

    def hint(self) -> str:
        if self.phase != "play":
            return ""
        r = self.rules
        p = self.cur
        start = self.turn_start_score
        if self.barrel_mode and p.on_barrel:
            left = r["barrel_attempts"] - p.barrel_attempts
            return f"На бочке: нужно {TARGET - start} за ход (попыток: {left})"
        parts = []
        if not p.opened and r["open_min"]:
            parts.append(f"открытие: нужно {r['open_min']}+ за ход")
        if p.debt:
            parts.append(f"долг за болты {p.debt} — гасится из записанных очков")
        top = self.pit_top(start)
        if top is not None:
            parts.append(f"яма: нужно {top - start}+ чтобы выбраться")
        if self.barrel == "open" and start >= 700:
            parts.append(f"нужно ровно {TARGET - start}")
        if r["roll_limit"]:
            parts.append(f"бросков: {self.rolls_in_turn}/{r['roll_limit']}")
        if self.must_roll:
            parts.append("все кубики сыграли — подтверди броском всех 5!")
        elif self.rolls_in_turn and self.dice_left == 5 and r["hot_dice"] == "free":
            parts.append("все кубики сыграли — можно записать или бросать все 5")
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
        dice, forced = self._roll_dice(5)
        total = sum(dice)
        p.order_rolls.append(total)
        self.roll_seq += 1
        self.last_roll = {"id": self.roll_seq, "uid": uid, "dice": dice, "scoring": [],
                          "points": total, "kind": "order", "seed": self.rng.randint(1, 2**31),
                          "forced": forced}
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
        self._record()
        names = ", ".join(f"{i + 1}. {p.name}" for i, p in enumerate(self.players))
        self._ev("order_done", f"Порядок ходов: {names}")

    # ---------- ход ----------

    def roll(self, uid: int) -> list[dict]:
        self._begin()
        p = self._check_turn(uid)
        r = self.rules
        n = self.dice_left
        dice, forced = self._roll_dice(n)
        points, idx = score_roll(dice, r["scoring"])
        confirming = self.must_roll
        self.roll_seq += 1
        self.rolls_in_turn += 1
        self.last_roll = {"id": self.roll_seq, "uid": uid, "dice": dice, "scoring": idx,
                          "points": points, "kind": "turn", "seed": self.rng.randint(1, 2**31),
                          "forced": forced}
        if n == 5 and sorted(dice) == [2, 3, 4, 5, 6]:
            p.facts.add("large_straight")
        if n == 5 and dice == [1] * 5:
            p.facts.add("five_ones")

        if points == 0:
            self._ev("roll", f"{p.name}: {' '.join(map(str, dice))} — пусто", uid, notable=False)
            if confirming and r["hot_dice"] == "safe" and self.can_stop(ignore_must_roll=True):
                self._ev("hot_saved", f"🛟 {p.name}: подтверждение пустое, но набранное {self.turn_points} "
                                      f"записывается", uid, notable=False)
                self._commit(p)
            else:
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
            self.hot_in_turn += 1
            if self.hot_in_turn >= 3:
                p.facts.add("hot3")
            self.must_roll = r["hot_dice"] != "free"
            what = "бросает все 5 заново" if self.must_roll else "может записать или бросать все 5"
            self._ev("hot", f"🔥 {p.name}: все кубики сыграли — {what}", uid, notable=False)

        total = p.score + self.turn_points - p.debt  # реальный счёт с учётом долга
        five_ones = r["scoring"]["five_ones"]
        if n == 5 and dice == [1] * 5 and (five_ones == "any" or (five_ones == "first" and self.rolls_in_turn == 1)):
            self._win(p, total, f"🎯 {p.name}: ПЯТЬ ЕДИНИЦ — ПОБЕДА!")
        elif r["samosval_on"] and total == r["samosval"]:
            # самосвал посреди хода: ход сразу заканчивается, дальше бросать нельзя
            p.opened = True
            p.debt = 0
            self._set_score(p, r["samosval"])
            self._next_turn()
        elif self.barrel == "none" and total >= TARGET:
            self._win(p, total)
        elif self.barrel_mode and p.on_barrel and total >= TARGET:
            if self.turn_start_attempts == 0:
                p.facts.add("barrel_first_try")
            self._win(p, total)
        elif self.barrel == "open" and total == TARGET:
            self._win(p, total)
        elif self.barrel == "open" and total > TARGET:
            self._fail("over")
        elif r["roll_limit"] and self.rolls_in_turn >= r["roll_limit"]:
            if self.can_stop(ignore_must_roll=True):
                self._ev("limit", f"✋ {p.name}: лимит {r['roll_limit']} бросков — очки записаны", uid,
                         notable=False)
                self._commit(p)
            else:
                self._ev("limit", f"✋ {p.name}: лимит {r['roll_limit']} бросков — записать нельзя, ход сгорел",
                         uid, notable=False)
                self._fail("limit")
        return self._new_events

    def stop(self, uid: int) -> list[dict]:
        self._begin()
        p = self._check_turn(uid)
        if not self.can_stop():
            raise GameError("сейчас нельзя записать очки")
        self._commit(p)
        return self._new_events

    def _commit(self, p: Player) -> None:
        r = self.rules
        old = p.score
        start_pit = self.pit_top(self.turn_start_score)
        new = old + self.turn_points
        if p.debt:
            pay = min(p.debt, self.turn_points)
            p.debt -= pay
            new -= pay
            left = f", осталось {p.debt}" if p.debt else " — долг погашен"
            self._ev("debt", f"🔩 {p.name}: из записанных очков списан долг −{pay}{left}", p.uid, notable=False)
        p.opened = True
        if r["bolts_reset_on_commit"]:
            p.bolts = 0
        p.st["best_turn"] = max(p.st["best_turn"], self.turn_points)
        if self.turn_points >= 300:
            p.facts.add("turn300")
        if start_pit is not None and self.rolls_in_turn == 1:
            p.facts.add("pit_one_roll")
        capped = False
        if self.barrel_mode and new >= TARGET:
            new = r["barrel_start"]
            capped = True
        self._ev("commit", f"✍️ {p.name} записал(а) +{self.turn_points} → {new}", p.uid, notable=False)
        self._set_score(p, new)
        top = self.pit_top(p.score)
        if top is not None and self.pit_top(old) != top:
            self._ev("pit_enter", f"🕳 {p.name} в яме ({p.score}) — выбираться до {top}", p.uid, notable=False)
        if self.barrel_mode and p.score >= r["barrel_start"] and not p.on_barrel:
            p.on_barrel = True
            p.barrel_attempts = 0
            extra = f" (перебор — сажаем на {r['barrel_start']})" if capped else ""
            self._ev("barrel_sit", f"🛢 {p.name} сел(а) на бочку с {p.score}{extra}", p.uid)
            if self.barrel == "knock":
                drop_to = r["barrel_start"] - r["knock_drop"]
                for q in self.players:
                    if q is not p and q.on_barrel:
                        q.on_barrel = False
                        q.barrel_attempts = 0
                        self._ev("barrel_knock", f"🛢💥 {p.name} сбросил(а) {q.name} с бочки → {max(0, drop_to)}",
                                 q.uid, by=p.uid)
                        self._set_score(q, drop_to)
        if p.score > old:
            pen = r["overtake_penalty"]
            for q in self.players:
                if q is p or q.score <= 0:
                    continue
                if old <= q.score < p.score and pen:
                    p.st["overtakes"] += 1
                    self._overtaken(q)
                    self._ev("overtake", f"🏎 {p.name} обогнал(а) {q.name}: у {q.name} −{pen}", q.uid,
                             by=p.uid, amount=pen)
                    self._set_score(q, q.score - pen)
                elif q.score == p.score and old < q.score and r["tie_rule"] != "none":
                    if r["tie_rule"] == "zero":
                        self._ev("tie_zero", f"🎯 {p.name} ровно сравнялся(-лась) с {q.name} — {q.name} обнуляется!",
                                 q.uid, by=p.uid, amount=q.score)
                        self._set_score(q, 0)
                    elif pen:
                        self._overtaken(q)
                        self._ev("overtake", f"🏎 {p.name} сравнялся(-лась) с {q.name}: у {q.name} −{pen}", q.uid,
                                 by=p.uid, amount=pen)
                        self._set_score(q, q.score - pen)
        self._track_last()
        self._next_turn()

    def _overtaken(self, q: Player) -> None:
        q.st["overtaken"] += 1
        if q.st["overtaken"] >= 3:
            q.facts.add("overtaken3")

    def _track_last(self) -> None:
        """Для ачивки «с последнего места»: игрок был последним, когда лидер уже далеко."""
        if len(self.players) < 2:
            return
        leader = max(p.score for p in self.players)
        if leader < 600:
            return
        low = min(p.score for p in self.players)
        for p in self.players:
            if p.score == low:
                p.facts.add("was_far_last")

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
            self._commit(p)
            return self._new_events
        self._ev("timeout", f"⏰ {p.name}: время вышло, ход пропущен", p.uid)
        self._fail("timeout")
        return self._new_events

    def _add_bolt(self, p: Player, lost: str = "") -> None:
        r = self.rules
        p.bolts += 1
        if p.bolts < r["bolts_limit"]:
            self._ev("bolt", f"🔩 {p.name}: болт {p.bolts}/{r['bolts_limit']}{lost}", p.uid, notable=False)
            return
        p.bolts = 0
        p.st["bolt_penalties"] += 1
        p.facts.add("bolts3")
        if not p.opened or p.debt:
            p.debt += r["bolt_penalty"]
            self._ev("bolt_penalty", f"🔩 {p.name}: {r['bolts_limit']}-й болт{lost} — долг +{r['bolt_penalty']} "
                                     f"(всего {p.debt}, гасится из записанных очков)", p.uid)
        else:
            self._ev("bolt_penalty", f"🔩 {p.name}: {r['bolts_limit']}-й болт{lost} — штраф −{r['bolt_penalty']}",
                     p.uid)
            self._set_score(p, p.score - r["bolt_penalty"])

    def _fail(self, reason: str):
        """Ход сгорел: пустой бросок, перебор (открытая бочка), таймаут или лимит бросков."""
        r = self.rules
        p = self.cur
        burned = self.turn_points
        lost = f", сгорело {burned}" if burned else ""
        on_barrel = self.barrel_mode and p.on_barrel
        in_pit = self.pit_top(self.turn_start_score) is not None
        if reason == "zero":
            p.st["zeros"] += 1
            if burned >= 300:
                p.facts.add("burned300")
        if on_barrel:
            p.barrel_attempts += 1
            if p.barrel_attempts >= r["barrel_attempts"]:
                p.barrel_falls += 1
                p.st["barrel_falls"] += 1
                p.on_barrel = False
                p.barrel_attempts = 0
                if p.barrel_falls >= r["barrel_falls"]:
                    p.barrel_falls = 0
                    p.facts.add("barrel_zero")
                    self._ev("barrel_zero", f"💥 {p.name} упал(а) с бочки в {r['barrel_falls']}-й раз — счёт обнулён!",
                             p.uid)
                    self._set_score(p, 0)
                else:
                    self._ev("barrel_fall",
                             f"🛢💥 {p.name} упал(а) с бочки (падение {p.barrel_falls}/{r['barrel_falls']}): "
                             f"−{r['barrel_penalty']}", p.uid)
                    self._set_score(p, p.score - r["barrel_penalty"])
            else:
                self._ev("barrel_attempt",
                         f"🛢 {p.name}: попытка на бочке не удалась ({p.barrel_attempts}/{r['barrel_attempts']}){lost}",
                         p.uid, notable=False)
        elif reason == "over":
            p.dots += 1
            text = f"• {p.name}: перебор! Точка {p.dots}/{r['dots_limit']}{lost}"
            if p.dots >= r["dots_limit"]:
                p.dots = 0
                p.dot_penalties += 1
                if p.dot_penalties >= r["dot_penalties_limit"]:
                    p.dot_penalties = 0
                    self._ev("dot_zero", text + f" — {r['dot_penalties_limit']}-й штраф, счёт обнулён!", p.uid)
                    self._set_score(p, 0)
                else:
                    self._ev("dot_penalty", text + f" — штраф −{r['dot_penalty']}", p.uid)
                    self._set_score(p, p.score - r["dot_penalty"])
            else:
                self._ev("dot", text, p.uid, notable=False)

        if reason == "zero":
            eligible = (r["bolts_on"]
                        and (p.opened or r["bolts_before_open"])
                        and (not in_pit or r["bolts_in_pit"])
                        and (not on_barrel or r["bolts_on_barrel"]))
            if eligible:
                self._add_bolt(p, lost if not on_barrel else "")
            elif not on_barrel:
                why = "в яме" if in_pit else ("игра не открыта" if not p.opened else "без болта")
                self._ev("zero", f"💨 {p.name}: пусто ({why}){lost}", p.uid, notable=False)
                if in_pit:
                    self._ev("pit_fail", f"🕳 {p.name} остаётся в яме", p.uid, notable=False)
        self._next_turn()

    def _win(self, p: Player, total: int, text: str | None = None):
        p.st["best_turn"] = max(p.st["best_turn"], self.turn_points)
        p.score = total
        p.opened = True
        p.debt = 0
        self.phase = "finished"
        self.winner = p.uid
        self._ev("win", text or f"🏆 {p.name} набрал(а) {total} и ПОБЕДИЛ(А)!", p.uid)
        self._record()

    def _record(self) -> None:
        self.history.append({"turn": self.turn_no, "uid": self.cur.uid if self.players else None,
                             "scores": {str(p.uid): p.score for p in self.players}})

    def _next_turn(self):
        if self.phase != "play":
            return
        self._record()
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

    # ---------- вмешательство администратора (без записей в общий журнал) ----------

    def admin_set_score(self, uid: int, value: int) -> None:
        p = self.player(uid)
        value = int(value)
        p.score = max(0, value)
        p.debt = max(0, -value)  # отрицательное значение = долг
        if p.score > 0:
            p.opened = True
        start = self.rules["barrel_start"]
        if self.barrel_mode:
            if p.score >= start and not p.on_barrel:
                p.on_barrel, p.barrel_attempts = True, 0
            elif p.score < start:
                p.on_barrel, p.barrel_attempts = False, 0
        if self.phase == "play" and self.cur is p and self.rolls_in_turn == 0:
            self.turn_start_score = p.score

    def admin_bolt(self, uid: int) -> list[dict]:
        self._begin()
        self._add_bolt(self.player(uid))
        return self._new_events

    def admin_samosval(self, uid: int) -> list[dict]:
        self._begin()
        p = self.player(uid)
        r = self.rules
        if r["samosval_on"]:
            self._set_score(p, r["samosval"])
        else:
            p.st["samosvals"] += 1
            self._ev("samosval", f"🚛 САМОСВАЛ! {p.name} — счёт обнулён", p.uid)
            self._set_score(p, 0)
        return self._new_events

    def force_next(self, dice: list[int]) -> None:
        if not dice or len(dice) > 5 or any(not 1 <= d <= 6 for d in dice):
            raise GameError("нужно от 1 до 5 значений от 1 до 6")
        self.forced = list(dice)

    def snapshot(self) -> Game:
        """Копия партии для отмены хода (генератор случайных чисел общий)."""
        return copy.deepcopy(self, {id(self.rng): self.rng})

    def restore_from(self, snap: Game) -> None:
        """Возвращает партию к снимку, сохраняя сквозные счётчики событий и бросков."""
        ev_seq, roll_seq = self._ev_seq, self.roll_seq
        self.__dict__.update(snap.snapshot().__dict__)
        self._ev_seq, self.roll_seq = ev_seq, roll_seq
        self.last_roll = None
        self.forced = None

    # ---------- сериализация ----------

    def to_dict(self) -> dict:
        return {
            "phase": self.phase,
            "barrel": self.barrel,
            "players": [{
                "uid": p.uid, "name": p.name, "score": p.score, "opened": p.opened,
                "bolts": p.bolts, "debt": p.debt, "on_barrel": p.on_barrel,
                "barrel_attempts": p.barrel_attempts, "barrel_falls": p.barrel_falls,
                "dots": p.dots, "dot_penalties": p.dot_penalties,
                "order_rolls": p.order_rolls, "order_pending": self.order_pending(p),
                "in_pit": self.pit_top(p.score) is not None, "best_turn": p.st["best_turn"],
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
            "risk": risk_table(self.rules),
            "last_roll": {k: v for k, v in self.last_roll.items() if k != "forced"} if self.last_roll else None,
            "log": self.log[-40:],
            "winner_uid": self.winner,
            "summary": self.summary() if self.phase == "finished" else None,
        }

    def summary(self) -> dict:
        """Итоги партии: таблица по игрокам, история счёта и яркие моменты."""
        rows = []
        for p in self.players:
            st = p.st
            rows.append({"uid": p.uid, "name": p.name, "score": p.score, "best_turn": st["best_turn"],
                         "samosvals": st["samosvals"], "bolt_penalties": st["bolt_penalties"],
                         "overtakes": st["overtakes"], "zeros": st["zeros"], "barrel_falls": st["barrel_falls"]})
        rows.sort(key=lambda r: (r["uid"] != self.winner, -r["score"]))
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
        if self.winner is not None and self.history:
            w = str(self.winner)
            gap = max((max(h["scores"].values()) - h["scores"].get(w, 0) for h in self.history), default=0)
            if gap >= 200:
                name = next((r["name"] for r in rows if r["uid"] == self.winner), "?")
                highlights.append(f"🔄 Камбэк: {name} отставал(а) на {gap} и победил(а)")
        return {"rows": rows, "history": self.history[-400:], "highlights": highlights}
