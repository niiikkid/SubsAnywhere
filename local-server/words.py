"""Persistent local vocabulary; no model imports, network, or startup writes."""
from __future__ import annotations

import os
import re
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

MAX_WORD_BODY_BYTES = 16384
MAX_SAFE_ID = 9007199254740991
WORD_FIELDS = {"language", "text", "pinyin", "translation"}
PUBLIC_COLUMNS = "id, language, text, pinyin, translation, created_at"
HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f\U00030000-\U000323af]")


def default_words_path() -> Path:
    override = os.environ.get("SUBSANYWHERE_WORDS_DB")
    return Path(override).expanduser() if override else Path.home() / ".local/share/SubsAnywhere/words.sqlite3"


def _field(value, limit: int, *, allow_empty=False, collapse=False) -> str:
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Invalid vocabulary field")
    # Reject controls, surrogates and invisible formatting before normalization.
    if any(unicodedata.category(char).startswith("C") for char in value):
        raise ValueError("Invalid vocabulary field")
    value = unicodedata.normalize("NFC", value).strip()
    if collapse:
        value = " ".join(value.split())
    if (not value and not allow_empty) or len(value) > limit:
        raise ValueError("Invalid vocabulary field")
    return value


def validate_word(payload) -> dict:
    if not isinstance(payload, dict) or set(payload) != WORD_FIELDS:
        raise ValueError("Expected language, text, pinyin and translation")
    language = payload["language"]
    if not isinstance(language, str) or language not in {"zh", "en"}:
        raise ValueError("Invalid vocabulary language")
    text = _field(payload["text"], 120, collapse=True)
    pinyin = _field(payload["pinyin"], 120, allow_empty=language == "en", collapse=True)
    translation = _field(payload["translation"], 1000)
    if language == "zh":
        if not HAN.search(text) or any(char.isalpha() and not HAN.fullmatch(char) for char in text):
            raise ValueError("Chinese vocabulary text must contain Han characters")
        if not any("LATIN" in unicodedata.name(char, "") for char in pinyin) or any(
            char.isalpha() and "LATIN" not in unicodedata.name(char, "") for char in pinyin
        ):
            raise ValueError("Invalid pinyin")
    elif pinyin or not re.search(r"[A-Za-z]", text) or any(
        char.isalpha() and "LATIN" not in unicodedata.name(char, "") for char in text
    ):
        raise ValueError("English vocabulary requires English text and empty pinyin")
    return {"language": language, "text": text, "pinyin": pinyin, "translation": translation}


def validate_word_id(value) -> int:
    if type(value) is not int or not 1 <= value <= MAX_SAFE_ID:
        raise ValueError("Invalid word ID")
    return value


class WordsStore:
    def __init__(self, path: Path):
        self.path = Path(path).expanduser()

    @contextmanager
    def _connection(self):
        # One connection per operation: no sqlite objects cross HTTP threads.
        # SQLite's journal, busy timeout and unique constraint also coordinate
        # distinct store instances/processes; no read-then-write dedup race.
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        connection = sqlite3.connect(self.path, timeout=3)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA synchronous = FULL")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS words (
                    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id <= 9007199254740991),
                    language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
                    text TEXT NOT NULL,
                    pinyin TEXT NOT NULL,
                    translation TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    text_key TEXT NOT NULL,
                    pinyin_key TEXT NOT NULL,
                    UNIQUE (language, text_key, pinyin_key)
                )
            """)
            with connection:
                yield connection
        finally:
            connection.close()

    def list(self) -> list[dict]:
        with self._connection() as connection:
            # Contract is the complete list, not a silently capped first page.
            return [dict(row) for row in connection.execute(
                f"SELECT {PUBLIC_COLUMNS} FROM words ORDER BY id DESC"
            )]

    def add(self, payload) -> dict:
        word = validate_word(payload)
        text_key = word["text"].lower() if word["language"] == "en" else word["text"]
        pinyin_key = word["pinyin"].lower()
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self._connection() as connection:
            connection.execute("""
                INSERT INTO words (language, text, pinyin, translation, created_at, text_key, pinyin_key)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (language, text_key, pinyin_key) DO NOTHING
            """, (word["language"], word["text"], word["pinyin"], word["translation"], created_at, text_key, pinyin_key))
            row = connection.execute(
                f"SELECT {PUBLIC_COLUMNS} FROM words WHERE language = ? AND text_key = ? AND pinyin_key = ?",
                (word["language"], text_key, pinyin_key),
            ).fetchone()
            return dict(row)

    def remove(self, identifier) -> bool:
        identifier = validate_word_id(identifier)
        with self._connection() as connection:
            return connection.execute("DELETE FROM words WHERE id = ?", (identifier,)).rowcount == 1
