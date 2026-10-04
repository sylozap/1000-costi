import asyncio

import pytest

from game import config
from game.engine import GameError
from game.history import History, chat_records, honesty, profile
from tests.test_rooms import FakeWs, run, setup


async def lobby(room, *people):
    wss = []
    for uid, name in people:
        ws = FakeWs()
        await room.attach(ws, uid, name)
        wss.append(ws)
    return wss


async def play_out(room, g):
    """Доигрывает партию: каждый бросает, пока набрано меньше 100, затем записывает."""
    for _ in range(5000):
        if room.status != "game":
            return
        if g.phase == "order":
            await room.handle(room.owner, "x", {"type": "order_roll_all"}, None)
            continue
        uid = g.cur.uid
        action = "stop" if g.can_stop() and g.turn_points >= 100 else "roll"
        await room.handle(uid, "x", {"type": action}, None)


# ---------- команды в лобби ----------

def test_team_lobby_flow(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w = await lobby(room, (1, "Вася"), (2, "Петя"), (3, "Маша"))
        await room.handle(1, "Вася", {"type": "settings", "teams": True}, w[0])
        assert room.team_of == {1: 0, 2: 0, 3: 1}
        with pytest.raises(GameError):  # 3 игрока — пар не получится
            await room.handle(1, "Вася", {"type": "start"}, w[0])
        await lobby(room, (4, "Оля"))
        assert room.team_of[4] == 1
        await room.handle(2, "Петя", {"type": "team", "team": 1}, w[1])  # в команде 1 уже двое
        assert False, "должна быть ошибка"
    with pytest.raises(GameError, match="уже двое"):
        run(go())


def test_team_choose_shuffle_start_and_bank(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w = await lobby(room, (1, "Вася"), (2, "Петя"), (3, "Маша"), (4, "Оля"))
        await room.handle(1, "Вася", {"type": "settings", "teams": True, "stake": 100}, w[0])
        await room.handle(3, "Маша", {"type": "team", "team": 2}, w[2])
        await room.handle(2, "Петя", {"type": "team", "team": 2}, w[1])
        assert room.team_of == {1: 0, 2: 2, 3: 2, 4: 1}
        with pytest.raises(GameError):  # чужую команду меняет только создатель
            await room.handle(2, "Петя", {"type": "team", "uid": 1, "team": 1}, w[1])
        await room.handle(1, "Вася", {"type": "team", "uid": 4, "team": 0}, w[0])
        await room.handle(1, "Вася", {"type": "start"}, w[0])
        g = room.game
        assert g.teams and g.player(1).side is g.player(4).side and g.player(2).side is g.player(3).side
        # победа команды: банк 400 делится на двоих
        g.force_next([6, 6, 6, 6, 6])
        while g.phase == "order":
            await room.handle(1, "Вася", {"type": "order_roll_all"}, w[0])
        win = g.cur
        win.score, win.opened = 990, True
        g._reset_turn()
        g.force_next([2, 3, 4, 5, 6])
        await room.handle(win.uid, "x", {"type": "roll"}, w[0])
        mates = [p.uid for p in g.members(win.side)]
        assert room.status == "finished" and sorted(g.winners) == sorted(mates)
        for u in mates:
            assert m.profiles.chips(u) == 1000 - 100 + 200
    run(go())


def test_shuffle_teams_makes_pairs(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w = await lobby(room, (1, "a"), (2, "b"), (3, "c"), (4, "d"), (5, "e"), (6, "f"))
        await room.handle(1, "a", {"type": "settings", "teams": True}, w[0])
        await room.handle(1, "a", {"type": "shuffle_teams"}, w[0])
        counts = {}
        for t in room.team_of.values():
            counts[t] = counts.get(t, 0) + 1
        assert sorted(counts.values()) == [2, 2, 2]
        await room.handle(1, "a", {"type": "start"}, w[0])
        assert len(room.game.sides()) == 3
    run(go())


# ---------- история, профиль, рекорды ----------

def test_history_profile_and_records(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w = await lobby(room, (1, "Вася"), (2, "Петя"))
        for _ in range(3):
            await room.handle(1, "Вася", {"type": "start"}, w[0])
            await play_out(room, room.game)
            assert room.status == "finished"
            await room.handle(1, "Вася", {"type": "rematch"}, w[0])
        assert len(m.history.games) == 3
        # история переживает перезапуск
        assert len(History(tmp_path / "games.jsonl").games) == 3

        await room.handle(1, "Вася", {"type": "profile_full", "uid": 2}, w[0])
        pr = w[0].last("profile_full")
        assert pr["games"] == 3 and pr["name"] == "Петя"
        assert pr["wins"] + pr["vs_viewer"]["losses"] == 3  # победы Пети = поражения Васи от Пети
        assert pr["luck"] and 40 < pr["luck"] < 250
        assert pr["honesty"]["n"] > 0 and len(pr["honesty"]["share"]) == 6
        assert pr["rivals"][0]["name"] == "Вася" and pr["rivals"][0]["games"] == 3

        await room.handle(1, "Вася", {"type": "records"}, w[0])
        rec = w[0].last("records")
        assert rec["games"] == 3 and len(rec["recent"]) == 3
        assert rec["records"]["best_turn"]["value"] >= 100
        gid = rec["recent"][0]["id"]
        await room.handle(1, "Вася", {"type": "game_detail", "id": gid}, w[0])
        assert w[0].last("game_detail")["game"]["history"]
    run(go())


def test_profile_nemesis_and_victim():
    h = History(None)

    def game(gid, winner, overtook=0):
        an = lambda o: {"overtook": o, "zeroed": {}, "faces": [1] * 6}  # noqa: E731
        h.add({"id": gid, "chat": -1, "t0": 0, "t1": int(gid), "map": "felt", "teams": False, "winners": [winner],
               "turns": 10, "history": [], "winprob": [],
               "players": [{"uid": 1, "name": "A", "score": 1000 if winner == 1 else 400, "team": None, "bot": False,
                            "st": {"best_turn": 100}, "an": an({"2": overtook})},
                           {"uid": 2, "name": "B", "score": 1000 if winner == 2 else 400, "team": None, "bot": False,
                            "st": {"best_turn": 50}, "an": an({})}]})
    game("1", 2)
    game("2", 2)
    game("3", 1, overtook=3)
    pr = profile(h, 1)
    assert pr["nemesis"]["name"] == "B" and pr["nemesis"]["losses"] == 2
    assert pr["victim"]["name"] == "B" and pr["victim"]["hits"] == 3
    assert pr["streak"] == 1 and pr["best_streak"] == 1
    rec = chat_records(h, -1)
    assert rec["records"]["best_turn"] == {"value": 100, "name": "A", "id": "1", "t": 1}


def test_honesty_check():
    assert honesty([100] * 6)["fair"] is True
    assert honesty([300, 20, 20, 20, 20, 20])["fair"] is False
    assert honesty([1, 1, 1, 1, 1, 1])["fair"] is None  # слишком мало бросков для вывода


# ---------- шансы на победу ----------

def test_winprob_in_room(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "WINPROB_BUDGET", 0.05)

    async def go():
        m, room = setup(tmp_path)
        w = await lobby(room, (1, "Вася"), (2, "Петя"))
        await room.handle(1, "Вася", {"type": "start"}, w[0])
        while room.game.phase == "order":
            await room.handle(1, "Вася", {"type": "order_roll_all"}, w[0])
        for _ in range(50):
            await asyncio.sleep(0.05)
            if room.winprob:
                break
        assert set(room.winprob) == {"1", "2"} and abs(sum(room.winprob.values()) - 1) < 0.05
        assert w[0].last("state")["state"]["winprob"] == room.winprob
        await play_out(room, room.game)
        st = room.state()
        assert st["winprob_hist"] and max(st["winprob_hist"][-1]["p"].values()) == 1.0
    run(go())
