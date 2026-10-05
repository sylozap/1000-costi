"""Ачивки: список и проверка по фактам партии и карьерной статистике."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .engine import Game, Player

# id: (эмодзи, название, описание)
ACHIEVEMENTS: dict[str, tuple[str, str, str]] = {
    # игровые моменты
    "samosval": ("🚛", "Самосвал", "Попасть на самосвал"),
    "five_ones": ("🎯", "5 единиц", "Выбросить пять единиц"),
    "barrel_zero": ("💥", "Слетел с бочки 3 раза", "Упасть с бочки до обнуления"),
    "large_straight": ("🌈", "Большой стрит", "Выбросить 2-3-4-5-6"),
    "turn300": ("💰", "Жирный ход", "Записать 300+ за один ход"),
    "hot3": ("🔥", "Трижды горячие", "Три раза за ход сыграть всеми 5 кубиками"),
    "pit_one_roll": ("🪜", "Из ямы одним броском", "Выбраться из ямы с первого броска"),
    "barrel_first_try": ("🛢", "С бочки с первой попытки", "Победить на первой же попытке с бочки"),
    # неудачи
    "bolts3": ("🔩", "Три болта", "Получить штраф за болты"),
    "burned300": ("🔥", "Сгорело 300+", "Потерять 300+ очков на пустом броске"),
    "zero_finish": ("🥚", "Ноль на финише", "Закончить партию с 0 очков"),
    "overtaken3": ("🎯", "Мальчик для битья", "Тебя обогнали 3 раза за партию"),
    # реванши и камбэки
    "phoenix": ("🐦‍🔥", "Феникс", "Победить после самосвала в той же партии"),
    "from_last": ("🚀", "С последнего места", "Победить, побывав последним, когда лидер уже далеко"),
    "dry_win": ("🧊", "Всухую", "Победить, когда у всех соперников меньше 300"),
    # вехи
    "games10": ("🎲", "10 партий", "Сыграть 10 партий"),
    "games50": ("🎲", "50 партий", "Сыграть 50 партий"),
    "games100": ("🎲", "100 партий", "Сыграть 100 партий"),
    "wins10": ("🏆", "10 побед", "Выиграть 10 партий"),
    "samosvals5": ("🚚", "Автопарк", "5 самосвалов за карьеру"),
}

CAREER_IDS = {"games10", "games50", "games100", "wins10", "samosvals5"}

MOMENT_IDS = {"samosval", "five_ones", "barrel_zero", "large_straight", "turn300", "hot3", "pit_one_roll",
              "barrel_first_try", "bolts3", "burned300", "overtaken3"}


def moment_ids(p: Player) -> set[str]:
    """Ачивки, которые выдаются сразу по ходу партии."""
    return p.facts & MOMENT_IDS


def end_ids(game: Game, p: Player) -> set[str]:
    """Ачивки, которые определяются по итогам партии."""
    res = set()
    won = p.uid in (game.winners or [game.winner])
    others = [q for q in game.players if q.side is not p.side]
    if won:
        if "samosval" in p.facts:
            res.add("phoenix")
        if "was_far_last" in p.facts:
            res.add("from_last")
        if others and all(q.score < 300 for q in others):
            res.add("dry_win")
    elif others and p.score == 0:
        res.add("zero_finish")
    return res


def career_ids(row: dict) -> set[str]:
    res = set()
    for n in (10, 50, 100):
        if row.get("games", 0) >= n:
            res.add(f"games{n}")
    if row.get("wins", 0) >= 10:
        res.add("wins10")
    if row.get("samosvals", 0) >= 5:
        res.add("samosvals5")
    return res


def title(aid: str) -> str:
    emoji, name, _ = ACHIEVEMENTS[aid]
    return f"{emoji} «{name}»"
