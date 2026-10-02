import pytest

from game.engine import Game, GameError
from game.rules import CLASSIC, VARIANT2, RulesError, builtin_label, describe, normalize, risk_table
from game.scoring import score_roll
from tests.test_engine import FakeRng, turn


def make(rules=None, n=2):
    rng = FakeRng()
    g = Game([(i + 1, f"P{i + 1}") for i in range(n)], rules=rules, rng=rng)
    for i, p in enumerate(list(g.players)):
        rng.push(*[6 - i] * 5)
        g.order_roll(p.uid)
    assert g.phase == "play"
    return g, rng


def setp(g, uid, **kw):
    p = g.player(uid)
    for k, v in kw.items():
        setattr(p, k, v)
    g._reset_turn() if g.cur is p else None
    return p


ZERO = (2, 3, 4, 6, 6)


# ---------- схема ----------

def test_normalize_defaults_and_errors():
    assert normalize(None) == CLASSIC
    assert normalize({"open_min": 75})["open_min"] == 75
    with pytest.raises(RulesError):
        normalize({"open_min": 73})
    with pytest.raises(RulesError):
        normalize({"pits": [[200, 300], [250, 400]]})
    with pytest.raises(RulesError):
        normalize({"barrel": "weird"})
    with pytest.raises(RulesError):
        normalize({"scoring": {"five_ones": "maybe"}})
    assert normalize({"unknown_key": 1}) == CLASSIC


def test_presets_and_labels():
    assert builtin_label(normalize(None)) == "classic"
    assert builtin_label(normalize(VARIANT2)) == "v2"
    assert builtin_label(normalize({"open_min": 100})) is None
    assert len(describe(VARIANT2)) >= 7


def test_risk_table_classic():
    r = risk_table(CLASSIC)
    assert [round(x * 100) for x in r] == [67, 44, 28, 16, 8]


def test_risk_depends_on_scoring():
    no_fives = normalize({"scoring": {"five": 0}})
    assert risk_table(no_fives)[0] == pytest.approx(5 / 6)


# ---------- открытие ----------

def test_open_min_75():
    g, rng = make({"open_min": 75})
    turn(g, rng, (6, 6, 6, 2, 3), stop=False)  # 60 < 75
    assert not g.can_stop()


def test_no_opening():
    g, rng = make({"open_min": 0})
    turn(g, rng, (5, 2, 3, 3, 6))
    assert g.player(1).score == 5


def test_bolts_before_open_debt():
    g, rng = make({"bolts_before_open": True})
    for _ in range(3):
        turn(g, rng, ZERO, stop=False)  # P1
        turn(g, rng, ZERO, stop=False)  # P2
    p1 = g.player(1)
    assert p1.debt == 100 and p1.score == 0 and p1.bolts == 0
    turn(g, rng, (1, 1, 1, 2, 3), (1, 2))  # +110 при открытии, долг −100
    assert p1.score == 10 and p1.debt == 0 and p1.opened


# ---------- ямы ----------

def test_pits_off():
    g, rng = make({"pits_on": False})
    setp(g, 1, score=225, opened=True)
    turn(g, rng, (5, 2, 3, 3, 6))
    assert g.player(1).score == 230


def test_custom_pit():
    g, rng = make({"pits": [[400, 450]]})
    setp(g, 1, score=410, opened=True)
    turn(g, rng, (5, 2, 3, 3, 6), stop=False)
    assert not g.can_stop()
    g2, rng2 = make({"pits": [[400, 450]]})
    setp(g2, 1, score=225, opened=True)
    turn(g2, rng2, (5, 2, 3, 3, 6))  # 200–300 больше не яма
    assert g2.player(1).score == 230


def test_bolts_in_pit():
    g, rng = make({"bolts_in_pit": True})
    setp(g, 1, score=225, opened=True)
    turn(g, rng, ZERO, stop=False)
    assert g.player(1).bolts == 1


# ---------- обгон и равенство ----------

def test_tie_zero():
    g, rng = make({"tie_rule": "zero"})
    p1, p2 = g.players
    p1.score, p1.opened, p2.score, p2.opened = 300, True, 400, True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3))  # 300 + 100 = 400 — ровно сравнялся
    assert p1.score == 400 and p2.score == 0


def test_tie_penalty_and_none():
    g, rng = make({"tie_rule": "penalty", "overtake_penalty": 30})
    p1, p2 = g.players
    p1.score, p1.opened, p2.score, p2.opened = 300, True, 400, True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3))
    assert p2.score == 370
    g, rng = make()
    p1, p2 = g.players
    p1.score, p1.opened, p2.score, p2.opened = 300, True, 400, True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3))
    assert p2.score == 400


def test_overtake_off():
    g, rng = make({"overtake_penalty": 0})
    p1, p2 = g.players
    p1.score, p1.opened, p2.score, p2.opened = 300, True, 350, True
    g._reset_turn()
    turn(g, rng, (1, 1, 1, 2, 3))
    assert p2.score == 350


# ---------- самосвал и болты ----------

def test_samosval_custom_and_off():
    g, rng = make({"samosval": 335})
    setp(g, 1, score=275, opened=True)
    turn(g, rng, (6, 6, 6, 2, 3), stop=False)  # 335
    assert g.player(1).score == 0
    g, rng = make({"samosval_on": False})
    setp(g, 1, score=495, opened=True)
    turn(g, rng, (6, 6, 6, 2, 3))
    assert g.player(1).score == 555


def test_bolts_custom_limit_penalty():
    g, rng = make({"bolts_limit": 2, "bolt_penalty": 50})
    setp(g, 1, score=150, opened=True)
    turn(g, rng, ZERO, stop=False)
    turn(g, rng, ZERO, stop=False)
    turn(g, rng, ZERO, stop=False)
    assert g.player(1).score == 100 and g.player(1).bolts == 0


def test_bolts_off():
    g, rng = make({"bolts_on": False})
    setp(g, 1, score=150, opened=True)
    turn(g, rng, ZERO, stop=False)
    assert g.player(1).bolts == 0


# ---------- бочка со сбросом ----------

def test_knock_barrel():
    g, rng = make({"barrel": "knock", "barrel_start": 850})
    p1, p2 = g.players
    p1.score, p1.opened, p1.on_barrel = 860, True, True
    p2.score, p2.opened = 800, True
    g.current = 1
    g._reset_turn()
    turn(g, rng, (5, 5, 5, 2, 3))  # +50 -> 850: садится и сбрасывает P1 на 750
    assert p2.on_barrel and p2.score == 850
    assert not p1.on_barrel and p1.score == 750 and p1.barrel_falls == 0


def test_points_barrel_custom_attempts():
    g, rng = make({"barrel": "points", "barrel_attempts": 1, "barrel_penalty": 50})
    p1 = g.player(1)
    p1.score, p1.opened, p1.on_barrel = 900, True, True
    g._reset_turn()
    turn(g, rng, ZERO, stop=False)
    assert p1.score == 850 and not p1.on_barrel


# ---------- подтверждающий бросок ----------

def test_hot_safe_keeps_points():
    g, rng = make({"hot_dice": "safe"})
    setp(g, 1, score=100, opened=True)
    turn(g, rng, (2, 3, 4, 5, 6), stop=False)  # стрит 250 — все сыграли
    assert g.must_roll and not g.can_stop()
    rng.push(*ZERO)
    g.roll(1)  # подтверждение пустое — 250 записываются
    assert g.player(1).score == 350 and g.player(1).bolts == 0 and g.cur.uid == 2


def test_hot_strict_burns():
    g, rng = make()
    setp(g, 1, score=100, opened=True)
    turn(g, rng, (2, 3, 4, 5, 6), ZERO, stop=False)
    assert g.player(1).score == 100


def test_hot_free_can_stop():
    g, rng = make({"hot_dice": "free"})
    setp(g, 1, score=100, opened=True)
    turn(g, rng, (2, 3, 4, 5, 6))
    assert g.player(1).score == 350


# ---------- таблица очков ----------

def test_custom_scoring():
    sc = normalize({"scoring": {"mult4": 50, "small_straight": 0}})["scoring"]
    assert score_roll([6, 6, 6, 6, 2], sc)[0] == 300
    assert score_roll([1, 2, 3, 4, 5], sc)[0] == 15  # стрит выключен — считаются 1 и 5


def test_five_ones_any_and_none():
    g, rng = make({"scoring": {"five_ones": "any"}})
    setp(g, 1, score=0, opened=True)
    turn(g, rng, (5, 2, 3, 3, 6), (5, 2, 3, 6), (5, 2, 6), (5, 2), (5,), (1, 1, 1, 1, 1), stop=False)
    assert g.winner == 1
    g, rng = make({"scoring": {"five_ones": "none"}, "barrel": "points"})  # без бочки 1000 очков и так победа
    turn(g, rng, (1, 1, 1, 1, 1), stop=False)
    assert g.winner is None and g.must_roll


# ---------- лимит бросков ----------

def test_roll_limit_autocommit():
    g, rng = make({"roll_limit": 3})
    setp(g, 1, score=100, opened=True)
    turn(g, rng, (5, 2, 3, 3, 6), (5, 2, 3, 6), (5, 2, 6), stop=False)
    assert g.player(1).score == 115 and g.cur.uid == 2


def test_roll_limit_burns_without_bolt():
    g, rng = make({"roll_limit": 2})
    turn(g, rng, (5, 2, 3, 3, 6), (5, 2, 3, 6), stop=False)  # 10 < открытия
    assert g.player(1).score == 0 and g.player(1).bolts == 0 and g.cur.uid == 2


# ---------- админ ----------

def test_force_next_roll():
    g, rng = make()
    g.force_next([1, 1, 1, 1, 1])
    g.roll(1)
    assert g.last_roll["dice"] == [1, 1, 1, 1, 1] and g.winner == 1
    with pytest.raises(GameError):
        g.force_next([7])


def test_admin_set_score_and_barrel():
    g, rng = make({"barrel": "points"})
    g.admin_set_score(2, 900)
    assert g.player(2).on_barrel and g.player(2).opened
    g.admin_set_score(2, 100)
    assert not g.player(2).on_barrel


def test_snapshot_restore():
    g, rng = make()
    snap = g.snapshot()
    setp(g, 1, score=100, opened=True)
    turn(g, rng, (1, 1, 1, 2, 3))
    seq = g._ev_seq
    g.restore_from(snap)
    assert g.player(1).score == 0 and g.cur.uid == 1 and g._ev_seq == seq and g.last_roll is None


def test_set_rules_midgame_drops_barrel():
    g, rng = make({"barrel": "points"})
    g.admin_set_score(1, 900)
    g.set_rules({"barrel": "none"})
    assert not g.player(1).on_barrel
