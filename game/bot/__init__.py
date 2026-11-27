"""Команды Telegram-бота и запуск polling."""
from __future__ import annotations

import logging
from html import escape

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ChatMemberStatus, ChatType, ParseMode
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (BotCommand, BotCommandScopeAllGroupChats, BotCommandScopeAllPrivateChats,
                           InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo)

from .. import config
from ..auth import display_name
from ..engine import GameError
from ..history import chat_records
from ..rooms import RoomManager, is_admin
from ..rules import BUILTIN_PRESETS, CLASSIC, short_title
from ..stats import RATING_MIN_GAMES, Presets, Stats
from .formatting import format_achievements, format_records, format_stats_rows, rules_html
from .notifier import GroupNotifier

log = logging.getLogger(__name__)


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
        room.chat_title = message.chat.title
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
