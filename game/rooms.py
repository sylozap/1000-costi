"""Комнаты: лобби, партия, таймер, рассылка состояния по WebSocket, админ-управление."""
from __future__ import annotations

import asyncio
import json
import logging
import random
import secrets
import time
from pathlib import Path
from typing import TYPE_CHECKING

from . import config
from .achievements import ACHIEVEMENTS, CAREER_IDS, career_ids, end_ids, moment_ids
from .ai import BOT_STYLES, is_bot, wants_stop
from .engine import TEAM_NAMES, Game, GameError
from .history import History, bank_shares, chat_records, game_record, profile
from .winprob import chances_from_clone, sim_clone
from .customdice import CustomDice, CustomDiceError, dice_id
from .profiles import ALL_SKINS, MAPS, PUBLIC_SKINS, STAKES, Profiles
from .rules import BUILTIN_PRESETS, RulesError, builtin_label, describe, normalize, same, short_title

if TYPE_CHECKING:
    from .stats import Presets, Stats

log = logging.getLogger(__name__)

MAX_PLAYERS = config.MAX_PLAYERS
TIMER_OPTIONS = (0, 30, 60, 120)
ANIMATION_GRACE = 2.5  # секунд на анимацию броска сверх таймера
REACTIONS = ("😂", "😱", "👏", "🔥", "😭", "🤡", "💩", "🍀")
STICKERS = {
    "pit": ("🕳", "В ЯМУ!"),
    "bolt": ("🔩", "БОЛТ!"),
    "lucky": ("🍀", "НУ ТЫ И ВЕЗУЧИЙ"),
    "fart": ("🤑", "ФАРТИТ!"),
    "truck": ("🚛", "САМОСВАЛ ЕДЕТ"),
    "go": ("🔥", "ДАВАЙ-ДАВАЙ!"),
    "gg": ("🤝", "ГГ"),
    "cheat": ("🤨", "ЖУЛЬНИЧАЕШЬ?"),
    "wait": ("🐢", "НУ ТЫ ДОЛГО?"),
    "risk": ("🎲", "РИСКНИ!"),
}
GAME_ACTIONS = {"roll", "stop", "order_roll", "order_roll_all"}
MAX_SNAPSHOTS = 40
# админ-команды, которым не нужна комната (работают и с экрана «нет игры»)
ADMIN_GLOBAL_OPS = {"grant_skin", "dice_list", "dice_save", "dice_delete"}
BOT_DELAY = (1.6, 2.6)  # сек между действиями бота: успевает проиграться анимация броска


def is_admin(uid: int | None) -> bool:
    return uid in config.ADMIN_IDS


class Room:
    def __init__(self, manager: RoomManager, chat_id: int | None, owner_uid: int, owner_name: str,
                 rules: dict | None = None, preset_name: str | None = None):
        self.manager = manager
        self.id = secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")
        self.chat_id = chat_id
        self.chat_title: str | None = None
        self.owner = owner_uid
        self.timer = 0
        self.rules = normalize(rules)
        self._custom_name = preset_name  # название загруженного сохранённого пресета
        self._custom_rules = self.rules if preset_name else None
        self.status = "lobby"  # lobby | game | finished | cancelled
        self.members: dict[int, str] = {owner_uid: owner_name}
        self.game: Game | None = None
        self.clients: dict = {}  # ws -> uid
        self.deadline: float | None = None
        self.paused = False
        self._timer_task: asyncio.Task | None = None
        self._timer_token = 0
        self._last_react: dict[int, float] = {}
        self._announced: dict[int, set] = {}
        self.rigged = False  # админ вмешивался в партию (подкрутка, счёт, болт, самосвал)
        self.snapshots: list[tuple[int, Game]] = []
        self.audit: list[dict] = []
        self.lobby_msg_id: int | None = None
        self.map = "felt"
        self.stake = 0             # взнос в фишках с каждого игрока
        self.stakes: dict[int, int] = {}  # кто сколько внёс в банк текущей партии
        self.bots: dict[int, str] = {}    # uid бота (< 0) → характер
        self._bot_task: asyncio.Task | None = None
        self.teams_mode = False
        self.team_of: dict[int, int] = {}  # uid → номер команды (командная игра, пары)
        self.started_at: float | None = None
        self.winprob: dict[str, float] = {}  # шансы на победу сейчас (uid → 0..1)
        self.winprob_hist: list[dict] = []  # шансы после каждого хода — для графика итогов
        self._wp_turn: int | None = None
        self._wp_seq = 0
        self.updated = time.time()

    # ---------- состояние ----------

    @property
    def active(self) -> bool:
        return self.status in ("lobby", "game")

    @property
    def settings(self) -> dict:
        """Короткие настройки (совместимость со старым клиентом и сообщениями бота)."""
        return {"barrel": self.rules["barrel"], "timer": self.timer, "map": self.map, "stake": self.stake,
                "teams": self.teams_mode}

    def preset_name(self) -> str:
        key = builtin_label(self.rules)
        if key:
            return BUILTIN_PRESETS[key][0]
        if self._custom_name and self._custom_rules is not None and same(self.rules, self._custom_rules):
            return self._custom_name
        return "Свои"

    def players_uids(self) -> set[int]:
        if self.game and self.status != "lobby":
            return {p.uid for p in self.game.players}
        return set(self.members)

    def state(self) -> dict:
        players = self.players_uids()
        online = set(self.clients.values())
        # админ, зашедший посмотреть, не светится среди зрителей
        visible = {u for u in online if u in players or not is_admin(u)}
        prefs = self.manager.admin_prefs
        prof = self.manager.profiles
        people = [u for u in players | set(self.members) if not is_bot(u)]
        skins = {str(u): self.skin_of(u) for u in players | set(self.members)}
        return {
            "id": self.id,
            "status": self.status,
            "owner": self.owner,
            "settings": self.settings,
            "rules": self.rules,
            "rules_text": describe(self.rules),
            "rules_title": short_title(self.rules),
            "preset": self.preset_name(),
            "members": [{"uid": u, "name": n} for u, n in self.members.items()],
            "online": sorted(visible),
            "spectators": len(visible - players),
            "paused": self.paused,
            "game": self.game.to_dict() if self.game else None,
            "deadline": int(self.deadline * 1000) if self.deadline else None,
            "server_now": int(time.time() * 1000),
            "max_players": MAX_PLAYERS,
            "reactions": REACTIONS,
            "stickers": {k: list(v) for k, v in STICKERS.items()},
            "cosmetics": {
                "gold": [u for u in config.ADMIN_IDS if prefs.get(u, {}).get("gold", True)],
                "badge": [u for u in config.ADMIN_IDS if prefs.get(u, {}).get("badge", True)],
                "skins": skins,
            },
            "custom_dice": self.manager.custom_views(skins.values()),
            "chips": {str(u): prof.chips(u) for u in people},
            "bank": sum(self.stakes.values()),
            "bots": {str(u): s for u, s in self.bots.items()},
            "bot_styles": {k: v[0] for k, v in BOT_STYLES.items()},
            "maps": MAPS,
            "skins": ALL_SKINS,
            "stakes": list(STAKES),
            "team_of": {str(u): t for u, t in self.team_of.items()},
            "team_names": TEAM_NAMES,
            "winprob": self.winprob,
            "winprob_hist": self.winprob_hist if self.status == "finished" else None,
        }

    def skin_of(self, uid: int) -> str:
        if is_bot(uid):
            return {"careful": "ice", "balanced": "onyx", "risky": "ruby"}.get(self.bots.get(uid, ""), "ivory")
        admin = is_admin(uid)
        gold = self.manager.admin_prefs.get(uid, {}).get("gold", True)
        return self.manager.profiles.skin(uid, admin, gold)

    async def broadcast(self) -> None:
        self.updated = time.time()
        state = self.state()
        payload = json.dumps({"type": "state", "state": state}, ensure_ascii=False)
        admin_payload = None
        if self.game and any(is_admin(u) for u in self.clients.values()):
            # подкрутки видит только админ
            admin_payload = json.dumps({"type": "state", "state": dict(state, rigs=self.game.rigs_view())},
                                       ensure_ascii=False)
        for ws, uid in list(self.clients.items()):
            try:
                await ws.send_str(admin_payload if admin_payload and is_admin(uid) else payload)
            except Exception:  # noqa: BLE001 — клиент отвалился
                self.clients.pop(ws, None)

    async def send_all(self, obj: dict) -> None:
        payload = json.dumps(obj, ensure_ascii=False)
        for ws in list(self.clients):
            try:
                await ws.send_str(payload)
            except Exception:  # noqa: BLE001
                self.clients.pop(ws, None)

    async def send_to(self, ws, obj: dict) -> None:
        try:
            await ws.send_str(json.dumps(obj, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            pass

    # ---------- подключения ----------

    async def attach(self, ws, uid: int, name: str, spectate: bool = False) -> None:
        self.clients[ws] = uid
        if (not spectate and self.status == "lobby" and uid not in self.members
                and len(self.members) < MAX_PLAYERS):
            self.members[uid] = name
            self._auto_team(uid)
            await self.manager.notify("lobby_update", self)
        await self.broadcast()

    async def detach(self, ws) -> None:
        if self.clients.pop(ws, None) is not None:
            await self.broadcast()

    # ---------- журнал действий (для админа) ----------

    def _audit(self, uid: int, name: str, action: str, detail: str = "") -> None:
        entry = {"t": time.time(), "uid": uid, "name": name, "action": action, "detail": detail}
        self.audit.append(entry)
        if len(self.audit) > 500:
            self.audit = self.audit[-500:]
        self.manager.write_audit(self, entry)

    # ---------- действия ----------

    async def handle(self, uid: int, name: str, msg: dict, ws) -> None:
        action = msg.get("type")
        is_owner = uid == self.owner
        admin = is_admin(uid)
        events: list[dict] = []

        if action == "react":
            emoji = msg.get("emoji")
            if emoji in REACTIONS and self._rate_ok(uid, 0.7):
                await self.send_all({"type": "reaction", "uid": uid, "name": name, "emoji": emoji})
            return

        if action == "sticker":
            sid = msg.get("id")
            if sid in STICKERS and self._rate_ok(uid, 2.0):
                emoji, text = STICKERS[sid]
                await self.send_all({"type": "sticker", "uid": uid, "name": name, "id": sid,
                                     "emoji": emoji, "text": text})
            return

        if action == "my_achievements":
            await self.send_to(ws, {"type": "achievements", "list": self.manager.achievements_of(uid)})
            return

        if action == "my_profile":
            await self.send_to(ws, self.manager.profile_msg(uid))
            return

        if action == "skin":
            try:
                self.manager.profiles.set_skin(uid, str(msg.get("id") or ""), is_admin(uid))
            except ValueError as e:
                raise GameError(str(e)) from None
            await self.send_to(ws, self.manager.profile_msg(uid))
            await self.manager.broadcast_all()
            return

        if action == "profile_full":
            target = int(msg.get("uid") or uid)
            await self.send_to(ws, self.manager.profile_full(target, viewer=uid))
            return

        if action == "records":
            await self.send_to(ws, {"type": "records", **chat_records(self.manager.history, self.chat_id)})
            return

        if action == "game_detail":
            rec = self.manager.history.get(str(msg.get("id") or ""), include_off=admin)
            self._require(rec is not None, "партия не найдена")
            await self.send_to(ws, {"type": "game_detail", "game": rec})
            return

        if action == "team":
            self._require(self.status == "lobby" and self.teams_mode, "команды выбираются в лобби")
            target = int(msg.get("uid") or uid)
            self._require(target == uid or is_owner or admin, "менять чужую команду может только создатель")
            self._require(target in self.members, "игрок не в лобби")
            team = int(msg.get("team", -1))
            self._require(0 <= team < len(TEAM_NAMES), "нет такой команды")
            self._require(sum(1 for u, t in self.team_of.items() if t == team and u != target) < 2, "в команде уже двое")
            self.team_of[target] = team
            await self.broadcast()
            return

        if action == "shuffle_teams":
            self._require(self.status == "lobby" and self.teams_mode and (is_owner or admin), "перемешивает создатель")
            uids = list(self.members)
            random.shuffle(uids)
            self.team_of = {u: i // 2 for i, u in enumerate(uids)}
            await self.broadcast()
            return

        if action == "my_presets":
            await self.send_to(ws, {"type": "presets", "list": self.manager.presets_of(uid)})
            return

        if action == "save_preset":
            pname = str(msg.get("name") or "").strip()[:40] or "Мои правила"
            if not self.manager.presets:
                raise GameError("пресеты недоступны")
            pid = self.manager.presets.create(pname, self.rules, uid)
            if self.preset_name() == "Свои":
                self._custom_name, self._custom_rules = pname, self.rules
            await self.send_to(ws, {"type": "preset_saved", "id": pid, "name": pname,
                                    "link": self.manager.preset_link(pid)})
            await self.broadcast()
            return

        if action == "admin":
            if not admin:
                raise GameError("нет доступа")
            await self._admin(uid, name, msg, ws)
            return

        if action in GAME_ACTIONS and self.paused:
            raise GameError("игра на паузе")

        if action == "join":
            if self.status != "lobby":
                raise GameError("игра уже началась")
            if uid not in self.members:
                if len(self.members) >= MAX_PLAYERS:
                    raise GameError("комната заполнена")
                self.members[uid] = name
                self._auto_team(uid)
                await self.manager.notify("lobby_update", self)

        elif action == "settings":
            self._require((is_owner and self.status == "lobby") or admin, "настройки меняет создатель в лобби")
            if "timer" in msg:
                timer = int(msg["timer"])
                if timer not in TIMER_OPTIONS:
                    raise GameError("неверный таймер")
                self.timer = timer
            if "teams" in msg:
                self._require(self.status == "lobby", "команды настраиваются в лобби")
                self.teams_mode = bool(msg["teams"])
                self.team_of = {}
                if self.teams_mode:
                    for u in self.members:
                        self._auto_team(u)
            if "map" in msg:
                if msg["map"] not in MAPS:
                    raise GameError("неизвестная карта")
                self.map = msg["map"]
            if "stake" in msg:
                stake = int(msg["stake"])
                if stake not in STAKES:
                    raise GameError("неверный взнос")
                self._require(self.status == "lobby", "взнос меняется в лобби")
                self._require(not stake or not self.bots, "с ботами играем без ставок")
                self.stake = stake
            if "barrel" in msg:
                rules = dict(self.rules, barrel=msg["barrel"])
                if msg["barrel"] == "knock" and self.rules["barrel"] != "knock":
                    rules["barrel_start"] = 850
                elif msg["barrel"] == "points" and self.rules["barrel"] == "knock":
                    rules["barrel_start"] = 880
                self._set_rules(rules)
            await self.manager.notify("lobby_update", self)

        elif action == "rules":
            self._require((is_owner and self.status == "lobby") or admin, "правила меняет создатель в лобби")
            self._set_rules(msg.get("rules"))
            self._audit(uid, name, "rules", "правила изменены")
            await self.manager.notify("lobby_update", self)

        elif action == "preset":
            self._require((is_owner and self.status == "lobby") or admin, "пресет выбирает создатель в лобби")
            self.load_preset(str(msg.get("id") or ""))
            await self.manager.notify("lobby_update", self)

        elif action == "add_bot":
            self._require(is_owner and self.status == "lobby", "ботов добавляет создатель в лобби")
            style = msg.get("style")
            self._require(style in BOT_STYLES, "неизвестный бот")
            self._require(len(self.members) < MAX_PLAYERS, "комната заполнена")
            bid = min([0, *self.members]) - 1
            name = BOT_STYLES[style][0]
            same_name = sum(1 for b in self.bots.values() if b == style)
            self.members[bid] = name + (f" {same_name + 1}" if same_name else "")
            self.bots[bid] = style
            self._auto_team(bid)
            self.stake = 0
            await self.manager.notify("lobby_update", self)

        elif action == "start":
            self._require(is_owner and self.status == "lobby", "начать может только создатель")
            self._require(len(self.members) >= 1, "нет игроков")
            teams = self._teams_list() if self.teams_mode else None
            self._take_stakes()
            self.game = Game(list(self.members.items()), rules=self.rules, teams=teams)
            self.status = "game"
            self.started_at = time.time()
            self.winprob, self.winprob_hist, self._wp_turn = {}, [], None
            self.snapshots = []
            self._announced = {}
            self.rigged = False
            self._audit(uid, name, "start", self.preset_name())
            await self.manager.notify("game_started", self)

        elif action in GAME_ACTIONS:
            g = self._game()
            self._snapshot()
            if action == "order_roll":
                events = g.order_roll(uid)
            elif action == "order_roll_all":
                self._require(is_owner, "только создатель")
                self._require(g.phase == "order", "очерёдность уже определена")
                events = g.timeout()
            elif action == "roll":
                events = g.roll(uid)
            else:
                events = g.stop(uid)
            self._audit_events(uid, name, action, events)

        elif action == "leave":
            await self._remove(uid)
            await self.send_to(ws, {"type": "left"})
            return

        elif action == "kick":
            self._require(is_owner, "исключать может только создатель")
            await self._kick(int(msg.get("uid", 0)))
            return

        elif action == "rematch":
            self._require(is_owner and self.status == "finished", "реванш предлагает создатель после игры")
            if self.game:
                self.members = {p.uid: p.name for p in self.game.players} or self.members
            self.game = None
            self.status = "lobby"
            self.lobby_msg_id = None
            await self.manager.notify("lobby_update", self)

        elif action == "end":
            self._require(is_owner, "завершить может только создатель")
            await self.cancel()
            return

        else:
            raise GameError("неизвестное действие")

        await self._after(events)

    def _auto_team(self, uid: int) -> None:
        """Новый игрок в командном режиме встаёт в первую команду со свободным местом."""
        if not self.teams_mode or uid in self.team_of:
            return
        for t in range(len(TEAM_NAMES)):
            if sum(1 for v in self.team_of.values() if v == t) < 2:
                self.team_of[uid] = t
                return

    def _teams_list(self) -> list[list[int]]:
        teams: dict[int, list[int]] = {}
        for u in self.members:
            self._require(u in self.team_of, f"{self.members[u]} не выбрал(а) команду")
            teams.setdefault(self.team_of[u], []).append(u)
        self._require(len(teams) >= 2 and all(len(t) == 2 for t in teams.values()),
                      "в командной игре нужны пары: в каждой команде ровно 2 игрока, команд — от двух")
        return [teams[k] for k in sorted(teams)]

    def _rate_ok(self, uid: int, gap: float) -> bool:
        now = time.time()
        if now - self._last_react.get(uid, 0) <= gap:
            return False
        self._last_react[uid] = now
        return True

    def _set_rules(self, raw) -> None:
        try:
            rules = normalize(raw)
        except RulesError as e:
            raise GameError(str(e)) from None
        self.rules = rules
        if self.game:
            self.game.set_rules(rules)

    def load_preset(self, pid: str) -> None:
        if pid in BUILTIN_PRESETS:
            self._set_rules(BUILTIN_PRESETS[pid][1])
            self._custom_name = self._custom_rules = None
            return
        preset = self.manager.presets.get(pid) if self.manager.presets else None
        if not preset:
            raise GameError("пресет не найден")
        self._set_rules(preset["rules"])
        self._custom_name, self._custom_rules = preset["name"], self.rules

    def _require(self, cond: bool, err: str) -> None:
        if not cond:
            raise GameError(err)

    def _game(self) -> Game:
        if self.status != "game" or not self.game:
            raise GameError("игра не идёт")
        return self.game

    def _snapshot(self) -> None:
        """Снимок перед первым действием хода — для «отменить последний ход»."""
        g = self.game
        if not g or g.phase != "play" or g.rolls_in_turn:
            return
        if self.snapshots and self.snapshots[-1][0] == g.turn_no:
            return
        self.snapshots.append((g.turn_no, g.snapshot()))
        if len(self.snapshots) > MAX_SNAPSHOTS:
            self.snapshots.pop(0)

    def _audit_events(self, uid: int, name: str, action: str, events: list[dict]) -> None:
        g = self.game
        if action in ("roll", "order_roll") and g and g.last_roll and g.last_roll["uid"] == uid:
            lr = g.last_roll
            detail = " ".join(map(str, lr["dice"])) + f" → {lr['points']}" + (" (подкручено)" if lr.get("forced") else "")
            self._audit(uid, name, action, detail)
        else:
            self._audit(uid, name, action, "; ".join(e["text"] for e in events if e["kind"] != "roll")[:300])

    async def _kick(self, target: int) -> None:
        self._require(target != self.owner or self.status != "lobby", "нельзя исключить создателя в лобби")
        await self._remove(target)
        for c, cu in list(self.clients.items()):
            if cu == target:
                await self.send_to(c, {"type": "kicked"})

    async def _remove(self, uid: int) -> None:
        if self.status == "lobby":
            self.members.pop(uid, None)
            self.bots.pop(uid, None)
            self.team_of.pop(uid, None)
            if uid == self.owner:
                if not self.members:
                    await self.cancel()
                    return
                self.owner = next(iter(self.members))
            await self.manager.notify("lobby_update", self)
        elif self.status == "game" and self.game:
            if any(p.uid == uid for p in self.game.players):
                events = self.game.remove_player(uid)
                self.members.pop(uid, None)
                if uid == self.owner and self.game.players:
                    self.owner = self.game.players[0].uid
                await self._after(events)
                return
        await self.broadcast()

    async def _after(self, events: list[dict]) -> None:
        if self.game and self.status == "game":
            if events:
                await self.manager.notify("game_events", self, events)
            await self._check_achievements(final=False)
            if self.game.phase == "finished":
                self.status = "finished"
                self._cancel_timer()
                self.winprob = {str(p.uid): float(p.uid in self.game.winners) for p in self.game.players}
                self.winprob_hist.append({"turn": self.game.turn_no, "p": self.winprob})
                if self.game.winner is not None:
                    self.manager.record(self)
                    await self._check_achievements(final=True)
                    self.manager.archive(self)  # после ачивок и до выплаты: в запись попадают ачивки и ставки
                    await self._pay_bank(self.game.winners or [self.game.winner])
                else:
                    self._refund()
                await self.manager.notify("game_over", self)
            else:
                self._restart_timer()
                self._schedule_bot()
                self._schedule_winprob()
        await self.broadcast()

    # ---------- шансы на победу ----------

    def _schedule_winprob(self, force: bool = False) -> None:
        """В начале каждого хода (и после правок админа) считаем шансы в фоновом потоке."""
        g = self.game
        if not config.WINPROB_BUDGET or not g or g.phase != "play":
            return
        if not force and (g.rolls_in_turn or g.turn_no == self._wp_turn):
            return
        self._wp_turn = turn = g.turn_no
        self._wp_seq += 1
        base = sim_clone(g, random.Random())
        uids = [p.uid for p in g.players]
        asyncio.create_task(self._winprob_task(g, turn, base, uids, self._wp_seq))

    async def _winprob_task(self, g, turn: int, base, uids: list[int], seq: int) -> None:
        try:
            probs = await asyncio.to_thread(chances_from_clone, base, uids, config.WINPROB_BUDGET)
        except Exception:  # noqa: BLE001 — аналитика не должна ронять игру
            log.exception("winprob failed in room %s", self.id)
            return
        if self.game is not g or self.status != "game" or seq != self._wp_seq:
            return  # партия кончилась или уже идёт более свежий расчёт
        self.winprob = probs
        if self.winprob_hist and self.winprob_hist[-1]["turn"] == turn:
            self.winprob_hist[-1] = {"turn": turn, "p": probs}
        else:
            self.winprob_hist.append({"turn": turn, "p": probs})
        await self.broadcast()

    # ---------- фишки ----------

    def _take_stakes(self) -> None:
        self.stakes = {}
        if not self.stake:
            return
        self._require(not self.bots, "с ботами играем без ставок")
        prof = self.manager.profiles
        poor = [f"{self.members[u]} ({prof.chips(u)})" for u in self.members if prof.chips(u) < self.stake]
        self._require(not poor, "не хватает фишек на взнос: " + ", ".join(poor))
        for u in self.members:
            prof.add_chips(u, -self.stake)
            self.stakes[u] = self.stake

    async def _pay_bank(self, winners: list[int]) -> None:
        """Банк — победителю; в командной игре делится поровну между игроками команды."""
        bank = sum(self.stakes.values())
        shares = bank_shares(self.stakes, winners)
        self.stakes = {}
        if not shares:
            return
        people = list(shares)
        for u, share in shares.items():
            self.manager.profiles.add_chips(u, share)
        names = " и ".join(self.game.player(u).name for u in people) if self.game else "?"
        await self.send_all({"type": "bank", "uid": people[0], "uids": people, "name": names, "amount": bank})

    def _refund(self) -> None:
        for u, amount in self.stakes.items():
            self.manager.profiles.add_chips(u, amount)
        self.stakes = {}

    # ---------- боты ----------

    def _schedule_bot(self) -> None:
        if self._bot_task and not self._bot_task.done():
            return
        g = self.game
        if not g or self.status != "game" or self.paused or not self.bots:
            return
        if g.phase == "order":
            if not any(is_bot(p.uid) and g.order_pending(p) for p in g.players):
                return
        elif g.phase != "play" or not is_bot(g.cur.uid):
            return
        delay = BOT_DELAY[0] + (BOT_DELAY[1] - BOT_DELAY[0]) * (time.time() % 1)
        self._bot_task = asyncio.create_task(self._bot_act(delay))

    async def _bot_act(self, delay: float) -> None:
        await asyncio.sleep(delay)
        self._bot_task = None
        g = self.game
        if not g or self.status != "game" or self.paused:
            return
        try:
            if g.phase == "order":
                bot = next((p for p in g.players if is_bot(p.uid) and g.order_pending(p)), None)
                if not bot:
                    return
                events = g.order_roll(bot.uid)
                action = "order_roll"
            elif g.phase == "play" and is_bot(g.cur.uid):
                bot = g.cur
                self._snapshot()
                stop = g.rolls_in_turn > 0 and wants_stop(g, self.bots.get(bot.uid, "balanced"))
                events = g.stop(bot.uid) if stop else g.roll(bot.uid)
                action = "stop" if stop else "roll"
            else:
                return
            self._audit_events(bot.uid, bot.name, action, events)
            await self._after(events)
        except Exception:  # noqa: BLE001 — бот не должен ронять комнату
            log.exception("bot failed in room %s", self.id)

    async def _check_achievements(self, final: bool) -> None:
        g = self.game
        if not g or not self.manager.stats:
            return
        got = []
        for p in g.players:
            if is_bot(p.uid):
                continue
            ids = set(moment_ids(p))
            if final:
                ids |= end_ids(g, p)
                total = self.manager.stats.user_total(p.uid)
                if total:
                    ids |= career_ids(total)
            done = self._announced.setdefault(p.uid, set())
            for aid in sorted(ids - done):
                done.add(aid)
                if self.manager.stats.unlock(p.uid, aid):
                    got.append((p, aid))
        for p, aid in got:
            emoji, title, desc = ACHIEVEMENTS[aid]
            await self.send_all({"type": "achievement", "uid": p.uid, "name": p.name, "id": aid,
                                 "emoji": emoji, "title": title, "desc": desc})
        if got:
            lines = [{"kind": "achievement", "notable": True,
                      "text": f"🏅 {p.name}: ачивка {ACHIEVEMENTS[aid][0]} «{ACHIEVEMENTS[aid][1]}»"} for p, aid in got]
            await self.manager.notify("game_events", self, lines)

    async def cancel(self) -> None:
        if self.status == "game":
            self._refund()
        self.status = "cancelled"
        self._cancel_timer()
        await self.manager.notify("cancelled", self)
        await self.broadcast()

    # ---------- админ ----------

    async def _admin(self, uid: int, name: str, msg: dict, ws) -> None:
        op = msg.get("op")
        g = self.game
        events: list[dict] = []
        self._audit(uid, name, f"admin:{op}", json.dumps({k: v for k, v in msg.items() if k not in ("type", "op")},
                                                         ensure_ascii=False)[:200])
        if op == "audit":
            await self.send_to(ws, {"type": "admin_audit", "list": self.audit[-200:]})
            return
        if op == "rooms":
            await self.send_to(ws, {"type": "admin_rooms", "list": self.manager.rooms_overview()})
            return
        if op == "cosmetics":
            prefs = self.manager.admin_prefs.setdefault(uid, {})
            for k in ("gold", "badge"):
                if k in msg:
                    prefs[k] = bool(msg[k])
            self.manager.save_admin_prefs()
            await self.manager.broadcast_all()
            return
        if op in ADMIN_GLOBAL_OPS:
            await self.manager.admin_global(uid, msg, lambda obj: self.send_to(ws, obj))
            await self.manager.broadcast_all()
            return
        if op == "chips":
            target = int(msg.get("uid", 0))
            self._require(not is_bot(target), "у ботов нет фишек")
            self.manager.profiles.set_chips(target, int(msg.get("value", 0)))
            await self.broadcast()
            return
        if op == "announce":
            text = str(msg.get("text") or "").strip()[:140]
            if text:
                await self.send_all({"type": "announce", "text": text})
            return
        if op == "end":
            await self.cancel()
            return
        if op == "games":
            await self.send_to(ws, {"type": "admin_games", "list": self.manager.games_overview(), "here": self.chat_id})
            return
        if op in ("game_off", "game_on", "game_purge"):
            gid = str(msg.get("id") or "")
            try:
                text = {"game_off": self.manager.exclude_game, "game_on": self.manager.restore_game,
                        "game_purge": self.manager.purge_game}[op](gid)
            except ValueError as e:
                raise GameError(str(e)) from None
            await self.send_to(ws, {"type": "admin_games", "list": self.manager.games_overview(), "here": self.chat_id,
                                    "text": text})
            await self.manager.broadcast_all()  # фишки и ачивки могли измениться
            return
        if op == "kick":
            await self._kick(int(msg.get("uid", 0)))
            return
        if op in ("pause", "resume"):
            self._require(self.status == "game", "игра не идёт")
            self.paused = op == "pause"
            if self.paused:
                self._cancel_timer()
            else:
                self._restart_timer()
                self._schedule_bot()
            await self.broadcast()
            return

        g = self._game()
        if op in ("set_score", "bolt", "samosval", "force", "rig"):
            self.rigged = True
        if op == "undo":
            self._require(self.snapshots, "нечего отменять")
            cur, started = g.turn_no, g.rolls_in_turn > 0 or g.phase != "play"
            while self.snapshots and self.snapshots[-1][0] == cur and not started:
                self.snapshots.pop()
            self._require(self.snapshots, "нечего отменять")
            _, snap = self.snapshots.pop()
            g.restore_from(snap)
        elif op == "set_score":
            g.admin_set_score(int(msg.get("uid", 0)), int(msg.get("score", 0)))
        elif op == "bolt":
            events = g.admin_bolt(int(msg.get("uid", 0)))
        elif op == "samosval":
            events = g.admin_samosval(int(msg.get("uid", 0)))
        elif op == "force":
            dice = msg.get("dice") or []
            try:
                dice = [int(d) for d in dice]
            except (TypeError, ValueError):
                raise GameError("значения кубиков — числа от 1 до 6") from None
            g.force_next(dice)
            await self.send_to(ws, {"type": "admin_ok", "text": f"Следующий бросок: {' '.join(map(str, dice))}"})
            return
        elif op == "rig":
            target = int(msg.get("uid", 0))
            what = g.rig(target, {"mode": msg.get("mode"), "dice": msg.get("dice")})
            await self.send_to(ws, {"type": "admin_ok", "text": f"🎯 {g.player(target).name}: {what}"})
            await self.broadcast()
            return
        elif op == "unrig":
            g.unrig(int(msg.get("uid", 0)))
            await self.broadcast()
            return
        else:
            raise GameError("неизвестная команда")
        await self._after(events)
        self._schedule_winprob(force=True)  # счёт поменялся вручную — шансы пересчитываем

    # ---------- таймер ----------

    def _cancel_timer(self) -> None:
        self.deadline = None
        self._timer_token += 1
        if self._timer_task:
            self._timer_task.cancel()
            self._timer_task = None

    def _restart_timer(self) -> None:
        self._cancel_timer()
        secs = self.timer
        if not secs or self.status != "game" or self.paused:
            return
        self.deadline = time.time() + secs + ANIMATION_GRACE
        token = self._timer_token
        self._timer_task = asyncio.create_task(self._timer(token, secs + ANIMATION_GRACE))

    async def _timer(self, token: int, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        if token != self._timer_token or self.status != "game" or not self.game or self.paused:
            return
        self._timer_task = None
        try:
            self._snapshot()
            events = self.game.timeout()
            self._audit(0, "таймер", "timeout", "; ".join(e["text"] for e in events)[:300])
            await self._after(events)
        except Exception:  # noqa: BLE001
            log.exception("timer failed in room %s", self.id)


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

    # ---------- партии в админ-панели ----------

    def games_overview(self) -> list[dict]:
        titles = {g["chat"]: g["chat_title"] for g in self.history.games if g.get("chat_title")}
        res = []
        for g in sorted(self.history.games, key=lambda g: -g["t1"]):
            res.append({
                "id": g["id"], "t": g["t1"], "duration": round(g["t1"] - g["t0"]), "turns": g["turns"],
                "chat": g.get("chat"), "chat_title": titles.get(g.get("chat")), "teams": bool(g["teams"]),
                "off": bool(g.get("off")), "rigged": bool(g.get("rigged")),
                "bank": sum(g.get("stakes", {}).values()),
                "ach": sum(len(v) for v in g.get("ach", {}).values()),
                "players": [{"uid": p["uid"], "name": p["name"], "score": p["score"], "bot": p["bot"],
                             "won": p["uid"] in g["winners"], "best_turn": p["st"].get("best_turn", 0)}
                            for p in sorted(g["players"], key=lambda p: (p["uid"] not in g["winners"], -p["score"]))],
            })
        return res

    def exclude_game(self, gid: str) -> str:
        """Партия перестаёт учитываться: счётчики чата, лучший ход, ачивки этой партии и банк откатываются.
        Всё, что изменили, сохраняется в записи (undo), чтобы партию можно было вернуть."""
        g = self.history.get(gid, include_off=True)
        if g is None:
            raise ValueError("партия не найдена")
        if g.get("off"):
            raise ValueError("партия уже не учитывается")
        g["off"] = True  # дальше history.of_user/of_chat её уже не видят
        undo: dict = {"best": {}, "ach": {}, "chips": {}}
        humans = [p for p in g["players"] if not p["bot"]]
        chat = g.get("chat")
        if self.stats:
            if chat is not None:
                self.stats.adjust_game(chat, humans, g["winners"], -1)
                for p in humans:
                    row = self.stats.row(chat, p["uid"])
                    if row and p["st"].get("best_turn", 0) >= row["best_turn"]:
                        undo["best"][str(p["uid"])] = row["best_turn"]
                        rest = (q["st"].get("best_turn", 0) for x in self.history.of_chat(chat)
                                for q in x["players"] if q["uid"] == p["uid"])
                        self.stats.set_best_turn(chat, p["uid"], max(rest, default=0))
            for p in humans:
                changed = self._revoke_achievements(g, p["uid"])
                if changed:
                    undo["ach"][str(p["uid"])] = changed
        prof = self.profiles
        stakes = {int(u): v for u, v in g.get("stakes", {}).items()}
        delta = {u: v for u, v in stakes.items()}  # взносы возвращаем…
        for u, share in bank_shares(stakes, g["winners"]).items():  # …а выигрыш забираем
            delta[u] = delta.get(u, 0) - share
        for u, d in delta.items():
            if d:
                before = prof.chips(u)
                undo["chips"][str(u)] = prof.add_chips(u, d) - before  # фишек не бывает меньше нуля
        g["undo"] = undo
        self.history.save()
        return "Партия больше не учитывается"

    def _revoke_achievements(self, g: dict, uid: int) -> dict[str, float]:
        """Ачивки игрока, полученные в партии g: переносятся на другую учитываемую партию, где они тоже выпали,
        иначе забираются. Карьерные — забираются, если порог больше не выполнен. Возвращает {aid: старое время}."""
        mine = self.stats.achievements(uid)
        career = career_ids(self.stats.user_total(uid) or {})
        changed = {}
        for aid, ts in list(mine.items()):
            if aid in CAREER_IDS:
                if aid not in career:
                    changed[aid] = ts
                    self.stats.set_unlock(uid, aid, None)
                continue
            # итоговые ачивки выдаются через мгновение после записи партии — отсюда запас после t1
            if not g["t0"] - 1 <= ts <= g["t1"] + 60:
                continue
            changed[aid] = ts
            other = min((x["t1"] for x in self.history.of_user(uid) if aid in x.get("ach", {}).get(str(uid), [])),
                        default=None)
            self.stats.set_unlock(uid, aid, other)
        return changed

    def restore_game(self, gid: str) -> str:
        g = self.history.get(gid, include_off=True)
        if g is None:
            raise ValueError("партия не найдена")
        if not g.get("off"):
            raise ValueError("партия и так учитывается")
        undo = g.pop("undo", {})
        g.pop("off")
        humans = [p for p in g["players"] if not p["bot"]]
        chat = g.get("chat")
        if self.stats:
            if chat is not None:
                self.stats.adjust_game(chat, humans, g["winners"], 1)
                for p in humans:
                    row = self.stats.row(chat, p["uid"])
                    best = max(row["best_turn"], p["st"].get("best_turn", 0), undo["best"].get(str(p["uid"]), 0))
                    self.stats.set_best_turn(chat, p["uid"], best)
            for u, changed in undo.get("ach", {}).items():
                mine = self.stats.achievements(int(u))
                for aid, ts in changed.items():
                    self.stats.set_unlock(int(u), aid, min(ts, mine.get(aid, ts)))
        for u, d in undo.get("chips", {}).items():
            self.profiles.add_chips(int(u), -d)
        self.history.save()
        return "Партия снова учитывается"

    def purge_game(self, gid: str) -> str:
        g = self.history.get(gid, include_off=True)
        if g is None:
            raise ValueError("партия не найдена")
        if not g.get("off"):
            raise ValueError("сначала отметь партию как неучитываемую")
        self.history.remove(gid)
        return "Партия удалена навсегда"

    def profile_full(self, uid: int, viewer: int | None = None) -> dict:
        """Полный профиль: аналитика по истории + карьерная статистика, ачивки, скин, фишки."""
        admin = is_admin(uid)
        gold = self.admin_prefs.get(uid, {}).get("gold", True)
        total = self.stats.user_total(uid) if self.stats else None
        ach = self.achievements_of(uid)
        return {"type": "profile_full", **profile(self.history, uid, viewer),
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
