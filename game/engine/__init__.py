"""Интерфейс игрового ядра без зависимостей от транспорта."""
from __future__ import annotations

from ..rules import BARREL_MODES, TARGET
from .game import Game
from .models import TEAM_NAMES, GameError, Player, Side


__all__ = ["Game", "GameError", "Player", "Side", "TARGET", "BARREL_MODES", "TEAM_NAMES"]
