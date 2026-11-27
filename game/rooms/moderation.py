"""Действия администратора внутри комнаты."""
from __future__ import annotations

import json
from typing import TYPE_CHECKING

from ..ai import is_bot
from ..engine import GameError
from .access import ADMIN_GLOBAL_OPS

if TYPE_CHECKING:
    from .room import Room


async def handle_admin(room: Room, uid: int, name: str, msg: dict, ws) -> None:
    op = msg.get("op")
    room._audit(uid, name, f"admin:{op}", json.dumps({k: v for k, v in msg.items() if k not in ("type", "op")},
                                                     ensure_ascii=False)[:200])
    if op == "audit":
        await room.send_to(ws, {"type": "admin_audit", "list": room.audit[-200:]})
        return
    if op == "rooms":
        await room.send_to(ws, {"type": "admin_rooms", "list": room.manager.rooms_overview()})
        return
    if op == "cosmetics":
        prefs = room.manager.admin_prefs.setdefault(uid, {})
        for k in ("gold", "badge"):
            if k in msg:
                prefs[k] = bool(msg[k])
        room.manager.save_admin_prefs()
        await room.manager.broadcast_all()
        return
    if op in ADMIN_GLOBAL_OPS:
        await room.manager.admin_global(uid, msg, lambda obj: room.send_to(ws, obj))
        await room.manager.broadcast_all()
        return
    if op == "chips":
        target = int(msg.get("uid", 0))
        room._require(not is_bot(target), "у ботов нет фишек")
        room.manager.profiles.set_chips(target, int(msg.get("value", 0)))
        await room.broadcast()
        return
    if op == "announce":
        text = str(msg.get("text") or "").strip()[:140]
        if text:
            await room.send_all({"type": "announce", "text": text})
        return
    if op == "end":
        await room.cancel()
        return
    if op == "games":
        await room.send_to(ws, {"type": "admin_games", "list": room.manager.games_overview(), "here": room.chat_id})
        return
    if op in ("game_off", "game_on", "game_purge"):
        gid = str(msg.get("id") or "")
        try:
            text = {"game_off": room.manager.exclude_game, "game_on": room.manager.restore_game,
                    "game_purge": room.manager.purge_game}[op](gid)
        except ValueError as e:
            raise GameError(str(e)) from None
        await room.send_to(ws, {"type": "admin_games", "list": room.manager.games_overview(), "here": room.chat_id,
                                "text": text})
        await room.manager.broadcast_all()  # фишки и ачивки могли измениться
        return
    if op == "kick":
        await room._kick(int(msg.get("uid", 0)))
        return
    if op in ("pause", "resume"):
        room._require(room.status == "game", "игра не идёт")
        room.paused = op == "pause"
        if room.paused:
            room._cancel_timer()
        else:
            room._restart_timer()
            room._schedule_bot()
        await room.broadcast()
        return

    # счёт, болты, самосвал и отмену хода админ менять не может — только честная игра
    raise GameError("неизвестная команда")
