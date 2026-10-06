"""Партии в админ-панели: исключение из статистики, возврат, удаление навсегда."""
import pytest

from game.engine import GameError
from game.history import chat_records, profile
from tests.test_engine import push_dice
from tests.test_rooms import ADMIN, FakeWs, run, setup


async def win_game(room, w1, w2, admin_ws=None):
    """Вася побеждает пятью единицами (ачивки: у Васи five_ones и dry_win, у Пети zero_finish)."""
    await room.handle(1, "Вася", {"type": "start"}, w1)
    push_dice(room.game, 6, 6, 6, 6, 6)
    await room.handle(1, "Вася", {"type": "order_roll"}, w1)
    push_dice(room.game, 1, 1, 2, 2, 3)
    await room.handle(2, "Петя", {"type": "order_roll"}, w2)
    if admin_ws:  # админ меняет правила посреди партии — партия помечается 🎯
        await room.handle(ADMIN, "Админ", {"type": "rules", "rules": dict(room.rules)}, admin_ws)
    push_dice(room.game, 1, 1, 1, 1, 1)
    await room.handle(1, "Вася", {"type": "roll"}, w1)
    assert room.status == "finished"


def shift_past(m, seconds=10_000):
    """Сдвигает уже сыгранные партии и полученные ачивки в прошлое — чтобы партии не совпадали по времени."""
    for g in m.history.games:
        g["t0"] -= seconds
        g["t1"] -= seconds
    for mine in m.stats.data["achievements"].values():
        for aid in mine:
            mine[aid] -= seconds


async def two_games(tmp_path, stake=100):
    m, room = setup(tmp_path)
    w1, w2, wa = FakeWs(), FakeWs(), FakeWs()
    await room.attach(w1, 1, "Вася")
    await room.attach(w2, 2, "Петя")
    await room.attach(wa, ADMIN, "Админ", spectate=True)
    await room.handle(1, "Вася", {"type": "settings", "stake": stake}, w1)
    await win_game(room, w1, w2)
    shift_past(m)
    await room.handle(1, "Вася", {"type": "rematch"}, w1)
    await win_game(room, w1, w2, admin_ws=wa)
    a, b = m.history.games
    return m, room, (w1, w2, wa), a, b


def test_record_has_achievements_stakes_rigged(tmp_path):
    async def go():
        m, room, _, a, b = await two_games(tmp_path)
        assert {"five_ones", "dry_win"} <= set(a["ach"]["1"]) and a["ach"]["2"] == ["zero_finish"]
        assert a["stakes"] == {"1": 100, "2": 100}
        assert not a["rigged"] and b["rigged"]
        assert m.profiles.chips(1) == 1200 and m.profiles.chips(2) == 800
    run(go())


def test_exclude_and_restore_last_game(tmp_path):
    async def go():
        m, room, (w1, w2, wa), a, b = await two_games(tmp_path)
        ach_before = dict(m.stats.achievements(1))
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_off", "id": b["id"]}, wa)
        assert wa.last("admin_games")["text"] == "Партия больше не учитывается"
        row = m.stats.row(-1, 1)
        assert (row["games"], row["wins"]) == (1, 1) and m.stats.row(-1, 2)["games"] == 1
        # ачивки получены в первой партии — остаются
        assert m.stats.achievements(1) == ach_before
        assert m.profiles.chips(1) == 1100 and m.profiles.chips(2) == 900  # банк второй партии вернулся
        assert profile(m.history, 1)["games"] == 1 and chat_records(m.history, -1)["games"] == 1
        with pytest.raises(GameError):  # игроки исключённую партию не видят…
            await room.handle(1, "Вася", {"type": "game_detail", "id": b["id"]}, w1)
        await room.handle(ADMIN, "Админ", {"type": "game_detail", "id": b["id"]}, wa)  # …а админ видит
        assert [g["off"] for g in wa.last("admin_games")["list"]] == [True, False]

        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_on", "id": b["id"]}, wa)
        row = m.stats.row(-1, 1)
        assert (row["games"], row["wins"]) == (2, 2)
        assert m.profiles.chips(1) == 1200 and m.profiles.chips(2) == 800
        assert "off" not in b and "undo" not in b
    run(go())


def test_exclude_revokes_achievements_of_that_game(tmp_path):
    async def go():
        m, room, (w1, w2, wa), a, b = await two_games(tmp_path)
        ts = dict(m.stats.achievements(1))
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_off", "id": b["id"]}, wa)
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_off", "id": a["id"]}, wa)
        assert m.stats.achievements(1) == {} and m.stats.achievements(2) == {}
        assert m.stats.row(-1, 1) is None  # других партий в чате не было
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_on", "id": a["id"]}, wa)
        assert m.stats.achievements(1) == ts  # вернулись с прежним временем
    run(go())


def test_achievement_moves_to_other_game(tmp_path):
    async def go():
        m, room, (w1, w2, wa), a, b = await two_games(tmp_path)
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_off", "id": a["id"]}, wa)
        # five_ones впервые выпала в первой партии, но была и во второй — ачивка остаётся, со временем второй
        assert m.stats.achievements(1)["five_ones"] == b["t1"]
        assert m.stats.achievements(2)["zero_finish"] == b["t1"]
    run(go())


def test_career_achievement_revoked_below_threshold(tmp_path):
    async def go():
        m, room, (w1, w2, wa), a, b = await two_games(tmp_path)
        m.stats.data["chats"]["-1"]["1"]["games"] = 10  # будто сыграно 10 партий
        m.stats.unlock(1, "games10")
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_off", "id": b["id"]}, wa)
        assert "games10" not in m.stats.achievements(1)
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_on", "id": b["id"]}, wa)
        assert "games10" in m.stats.achievements(1)
    run(go())


def test_best_turn_recomputed(tmp_path):
    async def go():
        m, room, (w1, w2, wa), a, b = await two_games(tmp_path)
        a["players"][0]["st"]["best_turn"] = 300  # в первой партии лучший ход был 300
        m.stats.set_best_turn(-1, 1, 1000)
        b["players"][0]["st"]["best_turn"] = 1000
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_off", "id": b["id"]}, wa)
        assert m.stats.row(-1, 1)["best_turn"] == 300
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_on", "id": b["id"]}, wa)
        assert m.stats.row(-1, 1)["best_turn"] == 1000
    run(go())


def test_purge_and_persist(tmp_path):
    async def go():
        m, room, (w1, w2, wa), a, b = await two_games(tmp_path)
        with pytest.raises(GameError, match="сначала"):
            await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_purge", "id": b["id"]}, wa)
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_off", "id": a["id"]}, wa)
        from game.history import History
        assert History(tmp_path / "games.jsonl").games[0]["off"] is True  # исключение сохранено в файл
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "game_purge", "id": a["id"]}, wa)
        assert [g["id"] for g in History(tmp_path / "games.jsonl").games] == [b["id"]]
    run(go())


def test_games_admin_only(tmp_path):
    async def go():
        m, room, (w1, w2, wa), a, b = await two_games(tmp_path)
        with pytest.raises(GameError):
            await room.handle(1, "Вася", {"type": "admin", "op": "game_off", "id": b["id"]}, w1)
        assert not b.get("off")
    run(go())
