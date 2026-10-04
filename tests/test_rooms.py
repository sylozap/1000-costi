import asyncio
import json

import pytest

from game.engine import GameError
from game.rooms import RoomManager
from game.stats import Presets, Stats

ADMIN = 621983693


class FakeWs:
    def __init__(self):
        self.out = []

    async def send_str(self, s):
        self.out.append(json.loads(s))

    def last(self, kind):
        return [m for m in self.out if m["type"] == kind][-1]


def setup(tmp_path, admin_plays=False):
    stats = Stats(tmp_path / "stats.json")
    presets = Presets(tmp_path / "presets.json")
    m = RoomManager(stats, presets, data_dir=tmp_path)
    m.bot_username = "TestBot"
    room = m.create(-1, 1, "Вася")
    return m, room


def run(coro):
    return asyncio.run(coro)


async def start_game(room, w1, w2):
    await room.attach(w1, 1, "Вася")
    await room.attach(w2, 2, "Петя")
    await room.handle(1, "Вася", {"type": "start"}, w1)
    room.game.force_next([6, 6, 6, 6, 6])
    await room.handle(1, "Вася", {"type": "order_roll"}, w1)
    room.game.force_next([1, 1, 2, 2, 3])
    await room.handle(2, "Петя", {"type": "order_roll"}, w2)
    assert room.game.phase == "play" and room.game.cur.uid == 1


def test_presets_flow(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1 = FakeWs()
        await room.attach(w1, 1, "Вася")
        await room.handle(1, "Вася", {"type": "preset", "id": "v2"}, w1)
        assert room.preset_name() == "Вариант 2" and room.rules["barrel"] == "knock"
        await room.handle(1, "Вася", {"type": "rules", "rules": dict(room.rules, open_min=100)}, w1)
        assert room.preset_name() == "Свои"
        await room.handle(1, "Вася", {"type": "save_preset", "name": "Дача"}, w1)
        saved = w1.last("preset_saved")
        assert saved["link"] == f"https://t.me/TestBot?start=p_{saved['id']}"
        assert room.preset_name() == "Дача"
        room2 = m.create(-2, 2, "Петя")
        room2.load_preset(saved["id"])
        assert room2.rules["open_min"] == 100 and room2.preset_name() == "Дача"
        with pytest.raises(GameError):
            await room.handle(1, "Вася", {"type": "rules", "rules": {"open_min": 3}}, w1)
    run(go())


def test_non_owner_cannot_change_rules(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w2 = FakeWs()
        await room.attach(w2, 2, "Петя")
        with pytest.raises(GameError):
            await room.handle(2, "Петя", {"type": "preset", "id": "v2"}, w2)
    run(go())


def test_admin_requires_rights(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1, w2 = FakeWs(), FakeWs()
        await start_game(room, w1, w2)
        with pytest.raises(GameError):
            await room.handle(1, "Вася", {"type": "admin", "op": "pause"}, w1)
    run(go())


def test_admin_spectate_pause_force_undo(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1, w2, wa = FakeWs(), FakeWs(), FakeWs()
        await start_game(room, w1, w2)
        await room.attach(wa, ADMIN, "Админ", spectate=True)
        st = room.state()
        assert ADMIN not in st["online"] and st["spectators"] == 0  # админ-наблюдатель скрыт

        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "pause"}, wa)
        with pytest.raises(GameError):
            await room.handle(1, "Вася", {"type": "roll"}, w1)
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "resume"}, wa)

        # ход Васи: 100 очков и запись
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "force", "dice": [1, 1, 1, 2, 3]}, wa)
        await room.handle(1, "Вася", {"type": "roll"}, w1)
        await room.handle(1, "Вася", {"type": "stop"}, w1)
        assert room.game.player(1).score == 100 and room.game.cur.uid == 2
        assert not any("подкручено" in e["text"] for e in room.game.log)  # игрокам не видно
        assert any("подкручено" in a["detail"] for a in room.audit)       # а в журнале админа есть

        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "undo"}, wa)
        assert room.game.player(1).score == 0 and room.game.cur.uid == 1

        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "set_score", "uid": 2, "score": 495}, wa)
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "samosval", "uid": 2}, wa)
        assert room.game.player(2).score == 0

        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "audit"}, wa)
        assert wa.last("admin_audit")["list"]
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "announce", "text": "Привет"}, wa)
        assert w1.last("announce")["text"] == "Привет"
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "cosmetics", "gold": False}, wa)
        assert ADMIN not in room.state()["cosmetics"]["gold"]
    run(go())


def test_admin_rig_visible_only_to_admin(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1, w2, wa = FakeWs(), FakeWs(), FakeWs()
        await start_game(room, w1, w2)
        await room.attach(wa, ADMIN, "Админ", spectate=True)
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "rig", "uid": 2, "mode": "exact",
                                            "dice": [5, 5, 5, 0, 0]}, wa)
        assert wa.last("state")["state"]["rigs"] == {"2": "5 5 5 ? ?"}
        assert "rigs" not in w1.last("state")["state"]
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "unrig", "uid": 2}, wa)
        assert wa.last("state")["state"]["rigs"] == {}
        await room.handle(ADMIN, "Админ", {"type": "admin", "op": "rig", "uid": 1, "mode": "good"}, wa)
        await room.handle(1, "Вася", {"type": "roll"}, w1)
        assert room.game.last_roll["points"] >= 100 and wa.last("state")["state"]["rigs"] == {}
    run(go())


def test_admin_rules_midgame(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1, w2, wa = FakeWs(), FakeWs(), FakeWs()
        await start_game(room, w1, w2)
        await room.attach(wa, ADMIN, "Админ", spectate=True)
        await room.handle(ADMIN, "Админ", {"type": "rules", "rules": dict(room.rules, open_min=0)}, wa)
        assert room.game.rules["open_min"] == 0
    run(go())


def test_moment_achievement_unlocked_once(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1, w2 = FakeWs(), FakeWs()
        await start_game(room, w1, w2)
        room.game.player(1).score, room.game.player(1).opened = 495, True
        room.game._reset_turn()
        room.game.force_next([6, 6, 6, 2, 3])
        await room.handle(1, "Вася", {"type": "roll"}, w1)  # 555 — самосвал
        ach = [x for x in w2.out if x["type"] == "achievement"]
        assert [a["id"] for a in ach] == ["samosval"]
        assert "samosval" in m.stats.achievements(1)
        lst = {a["id"]: a["got"] for a in m.achievements_of(1)}
        assert lst["samosval"] and not lst["five_ones"]
    run(go())


def test_five_ones_win_achievements_and_stats(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1, w2 = FakeWs(), FakeWs()
        await start_game(room, w1, w2)
        room.game.force_next([1, 1, 1, 1, 1])
        await room.handle(1, "Вася", {"type": "roll"}, w1)
        assert room.status == "finished"
        got = {x["id"] for x in w1.out if x["type"] == "achievement" and x["uid"] == 1}
        assert {"five_ones", "dry_win"} <= got
        assert {x["id"] for x in w1.out if x["type"] == "achievement" and x["uid"] == 2} == {"zero_finish"}
        assert m.stats.chat_table(-1)[0]["wins"] == 1
    run(go())


def test_stickers_and_spectator(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1, w2, w3 = FakeWs(), FakeWs(), FakeWs()
        await start_game(room, w1, w2)
        await room.attach(w3, 3, "Зритель")
        assert room.state()["spectators"] == 1 and 3 not in room.members
        await room.handle(3, "Зритель", {"type": "sticker", "id": "pit"}, w3)
        assert w1.last("sticker")["text"] == "В ЯМУ!"
        await room.handle(3, "Зритель", {"type": "sticker", "id": "pit"}, w3)  # слишком часто — игнор
        assert len([x for x in w1.out if x["type"] == "sticker"]) == 1
    run(go())


def test_old_stats_format_migrates(tmp_path):
    p = tmp_path / "stats.json"
    p.write_text(json.dumps({"-1": {"5": {"name": "A", "games": 3, "wins": 2, "samosvals": 0, "bolt_penalties": 0,
                                          "barrel_falls": 0, "overtakes": 0, "best_turn": 100}}}))
    st = Stats(p)
    rows = st.chat_table(-1)
    assert rows[0]["uid"] == 5 and rows[0]["rated"] and round(rows[0]["rate"], 2) == 0.67
