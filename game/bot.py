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
from .auth import display_name
from .engine import BARREL_START, TARGET
from .rooms import Room, RoomManager
from .stats import Stats

log = logging.getLogger(__name__)

BARREL_TITLES = {
    "none": "без бочки (до 1000+)",
    "points": f"бочка по очкам ({BARREL_START})",
    "open": "открытая бочка (ровно 1000)",
}
FLUSH_DELAY = 3.0  # сек: события копятся и уходят одним сообщением

RULES_TEXT = f"""<b>🎲 Игра «1000» — правила</b>

5 кубиков. Цель — набрать {TARGET} очков.

<b>Очки за бросок</b> (комбинации — только в одном броске):
• 1 = 10, 5 = 5
• три одинаковых = номинал×10 (три единицы = 100)
• четыре = номинал×20 (четыре единицы = 200)
• пять = номинал×100 (пять единиц = 1000)
• стрит 1‑2‑3‑4‑5 = 125, стрит 2‑3‑4‑5‑6 = 250

<b>Ход.</b> Очковые кубики откладываются автоматически, остальные можно перебросить или записать набранное. Пустой бросок — очки хода сгорают. Если все 5 кубиков сыграли — обязательно бросаешь все 5 заново.

<b>Открытие.</b> Первая запись — минимум 50 за ход.
<b>Ямы</b> 200–299 и 600–699: попасть можно, но выбраться нужно за один ход (до 300/700), иначе очки хода сгорают.
<b>Обгон.</b> Обогнал игрока — у него −50 (игроков с 0 не штрафуют).
<b>Болты.</b> Пустой бросок = болт; 3 болта = −100. Любая запись очков сбрасывает болты. Не считаются до открытия, в яме и на бочке.
<b>Самосвал.</b> Ровно 555 любым путём — счёт обнуляется. Попал на 555 прямо по ходу бросков — ход сразу заканчивается.
<b>Пять единиц</b> первым броском хода — сразу победа.

<b>Бочка</b> (выбирается при создании игры):
• <i>без бочки</i> — побеждает набравший 1000+;
• <i>по очкам</i> — с {BARREL_START}+ садишься на бочку (перебор мимо бочки → {BARREL_START}); за 3 своих хода нужно набрать до 1000 за один ход. Не вышло — падение −100; третье падение — счёт 0. На бочке могут сидеть несколько игроков;
• <i>открытая</i> — нужно ровно 1000; перебор = ход сгорает + точка; 6 точек = −100; третий такой штраф — счёт 0.

Очерёдность ходов разыгрывается бросками кубиков."""


def mention(uid: int, name: str) -> str:
    return f'<a href="tg://user?id={uid}">{escape(name)}</a>'


class GroupNotifier:
    def __init__(self, bot: Bot, username: str):
        self.bot = bot
        self.username = username
        self._buffers: dict[str, list[str]] = {}
        self._flush_tasks: dict[str, asyncio.Task] = {}
        self._lobby_tasks: dict[str, asyncio.Task] = {}
        self._turn_msg: dict[str, int] = {}  # сообщение «ходит X» без событий — удаляем при следующем

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
        timer = f"{room.settings['timer']} с на действие" if room.settings["timer"] else "без таймера"
        return (f"🎲 <b>Игра «1000»</b>\n"
                f"Создатель: {escape(owner)}\n"
                f"Режим: {BARREL_TITLES[room.settings['barrel']]}, {timer}\n\n"
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
                f"Режим: {BARREL_TITLES[room.settings['barrel']]}\nИгроки: {players}\n\n"
                f"Сначала разыгрываем очерёдность — все бросают кубики.")
        try:
            await self.bot.edit_message_text(text, chat_id=room.chat_id, message_id=room.lobby_msg_id,
                                             reply_markup=self.keyboard(room, "🎲 Открыть игру"))
        except Exception as e:  # noqa: BLE001
            log.debug("start edit: %s", e)

    # ---------- события партии ----------

    async def game_events(self, room: Room, events: list[dict]) -> None:
        lines = [escape(e["text"]) for e in events if e.get("notable")]
        if lines:
            self._buffers.setdefault(room.id, []).extend(lines)
        turn_changed = any(e["kind"] in ("commit", "bolt", "bolt_penalty", "zero", "barrel_attempt",
                                         "barrel_fall", "barrel_zero", "dot", "dot_penalty", "dot_zero",
                                         "timeout", "order_done", "leave") for e in events)
        if not (lines or turn_changed):
            return
        task = self._flush_tasks.get(room.id)
        if task and not task.done():
            return
        self._flush_tasks[room.id] = asyncio.create_task(self._flush_later(room))

    async def _flush_later(self, room: Room) -> None:
        await asyncio.sleep(FLUSH_DELAY)
        await self._flush(room)

    async def _flush(self, room: Room, final: bool = False) -> None:
        lines = self._buffers.pop(room.id, [])
        g = room.game
        turn_line = ""
        if not final and room.status == "game" and g:
            if g.phase == "play":
                p = g.cur
                turn_line = f"🎲 Ходит {mention(p.uid, p.name)} ({p.score})"
            elif g.phase == "order":
                waiting = ", ".join(mention(p.uid, p.name) for p in g.players if g.order_pending(p))
                turn_line = f"🎲 Бросают за очерёдность: {waiting}"
        if not lines and not turn_line:
            return
        prev = self._turn_msg.pop(room.id, None)
        if prev:
            try:
                await self.bot.delete_message(room.chat_id, prev)
            except Exception:  # noqa: BLE001
                pass
        text = "\n".join(lines + ([""] if lines and turn_line else []) + ([turn_line] if turn_line else []))
        markup = self.keyboard(room, "🎲 Открыть игру") if turn_line else None
        msg = await self.bot.send_message(room.chat_id, text, reply_markup=markup)
        if not lines:
            self._turn_msg[room.id] = msg.message_id

    async def game_over(self, room: Room) -> None:
        task = self._flush_tasks.pop(room.id, None)
        if task:
            task.cancel()
        await self._flush(room, final=True)
        g = room.game
        if not g:
            return
        medals = ["🥇", "🥈", "🥉"]
        ranked = sorted(g.players, key=lambda p: (p.uid != g.winner, -p.score))
        rows = []
        for i, p in enumerate(ranked):
            badge = medals[i] if i < 3 else f"{i + 1}."
            rows.append(f"{badge} {escape(p.name)} — {p.score}")
        if g.winner is not None:
            w = next(p for p in g.players if p.uid == g.winner)
            head = f"🏆 <b>Победа: {mention(w.uid, w.name)}!</b>"
        else:
            head = "Игра окончена."
        await self.bot.send_message(room.chat_id, head + "\n\n" + "\n".join(rows) +
                                    "\n\nСтатистика: /stats · Новая игра: /newgame (или «Реванш» в приложении)")

    async def cancelled(self, room: Room) -> None:
        self._buffers.pop(room.id, None)
        task = self._flush_tasks.pop(room.id, None)
        if task:
            task.cancel()
        if room.lobby_msg_id:
            try:
                await self.bot.edit_message_text("🎲 Игра «1000» отменена.", chat_id=room.chat_id,
                                                 message_id=room.lobby_msg_id)
                return
            except Exception:  # noqa: BLE001
                pass
        await self.bot.send_message(room.chat_id, "🎲 Игра «1000» отменена.")


def format_stats_rows(rows: list[dict]) -> str:
    lines = []
    for i, r in enumerate(rows):
        lines.append(f"{i + 1}. <b>{escape(r.get('name', '?'))}</b> — побед {r['wins']} из {r['games']}\n"
                     f"    🚛 {r['samosvals']} · 🔩 {r['bolt_penalties']} · 🛢💥 {r['barrel_falls']} · "
                     f"🏎 {r['overtakes']} · лучший ход {r['best_turn']}")
    return "\n".join(lines)


def build_router(manager: RoomManager, stats: Stats, notifier: GroupNotifier) -> Router:
    router = Router()
    groups = F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP})

    @router.message(Command("newgame"), groups)
    async def newgame(message: Message):
        user = message.from_user
        room = manager.active_in_chat(message.chat.id)
        if room:
            text = "В этом чате уже есть игра. Открой её или заверши командой /endgame."
            await message.reply(text, reply_markup=notifier.keyboard(room, "🎲 Открыть игру"))
            return
        name = display_name(user.model_dump())
        room = manager.create(message.chat.id, user.id, name)
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

    @router.message(Command("stats"), groups)
    async def stats_group(message: Message):
        rows = stats.chat_table(message.chat.id)
        if not rows:
            await message.reply("Ещё не сыграно ни одной партии. /newgame")
            return
        await message.reply("📊 <b>Статистика чата</b>\n🚛 самосвалы · 🔩 штрафы за болты · 🛢💥 падения с бочки · "
                            "🏎 обгоны\n\n" + format_stats_rows(rows))

    @router.message(Command("stats"), F.chat.type == ChatType.PRIVATE)
    async def stats_private(message: Message):
        row = stats.user_total(message.from_user.id)
        if not row:
            await message.answer("У тебя пока нет сыгранных партий.")
            return
        await message.answer("📊 <b>Твоя статистика (все чаты)</b>\n\n" + format_stats_rows([row]))

    @router.message(Command("rules"))
    async def rules(message: Message):
        await message.answer(RULES_TEXT)

    @router.message(CommandStart(deep_link=True), F.chat.type == ChatType.PRIVATE)
    async def start_join(message: Message, command: CommandObject):
        arg = command.args or ""
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
            "Команды: /newgame, /endgame, /stats, /rules")

    return router


async def build_bot(manager: RoomManager, stats: Stats) -> tuple[Bot, Dispatcher]:
    bot = Bot(config.BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    me = await bot.get_me()
    notifier = GroupNotifier(bot, me.username)
    manager.notifier = notifier
    dp = Dispatcher()
    dp.include_router(build_router(manager, stats, notifier))
    group_cmds = [
        BotCommand(command="newgame", description="Новая игра в 1000"),
        BotCommand(command="endgame", description="Завершить текущую игру"),
        BotCommand(command="stats", description="Статистика чата"),
        BotCommand(command="rules", description="Правила"),
    ]
    private_cmds = [
        BotCommand(command="help", description="Как играть"),
        BotCommand(command="stats", description="Моя статистика"),
        BotCommand(command="rules", description="Правила"),
    ]
    try:
        await bot.set_my_commands(group_cmds, scope=BotCommandScopeAllGroupChats())
        await bot.set_my_commands(private_cmds, scope=BotCommandScopeAllPrivateChats())
    except Exception:  # noqa: BLE001
        log.warning("не удалось установить команды бота")
    log.info("бот @%s запущен", me.username)
    return bot, dp
