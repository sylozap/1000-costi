"""Запуск: веб-сервер Mini App + Telegram-бот в одном процессе."""
import asyncio
import logging

from aiohttp import web

from game import config
from game.rooms import RoomManager
from game.stats import Presets, Stats
from game.web import create_app


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    stats = Stats(config.DATA_DIR / "stats.json")
    presets = Presets(config.DATA_DIR / "presets.json")
    manager = RoomManager(stats, presets, data_dir=config.DATA_DIR)
    runner = web.AppRunner(create_app(manager))
    await runner.setup()
    await web.TCPSite(runner, config.HOST, config.PORT).start()
    logging.info("веб-сервер: http://%s:%s  (публичный адрес: %s)", config.HOST, config.PORT,
                 config.PUBLIC_URL or "не задан")
    try:
        if config.BOT_TOKEN:
            from game.bot import build_bot
            bot, dp = await build_bot(manager, stats, presets)
            await dp.start_polling(bot)
        else:
            logging.warning("BOT_TOKEN не задан — работает только веб-сервер (для DEV_MODE)")
            await asyncio.Event().wait()
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
