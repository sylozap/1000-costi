import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

from game.auth import validate_init_data
from game.engine import Game
from game.stats import Stats

TOKEN = "123:ABC"


def sign(fields: dict) -> str:
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", TOKEN.encode(), hashlib.sha256).digest()
    return urlencode({**fields, "hash": hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()})


def test_init_data_valid_and_tampered():
    fields = {"auth_date": str(int(time.time())), "start_param": "room1",
              "user": json.dumps({"id": 42, "first_name": "Вася"}, ensure_ascii=False)}
    data = sign(fields)
    res = validate_init_data(data, TOKEN)
    assert res["user"]["id"] == 42 and res["start_param"] == "room1"
    assert validate_init_data(data.replace("room1", "room2"), TOKEN) is None
    assert validate_init_data(data, "999:XYZ") is None


def test_stats_persist(tmp_path):
    path = tmp_path / "stats.json"
    g = Game([(1, "A"), (2, "B")])
    g.players[0].st["samosvals"] = 2
    g.players[0].st["best_turn"] = 300
    st = Stats(path)
    st.record_game(-100, g.players, winner_uid=1)
    st.record_game(-100, g.players, winner_uid=2)
    again = Stats(path)  # «перезапуск»
    rows = {r["uid"]: r for r in again.chat_table(-100)}
    assert rows[1]["games"] == 2 and rows[1]["wins"] == 1 and rows[1]["samosvals"] == 4
    assert rows[1]["best_turn"] == 300
    assert again.user_total(2)["wins"] == 1
