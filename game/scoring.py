"""Подсчёт очков одного броска (кубики компонуются по максимальной комбинации)."""
from collections import Counter

SMALL_STRAIGHT = [1, 2, 3, 4, 5]
LARGE_STRAIGHT = [2, 3, 4, 5, 6]

# Классическая таблица. Комбинация из 3/4/5 одинаковых = номинал × множитель,
# номинал единицы = очки одиночной единицы (10), у остальных граней — само число.
DEFAULT_SCORING = {
    "one": 10, "five": 5,
    "mult3": 10, "mult4": 20, "mult5": 100,
    "small_straight": 125, "large_straight": 250,
    "five_ones": "first",  # none | first | any — пять единиц = мгновенная победа
}


def face_base(face: int, sc: dict | None = None) -> int:
    """Номинал грани для комбинаций: у единицы — очки одиночной единицы, у остальных — само число."""
    sc = sc or DEFAULT_SCORING
    return sc["one"] if face == 1 else face


def score_roll(dice: list[int], sc: dict | None = None) -> tuple[int, list[int]]:
    """Возвращает (очки, индексы очковых кубиков) для одного броска.

    Комбинации засчитываются только внутри одного броска.
    """
    sc = sc or DEFAULT_SCORING
    if len(dice) == 5:
        s = sorted(dice)
        if s == SMALL_STRAIGHT and sc["small_straight"] > 0:
            return sc["small_straight"], list(range(5))
        if s == LARGE_STRAIGHT and sc["large_straight"] > 0:
            return sc["large_straight"], list(range(5))

    mult = {3: sc["mult3"], 4: sc["mult4"], 5: sc["mult5"]}
    counts = Counter(dice)
    points = 0
    scoring_faces = set()
    for face, c in counts.items():
        if c >= 3 and mult[c] > 0:
            got = face_base(face, sc) * mult[c]
        elif face == 1:
            got = sc["one"] * c
        elif face == 5:
            got = sc["five"] * c
        else:
            got = 0
        if got > 0:
            points += got
            scoring_faces.add(face)

    idx = [i for i, d in enumerate(dice) if d in scoring_faces]
    return points, idx
