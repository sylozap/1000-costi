"""Состояние комнаты и жизненный цикл партии."""
from __future__ import annotations

import asyncio
import json
import logging
import random
import secrets
import time
from typing import TYPE_CHECKING

from .. import config, rooms
from ..achievements import ACHIEVEMENTS, career_ids, end_ids, moment_ids
from ..ai import is_bot, wants_stop
from ..engine import TEAM_NAMES, Game, GameError
from ..history import bank_shares
from ..rules import BUILTIN_PRESETS, RulesError, builtin_label, normalize, same
from ..winprob import chances_from_clone, sim_clone
from .access import ANIMATION_GRACE, MAX_PLAYERS, is_admin
from .commands import handle_command
from .snapshot import room_snapshot

if TYPE_CHECKING:
    from .manager import RoomManager

log = logging.getLogger(__name__)


class Room:
    def __init__(self, manager: RoomManager, chat_id: int | None, owner_uid: int, owner_name: str,
                 rules: dict | None = None, preset_name: str | None = None):
        self.manager = manager
        self.id = secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")
        self.chat_id = chat_id
        self.chat_title: str | None = None
        self.owner = owner_uid
        self.timer = 0
        self.rules = normalize(rules)
        self._custom_name = preset_name  # название загруженного сохранённого пресета
        self._custom_rules = self.rules if preset_name else None
        self.status = "lobby"  # lobby | game | finished | cancelled
        self.members: dict[int, str] = {owner_uid: owner_name}
        self.game: Game | None = None
        self.clients: dict = {}  # ws -> uid
        self.deadline: float | None = None
        self.paused = False
        self._timer_task: asyncio.Task | None = None
        self._timer_token = 0
        self._last_react: dict[int, float] = {}
        self._announced: dict[int, set] = {}
        self.rigged = False  # админ вмешивался в партию (менял правила посреди игры)
        self.audit: list[dict] = []
        self.lobby_msg_id: int | None = None
        self.map = "felt"
        self.stake = 0             # взнос в фишках с каждого игрока
        self.stakes: dict[int, int] = {}  # кто сколько внёс в банк текущей партии
        self.bots: dict[int, str] = {}    # uid бота (< 0) → характер
        self._bot_task: asyncio.Task | None = None
        self.teams_mode = False
        self.team_of: dict[int, int] = {}  # uid → номер команды (командная игра, пары)
        self.started_at: float | None = None
        self.duration: int | None = None
        self.winprob: dict[str, float] = {}  # шансы на победу сейчас (uid → 0..1)
        self.winprob_hist: list[dict] = []  # шансы после каждого хода — для графика итогов
        self._wp_turn: int | None = None
        self._wp_seq = 0
        self.updated = time.time()

    # ---------- состояние ----------

    @property
    def active(self) -> bool:
        return self.status in ("lobby", "game")

    @property
    def settings(self) -> dict:
        """Короткие настройки (совместимость со старым клиентом и сообщениями бота)."""
        return {"barrel": self.rules["barrel"], "timer": self.timer, "map": self.map, "stake": self.stake,
                "teams": self.teams_mode}

    def preset_name(self) -> str:
        key = builtin_label(self.rules)
        if key:
            return BUILTIN_PRESETS[key][0]
        if self._custom_name and self._custom_rules is not None and same(self.rules, self._custom_rules):
            return self._custom_name
        return "Свои"

    def players_uids(self) -> set[int]:
        if self.game and self.status != "lobby":
            return {p.uid for p in self.game.players}
        return set(self.members)

    def state(self) -> dict:
        return room_snapshot(self)

    def skin_of(self, uid: int) -> str:
        if is_bot(uid):
            return {"careful": "ice", "balanced": "onyx", "risky": "ruby"}.get(self.bots.get(uid, ""), "ivory")
        admin = is_admin(uid)
        gold = self.manager.admin_prefs.get(uid, {}).get("gold", True)
        return self.manager.profiles.skin(uid, admin, gold)

    async def broadcast(self) -> None:
        self.updated = time.time()
        await self.send_all({"type": "state", "state": self.state()})

    async def send_all(self, obj: dict) -> None:
        payload = json.dumps(obj, ensure_ascii=False)
        for ws in list(self.clients):
            try:
                await ws.send_str(payload)
            except Exception:  # noqa: BLE001 — клиент отвалился
                self.clients.pop(ws, None)

    async def send_to(self, ws, obj: dict) -> None:
        try:
            await ws.send_str(json.dumps(obj, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            pass

    # ---------- подключения ----------

    async def attach(self, ws, uid: int, name: str, spectate: bool = False) -> None:
        self.clients[ws] = uid
        if (not spectate and self.status == "lobby" and uid not in self.members
                and len(self.members) < MAX_PLAYERS):
            self.members[uid] = name
            self._auto_team(uid)
            await self.manager.notify("lobby_update", self)
        await self.broadcast()

    async def detach(self, ws) -> None:
        if self.clients.pop(ws, None) is not None:
            await self.broadcast()

    # ---------- журнал действий (для админа) ----------

    def _audit(self, uid: int, name: str, action: str, detail: str = "") -> None:
        entry = {"t": time.time(), "uid": uid, "name": name, "action": action, "detail": detail}
        self.audit.append(entry)
        if len(self.audit) > 500:
            self.audit = self.audit[-500:]
        self.manager.write_audit(self, entry)

    # ---------- действия ----------
    async def handle(self, uid: int, name: str, msg: dict, ws) -> None:
        await handle_command(self, uid, name, msg, ws)

    def _auto_team(self, uid: int) -> None:
        """Новый игрок в командном режиме встаёт в первую команду со свободным местом."""
        if not self.teams_mode or uid in self.team_of:
            return
        for t in range(len(TEAM_NAMES)):
            if sum(1 for v in self.team_of.values() if v == t) < 2:
                self.team_of[uid] = t
                return

    def _teams_list(self) -> list[list[int]]:
        teams: dict[int, list[int]] = {}
        for u in self.members:
            self._require(u in self.team_of, f"{self.members[u]} не выбрал(а) команду")
            teams.setdefault(self.team_of[u], []).append(u)
        self._require(len(teams) >= 2 and all(len(t) == 2 for t in teams.values()),
                      "в командной игре нужны пары: в каждой команде ровно 2 игрока, команд — от двух")
        return [teams[k] for k in sorted(teams)]

    def _rate_ok(self, uid: int, gap: float) -> bool:
        now = time.time()
        if now - self._last_react.get(uid, 0) <= gap:
            return False
        self._last_react[uid] = now
        return True

    def _set_rules(self, raw) -> None:
        try:
            rules = normalize(raw)
        except RulesError as e:
            raise GameError(str(e)) from None
        self.rules = rules
        if self.game:
            self.game.set_rules(rules)

    def load_preset(self, pid: str) -> None:
        if pid in BUILTIN_PRESETS:
            self._set_rules(BUILTIN_PRESETS[pid][1])
            self._custom_name = self._custom_rules = None
            return
        preset = self.manager.presets.get(pid) if self.manager.presets else None
        if not preset:
            raise GameError("пресет не найден")
        self._set_rules(preset["rules"])
        self._custom_name, self._custom_rules = preset["name"], self.rules

    def _require(self, cond: bool, err: str) -> None:
        if not cond:
            raise GameError(err)

    def _game(self) -> Game:
        if self.status != "game" or not self.game:
            raise GameError("игра не идёт")
        return self.game

    def _audit_events(self, uid: int, name: str, action: str, events: list[dict]) -> None:
        g = self.game
        if action in ("roll", "order_roll") and g and g.last_roll and g.last_roll["uid"] == uid:
            lr = g.last_roll
            detail = " ".join(map(str, lr["dice"])) + f" → {lr['points']}"
            self._audit(uid, name, action, detail)
        else:
            self._audit(uid, name, action, "; ".join(e["text"] for e in events if e["kind"] != "roll")[:300])

    async def _kick(self, target: int) -> None:
        self._require(target != self.owner or self.status != "lobby", "нельзя исключить создателя в лобби")
        await self._remove(target)
        for c, cu in list(self.clients.items()):
            if cu == target:
                await self.send_to(c, {"type": "kicked"})

    async def _remove(self, uid: int) -> None:
        if self.status == "lobby":
            self.members.pop(uid, None)
            self.bots.pop(uid, None)
            self.team_of.pop(uid, None)
            if uid == self.owner:
                if not self.members:
                    await self.cancel()
                    return
                self.owner = next(iter(self.members))
            await self.manager.notify("lobby_update", self)
        elif self.status == "game" and self.game:
            if any(p.uid == uid for p in self.game.players):
                events = self.game.remove_player(uid)
                self.members.pop(uid, None)
                if uid == self.owner and self.game.players:
                    self.owner = self.game.players[0].uid
                await self._after(events)
                return
        await self.broadcast()

    async def _after(self, events: list[dict]) -> None:
        if self.game and self.status == "game":
            if events:
                await self.manager.notify("game_events", self, events)
            await self._check_achievements(final=False)
            if self.game.phase == "finished":
                self.status = "finished"
                self.duration = round(time.time() - self.started_at) if self.started_at is not None else None
                self._cancel_timer()
                self.winprob = {str(p.uid): float(p.uid in self.game.winners) for p in self.game.players}
                self.winprob_hist.append({"turn": self.game.turn_no, "p": self.winprob, "final": True})
                if self.game.winner is not None:
                    self.manager.record(self)
                    await self._check_achievements(final=True)
                    self.manager.archive(self)  # после ачивок и до выплаты: в запись попадают ачивки и ставки
                    await self._pay_bank(self.game.winners or [self.game.winner])
                else:
                    self._refund()
                await self.manager.notify("game_over", self)
            else:
                self._restart_timer()
                self._schedule_bot()
                self._schedule_winprob()
        await self.broadcast()

    # ---------- шансы на победу ----------

    def _schedule_winprob(self, force: bool = False) -> None:
        """В начале каждого хода (и после правок админа) считаем шансы в фоновом потоке."""
        g = self.game
        if not config.WINPROB_BUDGET or not g or g.phase != "play":
            return
        if not force and (g.rolls_in_turn or g.turn_no == self._wp_turn):
            return
        self._wp_turn = turn = g.turn_no
        self._wp_seq += 1
        base = sim_clone(g, random.Random())
        uids = [p.uid for p in g.players]
        asyncio.create_task(self._winprob_task(g, turn, base, uids, self._wp_seq))

    async def _winprob_task(self, g, turn: int, base, uids: list[int], seq: int) -> None:
        try:
            probs = await asyncio.to_thread(chances_from_clone, base, uids, config.WINPROB_BUDGET)
        except Exception:  # noqa: BLE001 — аналитика не должна ронять игру
            log.exception("winprob failed in room %s", self.id)
            return
        if self.game is not g or self.status != "game" or seq != self._wp_seq:
            return  # партия кончилась или уже идёт более свежий расчёт
        self.winprob = probs
        if self.winprob_hist and self.winprob_hist[-1]["turn"] == turn:
            self.winprob_hist[-1] = {"turn": turn, "p": probs}
        else:
            self.winprob_hist.append({"turn": turn, "p": probs})
        await self.broadcast()

    # ---------- фишки ----------

    def _take_stakes(self) -> None:
        self.stakes = {}
        if not self.stake:
            return
        self._require(not self.bots, "с ботами играем без ставок")
        prof = self.manager.profiles
        poor = [f"{self.members[u]} ({prof.chips(u)})" for u in self.members if prof.chips(u) < self.stake]
        self._require(not poor, "не хватает фишек на взнос: " + ", ".join(poor))
        for u in self.members:
            prof.add_chips(u, -self.stake)
            self.stakes[u] = self.stake

    async def _pay_bank(self, winners: list[int]) -> None:
        """Банк — победителю; в командной игре делится поровну между игроками команды."""
        bank = sum(self.stakes.values())
        shares = bank_shares(self.stakes, winners)
        self.stakes = {}
        if not shares:
            return
        people = list(shares)
        for u, share in shares.items():
            self.manager.profiles.add_chips(u, share)
        names = " и ".join(self.game.player(u).name for u in people) if self.game else "?"
        await self.send_all({"type": "bank", "uid": people[0], "uids": people, "name": names, "amount": bank})

    def _refund(self) -> None:
        for u, amount in self.stakes.items():
            self.manager.profiles.add_chips(u, amount)
        self.stakes = {}

    # ---------- боты ----------

    def _schedule_bot(self) -> None:
        if self._bot_task and not self._bot_task.done():
            return
        g = self.game
        if not g or self.status != "game" or self.paused or not self.bots:
            return
        if g.phase == "order":
            if not any(is_bot(p.uid) and g.order_pending(p) for p in g.players):
                return
        elif g.phase != "play" or not is_bot(g.cur.uid):
            return
        minimum, maximum = rooms.BOT_DELAY
        delay = minimum + (maximum - minimum) * (time.time() % 1)
        self._bot_task = asyncio.create_task(self._bot_act(delay))

    async def _bot_act(self, delay: float) -> None:
        await asyncio.sleep(delay)
        self._bot_task = None
        g = self.game
        if not g or self.status != "game" or self.paused:
            return
        try:
            if g.phase == "order":
                bot = next((p for p in g.players if is_bot(p.uid) and g.order_pending(p)), None)
                if not bot:
                    return
                events = g.order_roll(bot.uid)
                action = "order_roll"
            elif g.phase == "play" and is_bot(g.cur.uid):
                bot = g.cur
                stop = g.rolls_in_turn > 0 and wants_stop(g, self.bots.get(bot.uid, "balanced"))
                events = g.stop(bot.uid) if stop else g.roll(bot.uid)
                action = "stop" if stop else "roll"
            else:
                return
            self._audit_events(bot.uid, bot.name, action, events)
            await self._after(events)
        except Exception:  # noqa: BLE001 — бот не должен ронять комнату
            log.exception("bot failed in room %s", self.id)

    async def _check_achievements(self, final: bool) -> None:
        g = self.game
        if not g or not self.manager.stats:
            return
        got = []
        for p in g.players:
            if is_bot(p.uid):
                continue
            ids = set(moment_ids(p))
            if final:
                ids |= end_ids(g, p)
                total = self.manager.stats.user_total(p.uid)
                if total:
                    ids |= career_ids(total)
            done = self._announced.setdefault(p.uid, set())
            for aid in sorted(ids - done):
                done.add(aid)
                if self.manager.stats.unlock(p.uid, aid):
                    got.append((p, aid))
        for p, aid in got:
            emoji, title, desc = ACHIEVEMENTS[aid]
            await self.send_all({"type": "achievement", "uid": p.uid, "name": p.name, "id": aid,
                                 "emoji": emoji, "title": title, "desc": desc})
        if got:
            lines = [{"kind": "achievement", "notable": True,
                      "text": f"🏅 {p.name}: ачивка {ACHIEVEMENTS[aid][0]} «{ACHIEVEMENTS[aid][1]}»"} for p, aid in got]
            await self.manager.notify("game_events", self, lines)

    async def cancel(self) -> None:
        if self.status == "game":
            self._refund()
        self.status = "cancelled"
        self._cancel_timer()
        await self.manager.notify("cancelled", self)
        await self.broadcast()

    # ---------- админ ----------

    # ---------- таймер ----------

    def _cancel_timer(self) -> None:
        self.deadline = None
        self._timer_token += 1
        if self._timer_task:
            self._timer_task.cancel()
            self._timer_task = None

    def _restart_timer(self) -> None:
        self._cancel_timer()
        secs = self.timer
        if not secs or self.status != "game" or self.paused:
            return
        self.deadline = time.time() + secs + ANIMATION_GRACE
        token = self._timer_token
        self._timer_task = asyncio.create_task(self._timer(token, secs + ANIMATION_GRACE))

    async def _timer(self, token: int, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        if token != self._timer_token or self.status != "game" or not self.game or self.paused:
            return
        self._timer_task = None
        try:
            events = self.game.timeout()
            self._audit(0, "таймер", "timeout", "; ".join(e["text"] for e in events)[:300])
            await self._after(events)
        except Exception:  # noqa: BLE001
            log.exception("timer failed in room %s", self.id)
