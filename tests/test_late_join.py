import pytest

from game.engine import GameError
from game.rooms import MAX_PLAYERS
from tests.test_engine import make, push_dice
from tests.test_rooms import FakeWs, run, setup, start_game


def test_add_preserves_active_turn_and_adds_zero_at_end():
    g, rng = make()
    rng.push(1, 5, 2, 3, 4)
    g.roll(1)
    before = (g.current, g.turn_no, g.turn_points, g.dice_left, g.last_roll.copy())
    events = g.add_player(3, 'Новичок')
    assert (g.current, g.turn_no, g.turn_points, g.dice_left, g.last_roll) == before
    assert g.order == [1, 2, 3] and events[0]['kind'] == 'join'
    p = g.player(3)
    assert p.score == p.bolts == p.debt == 0 and not p.opened
    assert not g.add_player(3, 'Другое имя') and len(g.players) == 3
    g.stop(1) if g.can_stop() else g.timeout()
    g.timeout()
    assert g.cur.uid == 3 and g.turn_points == 0


def test_join_during_order_must_roll():
    from game.engine import Game
    g = Game([(1, 'A'), (2, 'B')])
    g.add_player(3, 'C')
    assert g.order_pending(g.player(3))
    push_dice(g, 6, 6, 6, 6, 6)
    g.order_roll(3)
    assert g.player(3).order_rolls == [30]


def test_room_join_stake_reconnect_and_timer(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        room.stake = 100
        w1, w2, w3 = FakeWs(), FakeWs(), FakeWs()
        await start_game(room, w1, w2)
        room.timer = 30
        room._restart_timer()
        deadline, task = room.deadline, room._timer_task
        await room.attach(w3, 3, 'C')
        assert 3 not in room.members  # сначала зритель
        await room.handle(3, 'C', {'type': 'join'}, w3)
        assert room.game.player(3).score == 0 and room.game.order[-1] == 3
        assert room.deadline == deadline and room._timer_task is task
        assert m.profiles.chips(3) == 900 and room.stakes[3] == 100
        room.game.player(3).score = 75
        await room.handle(3, 'C', {'type': 'join'}, w3)
        await room.detach(w3)
        await room.attach(w3, 3, 'C')
        assert room.game.player(3).score == 75 and m.profiles.chips(3) == 900
        room._cancel_timer()
    run(go())


def test_join_rejects_insufficient_stake_full_and_finished(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1, w2 = FakeWs(), FakeWs()
        await start_game(room, w1, w2)
        room.stake = 250
        m.profiles.set_chips(3, 200)
        with pytest.raises(GameError, match='не хватает'):
            await room.handle(3, 'C', {'type': 'join'}, w1)
        assert 3 not in room.members and len(room.game.players) == 2
        room.stake = 0
        for uid in range(3, MAX_PLAYERS + 1):
            await room.handle(uid, str(uid), {'type': 'join'}, w1)
        with pytest.raises(GameError, match='заполнена'):
            await room.handle(99, 'X', {'type': 'join'}, w1)
        room.status = 'finished'
        with pytest.raises(GameError, match='закончилась'):
            await room.handle(99, 'X', {'type': 'join'}, w1)
    run(go())


def test_team_join_is_rejected(tmp_path):
    async def go():
        _, room = setup(tmp_path)
        w = FakeWs()
        for uid in (1, 2, 3, 4):
            await room.attach(w, uid, str(uid))
        await room.handle(1, 'A', {'type': 'settings', 'teams': True}, w)
        await room.handle(1, 'A', {'type': 'start'}, w)
        with pytest.raises(GameError, match='командную'):
            await room.handle(5, 'E', {'type': 'join'}, w)
        assert len(room.game.players) == 4 and 5 not in room.members
    run(go())
