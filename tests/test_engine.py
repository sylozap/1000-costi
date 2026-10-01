import pytest

from game.engine import Game, GameError
from game.scoring import score_roll


class FakeRng:
    """Выдаёт заранее заданные значения кубиков."""

    def __init__(self, dice=()):
        self.queue = list(dice)

    def push(self, *dice):
        self.queue += dice

    def randint(self, a, b):
        if b == 6:
            return self.queue.pop(0)
        return 1


def make(n=2, barrel="none"):
    rng = FakeRng()
    g = Game([(i + 1, f"P{i + 1}") for i in range(n)], barrel=barrel, rng=rng)
    # очерёдность: P1 > P2 > ...
    for i, p in enumerate(list(g.players)):
        rng.push(*[6 - i] * 5)
        g.order_roll(p.uid)
    assert g.phase == "play"
    assert [p.uid for p in g.players] == list(range(1, n + 1))
    return g, rng


def turn(g, rng, *rolls, stop=True):
    uid = g.cur.uid
    for r in rolls:
        rng.push(*r)
        g.roll(uid)
    if stop:
        g.stop(uid)


# ---------- подсчёт ----------

@pytest.mark.parametrize("dice,points,n", [
    ([1, 2, 3, 4, 5], 125, 5),
    ([2, 3, 4, 5, 6], 250, 5),
    ([1, 1, 1, 2, 3], 100, 3),
    ([1, 1, 1, 1, 3], 200, 4),
    ([1, 1, 1, 1, 1], 1000, 5),
    ([2, 2, 2, 3, 4], 20, 3),
    ([2, 2, 2, 2, 2], 200, 5),
    ([5, 5, 5, 5, 3], 100, 4),
    ([6, 6, 6, 1, 5], 75, 5),
    ([4, 4, 4, 4, 1], 90, 5),
    ([2, 3, 4, 6, 6], 0, 0),
    ([1, 5, 3, 3, 6], 15, 2),
    ([3, 3], 0, 0),
])
def test_score(dice, points, n):
    p, idx = score_roll(dice)
    assert p == points and len(idx) == n


# ---------- открытие ----------

def test_cannot_stop_before_opening():
    g, rng = make()
    rng.push(1, 2, 3, 4, 6)  # 10
    g.roll(1)
    assert not g.can_stop()
    with pytest.raises(GameError):
        g.stop(1)
    rng.push(1, 5, 3, 4)  # +15 = 25
    g.roll(1)
    assert not g.can_stop()
    rng.push(1, 5)  # +15 = 40 -> все сыграли
    g.roll(1)
    assert g.must_roll and not g.can_stop()
    rng.push(1, 2, 3, 4, 6)  # +10 = 50
    g.roll(1)
    g.stop(1)
    assert g.player(1).score == 50 and g.player(1).opened


def test_no_bolt_before_opening():
    g, rng = make()
    turn(g, rng, (2, 3, 4, 6, 6), stop=False)
    assert g.player(1).bolts == 0 and g.cur.uid == 2


def test_hot_dice_must_roll():
    g, rng = make()
    turn(g, rng, (2, 3, 4, 5, 6), stop=False)
    assert g.must_roll and g.dice_left == 5 and not g.can_stop()


# ---------- болты ----------

def test_bolts_penalty():
    g, rng = make()
    turn(g, rng, (1, 1, 1, 2, 3), (5, 2))  # 105
    turn(g, rng, (2, 3, 4, 6, 6), stop=False)  # P2 не открыт, без болта
    p1 = g.player(1)
    assert p1.score == 105
    for i in range(3):
        turn(g, rng, (2, 3, 4, 6, 6), stop=False)
        turn(g, rng, (2, 3, 4, 6, 6), stop=False)
    assert p1.score == 5 and p1.bolts == 0


def test_commit_resets_bolts():
    g, rng = make()
    p1 = g.player(1)
    p1.score, p1.opened, p1.bolts = 105, True, 2
    g._reset_turn()
    turn(g, rng, (5, 2, 3, 3, 6))  # +5 — минимальная запись
    assert p1.score == 110 and p1.bolts == 0
    turn(g, rng, (2, 3, 4, 6, 6), stop=False)  # P2
    turn(g, rng, (2, 3, 4, 6, 6), stop=False)  # P1: болт 1, а не третий
    assert p1.score == 110 and p1.bolts == 1


# ---------- ямы ----------

def test_pit():
    g, rng = make()
    g.player(1).score, g.player(1).opened = 225, True
    g._reset_turn()
    turn(g, rng, (1, 2, 3, 4, 6), (5, 2, 3, 4), stop=False)  # 15 — мало
    assert not g.can_stop()
    rng.push(1, 1, 3)  # +20 = 35 < 75
    g.roll(1)
    assert not g.can_stop()
    rng.push(6)  # пусто — без болта
    g.roll(1)
    assert g.player(1).score == 225 and g.player(1).bolts == 0


def test_land_in_pit_allowed():
    g, rng = make()
    g.player(1).score, g.player(1).opened = 150, True
    g._reset_turn()
    turn(g, rng, (6, 6, 6, 1, 2))  # +70 -> 220
    assert g.player(1).score == 220


# ---------- самосвал, обгон ----------

def test_samosval():
    g, rng = make()
    g.player(1).score, g.player(1).opened = 495, True
    g._reset_turn()
    turn(g, rng, (6, 6, 6, 2, 3), stop=False)  # 495 + 60 = 555 — самосвал сразу
    assert g.player(1).score == 0 and g.player(1).opened and g.cur.uid == 2


def test_overtake_and_samosval_by_penalty():
    g, rng = make(3)
    p1, p2, p3 = g.players
    p1.score, p1.opened = 500, True
    p2.score, p2.opened = 605, True
    p3.score, p3.opened = 0, False
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3), (1, 2))  # +110 -> 610, обгон P2: 605-50=555 -> самосвал
    assert p1.score == 610 and p2.score == 0 and p3.score == 0


def test_overtake_from_equal():
    g, rng = make()
    p1, p2 = g.players
    p1.score = p2.score = 400
    p1.opened = p2.opened = True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3))
    assert p2.score == 350


# ---------- без бочки ----------

def test_win_none():
    g, rng = make()
    g.player(1).score, g.player(1).opened = 950, True
    g._reset_turn()
    turn(g, rng, (6, 6, 6, 2, 3), stop=False)
    assert g.phase == "finished" and g.winner == 1


# ---------- бочка по очкам ----------

def test_barrel_points_cap_and_win():
    g, rng = make(barrel="points")
    p1 = g.player(1)
    p1.score, p1.opened = 750, True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3), (1, 1), (1, 1, 1, 1, 1), (2, 2, 2, 3, 4), (1, 2))  # 750+1150 -> 880
    assert p1.score == 880 and p1.on_barrel
    turn(g, rng, (2, 3, 4, 6, 6), stop=False)  # P2
    rng.push(1, 1, 1, 2, 3)  # +100
    g.roll(1)
    assert not g.can_stop()
    rng.push(1, 2)  # +10 -> 990
    g.roll(1)
    rng.push(5)  # +5 = 995
    g.roll(1)
    rng.push(5, 2, 3, 6, 6)
    g.roll(1)  # +5 = 1000
    assert g.winner == 1


def test_barrel_real_score_and_falls():
    g, rng = make(barrel="points")
    p1 = g.player(1)
    p1.score, p1.opened = 860, True
    g._reset_turn()
    turn(g, rng, (1, 1, 2, 3, 4), (1, 2, 3))  # +30 -> 890 реальный счёт
    assert p1.score == 890 and p1.on_barrel
    for _ in range(3):
        turn(g, rng, (2, 3, 4, 6, 6), stop=False)  # P2
        turn(g, rng, (2, 3, 4, 6, 6), stop=False)  # P1 попытка
    assert p1.score == 790 and not p1.on_barrel and p1.barrel_falls == 1 and p1.bolts == 0


def test_barrel_third_fall_zero():
    g, rng = make(barrel="points")
    p1 = g.player(1)
    p1.score, p1.opened, p1.on_barrel, p1.barrel_falls, p1.barrel_attempts = 900, True, True, 2, 2
    g._reset_turn()
    turn(g, rng, (2, 3, 4, 6, 6), stop=False)
    assert p1.score == 0 and p1.barrel_falls == 0


def test_barrel_both_sit():
    g, rng = make(barrel="points")
    p1, p2 = g.players
    p1.score, p1.opened, p1.on_barrel = 900, True, True
    p2.score, p2.opened = 860, True
    g.current = 1
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3))  # +100 -> 960, обгоняет P1 -> 850, слетает
    assert p2.on_barrel and p2.score == 960
    assert p1.score == 850 and not p1.on_barrel and p1.barrel_falls == 0


def test_barrel_win_over_1000():
    g, rng = make(barrel="points")
    p1 = g.player(1)
    p1.score, p1.opened, p1.on_barrel = 900, True, True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 1, 3), stop=False)  # +200 -> 1100: на бочке перебор разрешён
    assert g.phase == "finished" and g.winner == 1


def test_points_exact_1000_without_barrel_is_not_win():
    g, rng = make(barrel="points")
    p1 = g.player(1)
    p1.score, p1.opened = 870, True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3), (1, 1), (1, 2, 3, 4, 6))  # +130 -> 1000 мимо бочки -> 880
    assert g.winner is None and p1.score == 880 and p1.on_barrel


# ---------- самосвал посреди хода, пять единиц ----------

def test_samosval_mid_turn():
    g, rng = make()
    p1 = g.player(1)
    p1.score, p1.opened = 500, True
    g._reset_turn()
    turn(g, rng, (5, 5, 5, 2, 3), stop=False)  # +50 -> 550
    assert g.cur.uid == 1
    rng.push(5, 3)  # +5 -> ровно 555
    g.roll(1)
    assert p1.score == 0 and g.cur.uid == 2 and g.turn_points == 0
    with pytest.raises(GameError):
        g.roll(1)


def test_five_ones_first_roll_wins():
    g, rng = make(barrel="open")
    p1 = g.player(1)
    p1.score, p1.opened = 300, True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 1, 1), stop=False)
    assert g.phase == "finished" and g.winner == 1


def test_five_ones_not_first_roll():
    g, rng = make(barrel="open")
    p1 = g.player(1)
    p1.score, p1.opened = 0, True
    g._reset_turn()
    turn(g, rng, (5, 2, 3, 3, 6), (5, 2, 3, 6), (5, 2, 6), (5, 2), (5,), stop=False)  # +25, все сыграли
    rng.push(1, 1, 1, 1, 1)  # пять единиц, но не первым броском: 25 + 1000 -> перебор
    g.roll(1)
    assert g.winner is None and p1.dots == 1


# ---------- открытая бочка ----------

def test_open_barrel_exact_and_dots():
    g, rng = make(barrel="open")
    p1 = g.player(1)
    p1.score, p1.opened = 980, True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3), stop=False)  # перебор
    assert p1.dots == 1 and p1.score == 980
    p1.dots = 5
    turn(g, rng, (2, 3, 4, 6, 6), stop=False)  # P2
    turn(g, rng, (1, 1, 1, 2, 3), stop=False)
    assert p1.dots == 0 and p1.score == 880 and p1.dot_penalties == 1
    turn(g, rng, (2, 3, 4, 6, 6), stop=False)
    turn(g, rng, (1, 1, 1, 1, 2), stop=False)  # 880+200 -> перебор
    assert p1.dots == 1


def test_open_barrel_win():
    g, rng = make(barrel="open")
    p1 = g.player(1)
    p1.score, p1.opened = 985, True
    g._reset_turn()
    turn(g, rng, (1, 5, 2, 3, 6), stop=False)  # +15 = 1000
    assert g.winner == 1


# ---------- очерёдность ----------

def test_order_ties():
    rng = FakeRng()
    g = Game([(1, "A"), (2, "B"), (3, "C")], rng=rng)
    rng.push(6, 6, 6, 6, 6)
    g.order_roll(1)  # 30
    rng.push(6, 6, 6, 6, 6)
    g.order_roll(2)  # 30 — ничья
    rng.push(1, 1, 1, 1, 1)
    g.order_roll(3)  # 5
    assert g.phase == "order"
    assert g.order_pending(g.player(1)) and g.order_pending(g.player(2))
    assert not g.order_pending(g.player(3))
    rng.push(1, 1, 1, 1, 2)
    g.order_roll(1)
    assert g.order_pending(g.player(2)) and g.phase == "order"
    rng.push(1, 1, 1, 1, 3)
    g.order_roll(2)
    assert g.phase == "play"
    assert [p.uid for p in g.players] == [2, 1, 3]


def test_timeout_order_and_play():
    rng = FakeRng([3] * 5 + [4] * 5)
    g = Game([(1, "A"), (2, "B")], rng=rng)
    g.timeout()
    assert g.phase == "play" and g.players[0].uid == 2
    g.timeout()  # ни одного броска — ход пропущен
    assert g.cur.uid == 1


def test_remove_current_player():
    g, rng = make(3)
    rng.push(1, 2, 3, 4, 6)
    g.roll(1)
    g.remove_player(1)
    assert g.cur.uid == 2 and g.turn_points == 0
