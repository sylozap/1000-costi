"""Настройки из переменных окружения и файла .env."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file(ROOT / ".env")

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
NGROK_DOMAIN = os.environ.get("NGROK_DOMAIN", "").removeprefix("https://").rstrip("/")
PUBLIC_URL = (os.environ.get("PUBLIC_URL") or (f"https://{NGROK_DOMAIN}" if NGROK_DOMAIN else "")).rstrip("/")
# Короткое имя Mini App из /newapp в BotFather. Пусто — используется «главное» Mini App бота.
WEBAPP_SHORT_NAME = os.environ.get("WEBAPP_SHORT_NAME", "")
# direct — кнопка в группе открывает игру сразу; private — через личку с ботом
ENTRY_MODE = os.environ.get("ENTRY_MODE", "direct")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
DEV_MODE = os.environ.get("DEV_MODE", "0") == "1"
MAX_PLAYERS = 8
WEBAPP_DIR = ROOT / "webapp"
# Администраторы бота (админ-панель): id пользователей Telegram через запятую
ADMIN_IDS = {int(x) for x in os.environ.get("ADMIN_IDS", "621983693").replace(" ", "").split(",") if x}
# Сколько секунд CPU на расчёт шансов на победу после каждого хода (0 — не считать)
WINPROB_BUDGET = float(os.environ.get("WINPROB_BUDGET", "0.6"))
