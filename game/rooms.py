"""Комнаты: лобби, партия, таймер, рассылка состояния по WebSocket."""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from typing import TYPE_CHECKING

from .config import MAX_PLAYERS
from .engine import BARREL_MODES, Game, GameError

if TYPE_CHECKING:
    from .stats import Stats

log = logging.getLogger(__name__)

TIMER_OPTIONS = (0, 30, 60, 120)
ANIMATION_GRACE = 2.5  # секунд на анимацию броска сверх таймера
REACTIONS = ("😂", "😱", "👏", "🔥", "😭", "🤡", "💩", "🍀")


class Room:
    def __init__(self, manager: RoomManager, chat_id: int | None, owner_uid: int, owner_name: str):
        self.manager = manager
        self.id = secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")
        self.chat_id = chat_id
        self.owner = owner_uid
        self.settings = {"barrel": "none", "timer": 0}
        self.status = "lobby"  # lobby | game | finished | cancelled
        self.members: dict[int, str] = {owner_uid: owner_name}
        self.game: Game | None = None
        self.clients: dict = {}  # ws -> uid
        self.deadline: float | None = None
        self._timer_task: asyncio.Task | None = None
        self._timer_token = 0
        self._last_react: dict[int, float] = {}
        self.lobby_msg_id: int | None = None
        self.updated = time.time()

    # ---------- состояние ----------

    @property
    def active(self) -> bool:
        return self.status in ("lobby", "game")

    def state(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "owner": self.owner,
            "settings": self.settings,
            "members": [{"uid": u, "name": n} for u, n in self.members.items()],
            "online": sorted(set(self.clients.values())),
            "game": self.game.to_dict() if self.game else None,
            "deadline": int(self.deadline * 1000) if self.deadline else None,
            "server_now": int(time.time() * 1000),
            "max_players": MAX_PLAYERS,
            "reactions": REACTIONS,
        }

    async def broadcast(self) -> None:
        self.updated = time.time()
        payload = json.dumps({"type": "state", "state": self.state()}, ensure_ascii=False)
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

    async def attach(self, ws, uid: int, name: str) -> None:
        self.clients[ws] = uid
        if self.status == "lobby" and uid not in self.members and len(self.members) < MAX_PLAYERS:
            self.members[uid] = name
            await self.manager.notify("lobby_update", self)
        await self.broadcast()

    async def detach(self, ws) -> None:
        if self.clients.pop(ws, None) is not None:
            await self.broadcast()

    # ---------- действия ----------

    async def handle(self, uid: int, name: str, msg: dict, ws) -> None:
        action = msg.get("type")
        is_owner = uid == self.owner
        events: list[dict] = []

        if action == "react":
            emoji = msg.get("emoji")
            now = time.time()
            if emoji in REACTIONS and now - self._last_react.get(uid, 0) > 0.7:
                self._last_react[uid] = now
                payload = {"type": "reaction", "uid": uid, "name": name, "emoji": emoji}
                for c in list(self.clients):
                    await self.send_to(c, payload)
            return

        if action == "join":
            if self.status != "lobby":
                raise GameError("игра уже началась")
            if uid not in self.members:
                if len(self.members) >= MAX_PLAYERS:
                    raise GameError("комната заполнена")
                self.members[uid] = name
                await self.manager.notify("lobby_update", self)

        elif action == "settings":
            self._require(is_owner and self.status == "lobby", "настройки меняет создатель в лобби")
            barrel = msg.get("barrel", self.settings["barrel"])
            timer = int(msg.get("timer", self.settings["timer"]))
            if barrel not in BARREL_MODES or timer not in TIMER_OPTIONS:
                raise GameError("неверные настройки")
            self.settings = {"barrel": barrel, "timer": timer}
            await self.manager.notify("lobby_update", self)

        elif action == "start":
            self._require(is_owner and self.status == "lobby", "начать может только создатель")
            self._require(len(self.members) >= 1, "нет игроков")
            self.game = Game(list(self.members.items()), barrel=self.settings["barrel"])
            self.status = "game"
            await self.manager.notify("game_started", self)

        elif action == "order_roll":
            events = self._game().order_roll(uid)

        elif action == "order_roll_all":
            self._require(is_owner, "только создатель")
            g = self._game()
            self._require(g.phase == "order", "очерёдность уже определена")
            events = g.timeout()

        elif action == "roll":
            events = self._game().roll(uid)

        elif action == "stop":
            events = self._game().stop(uid)

        elif action == "leave":
            await self._remove(uid)
            await self.send_to(ws, {"type": "left"})
            return

        elif action == "kick":
            self._require(is_owner, "исключать может только создатель")
            target = int(msg.get("uid", 0))
            self._require(target != self.owner, "нельзя исключить себя")
            await self._remove(target)
            for c, cu in list(self.clients.items()):
                if cu == target:
                    await self.send_to(c, {"type": "kicked"})
            return

        elif action == "rematch":
            self._require(is_owner and self.status == "finished", "реванш предлагает создатель после игры")
            if self.game:
                self.members = {p.uid: p.name for p in self.game.players} or self.members
            self.game = None
            self.status = "lobby"
            self.lobby_msg_id = None
            await self.manager.notify("lobby_update", self)

        elif action == "end":
            self._require(is_owner, "завершить может только создатель")
            await self.cancel()
            return

        else:
            raise GameError("неизвестное действие")

        await self._after(events)

    def _require(self, cond: bool, err: str) -> None:
        if not cond:
            raise GameError(err)

    def _game(self) -> Game:
        if self.status != "game" or not self.game:
            raise GameError("игра не идёт")
        return self.game

    async def _remove(self, uid: int) -> None:
        if self.status == "lobby":
            self.members.pop(uid, None)
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
            if self.game.phase == "finished":
                self.status = "finished"
                self._cancel_timer()
                if self.game.winner is not None:
                    self.manager.record(self)
                await self.manager.notify("game_over", self)
            else:
                self._restart_timer()
        await self.broadcast()

    async def cancel(self) -> None:
        self.status = "cancelled"
        self._cancel_timer()
        await self.manager.notify("cancelled", self)
        await self.broadcast()

    # ---------- таймер ----------

    def _cancel_timer(self) -> None:
        self.deadline = None
        self._timer_token += 1
        if self._timer_task:
            self._timer_task.cancel()
            self._timer_task = None

    def _restart_timer(self) -> None:
        self._cancel_timer()
        secs = self.settings["timer"]
        if not secs or self.status != "game":
            return
        self.deadline = time.time() + secs + ANIMATION_GRACE
        token = self._timer_token
        self._timer_task = asyncio.create_task(self._timer(token, secs + ANIMATION_GRACE))

    async def _timer(self, token: int, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        if token != self._timer_token or self.status != "game" or not self.game:
            return
        self._timer_task = None
        try:
            events = self.game.timeout()
            await self._after(events)
        except Exception:  # noqa: BLE001
            log.exception("timer failed in room %s", self.id)


class RoomManager:
    def __init__(self, stats: Stats | None = None):
        self.rooms: dict[str, Room] = {}
        self.stats = stats
        self.notifier = None  # объект с async-методами lobby_update/game_started/...

    def create(self, chat_id: int | None, owner_uid: int, owner_name: str) -> Room:
        self.cleanup()
        room = Room(self, chat_id, owner_uid, owner_name)
        self.rooms[room.id] = room
        return room

    def get(self, rid: str | None) -> Room | None:
        return self.rooms.get(rid or "")

    def active_in_chat(self, chat_id: int) -> Room | None:
        for r in self.rooms.values():
            if r.chat_id == chat_id and r.active:
                return r
        return None

    def rooms_of_user(self, uid: int) -> list[Room]:
        res = []
        for r in self.rooms.values():
            in_game = r.game and any(p.uid == uid for p in r.game.players)
            if r.status in ("lobby", "game", "finished") and (uid in r.members or in_game):
                res.append(r)
        res.sort(key=lambda r: (r.active, r.updated), reverse=True)
        return res

    def record(self, room: Room) -> None:
        if self.stats and room.chat_id is not None and room.game:
            self.stats.record_game(room.chat_id, room.game.players, room.game.winner)

    async def notify(self, method: str, room: Room, *args) -> None:
        if not self.notifier or room.chat_id is None:
            return
        try:
            await getattr(self.notifier, method)(room, *args)
        except Exception:  # noqa: BLE001 — сбой Telegram не должен ломать игру
            log.exception("notifier.%s failed", method)

    def cleanup(self) -> None:
        now = time.time()
        for rid, r in list(self.rooms.items()):
            idle = now - r.updated
            if (not r.active and idle > 6 * 3600) or idle > 3 * 24 * 3600:
                if not r.clients:
                    del self.rooms[rid]
