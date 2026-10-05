"""Кубики с картинками на гранях: создаёт админ, картинки лежат в data/dice/<id>/.

Скин такого кубика называется «c_<id>» и выдаётся игрокам как личный (см. game/profiles.py).
Картинки приходят из приложения уже обрезанными до квадрата и сжатыми; сервер проверяет формат и размер.
"""
from __future__ import annotations

import base64
import binascii
import re
import secrets
import shutil
import time
from pathlib import Path

from .stats import _load, _save

PREFIX = "c_"
MAX_DICE = 60
MAX_FACE_BYTES = 400_000
MAX_NAME = 30
ID_RE = re.compile(r"^[a-z0-9]{8}$")
DATA_URL_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,(.+)$", re.S)
MAGIC = {"jpg": (b"\xff\xd8\xff",), "png": (b"\x89PNG\r\n\x1a\n",), "webp": (b"RIFF",)}


class CustomDiceError(ValueError):
    pass


def skin_id(did: str) -> str:
    return PREFIX + did


def dice_id(skin: str) -> str | None:
    """id кубика по имени скина, если это кубик с картинками."""
    return skin[len(PREFIX):] if isinstance(skin, str) and skin.startswith(PREFIX) else None


def decode_face(data_url: str) -> tuple[bytes, str]:
    """data:image/...;base64 → (байты, расширение). Проверяет формат по сигнатуре и размер."""
    m = DATA_URL_RE.match(data_url or "")
    if not m:
        raise CustomDiceError("картинка должна быть JPEG, PNG или WebP")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise CustomDiceError("картинка повреждена") from None
    if len(raw) > MAX_FACE_BYTES:
        raise CustomDiceError("картинка слишком большая (больше 400 КБ)")
    ext = {"jpeg": "jpg"}.get(m.group(1), m.group(1))
    if not raw.startswith(MAGIC[ext]) or (ext == "webp" and raw[8:12] != b"WEBP"):
        raise CustomDiceError("файл не похож на картинку")
    return raw, ext


class CustomDice:
    def __init__(self, root: Path | None):
        self.root = root
        self.index = root / "index.json" if root else None
        data = _load(self.index) if self.index else {}
        self.dice: dict[str, dict] = data.get("dice", {})

    def _save(self) -> None:
        if self.index:
            _save(self.index, {"dice": self.dice})

    def exists(self, skin_or_id: str) -> bool:
        return (dice_id(skin_or_id) or skin_or_id) in self.dice

    def name(self, skin: str) -> str:
        d = self.dice.get(dice_id(skin) or "")
        return d["name"] if d else "?"

    def _face_index(self, d: dict, n: int) -> int | None:
        """Номер файла для грани n (1..6): своя картинка или первая заданная."""
        if d["faces"][n - 1]:
            return n
        return next((i + 1 for i, f in enumerate(d["faces"]) if f), None)

    def face_path(self, did: str, n: int) -> Path | None:
        d = self.dice.get(did)
        if not d or not self.root or not 1 <= n <= 6:
            return None
        k = self._face_index(d, n)
        return self.root / did / f"{k}.{d['faces'][k - 1]}" if k else None

    def view(self, did: str) -> dict:
        d = self.dice[did]
        return {"id": did, "skin": skin_id(did), "name": d["name"], "ver": d["ver"],
                "faces": [f"/dice/{did}/{n}?v={d['ver']}" for n in range(1, 7)],
                "own": [bool(f) for f in d["faces"]]}

    def list(self) -> list[dict]:
        return [self.view(did) for did in sorted(self.dice, key=lambda k: -self.dice[k]["created"])]

    def save(self, did: str | None, name: str, faces: list, author: int) -> str:
        """faces — 6 значений: data URL (новая картинка), "keep" (оставить) или None (без картинки)."""
        name = str(name or "").strip()[:MAX_NAME]
        if not name:
            raise CustomDiceError("дай кубику название")
        if not isinstance(faces, list) or len(faces) != 6:
            raise CustomDiceError("нужно 6 граней")
        if did is None:
            if len(self.dice) >= MAX_DICE:
                raise CustomDiceError(f"кубиков уже {MAX_DICE} — удали ненужные")
            did = secrets.token_hex(4)
            while did in self.dice:
                did = secrets.token_hex(4)
            old = {"faces": [None] * 6, "created": time.time(), "ver": 0, "author": author}
        else:
            if did not in self.dice:
                raise CustomDiceError("кубик не найден")
            old = self.dice[did]
        decoded: list = []
        for i, f in enumerate(faces):
            if f == "keep":
                decoded.append("keep" if old["faces"][i] else None)
            elif f:
                decoded.append(decode_face(f))
            else:
                decoded.append(None)
        if not any(decoded):
            raise CustomDiceError("загрузи хотя бы одну картинку")
        exts: list = []
        folder = self.root / did if self.root else None
        if folder:
            folder.mkdir(parents=True, exist_ok=True)
        for i, f in enumerate(decoded):
            n = i + 1
            if f == "keep":
                exts.append(old["faces"][i])
                continue
            if folder:
                for p in folder.glob(f"{n}.*"):
                    p.unlink()
            if f is None:
                exts.append(None)
                continue
            raw, ext = f
            if folder:
                (folder / f"{n}.{ext}").write_bytes(raw)
            exts.append(ext)
        self.dice[did] = {"name": name, "faces": exts, "created": old["created"], "ver": old["ver"] + 1,
                          "author": old.get("author", author)}
        self._save()
        return did

    def delete(self, did: str) -> None:
        if did not in self.dice:
            raise CustomDiceError("кубик не найден")
        del self.dice[did]
        if self.root and (self.root / did).exists():
            shutil.rmtree(self.root / did)
        self._save()
