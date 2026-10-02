"""HTTP-сервер: раздаёт Mini App и обслуживает WebSocket игры."""
from __future__ import annotations

import json
import logging

from aiohttp import WSMsgType, web

from . import config
from .auth import display_name, validate_init_data
from .engine import GameError
from .rooms import RoomManager, is_admin

log = logging.getLogger(__name__)


@web.middleware
async def no_cache(request: web.Request, handler):
    resp = await handler(request)
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"  # Telegram-webview иначе держит старые файлы
    return resp


def create_app(manager: RoomManager) -> web.Application:
    app = web.Application(middlewares=[no_cache])

    async def index(request: web.Request) -> web.StreamResponse:
        resp = web.FileResponse(config.WEBAPP_DIR / "index.html")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    async def ws_handler(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=25)
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

    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/static/", config.WEBAPP_DIR)

    if config.DEV_MODE:
        async def dev_new(request: web.Request) -> web.Response:
            room = manager.create(None, int(request.query.get("uid", 1)), request.query.get("name", "Dev"))
            return web.json_response({"room": room.id})
        app.router.add_get("/dev/new", dev_new)

    return app
