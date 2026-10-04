import asyncio
from types import SimpleNamespace

from game.bot import GroupNotifier
from game.rooms import RoomManager
from game.stats import Stats


class FakeBot:
    def __init__(self):
        self.sent, self.edited, self.deleted = [], [], []
        self._id = 100

    async def send_message(self, chat_id, text, reply_markup=None):
        self._id += 1
        self.sent.append(text)
        return SimpleNamespace(message_id=self._id)

    async def edit_message_text(self, text, chat_id, message_id, reply_markup=None):
        self.edited.append(text)

    async def delete_message(self, chat_id, message_id):
        self.deleted.append(message_id)


class FakeWs:
    def __init__(self):
        self.out = []

    async def send_str(self, s):
        self.out.append(s)


def test_full_flow(tmp_path):
    async def run():
        fb = FakeBot()
        stats = Stats(tmp_path / "stats.json")
        m = RoomManager(stats)
        m.notifier = GroupNotifier(fb, "bot")
        room = m.create(-5, 1, "Вася")
        await m.notifier.lobby_update(room)
        ws1, ws2 = FakeWs(), FakeWs()
        await room.attach(ws1, 1, "Вася")
        await room.attach(ws2, 2, "Петя")
        assert list(room.members) == [1, 2]
        await room.handle(1, "Вася", {"type": "start"}, ws1)
        while room.game.phase == "order":
            await room.handle(1, "Вася", {"type": "order_roll_all"}, ws1)
        g = room.game
        for _ in range(3000):
            if room.status != "game":
                break
            uid = g.cur.uid
            action = "stop" if g.can_stop() and g.turn_points >= 100 else "roll"
            await room.handle(uid, "x", {"type": action}, ws1)
            await asyncio.sleep(0.03 if g.phase == "play" and g.cur.uid != uid else 0)
        await asyncio.sleep(0.05)
        assert room.status == "finished"
        # в группу только лобби/старт (правкой одного сообщения) и итог — без сообщений по ходу партии
        assert len(fb.sent) == 2 and "Победа" in fb.sent[-1]
        assert not any("Ходит" in t for t in fb.sent)
        rows = stats.chat_table(-5)
        assert sum(r["wins"] for r in rows) == 1 and all(r["games"] == 1 for r in rows)

    asyncio.run(run())
