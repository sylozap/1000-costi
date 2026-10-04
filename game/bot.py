"""Telegram-бот: создание игр в группе, уведомления о событиях, статистика."""
from __future__ import annotations

import asyncio
import logging
from html import escape

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ChatMemberStatus, ChatType, ParseMode
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (BotCommand, BotCommandScopeAllGroupChats, BotCommandScopeAllPrivateChats,
                           InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo)

from . import config
from .achievements import ACHIEVEMENTS
from .auth import display_name
from .engine import TEAM_NAMES, GameError
from .history import chat_records
from .rooms import Room, RoomManager, is_admin
from .rules import BUILTIN_PRESETS, CLASSIC, describe, short_title
from .stats import RATING_MIN_GAMES, Presets, Stats

log = logging.getLogger(__name__)


def rules_html(rules: dict, title: str = "🎲 Игра «1000» — правила") -> str:
    parts = [f"<b>{escape(title)}</b>", "", "5 кубиков. Цель — набрать 1000 очков."]
    for head, text in describe(rules):
        parts.append(f"\n<b>{escape(head)}.</b> {escape(text)}")
    parts.append("\nОчерёдность ходов разыгрывается бросками кубиков.")
    return "\n".join(parts)


def mention(uid: int, name: str) -> str:
    if uid < 0:  # бот-соперник — не аккаунт Telegram
        return escape(name)
    return f'<a href="tg://user?id={uid}">{escape(name)}</a>'


class GroupNotifier:
    def __init__(self, bot: Bot, username: str):
        self.bot = bot
        self.username = username
        self._buffers: dict[str, list[str]] = {}  # ачивки партии — уходят в итоговом сообщении
        self._lobby_tasks: dict[str, asyncio.Task] = {}

    # ---------- ссылки ----------

    def app_link(self, room: Room) -> str:
        if config.ENTRY_MODE == "private":
            return f"https://t.me/{self.username}?start=join_{room.id}"
        if config.WEBAPP_SHORT_NAME:
            return f"https://t.me/{self.username}/{config.WEBAPP_SHORT_NAME}?startapp={room.id}"
        return f"https://t.me/{self.username}?startapp={room.id}"

    def keyboard(self, room: Room, text: str) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text=text, url=self.app_link(room))]])

    # ---------- лобби ----------

    def lobby_text(self, room: Room) -> str:
        owner = room.members.get(room.owner, "?")
        players = "\n".join(f"  {i + 1}. {escape(n)}" for i, n in enumerate(room.members.values()))
        timer = f"{room.timer} с на действие" if room.timer else "без таймера"
        return (f"🎲 <b>Игра «1000»</b>\n"
                f"Создатель: {escape(owner)}\n"
                f"Правила: {escape(room.preset_name())} — {short_title(room.rules)}, {timer}\n\n"
                f"Игроки ({len(room.members)}/{config.MAX_PLAYERS}):\n{players}\n\n"
                f"Жми «Играть», чтобы присоединиться. Создатель запускает игру в приложении.")

    async def lobby_update(self, room: Room) -> None:
        if room.lobby_msg_id is None:
            msg = await self.bot.send_message(room.chat_id, self.lobby_text(room),
                                              reply_markup=self.keyboard(room, "🎲 Играть"))
            room.lobby_msg_id = msg.message_id
            return
        task = self._lobby_tasks.get(room.id)
        if task and not task.done():
            return  # правка уже запланирована и возьмёт свежее состояние
        self._lobby_tasks[room.id] = asyncio.create_task(self._edit_lobby_later(room))

    async def _edit_lobby_later(self, room: Room) -> None:
        await asyncio.sleep(1.5)
        if room.status != "lobby" or room.lobby_msg_id is None:
            return
        try:
            await self.bot.edit_message_text(self.lobby_text(room), chat_id=room.chat_id,
                                             message_id=room.lobby_msg_id,
                                             reply_markup=self.keyboard(room, "🎲 Играть"))
        except Exception as e:  # noqa: BLE001 — «message is not modified» и т.п.
            log.debug("lobby edit: %s", e)

    async def game_started(self, room: Room) -> None:
        if room.lobby_msg_id is None:
            return
        players = ", ".join(escape(n) for n in room.members.values())
        text = (f"🎲 <b>Игра «1000» началась!</b>\n"
                f"Правила: {escape(room.preset_name())} — {short_title(room.rules)}\nИгроки: {players}\n\n"
                f"Сначала разыгрываем очерёдность — все бросают кубики.")
        try:
            await self.bot.edit_message_text(text, chat_id=room.chat_id, message_id=room.lobby_msg_id,
                                             reply_markup=self.keyboard(room, "🎲 Открыть игру"))
        except Exception as e:  # noqa: BLE001
            log.debug("start edit: %s", e)

    # ---------- события партии ----------

    async def game_events(self, room: Room, events: list[dict]) -> None:
        """Во время партии в группу ничего не пишем — только копим ачивки для итогового сообщения."""
        lines = [escape(e["text"]) for e in events if e.get("kind") == "achievement"]
        if lines:
            self._buffers.setdefault(room.id, []).extend(lines)

    async def game_over(self, room: Room) -> None:
        achievements = self._buffers.pop(room.id, [])
        g = room.game
        if not g:
            return
        medals = ["🥇", "🥈", "🥉"]
        summary = g.summary()
        rows = []
        if g.teams:  # командная игра: строка на команду
            ranked = sorted(g.sides(), key=lambda sd: (not any(m.uid in g.winners for m in g.members(sd)), -sd.score))
            for i, sd in enumerate(ranked):
                badge = medals[i] if i < 3 else f"{i + 1}."
                rows.append(f"{badge} {escape(g.side_name(sd))} — {sd.score}")
        else:
            for i, r in enumerate(summary["rows"]):
                badge = medals[i] if i < 3 else f"{i + 1}."
                rows.append(f"{badge} {escape(r['name'])} — {r['score']}")
        if g.winner is not None:
            ws = [p for p in g.players if p.uid in (g.winners or [g.winner])]
            who = " и ".join(mention(p.uid, p.name) for p in ws)
            if g.teams:
                who = f"{escape(TEAM_NAMES[ws[0].side.team % len(TEAM_NAMES)])} ({who})"
            head = f"🏆 <b>Победа: {who}!</b>"
        else:
            head = "Игра окончена."
        parts = [head, "", "\n".join(rows)]
        if summary["highlights"]:
            parts += ["", "\n".join(escape(h) for h in summary["highlights"])]
        if achievements:
            parts += ["", "\n".join(achievements)]
        parts += ["", "Статистика: /stats · Новая игра: /newgame (или «Реванш» в приложении)"]
        await self.bot.send_message(room.chat_id, "\n".join(parts))

    async def cancelled(self, room: Room) -> None:
        self._buffers.pop(room.id, None)
        if room.lobby_msg_id:
            try:
                await self.bot.edit_message_text("🎲 Игра «1000» отменена.", chat_id=room.chat_id,
                                                 message_id=room.lobby_msg_id)
                return
            except Exception:  # noqa: BLE001
                pass
        await self.bot.send_message(room.chat_id, "🎲 Игра «1000» отменена.")


def format_stats_rows(rows: list[dict], chips: dict[int, int] | None = None) -> str:
    lines = []
    for i, r in enumerate(rows):
        bal = f" · 🪙 {chips[r['uid']]}" if chips and r.get("uid") in chips else ""
        games = r["games"]
        rate = f"{round(100 * r['wins'] / games)}%" if games else "—"
        mark = "" if games >= RATING_MIN_GAMES else " (мало игр для рейтинга)"
        lines.append(f"{i + 1}. <b>{escape(r.get('name', '?'))}</b> — {rate} побед ({r['wins']} из {games}){mark}\n"
                     f"    🚛 {r['samosvals']} · 🔩 {r['bolt_penalties']} · 🛢💥 {r['barrel_falls']} · "
                     f"🏎 {r['overtakes']} · лучший ход {r['best_turn']}{bal}")
    return "\n".join(lines)


def _dur(sec: int) -> str:
    m = max(1, round(sec / 60))
    return f"{m // 60} ч {m % 60} мин" if m >= 60 else f"{m} мин"


RECORD_LINES = (
    ("best_turn", "💥 Лучший ход", lambda v: f"{v}"),
    ("comeback", "🔄 Камбэк", lambda v: f"отставал(а) на {v}"),
    ("fastest", "⚡ Быстрая победа", lambda v: f"за {v} ходов"),
    ("quickest", "⏱ Самая короткая партия", _dur),
    ("longest", "🐢 Самая долгая партия", _dur),
    ("samosvals", "🚛 Самосвалов за партию", lambda v: f"{v}"),
    ("overtakes", "🏎 Обгонов за партию", lambda v: f"{v}"),
)


def format_records(data: dict) -> str:
    if not data["games"]:
        return "Рекордов пока нет: история копится с партий, сыгранных после обновления. /newgame"
    lines = [f"🏛 <b>Зал славы чата</b> · партий: {data['games']}", ""]
    for key, title, fmt in RECORD_LINES:
        r = data["records"].get(key)
        if r:
            lines.append(f"{title}: <b>{fmt(r['value'])}</b> — {escape(r['name'])}")
    h = data["honesty"]
    if h["n"]:
        verdict = {True: "кубики честные ✅", False: "подозрительно неровно 🤨", None: "мало бросков для вывода"}[h["fair"]]
        lines += ["", "🎲 Грани 1–6: " + " · ".join(f"{x}%" for x in h["share"]) + f" — {verdict}"]
    lines += ["", "<b>Последние партии</b>"]
    for g in data["recent"][:5]:
        ps = ", ".join(("🏆 " if p["won"] else "") + f"{escape(p['name'])} {p['score']}" for p in g["players"])
        lines.append(f"• {ps} ({g['turns']} ходов, {_dur(g['duration'])})")
    lines.append("\nПодробнее, с графиками — в приложении: ☰ → Рекорды чата.")
    return "\n".join(lines)


def format_achievements(stats: Stats, uid: int, name: str) -> str:
    mine = stats.achievements(uid)
    got = [f"{e} <b>{escape(t)}</b> — {escape(d)}" for aid, (e, t, d) in ACHIEVEMENTS.items() if aid in mine]
    left = [f"▫️ {escape(t)} — {escape(d)}" for aid, (e, t, d) in ACHIEVEMENTS.items() if aid not in mine]
    text = f"🏅 <b>Ачивки: {escape(name)}</b> ({len(got)}/{len(ACHIEVEMENTS)})\n\n"
    text += "\n".join(got) if got else "Пока ни одной — всё впереди!"
    if left:
        text += "\n\n<i>Ещё не получены:</i>\n" + "\n".join(left)
    return text


def build_router(manager: RoomManager, stats: Stats, notifier: GroupNotifier, presets: Presets | None = None) -> Router:
    router = Router()
    groups = F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP})

    @router.message(Command("newgame"), groups)
    async def newgame(message: Message, command: CommandObject):
        user = message.from_user
        room = manager.active_in_chat(message.chat.id)
        if room:
            text = "В этом чате уже есть игра. Открой её или заверши командой /endgame."
            await message.reply(text, reply_markup=notifier.keyboard(room, "🎲 Открыть игру"))
            return
        name = display_name(user.model_dump())
        room = manager.create(message.chat.id, user.id, name)
        code = (command.args or "").strip().removeprefix("p_")
        if code:
            try:
                room.load_preset(code if code in BUILTIN_PRESETS else code.upper())
            except GameError:
                await message.reply(f"Пресет «{escape(code)}» не найден — играем по классике.")
        await notifier.lobby_update(room)

    @router.message(Command("endgame"), groups)
    async def endgame(message: Message):
        room = manager.active_in_chat(message.chat.id)
        if not room:
            await message.reply("Активной игры нет. Создать: /newgame")
            return
        allowed = message.from_user.id == room.owner
        if not allowed:
            member = await message.bot.get_chat_member(message.chat.id, message.from_user.id)
            allowed = member.status in (ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR)
        if not allowed:
            await message.reply("Завершить игру может её создатель или админ чата.")
            return
        await room.cancel()

    @router.message(Command("records"), groups)
    async def records(message: Message):
        await message.reply(format_records(chat_records(manager.history, message.chat.id)))

    @router.message(Command("stats"), groups)
    async def stats_group(message: Message):
        rows = stats.chat_table(message.chat.id)
        if not rows:
            await message.reply("Ещё не сыграно ни одной партии. /newgame")
            return
        chips = {r["uid"]: manager.profiles.chips(r["uid"]) for r in rows}
        await message.reply(f"📊 <b>Рейтинг чата</b> — по проценту побед (от {RATING_MIN_GAMES} партий)\n"
                            "🚛 самосвалы · 🔩 штрафы за болты · 🛢💥 падения с бочки · 🏎 обгоны · 🪙 фишки\n\n"
                            + format_stats_rows(rows, chips))

    @router.message(Command("stats"), F.chat.type == ChatType.PRIVATE)
    async def stats_private(message: Message):
        row = stats.user_total(message.from_user.id)
        if not row:
            await message.answer("У тебя пока нет сыгранных партий.")
            return
        uid = message.from_user.id
        await message.answer("📊 <b>Твоя статистика (все чаты)</b>\n\n"
                             + format_stats_rows([dict(row, uid=uid)], {uid: manager.profiles.chips(uid)}))

    @router.message(Command("rules"))
    async def rules(message: Message):
        room = manager.active_in_chat(message.chat.id) if message.chat.type != ChatType.PRIVATE else None
        if room:
            await message.answer(rules_html(room.rules, f"🎲 Правила этой игры — {room.preset_name()}"))
        else:
            await message.answer(rules_html(CLASSIC))

    @router.message(Command("achievements"))
    async def achievements(message: Message):
        user = message.from_user
        await message.answer(format_achievements(stats, user.id, display_name(user.model_dump())))

    @router.message(Command("admin"), F.chat.type == ChatType.PRIVATE)
    async def admin_cmd(message: Message):
        if not is_admin(message.from_user.id):
            return
        rooms = [r for r in manager.rooms_overview() if r["status"] in ("lobby", "game")]
        if not rooms:
            await message.answer("🛠 Активных игр нет.")
            return
        rows, lines = [], []
        for r in rooms[:20]:
            st = "лобби" if r["status"] == "lobby" else ("пауза" if r["paused"] else "идёт")
            lines.append(f"• <code>{r['id']}</code> — {st}, {escape(r['rules'])}: {escape(', '.join(r['players']))}")
            if config.PUBLIC_URL:
                rows.append([InlineKeyboardButton(text=f"👀 {r['id']} ({st})", web_app=WebAppInfo(
                    url=f"{config.PUBLIC_URL}/?room={r['id']}&spectate=1"))])
        await message.answer("🛠 <b>Активные игры</b>\n" + "\n".join(lines),
                             reply_markup=InlineKeyboardMarkup(inline_keyboard=rows) if rows else None)

    @router.message(CommandStart(deep_link=True), F.chat.type == ChatType.PRIVATE)
    async def start_join(message: Message, command: CommandObject):
        arg = command.args or ""
        if arg.startswith("p_") and presets:
            preset = presets.get(arg[2:])
            if not preset:
                await message.answer("Пресет не найден — возможно, ссылка устарела.")
                return
            presets.add_to(message.from_user.id, arg[2:].upper())
            await message.answer(
                rules_html(preset["rules"], f"📋 Пресет «{preset['name']}»")
                + f"\n\n✅ Пресет сохранён у тебя. Выбери его в лобби или напиши в группе "
                  f"<code>/newgame {arg[2:].upper()}</code>")
            return
        room = manager.get(arg.removeprefix("join_")) if arg.startswith("join_") else None
        if not room or not config.PUBLIC_URL:
            await help_cmd(message)
            return
        kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(
            text="🎲 Играть", web_app=WebAppInfo(url=f"{config.PUBLIC_URL}/?room={room.id}"))]])
        await message.answer("Жми, чтобы открыть стол:", reply_markup=kb)

    @router.message(Command("start", "help"))
    async def help_cmd(message: Message):
        await message.answer(
            "🎲 <b>Игра «1000» в кости</b>\n\n"
            "1. Добавь меня в группу с друзьями.\n"
            "2. Напиши там /newgame — появится кнопка «Играть».\n"
            "3. Все жмут «Играть», создатель выбирает режим и запускает игру.\n\n"
            "Команды: /newgame [код пресета], /endgame, /stats, /achievements, /rules")

    return router


async def build_bot(manager: RoomManager, stats: Stats, presets: Presets | None = None) -> tuple[Bot, Dispatcher]:
    bot = Bot(config.BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    me = await bot.get_me()
    notifier = GroupNotifier(bot, me.username)
    manager.notifier = notifier
    manager.bot_username = me.username
    dp = Dispatcher()
    dp.include_router(build_router(manager, stats, notifier, presets))
    group_cmds = [
        BotCommand(command="newgame", description="Новая игра в 1000"),
        BotCommand(command="endgame", description="Завершить текущую игру"),
        BotCommand(command="stats", description="Рейтинг чата"),
        BotCommand(command="records", description="Рекорды и последние партии"),
        BotCommand(command="achievements", description="Мои ачивки"),
        BotCommand(command="rules", description="Правила"),
    ]
    private_cmds = [
        BotCommand(command="help", description="Как играть"),
        BotCommand(command="stats", description="Моя статистика"),
        BotCommand(command="achievements", description="Мои ачивки"),
        BotCommand(command="rules", description="Правила"),
    ]
    try:
        await bot.set_my_commands(group_cmds, scope=BotCommandScopeAllGroupChats())
        await bot.set_my_commands(private_cmds, scope=BotCommandScopeAllPrivateChats())
    except Exception:  # noqa: BLE001
        log.warning("не удалось установить команды бота")
    log.info("бот @%s запущен", me.username)
    return bot, dp
