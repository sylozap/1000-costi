"""Текстовое представление правил, статистики и достижений для Telegram."""
from __future__ import annotations

from html import escape

from ..achievements import ACHIEVEMENTS
from ..rules import describe
from ..stats import RATING_MIN_GAMES, Stats


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
