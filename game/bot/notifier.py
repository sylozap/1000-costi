"""Сообщения о лобби и итогах партии в группе Telegram."""
from __future__ import annotations

import asyncio
import logging
from html import escape

from aiogram import Bot
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from .. import config
from ..engine import TEAM_NAMES
from ..rooms import Room
from ..rules import short_title
from .formatting import mention

log = logging.getLogger(__name__)


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
