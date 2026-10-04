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
from .achievements import ACHIEVEMENTS, career_ids, end_ids, moment_ids
from .ai import BOT_STYLES, is_bot, wants_stop
from .engine import TEAM_NAMES, Game, GameError
from .history import History, chat_records, game_record, profile
from .winprob import chances_from_clone, sim_clone
from .profiles import ALL_SKINS, MAPS, PERSONAL_SKINS, PUBLIC_SKINS, STAKES, Profiles
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
BOT_DELAY = (1.6, 2.6)  # сек между действиями бота: успевает проиграться анимация броска


def is_admin(uid: int | None) -> bool:
    return uid in config.ADMIN_IDS


class Room:
    def __init__(self, manager: RoomManager, chat_id: int | None, owner_uid: int, owner_name: str,
                 rules: dict | None = None, preset_name: str | None = None):
        self.manager = manager
        self.id = secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")
        self.chat_id = chat_id
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
                "skins": {str(u): self.skin_of(u) for u in players | set(self.members)},
            },
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
            rec = self.manager.history.get(str(msg.get("id") or ""))
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

    def _schedule_winprob(self) -> None:
        """В начале каждого хода считаем шансы в фоновом потоке (симуляция партии до конца)."""
        g = self.game
        if not config.WINPROB_BUDGET or not g or g.phase != "play" or g.rolls_in_turn or g.turn_no == self._wp_turn:
            return
        self._wp_turn = turn = g.turn_no
        base = sim_clone(g, random.Random())
        uids = [p.uid for p in g.players]
        asyncio.create_task(self._winprob_task(g, turn, base, uids))

    async def _winprob_task(self, g, turn: int, base, uids: list[int]) -> None:
        try:
            probs = await asyncio.to_thread(chances_from_clone, base, uids, config.WINPROB_BUDGET)
        except Exception:  # noqa: BLE001 — аналитика не должна ронять игру
            log.exception("winprob failed in room %s", self.id)
            return
        if self.game is not g or self.status != "game":
            return
        self.winprob = probs
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
        self.stakes = {}
        people = [u for u in winners if not is_bot(u)]
        if not bank or not people:
            return
        share = bank // len(people)
        for u in people:
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
        if op == "grant_skin":
            target, skin = int(msg.get("uid", 0)), str(msg.get("skin") or "")
            try:
                self.manager.profiles.grant(target, skin, bool(msg.get("on", True)))
            except ValueError as e:
                raise GameError(str(e)) from None
            await self.send_to(ws, {"type": "admin_ok", "text": f"Скин «{PERSONAL_SKINS[skin]}»: "
                                                                f"{'выдан' if msg.get('on', True) else 'забран'}"})
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
        self.profiles = Profiles(data_dir / "profiles.json" if data_dir else None)
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
        if room.game and any(p.uid >= 0 for p in room.game.players):
            self.history.add(game_record(room))
        if self.stats and room.chat_id is not None and room.game:
            people = [p for p in room.game.players if not is_bot(p.uid)]
            self.stats.record_game(room.chat_id, people, room.game.winners)

    def profile_full(self, uid: int, viewer: int | None = None) -> dict:
        """Полный профиль: аналитика по истории + карьерная статистика, ачивки, скин, фишки."""
        admin = is_admin(uid)
        gold = self.admin_prefs.get(uid, {}).get("gold", True)
        total = self.stats.user_total(uid) if self.stats else None
        ach = self.achievements_of(uid)
        return {"type": "profile_full", **profile(self.history, uid, viewer),
                "name": (total or {}).get("name") or self._name_of(uid),
                "career": total, "chips": self.profiles.chips(uid), "skin": self.profiles.skin(uid, admin, gold),
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
        return {"type": "profile", "chips": self.profiles.chips(uid), "skin": self.profiles.skin(uid, admin, gold),
                "skins": [{"id": k, "name": ALL_SKINS[k], "personal": k not in PUBLIC_SKINS} for k in allowed]}

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
