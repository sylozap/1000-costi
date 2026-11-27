"""Маршрутизация команд WebSocket и действия в партии."""
from __future__ import annotations

import time
from typing import TYPE_CHECKING

from ..engine import Game, GameError
from ..history import chat_records
from ..phrases import STICKERS
from .access import GAME_ACTIONS, MAX_PLAYERS, REACTIONS, is_admin
from .lobby import handle_lobby
from .moderation import handle_admin

if TYPE_CHECKING:
    from .room import Room


async def handle_command(room: Room, uid: int, name: str, msg: dict, ws) -> None:
    action = msg.get("type")
    admin = is_admin(uid)
    if await handle_social(room, uid, name, msg, ws):
        return
    if await handle_lobby(room, uid, name, msg, ws, admin):
        return
    if action == "admin":
        if not admin:
            raise GameError("нет доступа")
        await handle_admin(room, uid, name, msg, ws)
        return
    await handle_match(room, uid, name, msg, ws)


async def handle_social(room: Room, uid: int, name: str, msg: dict, ws) -> bool:
    action = msg.get("type")

    if action == "react":
        emoji = msg.get("emoji")
        if emoji in REACTIONS and room._rate_ok(uid, 0.7):
            await room.send_all({"type": "reaction", "uid": uid, "name": name, "emoji": emoji})
        return True

    if action == "sticker":
        sid = msg.get("id")
        if sid in STICKERS and room._rate_ok(uid, 2.0):
            emoji, text = STICKERS[sid]
            await room.send_all({"type": "sticker", "uid": uid, "name": name, "id": sid,
                                 "emoji": emoji, "text": text})
        return True

    if action == "my_achievements":
        await room.send_to(ws, {"type": "achievements", "list": room.manager.achievements_of(uid)})
        return True

    if action == "my_profile":
        await room.send_to(ws, room.manager.profile_msg(uid))
        return True

    if action == "skin":
        try:
            room.manager.profiles.set_skin(uid, str(msg.get("id") or ""), is_admin(uid))
        except ValueError as e:
            raise GameError(str(e)) from None
        await room.send_to(ws, room.manager.profile_msg(uid))
        await room.manager.broadcast_all()
        return True

    if action == "profile_full":
        target = int(msg.get("uid") or uid)
        profile = room.manager.profile_full(target, viewer=uid, filters=msg.get("filters"), chat_id=room.chat_id)
        await room.send_to(ws, profile)
        return True

    if action == "records":
        await room.send_to(ws, {"type": "records", **chat_records(room.manager.history, room.chat_id)})
        return True

    if action == "game_detail":
        rec = room.manager.history.get(str(msg.get("id") or ""), include_off=is_admin(uid))
        room._require(rec is not None, "партия не найдена")
        await room.send_to(ws, {"type": "game_detail", "game": rec})
        return True
    return False


async def handle_match(room: Room, uid: int, name: str, msg: dict, ws) -> None:
    action = msg.get("type")
    is_owner = uid == room.owner
    events: list[dict] = []

    if action in GAME_ACTIONS and room.paused:
        raise GameError("игра на паузе")

    if action == "join":
        room._require(room.status in ("lobby", "game"), "партия уже закончилась")
        if room.status == "game":
            g = room._game()
            if any(p.uid == uid for p in g.players):
                await room.broadcast()
                return  # повторное нажатие и переподключение не сбрасывают счёт
            room._require(not g.teams, "в командную игру можно вступить только в лобби")
            room._require(len(g.players) < MAX_PLAYERS, "комната заполнена")
            # Взнос показывается на кнопке. Уже оплаченный взнос повторно не берём.
            cost = room.stake if uid not in room.stakes else 0
            room._require(room.manager.profiles.chips(uid) >= cost, "не хватает фишек на взнос")
            events = g.add_player(uid, name)
            if cost:
                room.manager.profiles.add_chips(uid, -cost)
                room.stakes[uid] = cost
            room.members[uid] = name
            room._audit(uid, name, "join", "вход в партию с 0 очками")
            await room.manager.notify("game_events", room, events)
            room._schedule_winprob(force=True)
            # Вход не перезапускает чужой таймер, бросок или задачу бота.
            await room.broadcast()
            return
        if uid not in room.members:
            if len(room.members) >= MAX_PLAYERS:
                raise GameError("комната заполнена")
            room.members[uid] = name
            room._auto_team(uid)
            await room.manager.notify("lobby_update", room)

    elif action == "start":
        room._require(is_owner and room.status == "lobby", "начать может только создатель")
        room._require(len(room.members) >= 1, "нет игроков")
        teams = room._teams_list() if room.teams_mode else None
        room._take_stakes()
        room.game = Game(list(room.members.items()), rules=room.rules, teams=teams)
        room.status = "game"
        room.started_at = time.time()
        room.duration = None
        room.winprob, room.winprob_hist, room._wp_turn = {}, [], None
        room._announced = {}
        room.rigged = False
        room._audit(uid, name, "start", room.preset_name())
        await room.manager.notify("game_started", room)

    elif action in GAME_ACTIONS:
        g = room._game()
        if action == "order_roll":
            events = g.order_roll(uid)
        elif action == "order_roll_all":
            room._require(is_owner, "только создатель")
            room._require(g.phase == "order", "очерёдность уже определена")
            events = g.timeout()
        elif action == "roll":
            events = g.roll(uid)
        else:
            events = g.stop(uid)
        room._audit_events(uid, name, action, events)

    elif action == "leave":
        await room._remove(uid)
        await room.send_to(ws, {"type": "left"})
        return

    elif action == "kick":
        room._require(is_owner, "исключать может только создатель")
        await room._kick(int(msg.get("uid", 0)))
        return

    elif action == "rematch":
        room._require(is_owner and room.status == "finished", "реванш предлагает создатель после игры")
        if room.game:
            room.members = {p.uid: p.name for p in room.game.players} or room.members
        room.game = None
        room.status = "lobby"
        room.lobby_msg_id = None
        await room.manager.notify("lobby_update", room)

    elif action == "end":
        room._require(is_owner, "завершить может только создатель")
        await room.cancel()
        return

    else:
        raise GameError("неизвестное действие")

    await room._after(events)
