"""Команды лобби, настроек и пресетов."""
from __future__ import annotations

import random
from typing import TYPE_CHECKING

from ..ai import BOT_STYLES
from ..engine import TEAM_NAMES, GameError
from ..profiles import MAPS, STAKES
from .access import MAX_PLAYERS, TIMER_OPTIONS

if TYPE_CHECKING:
    from .room import Room


async def handle_lobby(room: Room, uid: int, name: str, msg: dict, ws, admin: bool) -> bool:
    action = msg.get("type")
    is_owner = uid == room.owner

    if action == "team":
        room._require(room.status == "lobby" and room.teams_mode, "команды выбираются в лобби")
        target = int(msg.get("uid") or uid)
        room._require(target == uid or is_owner or admin, "менять чужую команду может только создатель")
        room._require(target in room.members, "игрок не в лобби")
        team = int(msg.get("team", -1))
        room._require(0 <= team < len(TEAM_NAMES), "нет такой команды")
        room._require(sum(1 for u, t in room.team_of.items() if t == team and u != target) < 2, "в команде уже двое")
        room.team_of[target] = team
        await room.broadcast()
        return True

    if action == "shuffle_teams":
        room._require(room.status == "lobby" and room.teams_mode and (is_owner or admin), "перемешивает создатель")
        uids = list(room.members)
        random.shuffle(uids)
        room.team_of = {u: i // 2 for i, u in enumerate(uids)}
        await room.broadcast()
        return True

    if action == "my_presets":
        await room.send_to(ws, {"type": "presets", "list": room.manager.presets_of(uid)})
        return True

    if action == "save_preset":
        pname = str(msg.get("name") or "").strip()[:40] or "Мои правила"
        if not room.manager.presets:
            raise GameError("пресеты недоступны")
        pid = room.manager.presets.create(pname, room.rules, uid)
        if room.preset_name() == "Свои":
            room._custom_name, room._custom_rules = pname, room.rules
        await room.send_to(ws, {"type": "preset_saved", "id": pid, "name": pname,
                                "link": room.manager.preset_link(pid)})
        await room.broadcast()
        return True

    if action == "settings":
        room._require((is_owner and room.status == "lobby") or admin, "настройки меняет создатель в лобби")
        if "timer" in msg:
            timer = int(msg["timer"])
            if timer not in TIMER_OPTIONS:
                raise GameError("неверный таймер")
            room.timer = timer
        if "teams" in msg:
            room._require(room.status == "lobby", "команды настраиваются в лобби")
            room.teams_mode = bool(msg["teams"])
            room.team_of = {}
            if room.teams_mode:
                for u in room.members:
                    room._auto_team(u)
        if "map" in msg:
            if msg["map"] not in MAPS:
                raise GameError("неизвестная карта")
            room.map = msg["map"]
        if "stake" in msg:
            stake = int(msg["stake"])
            if stake not in STAKES:
                raise GameError("неверный взнос")
            room._require(room.status == "lobby", "взнос меняется в лобби")
            room._require(not stake or not room.bots, "с ботами играем без ставок")
            room.stake = stake
        if "barrel" in msg:
            if room.status == "game":
                room.rigged = True  # бочку посреди партии меняет только админ
            rules = dict(room.rules, barrel=msg["barrel"])
            if msg["barrel"] == "knock" and room.rules["barrel"] != "knock":
                rules["barrel_start"] = 850
            elif msg["barrel"] == "points" and room.rules["barrel"] == "knock":
                rules["barrel_start"] = 880
            room._set_rules(rules)
        await room.manager.notify("lobby_update", room)

    elif action == "rules":
        room._require((is_owner and room.status == "lobby") or admin, "правила меняет создатель в лобби")
        room._set_rules(msg.get("rules"))
        if room.status == "game":
            room.rigged = True
            room._schedule_winprob(force=True)
        room._audit(uid, name, "rules", "правила изменены")
        await room.manager.notify("lobby_update", room)

    elif action == "preset":
        room._require((is_owner and room.status == "lobby") or admin, "пресет выбирает создатель в лобби")
        room.load_preset(str(msg.get("id") or ""))
        await room.manager.notify("lobby_update", room)

    elif action == "add_bot":
        room._require(is_owner and room.status == "lobby", "ботов добавляет создатель в лобби")
        style = msg.get("style")
        room._require(style in BOT_STYLES, "неизвестный бот")
        room._require(len(room.members) < MAX_PLAYERS, "комната заполнена")
        bid = min([0, *room.members]) - 1
        bot_name = BOT_STYLES[style][0]
        same_name = sum(1 for b in room.bots.values() if b == style)
        room.members[bid] = bot_name + (f" {same_name + 1}" if same_name else "")
        room.bots[bid] = style
        room._auto_team(bid)
        room.stake = 0
        await room.manager.notify("lobby_update", room)

    else:
        return False

    await room._after([])
    return True
