"""Представление комнаты в WebSocket-протоколе."""
from __future__ import annotations

import time
from typing import TYPE_CHECKING

from .. import config
from ..ai import BOT_STYLES, is_bot
from ..engine import TEAM_NAMES
from ..phrases import STICKERS, STICKER_GROUPS
from ..profiles import ALL_SKINS, MAPS, STAKES
from ..rules import describe, short_title
from .access import MAX_PLAYERS, REACTIONS, is_admin

if TYPE_CHECKING:
    from .room import Room


def room_snapshot(room: Room) -> dict:
    players = room.players_uids()
    online = set(room.clients.values())
    # админ, зашедший посмотреть, не светится среди зрителей
    visible = {u for u in online if u in players or not is_admin(u)}
    prefs = room.manager.admin_prefs
    prof = room.manager.profiles
    people = [u for u in players | set(room.members) if not is_bot(u)]
    skins = {str(u): room.skin_of(u) for u in players | set(room.members)}
    return {
        "id": room.id,
        "status": room.status,
        "owner": room.owner,
        "settings": room.settings,
        "rules": room.rules,
        "rules_text": describe(room.rules),
        "rules_title": short_title(room.rules),
        "preset": room.preset_name(),
        "members": [{"uid": u, "name": n} for u, n in room.members.items()],
        "online": sorted(visible),
        "spectators": len(visible - players),
        "paused": room.paused,
        "game": room.game.to_dict() if room.game else None,
        "deadline": int(room.deadline * 1000) if room.deadline else None,
        "duration": room.duration,
        "server_now": int(time.time() * 1000),
        "max_players": MAX_PLAYERS,
        "reactions": REACTIONS,
        "stickers": {k: list(v) for k, v in STICKERS.items()},
        "sticker_groups": STICKER_GROUPS,
        "cosmetics": {
            "gold": [u for u in config.ADMIN_IDS if prefs.get(u, {}).get("gold", True)],
            "badge": [u for u in config.ADMIN_IDS if prefs.get(u, {}).get("badge", True)],
            "skins": skins,
        },
        "custom_dice": room.manager.custom_views(skins.values()),
        "chips": {str(u): prof.chips(u) for u in people},
        "bank": sum(room.stakes.values()),
        "bots": {str(u): s for u, s in room.bots.items()},
        "bot_styles": {k: v[0] for k, v in BOT_STYLES.items()},
        "maps": MAPS,
        "skins": ALL_SKINS,
        "stakes": list(STAKES),
        "team_of": {str(u): t for u, t in room.team_of.items()},
        "team_names": TEAM_NAMES,
        "winprob": room.winprob,
        "winprob_hist": room.winprob_hist if room.status == "finished" else None,
    }
