"""Роли и константы протокола комнат."""
from __future__ import annotations

from .. import config

MAX_PLAYERS = config.MAX_PLAYERS
TIMER_OPTIONS = (0, 30, 60, 120)
ANIMATION_GRACE = 2.5  # секунд на анимацию броска сверх таймера
REACTIONS = ("😂", "😱", "👏", "🔥", "😭", "🤡", "💩", "🍀")
GAME_ACTIONS = {"roll", "stop", "order_roll", "order_roll_all"}
# админ-команды, которым не нужна комната (работают и с экрана «нет игры»)
ADMIN_GLOBAL_OPS = {"grant_skin", "dice_list", "dice_save", "dice_delete"}


def is_admin(uid: int | None) -> bool:
    return uid in config.ADMIN_IDS
