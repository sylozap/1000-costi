"""WebSocket-сессии, аутентификация и отправка команд в комнату."""
from __future__ import annotations

import json
import logging

from aiohttp import WSMsgType, web

from .. import config
from ..auth import display_name, validate_init_data
from ..engine import GameError
from ..rooms import ADMIN_GLOBAL_OPS, RoomManager, is_admin

log = logging.getLogger(__name__)


def make_ws_handler(manager: RoomManager):
    async def ws_handler(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=8 * 1024 * 1024)  # картинки граней кубиков
        await ws.prepare(request)
        uid: int | None = None
        name = ""
        room = None
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                kind = data.get("type")
                if kind == "hello":
                    auth = validate_init_data(data.get("initData", ""), config.BOT_TOKEN)
                    if auth:
                        uid, name = int(auth["user"]["id"]), display_name(auth["user"])
                        start_param = auth.get("start_param")
                    elif config.DEV_MODE and data.get("dev_uid"):
                        uid, name, start_param = int(data["dev_uid"]), str(data.get("dev_name", "dev"))[:32], None
                    else:
                        await ws.send_json({"type": "error", "code": "auth",
                                            "message": "Открой игру из Telegram"})
                        continue
                    if room:
                        await room.detach(ws)
                        room = None
                    target = manager.get(data.get("room") or start_param)
                    if not target:
                        mine = manager.rooms_of_user(uid)
                        target = mine[0] if mine and mine[0].active else None
                    if not target:
                        await ws.send_json({"type": "no_room", "uid": uid, "is_admin": is_admin(uid)})
                        continue
                    room = target
                    await ws.send_json({"type": "hello_ok", "uid": uid, "name": name, "room": room.id,
                                        "is_admin": is_admin(uid)})
                    await room.attach(ws, uid, name, spectate=bool(data.get("spectate")))
                    continue
                if kind == "admin" and data.get("op") == "rooms" and is_admin(uid):
                    # список комнат доступен админу и без входа в комнату
                    await ws.send_json({"type": "admin_rooms", "list": manager.rooms_overview()})
                    continue
                if kind == "admin" and data.get("op") in ADMIN_GLOBAL_OPS and is_admin(uid) and room is None:
                    try:
                        await manager.admin_global(uid, data, ws.send_json)
                    except GameError as e:
                        await ws.send_json({"type": "error", "message": str(e)})
                    continue
                if uid is None or room is None:
                    await ws.send_json({"type": "error", "message": "нет подключения к игре"})
                    continue
                try:
                    await room.handle(uid, name, data, ws)
                except GameError as e:
                    await ws.send_json({"type": "error", "message": str(e)})
                except Exception:  # noqa: BLE001
                    log.exception("action failed: %s", data)
                    await ws.send_json({"type": "error", "message": "ошибка сервера"})
        finally:
            if room:
                await room.detach(ws)
        return ws

    return ws_handler
