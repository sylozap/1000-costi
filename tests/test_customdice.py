import base64

import pytest
from aiohttp.test_utils import TestClient, TestServer

from game.customdice import CustomDice, CustomDiceError, decode_face
from game.engine import GameError
from game.web import create_app
from tests.test_rooms import ADMIN, FakeWs, run, setup

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 100
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 100


def url(raw: bytes, kind="jpeg") -> str:
    return f"data:image/{kind};base64," + base64.b64encode(raw).decode()


def test_decode_face_validation():
    assert decode_face(url(JPEG)) == (JPEG, "jpg")
    assert decode_face(url(PNG, "png"))[1] == "png"
    for bad in ("", "data:text/plain;base64,aGk=", url(PNG), url(b"\xff\xd8\xff" + b"0" * 500_000)):
        with pytest.raises(CustomDiceError):
            decode_face(bad)


def test_save_edit_fallback_and_delete(tmp_path):
    c = CustomDice(tmp_path / "dice")
    did = c.save(None, "Котики", [url(JPEG), None, url(PNG, "png"), None, None, None], ADMIN)
    assert c.face_path(did, 1).name == "1.jpg"
    assert c.face_path(did, 2).name == "1.jpg"  # пустая грань берёт первую картинку
    assert c.face_path(did, 3).name == "3.png"
    v = c.view(did)
    assert v["skin"] == f"c_{did}" and v["faces"][4] == f"/dice/{did}/5?v=1" and v["own"] == [True, False, True, False, False, False]
    # правка: первую оставить, третью убрать, шестую добавить
    c.save(did, "Котики 2", ["keep", None, None, None, None, url(JPEG)], ADMIN)
    assert c.dice[did]["ver"] == 2 and c.dice[did]["faces"] == ["jpg", None, None, None, None, "jpg"]
    assert not (tmp_path / "dice" / did / "3.png").exists()
    # переживает перезапуск
    assert CustomDice(tmp_path / "dice").dice[did]["name"] == "Котики 2"
    with pytest.raises(CustomDiceError):
        c.save(did, "x", [None] * 6, ADMIN)  # хотя бы одна картинка
    with pytest.raises(CustomDiceError):
        c.save(None, "  ", [url(JPEG)] + [None] * 5, ADMIN)  # нужно название
    c.delete(did)
    assert not (tmp_path / "dice" / did).exists() and not c.dice


def test_admin_grant_choose_revoke_delete(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        w1, wa = FakeWs(), FakeWs()
        await room.attach(w1, 1, "Вася")
        await room.attach(wa, ADMIN, "Админ", spectate=True)
        with pytest.raises(GameError):  # не админ
            await room.handle(1, "Вася", {"type": "admin", "op": "dice_list"}, w1)
        await room.handle(ADMIN, "А", {"type": "admin", "op": "dice_save", "name": "Мемы",
                                       "faces": [url(JPEG)] + [None] * 5}, wa)
        did = wa.last("admin_dice")["saved"]
        skin = f"c_{did}"
        await room.handle(ADMIN, "А", {"type": "admin", "op": "grant_skin", "uid": 1, "skin": skin}, wa)
        assert wa.last("admin_dice")["list"][0]["owners"] == [{"uid": 1, "name": "Вася"}]
        st = room.state()
        assert st["cosmetics"]["skins"]["1"] == skin  # выданный кубик сразу выбран
        assert st["custom_dice"][skin]["faces"][0] == f"/dice/{did}/1?v=1"
        # игрок может переключиться и вернуться
        await room.handle(1, "Вася", {"type": "skin", "id": "ruby"}, w1)
        await room.handle(1, "Вася", {"type": "skin", "id": skin}, w1)
        prof = w1.last("profile")
        assert any(s["id"] == skin and s["name"] == "Мемы" and s["img"] for s in prof["skins"])
        # забрать
        await room.handle(ADMIN, "А", {"type": "admin", "op": "grant_skin", "uid": 1, "skin": skin, "on": False}, wa)
        assert room.state()["cosmetics"]["skins"]["1"] == "ivory"
        with pytest.raises(GameError):
            await room.handle(1, "Вася", {"type": "skin", "id": skin}, w1)
        # удаление забирает у всех
        await room.handle(ADMIN, "А", {"type": "admin", "op": "grant_skin", "uid": 1, "skin": skin}, wa)
        await room.handle(ADMIN, "А", {"type": "admin", "op": "dice_delete", "id": did}, wa)
        assert room.state()["cosmetics"]["skins"]["1"] == "ivory" and not m.custom.dice
        assert skin not in m.profiles._user(1)["grants"]
    run(go())


def test_face_served_over_http(tmp_path):
    async def go():
        m, room = setup(tmp_path)
        did = m.custom.save(None, "Фото", [None, url(PNG, "png")] + [None] * 4, ADMIN)
        async with TestClient(TestServer(create_app(m))) as client:
            r = await client.get(f"/dice/{did}/6?v=1")  # пустая грань → первая заданная
            assert r.status == 200 and await r.read() == PNG and "immutable" in r.headers["Cache-Control"]
            assert (await client.get(f"/dice/{did}/9")).status == 404
            assert (await client.get("/dice/../etc/1")).status == 404
            assert (await client.get("/dice/zzzzzzzz/1")).status == 404
    run(go())
