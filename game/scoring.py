"""Подсчёт очков одного броска (кубики компонуются по максимальной комбинации)."""
from collections import Counter

SMALL_STRAIGHT = [1, 2, 3, 4, 5]
LARGE_STRAIGHT = [2, 3, 4, 5, 6]

# множитель для 3/4/5 одинаковых кубиков
SET_MULT = {3: 10, 4: 20, 5: 100}


def face_base(face: int) -> int:
    """Номинал грани для комбинаций: у единицы 10, у остальных — само число."""
    return 10 if face == 1 else face


def score_roll(dice: list[int]) -> tuple[int, list[int]]:
    """Возвращает (очки, индексы очковых кубиков) для одного броска.

    Комбинации засчитываются только внутри одного броска.
    """
    if len(dice) == 5:
        s = sorted(dice)
        if s == SMALL_STRAIGHT:
            return 125, list(range(5))
        if s == LARGE_STRAIGHT:
            return 250, list(range(5))

    counts = Counter(dice)
    points = 0
    scoring_faces = set()
    for face, c in counts.items():
        if c >= 3:
            points += face_base(face) * SET_MULT[c]
            scoring_faces.add(face)
        elif face == 1:
            points += 10 * c
            scoring_faces.add(face)
        elif face == 5:
            points += 5 * c
            scoring_faces.add(face)

    idx = [i for i, d in enumerate(dice) if d in scoring_faces]
    return points, idx
