"""Настраиваемые правила: схема, проверка, пресеты, описание и подсказка риска."""
from __future__ import annotations

import copy
import itertools
import json
from functools import lru_cache

from .scoring import DEFAULT_SCORING, score_roll

TARGET = 1000
BARREL_MODES = ("none", "points", "open", "knock")
TIE_RULES = ("none", "penalty", "zero")
HOT_DICE_MODES = ("strict", "safe", "free")
FIVE_ONES_MODES = ("none", "first", "any")
MAX_PITS = 3


class RulesError(ValueError):
    pass


CLASSIC: dict = {
    "open_min": 50,                 # порог открытия (0 — без открытия)
    "bolts_before_open": False,     # болты и до открытия (штраф копится долгом)
    "pits_on": True,
    "pits": [[200, 300], [600, 700]],  # [нижняя, верхняя): на верхней границе игрок уже вне ямы
    "overtake_penalty": 50,         # 0 — без штрафа за обгон
    "tie_rule": "none",             # равенство: none — ничего, penalty — как обгон, zero — соперник обнуляется
    "samosval_on": True,
    "samosval": 555,
    "bolts_on": True,
    "bolts_limit": 3,
    "bolt_penalty": 100,
    "bolts_in_pit": False,
    "bolts_on_barrel": False,
    "bolts_reset_on_commit": True,  # любая запись очков сбрасывает болты
    "barrel": "none",               # none | points | open | knock
    "barrel_start": 880,
    "barrel_attempts": 3,
    "barrel_penalty": 100,
    "barrel_falls": 3,
    "knock_drop": 100,              # knock: сброшенный с бочки падает на barrel_start − knock_drop
    "dots_limit": 6,
    "dot_penalty": 100,
    "dot_penalties_limit": 3,
    "hot_dice": "strict",           # strict — подтверждающий бросок обязателен, пустой сжигает всё;
                                    # safe — обязателен, пустой: набранное записывается; free — не нужен
    "roll_limit": 0,                # 0 — без лимита бросков за ход
    "scoring": dict(DEFAULT_SCORING),
}

VARIANT2: dict = copy.deepcopy(CLASSIC)
VARIANT2.update({
    "open_min": 75,
    "bolts_before_open": True,
    "tie_rule": "zero",
    "barrel": "knock",
    "barrel_start": 850,
})

BUILTIN_PRESETS = {
    "classic": ("Классика", CLASSIC),
    "v2": ("Вариант 2", VARIANT2),
}

# поле: (минимум, максимум, шаг)
_INT_FIELDS = {
    "open_min": (0, 500, 5),
    "overtake_penalty": (0, 500, 5),
    "samosval": (5, 995, 5),
    "bolts_limit": (1, 10, 1),
    "bolt_penalty": (0, 500, 5),
    "barrel_start": (300, 995, 5),
    "barrel_attempts": (1, 10, 1),
    "barrel_penalty": (0, 500, 5),
    "barrel_falls": (1, 10, 1),
    "knock_drop": (0, 500, 5),
    "dots_limit": (1, 20, 1),
    "dot_penalty": (0, 500, 5),
    "dot_penalties_limit": (1, 10, 1),
    "roll_limit": (0, 10, 1),
}
_BOOL_FIELDS = ("bolts_before_open", "pits_on", "samosval_on", "bolts_on", "bolts_in_pit",
                "bolts_on_barrel", "bolts_reset_on_commit")
_CHOICE_FIELDS = {"tie_rule": TIE_RULES, "barrel": BARREL_MODES, "hot_dice": HOT_DICE_MODES}
_SCORING_INT = {
    "one": (0, 100, 5), "five": (0, 100, 5),
    "mult3": (0, 1000, 1), "mult4": (0, 1000, 1), "mult5": (0, 1000, 1),
    "small_straight": (0, 2000, 5), "large_straight": (0, 2000, 5),
}


def _int(name: str, value, lo: int, hi: int, step: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise RulesError(f"{name}: нужно число")
    try:
        v = int(float(value))
    except ValueError:
        raise RulesError(f"{name}: нужно число") from None
    if not lo <= v <= hi:
        raise RulesError(f"{name}: допустимо от {lo} до {hi}")
    if v % step:
        raise RulesError(f"{name}: должно делиться на {step}")
    return v


def normalize(raw: dict | None) -> dict:
    """Проверяет правила и дополняет недостающее значениями «Классики»."""
    if raw is None:
        return copy.deepcopy(CLASSIC)
    if not isinstance(raw, dict):
        raise RulesError("правила должны быть объектом")
    r = copy.deepcopy(CLASSIC)
    for k, v in raw.items():
        if k in _INT_FIELDS:
            r[k] = _int(k, v, *_INT_FIELDS[k])
        elif k in _BOOL_FIELDS:
            r[k] = bool(v)
        elif k in _CHOICE_FIELDS:
            if v not in _CHOICE_FIELDS[k]:
                raise RulesError(f"{k}: неизвестное значение")
            r[k] = v
        elif k == "pits":
            r["pits"] = _pits(v)
        elif k == "scoring":
            if not isinstance(v, dict):
                raise RulesError("scoring: нужен объект")
            for sk, sv in v.items():
                if sk in _SCORING_INT:
                    r["scoring"][sk] = _int(sk, sv, *_SCORING_INT[sk])
                elif sk == "five_ones":
                    if sv not in FIVE_ONES_MODES:
                        raise RulesError("five_ones: неизвестное значение")
                    r["scoring"]["five_ones"] = sv
        # неизвестные ключи молча игнорируем: так старые ссылки на пресеты не ломаются
    if r["barrel"] in ("points", "knock") and r["barrel_start"] >= TARGET:
        raise RulesError("бочка должна начинаться ниже 1000")
    return r


def _pits(v) -> list[list[int]]:
    if not isinstance(v, list) or len(v) > MAX_PITS:
        raise RulesError(f"ямы: не больше {MAX_PITS}")
    pits = []
    for p in v:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise RulesError("яма задаётся парой границ")
        lo = _int("яма", p[0], 5, 990, 5)
        hi = _int("яма", p[1], 10, 995, 5)
        if lo >= hi:
            raise RulesError("у ямы нижняя граница должна быть меньше верхней")
        pits.append([lo, hi])
    pits.sort()
    for a, b in zip(pits, pits[1:]):
        if b[0] < a[1]:
            raise RulesError("ямы не должны пересекаться")
    return pits


def same(a: dict, b: dict) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def builtin_label(rules: dict) -> str | None:
    for key, (title, preset) in BUILTIN_PRESETS.items():
        if same(rules, preset):
            return key
    return None


# ---------- риск ----------

@lru_cache(maxsize=64)
def _risk(scoring_json: str) -> tuple[float, ...]:
    sc = json.loads(scoring_json)
    res = []
    for n in range(1, 6):
        zero = sum(1 for d in itertools.product(range(1, 7), repeat=n) if score_roll(list(d), sc)[0] == 0)
        res.append(zero / 6 ** n)
    return tuple(res)


def risk_table(rules: dict) -> list[float]:
    """Вероятность пустого броска для 1..5 кубиков при текущей таблице очков."""
    return list(_risk(json.dumps(rules["scoring"], sort_keys=True)))


# ---------- описание ----------

BARREL_TITLES = {
    "none": "без бочки",
    "points": "бочка по очкам",
    "open": "открытая бочка (ровно 1000)",
    "knock": "бочка со сбросом",
}


def short_title(rules: dict) -> str:
    b = rules["barrel"]
    if b in ("points", "knock"):
        return f"{BARREL_TITLES[b]} {rules['barrel_start']}"
    return BARREL_TITLES[b]


def describe(rules: dict) -> list[tuple[str, str]]:
    """Правила человеческим языком: [(заголовок, текст)]."""
    sc = rules["scoring"]
    out = []

    def mult_text(m: int) -> str:
        return f"номинал × {m}" if m else "не считается"

    singles = []
    if sc["one"]:
        singles.append(f"1 = {sc['one']}")
    if sc["five"]:
        singles.append(f"5 = {sc['five']}")
    combo = [
        f"три одинаковых — {mult_text(sc['mult3'])} (три единицы = {sc['one'] * sc['mult3']})",
        f"четыре — {mult_text(sc['mult4'])} (четыре единицы = {sc['one'] * sc['mult4']})",
        f"пять — {mult_text(sc['mult5'])} (пять единиц = {sc['one'] * sc['mult5']})",
    ]
    if sc["small_straight"]:
        combo.append(f"стрит 1-2-3-4-5 = {sc['small_straight']}")
    if sc["large_straight"]:
        combo.append(f"стрит 2-3-4-5-6 = {sc['large_straight']}")
    if sc["five_ones"] == "first":
        combo.append("пять единиц первым броском хода — сразу победа")
    elif sc["five_ones"] == "any":
        combo.append("пять единиц любым броском — сразу победа")
    out.append(("Очки за бросок", "; ".join(singles + combo) + ". Комбинации — только внутри одного броска."))

    hot = {
        "strict": "все 5 кубиков сыграли — обязательный подтверждающий бросок всеми 5; пустой сжигает весь ход",
        "safe": "все 5 кубиков сыграли — обязательный подтверждающий бросок; если он пустой, набранное всё равно записывается",
        "free": "все 5 кубиков сыграли — можно сразу записать или бросать все 5 дальше",
    }[rules["hot_dice"]]
    turn = "Очковые кубики откладываются автоматически. Пустой бросок — очки хода сгорают. " + hot.capitalize() + "."
    if rules["roll_limit"]:
        turn += (f" Не больше {rules['roll_limit']} бросков за ход: после последнего набранное записывается само,"
                 f" а если записать нельзя — сгорает (без болта).")
    out.append(("Ход", turn))

    if rules["open_min"]:
        t = f"Первая запись — минимум {rules['open_min']} за ход."
        if rules["bolts_before_open"] and rules["bolts_on"]:
            t += " Болты считаются и до открытия, штраф копится долгом и гасится из записанных очков (открылся на 60 при долге 100 — остаётся долг 40)."
        out.append(("Открытие", t))
    else:
        out.append(("Открытие", "Не нужно — записывать можно с первого хода."))

    if rules["pits_on"] and rules["pits"]:
        pits = ", ".join(f"{lo}–{hi - 1}" for lo, hi in rules["pits"])
        out.append(("Ямы", f"{pits}: стоять в яме можно, но выбраться нужно за один ход, иначе очки хода сгорают."))
    else:
        out.append(("Ямы", "Нет."))

    if rules["overtake_penalty"]:
        t = f"Обогнал игрока — у него −{rules['overtake_penalty']} (у кого 0 — не штрафуют)."
    else:
        t = "Штрафа за обгон нет."
    t += {
        "none": " Если сравнялся — ничего.",
        "penalty": f" Сравнялся — тоже штраф −{rules['overtake_penalty']}.",
        "zero": " Ровно сравнялся — соперник обнуляется!",
    }[rules["tie_rule"]]
    out.append(("Обгон", t))

    if rules["bolts_on"]:
        where = []
        if not rules["bolts_in_pit"]:
            where.append("в яме")
        if not rules["bolts_on_barrel"]:
            where.append("на бочке")
        if not rules["bolts_before_open"]:
            where.append("до открытия")
        t = f"Пустой бросок = болт; {rules['bolts_limit']} болта = −{rules['bolt_penalty']}."
        if rules["bolts_reset_on_commit"]:
            t += " Любая запись очков сбрасывает болты."
        if where:
            t += " Не считаются " + ", ".join(where) + "."
        out.append(("Болты", t))
    else:
        out.append(("Болты", "Нет."))

    if rules["samosval_on"]:
        out.append(("Самосвал", f"Ровно {rules['samosval']} любым путём — счёт обнуляется. "
                                f"Попал на {rules['samosval']} по ходу бросков — ход сразу заканчивается."))

    b = rules["barrel"]
    if b == "none":
        t = "Без бочки: побеждает первый, кто наберёт 1000+."
    elif b == "open":
        t = (f"Открытая: нужно ровно 1000. Перебор — ход сгорает и ставится точка; {rules['dots_limit']} точек = "
             f"−{rules['dot_penalty']}; {rules['dot_penalties_limit']}-й такой штраф — счёт 0.")
    else:
        t = (f"С {rules['barrel_start']}+ садишься на бочку (перебор мимо бочки — садишься на {rules['barrel_start']}). "
             f"За {rules['barrel_attempts']} своих хода нужно за один ход добрать до 1000. Не вышло — падение "
             f"−{rules['barrel_penalty']}; {rules['barrel_falls']}-е падение — счёт 0.")
        if b == "knock":
            t += (f" На бочке только один: кто залез, сбрасывает сидящего на "
                  f"{rules['barrel_start'] - rules['knock_drop']}.")
        else:
            t += " На бочке могут сидеть несколько игроков."
    out.append(("Бочка", t))
    return out
