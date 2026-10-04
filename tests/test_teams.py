import pytest

from game.achievements import end_ids
from game.engine import Game, GameError
from game.stats import Stats
from tests.test_engine import FakeRng, turn

ZERO = (2, 3, 4, 6, 6)


def make_teams(teams=((1, 3), (2, 4)), rules=None):
    rng = FakeRng()
    uids = sorted(u for t in teams for u in t)
    g = Game([(u, f"P{u}") for u in uids], rules=rules, rng=rng, teams=[list(t) for t in teams])
    for i, u in enumerate(uids):  # очерёдность: P1 > P2 > P3 > P4
        rng.push(*[6 - i] * 5)
        g.order_roll(u)
    assert g.phase == "play"
    return g, rng


def test_turn_order_alternates_teams():
    g, _ = make_teams()
    assert g.order == [1, 2, 3, 4]
    g, _ = make_teams(((1, 4), (2, 3)))
    assert g.order == [1, 2, 4, 3]  # А1, Б1, А2, Б2


def test_teams_must_be_pairs():
    with pytest.raises(GameError):
        Game([(1, "a"), (2, "b"), (3, "c")], teams=[[1, 2], [3]])
    with pytest.raises(GameError):
        Game([(1, "a"), (2, "b")], teams=[[1, 2]])


def test_shared_score_and_bolts():
    g, rng = make_teams()
    turn(g, rng, (1, 1, 1, 2, 3))  # P1: +100 команде А
    assert g.player(3).score == 100 and g.player(3).opened
    turn(g, rng, ZERO, stop=False)  # P2: команда Б пусто (не открыта — без болта)
    assert g.cur.uid == 3 and g.turn_start_score == 100
    turn(g, rng, ZERO, stop=False)  # P3: болт команде А
    assert g.player(1).bolts == 1


def test_overtake_penalises_other_team_once():
    g, rng = make_teams()
    turn(g, rng, (1, 1, 1, 2, 3))  # А: 100
    turn(g, rng, (1, 1, 1, 1, 3))  # Б: 200 — обгоняет А
    assert g.player(1).score == 50 and g.player(3).score == 50  # −50 один раз на команду
    assert g.player(2).an["overtook"] == {"1": 1, "3": 1}


def test_team_win_and_stats(tmp_path):
    g, rng = make_teams()
    g.player(1).score = 990
    g.player(1).opened = True
    g._reset_turn()
    g.turn_no = 1
    turn(g, rng, (5, 2, 3, 4, 6), stop=False)  # большой стрит 250 → 1240, победа (без бочки)
    assert g.phase == "finished" and sorted(g.winners) == [1, 3]
    assert "dry_win" in end_ids(g, g.player(3))
    stats = Stats(tmp_path / "s.json")
    stats.record_game(-1, g.players, g.winners)
    rows = {r["uid"]: r for r in stats.chat_table(-1)}
    assert rows[1]["wins"] == rows[3]["wins"] == 1 and rows[2]["wins"] == 0


def test_teammate_takes_over_slots_when_partner_leaves():
    g, rng = make_teams()
    g.remove_player(3)
    assert g.order == [1, 2, 1, 4]
    turn(g, rng, (1, 1, 1, 2, 3))
    turn(g, rng, ZERO, stop=False)
    assert g.cur.uid == 1  # ходит за ушедшего напарника


# ---------- аналитика ----------

def test_roll_analytics_and_honesty():
    g, rng = make_teams()
    turn(g, rng, (1, 5, 2, 3, 6), stop=False)
    a = g.player(1).an
    assert a["rolls"] == 1 and a["pts"] == 15 and a["faces"] == [1, 1, 1, 0, 1, 1] and a["exp"] > 0
    g.force_next([1, 1, 1, 1, 2])  # подкрученный бросок в честность и удачу не идёт
    g.roll(1)
    assert a["rolls"] == 1


def test_decision_quality():
    g, rng = make_teams()
    turn(g, rng, (1, 1, 1, 2, 3), stop=False)  # 100, в руке 2
    turn(g, rng, (5, 2), stop=False)  # 105, в руке 1: бросать 1 кубик при 105 — плохо
    g.stop(1)  # записать — верное решение
    a = g.player(1).an
    assert a["dec"] == 2 and a["dec_good"] == 1  # бросок при 100 и 2 кубиках — тоже плохо по математике
    assert a["risky_opps"] == 2 and a["risky_rolls"] == 1
    assert a["commits"] == 1 and a["commit_pts"] == 105


def test_burned_points():
    g, rng = make_teams()
    turn(g, rng, (1, 1, 1, 2, 3), ZERO[:2], stop=False)
    a = g.player(1).an
    assert a["burned"] == 1 and a["burned_pts"] == 100
