"""Профили игроков: скин кубиков и фишки. JSON-файл, переживает перезапуск."""
from __future__ import annotations

import time
from pathlib import Path

from .stats import _load, _save

# Скины кубиков: id → название. Внешний вид — в webapp/dice3d.js (SKINS).
PUBLIC_SKINS = {
    "ivory": "Классика",
    "onyx": "Оникс",
    "ruby": "Рубин",
    "sapphire": "Сапфир",
    "emerald": "Изумруд",
    "marble": "Мрамор",
    "wood": "Дерево",
    "neon": "Неон",
    "ice": "Лёд",
    "candy": "Карамель",
    "bone": "Кость",
}
# личные скины: только у тех, кому выдал админ (золото — у админов всегда)
PERSONAL_SKINS = {
    "gold": "Золото",
    "pink": "Розовый перламутр",
}
ALL_SKINS = {**PUBLIC_SKINS, **PERSONAL_SKINS}
# выдано по умолчанию (можно поменять в админ-панели)
DEFAULT_GRANTS = {6582586667: ["pink"]}

MAPS = {
    "felt": "Сукно",
    "octagon": "Октагон MMA",
    "ring": "Ринг",
    "bar": "Барная стойка",
    "casino": "Казино",
    "space": "Космос",
    "beach": "Пляж",
    "snow": "Снег",
}

START_CHIPS = 1000
DAILY_BONUS = 100
DAILY_BONUS_BELOW = 200
STAKES = (0, 50, 100, 250)


def _today() -> str:
    return time.strftime("%Y-%m-%d")


class Profiles:
    def __init__(self, path: Path | None, custom=None):
        self.path = path
        self.custom = custom  # game.customdice.CustomDice — кубики с картинками (личные скины «c_…»)
        self.data = _load(path) if path else {}
        self.data.setdefault("users", {})

    def _save(self) -> None:
        if self.path:
            _save(self.path, self.data)

    def _user(self, uid: int) -> dict:
        u = self.data["users"].setdefault(str(uid), {})
        if "chips" not in u:
            u["chips"] = START_CHIPS
        if "grants" not in u:
            u["grants"] = list(DEFAULT_GRANTS.get(uid, []))
        return u

    # ---------- скины ----------

    def _personal(self, skin: str) -> bool:
        return skin in PERSONAL_SKINS or bool(self.custom and self.custom.exists(skin))

    def allowed_skins(self, uid: int, admin: bool = False) -> list[str]:
        res = list(PUBLIC_SKINS) + [s for s in self._user(uid)["grants"] if self._personal(s)]
        if admin and "gold" not in res:
            res.append("gold")
        return res

    def skin(self, uid: int, admin: bool = False, admin_gold: bool = True) -> str:
        u = self._user(uid)
        allowed = self.allowed_skins(uid, admin)
        if u.get("skin") in allowed:
            return u["skin"]
        if admin and admin_gold:
            return "gold"
        personal = [s for s in u["grants"] if self._personal(s)]
        return personal[0] if personal else "ivory"

    def set_skin(self, uid: int, skin: str, admin: bool = False) -> None:
        if skin not in self.allowed_skins(uid, admin):
            raise ValueError("этот скин недоступен")
        self._user(uid)["skin"] = skin
        self._save()

    def grant(self, uid: int, skin: str, on: bool) -> None:
        if not self._personal(skin):
            raise ValueError("выдавать можно только личные скины")
        u = self._user(uid)
        if on and skin not in u["grants"]:
            u["grants"].append(skin)
            u["skin"] = skin
        elif not on and skin in u["grants"]:
            u["grants"].remove(skin)
        self._save()

    def owners(self, skin: str) -> list[int]:
        return [int(uid) for uid, u in self.data["users"].items() if skin in u.get("grants", [])]

    def revoke_all(self, skin: str) -> None:
        """Скин удалён: забрать у всех; кто им пользовался — вернётся к обычным кубикам."""
        for u in self.data["users"].values():
            if skin in u.get("grants", []):
                u["grants"].remove(skin)
            if u.get("skin") == skin:
                u.pop("skin")
        self._save()

    # ---------- фишки ----------

    def chips(self, uid: int) -> int:
        """Баланс; раз в сутки +100, если фишек мало."""
        u = self._user(uid)
        if u["chips"] < DAILY_BONUS_BELOW and u.get("bonus_day") != _today():
            u["chips"] += DAILY_BONUS
            u["bonus_day"] = _today()
            self._save()
        return u["chips"]

    def add_chips(self, uid: int, amount: int) -> int:
        u = self._user(uid)
        u["chips"] = max(0, u["chips"] + amount)
        self._save()
        return u["chips"]

    def set_chips(self, uid: int, value: int) -> None:
        self._user(uid)["chips"] = max(0, int(value))
        self._save()
