"""Реестр комнат и доступ к данным игроков."""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import TYPE_CHECKING

from ..achievements import ACHIEVEMENTS
from ..ai import is_bot
from ..customdice import CustomDice, CustomDiceError, dice_id
from ..engine import GameError
from ..history import GameArchive, History, game_record, profile
from ..profiles import ALL_SKINS, PUBLIC_SKINS, Profiles
from ..rules import BUILTIN_PRESETS, short_title
from .access import is_admin
from .room import Room

if TYPE_CHECKING:
    from ..stats import Presets, Stats

log = logging.getLogger(__name__)


class RoomManager:
    def __init__(self, stats: Stats | None = None, presets: Presets | None = None, data_dir: Path | None = None):
        self.rooms: dict[str, Room] = {}
        self.stats = stats
        self.presets = presets
        self.data_dir = data_dir
        self.notifier = None  # объект с async-методами lobby_update/game_started/...
        self.bot_username: str | None = None
        self.admin_prefs: dict[int, dict] = self._load_admin_prefs()
        self.custom = CustomDice(data_dir / "dice" if data_dir else None)
        self.profiles = Profiles(data_dir / "profiles.json" if data_dir else None, custom=self.custom)
        self.history = History(data_dir / "games.jsonl" if data_dir else None)
        self.game_archive = GameArchive(self.history, self.stats, self.profiles)

    # ---------- комнаты ----------

    def create(self, chat_id: int | None, owner_uid: int, owner_name: str,
               rules: dict | None = None, preset_name: str | None = None) -> Room:
        self.cleanup()
        room = Room(self, chat_id, owner_uid, owner_name, rules=rules, preset_name=preset_name)
        self.rooms[room.id] = room
        return room

    def get(self, rid: str | None) -> Room | None:
        return self.rooms.get(rid or "")

    def active_in_chat(self, chat_id: int) -> Room | None:
        for r in self.rooms.values():
            if r.chat_id == chat_id and r.active:
                return r
        return None

    def rooms_of_user(self, uid: int) -> list[Room]:
        res = []
        for r in self.rooms.values():
            in_game = r.game and any(p.uid == uid for p in r.game.players)
            if r.status in ("lobby", "game", "finished") and (uid in r.members or in_game):
                res.append(r)
        res.sort(key=lambda r: (r.active, r.updated), reverse=True)
        return res

    def rooms_overview(self) -> list[dict]:
        res = []
        for r in sorted(self.rooms.values(), key=lambda r: (r.active, r.updated), reverse=True):
            if r.game and r.status != "lobby":
                players = [f"{p.name} {p.score}" for p in r.game.players]
            else:
                players = list(r.members.values())
            res.append({"id": r.id, "chat_id": r.chat_id, "status": r.status, "paused": r.paused,
                        "owner": r.members.get(r.owner, ""), "players": players,
                        "rules": short_title(r.rules), "updated": r.updated})
        return res

    async def broadcast_all(self) -> None:
        for r in list(self.rooms.values()):
            if r.clients:
                await r.broadcast()

    # ---------- статистика, ачивки, пресеты ----------

    def record(self, room: Room) -> None:
        if self.stats and room.chat_id is not None and room.game:
            people = [p for p in room.game.players if not is_bot(p.uid)]
            self.stats.record_game(room.chat_id, people, room.game.winners)

    def archive(self, room: Room) -> None:
        """Запись законченной партии в историю (после итоговых ачивок, пока ставки ещё не выплачены)."""
        if room.game and any(not is_bot(p.uid) for p in room.game.players):
            self.history.add(game_record(room))

    def games_overview(self) -> list[dict]:
        return self.game_archive.overview()

    def exclude_game(self, gid: str) -> str:
        return self.game_archive.exclude(gid)

    def restore_game(self, gid: str) -> str:
        return self.game_archive.restore(gid)

    def purge_game(self, gid: str) -> str:
        return self.game_archive.purge(gid)

    def profile_full(self, uid: int, viewer: int | None = None,
                     filters: dict | None = None, chat_id: int | None = None) -> dict:
        """Полный профиль: аналитика по истории + карьерная статистика, ачивки, скин, фишки."""
        admin = is_admin(uid)
        gold = self.admin_prefs.get(uid, {}).get("gold", True)
        total = self.stats.user_total(uid) if self.stats else None
        ach = self.achievements_of(uid)
        return {"type": "profile_full", **profile(self.history, uid, viewer, filters, chat_id),
                "name": (total or {}).get("name") or self._name_of(uid),
                "career": total, "chips": self.profiles.chips(uid), "skin": self.profiles.skin(uid, admin, gold),
                "custom_dice": self.custom_views([self.profiles.skin(uid, admin, gold)]),
                "achievements": [a for a in ach if a["got"]], "achievements_total": len(ach)}

    def _name_of(self, uid: int) -> str:
        for r in self.rooms.values():
            if uid in r.members:
                return r.members[uid]
            if r.game and any(p.uid == uid for p in r.game.players):
                return r.game.player(uid).name
        return "Игрок"

    def profile_msg(self, uid: int) -> dict:
        admin = is_admin(uid)
        allowed = self.profiles.allowed_skins(uid, admin)
        gold = self.admin_prefs.get(uid, {}).get("gold", True)
        skins = []
        for k in allowed:
            item = {"id": k, "name": self.skin_name(k), "personal": k not in PUBLIC_SKINS}
            if dice_id(k):
                item["img"] = self.custom.view(dice_id(k))["faces"][0]
            skins.append(item)
        return {"type": "profile", "chips": self.profiles.chips(uid), "skin": self.profiles.skin(uid, admin, gold),
                "skins": skins, "custom_dice": self.custom_views(allowed)}

    # ---------- кубики с картинками ----------

    def skin_name(self, skin: str) -> str:
        return self.custom.name(skin) if dice_id(skin) else ALL_SKINS.get(skin, skin)

    def custom_views(self, skins) -> dict[str, dict]:
        """Описание кубиков с картинками для клиента (скин → адреса граней)."""
        return {s: self.custom.view(dice_id(s)) for s in set(skins) if dice_id(s) and self.custom.exists(s)}

    def known_people(self) -> dict[int, str]:
        """Все известные игроки (для выдачи кубиков): из статистики, истории и комнат."""
        people: dict[int, str] = {}
        if self.stats:
            for chat in self.stats.data["chats"].values():
                for uid, row in chat.items():
                    people[int(uid)] = row.get("name") or people.get(int(uid), "")
        for g in self.history.games:
            for p in g["players"]:
                if not p.get("bot"):
                    people[p["uid"]] = p["name"]
        for r in self.rooms.values():
            for uid, name in r.members.items():
                if uid >= 0:
                    people[uid] = name
        for uid in self.profiles.data["users"]:
            people.setdefault(int(uid), f"id {uid}")
        return people

    def dice_admin_msg(self) -> dict:
        people = self.known_people()
        items = []
        for v in self.custom.list():
            owners = self.profiles.owners(v["skin"])
            items.append(dict(v, owners=[{"uid": u, "name": people.get(u, f"id {u}")} for u in owners]))
        return {"type": "admin_dice", "list": items,
                "people": sorted(({"uid": u, "name": n} for u, n in people.items()), key=lambda x: x["name"].lower())}

    async def admin_global(self, uid: int, msg: dict, reply) -> None:
        """Админ-команды без привязки к комнате: кубики с картинками и выдача личных скинов."""
        op = msg.get("op")
        try:
            if op == "dice_list":
                await reply(self.dice_admin_msg())
                return
            if op == "dice_save":
                did = msg.get("id") or None
                did = self.custom.save(did, msg.get("name"), msg.get("faces"), uid)
                await reply({"type": "admin_ok", "text": f"Кубик «{self.custom.dice[did]['name']}» сохранён"})
                await reply(dict(self.dice_admin_msg(), saved=did))
            elif op == "dice_delete":
                did = str(msg.get("id") or "")
                name = self.custom.dice.get(did, {}).get("name", "?")
                self.custom.delete(did)
                self.profiles.revoke_all("c_" + did)
                await reply({"type": "admin_ok", "text": f"Кубик «{name}» удалён и забран у всех"})
                await reply(self.dice_admin_msg())
            elif op == "grant_skin":
                target, skin, on = int(msg.get("uid", 0)), str(msg.get("skin") or ""), bool(msg.get("on", True))
                self.profiles.grant(target, skin, on)
                await reply({"type": "admin_ok", "text": f"«{self.skin_name(skin)}»: {'выдан' if on else 'забран'}"})
                if dice_id(skin):
                    await reply(self.dice_admin_msg())
            else:
                return
        except (CustomDiceError, ValueError) as e:
            raise GameError(str(e)) from None
        await self.broadcast_all()

    def achievements_of(self, uid: int) -> list[dict]:
        mine = self.stats.achievements(uid) if self.stats else {}
        return [{"id": aid, "emoji": e, "title": t, "desc": d, "got": aid in mine}
                for aid, (e, t, d) in ACHIEVEMENTS.items()]

    def presets_of(self, uid: int) -> list[dict]:
        res = [{"id": k, "name": v[0], "builtin": True} for k, v in BUILTIN_PRESETS.items()]
        if self.presets:
            res += [dict(p, builtin=False, link=self.preset_link(p["id"])) for p in self.presets.of_user(uid)]
        return res

    def preset_link(self, pid: str) -> str | None:
        return f"https://t.me/{self.bot_username}?start=p_{pid}" if self.bot_username else None

    # ---------- админ ----------

    def _admin_file(self) -> Path | None:
        return self.data_dir / "admin.json" if self.data_dir else None

    def _load_admin_prefs(self) -> dict[int, dict]:
        f = self._admin_file()
        if f and f.exists():
            try:
                return {int(k): v for k, v in json.loads(f.read_text(encoding="utf-8")).items()}
            except (json.JSONDecodeError, OSError, ValueError):
                pass
        return {}

    def save_admin_prefs(self) -> None:
        f = self._admin_file()
        if f:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(self.admin_prefs), encoding="utf-8")

    def write_audit(self, room: Room, entry: dict) -> None:
        if not self.data_dir:
            return
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            with open(self.data_dir / "audit.log", "a", encoding="utf-8") as f:
                f.write(json.dumps(dict(entry, room=room.id, chat=room.chat_id), ensure_ascii=False) + "\n")
        except OSError:
            log.warning("не удалось записать audit.log")

    # ---------- уведомления ----------

    async def notify(self, method: str, room: Room, *args) -> None:
        if not self.notifier or room.chat_id is None:
            return
        try:
            await getattr(self.notifier, method)(room, *args)
        except Exception:  # noqa: BLE001 — сбой Telegram не должен ломать игру
            log.exception("notifier.%s failed", method)

    def cleanup(self) -> None:
        now = time.time()
        for rid, r in list(self.rooms.items()):
            idle = now - r.updated
            if (not r.active and idle > 6 * 3600) or idle > 3 * 24 * 3600:
                if not r.clients:
                    del self.rooms[rid]
