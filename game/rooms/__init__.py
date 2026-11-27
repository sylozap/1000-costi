"""Интерфейс управления комнатами."""
from __future__ import annotations

from .access import ADMIN_GLOBAL_OPS, MAX_PLAYERS, is_admin
from .manager import RoomManager
from .room import Room


__all__ = ["ADMIN_GLOBAL_OPS", "BOT_DELAY", "MAX_PLAYERS", "Room", "RoomManager", "is_admin"]

BOT_DELAY = (1.6, 2.6)  # секунды между действиями бота для анимации броска
