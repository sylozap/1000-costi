"""HTTP-точки входа и раздача Mini App."""
from __future__ import annotations

from aiohttp import web

from .. import config
from ..customdice import ID_RE
from ..rooms import RoomManager
from .socket import make_ws_handler


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

    async def dice_face(request: web.Request) -> web.StreamResponse:
        """Картинка грани кубика: /dice/<id>/<1..6>?v=<версия> (версия в адресе — можно кэшировать надолго)."""
        did = request.match_info["did"]
        try:
            n = int(request.match_info["n"])
        except ValueError:
            raise web.HTTPNotFound() from None
        path = manager.custom.face_path(did, n) if ID_RE.match(did) else None
        if not path or not path.exists():
            raise web.HTTPNotFound()
        resp = web.FileResponse(path)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    app.router.add_get("/", index)
    app.router.add_get("/dice/{did}/{n}", dice_face)
    app.router.add_get("/ws", make_ws_handler(manager))
    app.router.add_static("/static/", config.WEBAPP_DIR)

    if config.DEV_MODE:
        async def dev_new(request: web.Request) -> web.Response:
            room = manager.create(None, int(request.query.get("uid", 1)), request.query.get("name", "Dev"))
            return web.json_response({"room": room.id})
        app.router.add_get("/dev/new", dev_new)

    return app
