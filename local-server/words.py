"""Persistent local vocabulary; no model imports, network, or startup writes."""
from __future__ import annotations

import json
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
MAX_EXPLANATION_CHARS = 1200
MAX_AI_TRANSLATIONS = 3
MAX_AI_TRANSLATION_CHARS = 320
MAX_AI_USAGE_CHARS = 240
PUBLIC_WORD_COLUMNS = "id, language, text, pinyin, translation, explanation, ai_translations, analysis, created_at, learned"
PUBLIC_SENTENCE_COLUMNS = "id, language, text, pinyin, translation, explanation, analysis, created_at, learned"
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


def validate_sentence(payload) -> dict:
    if not isinstance(payload, dict) or set(payload) != WORD_FIELDS:
        raise ValueError("Expected language, text, pinyin and translation")
    language = payload["language"]
    if not isinstance(language, str) or language not in {"zh", "en"}:
        raise ValueError("Invalid sentence language")
    text = _field(payload["text"], 500, collapse=True)
    pinyin = _field(payload["pinyin"], 500, allow_empty=language == "en", collapse=True)
    translation = _field(payload["translation"], 1200)
    if language == "zh":
        if not HAN.search(text):
            raise ValueError("Chinese sentence must contain Han characters")
        if not any("LATIN" in unicodedata.name(char, "") for char in pinyin) or any(
            char.isalpha() and "LATIN" not in unicodedata.name(char, "") for char in pinyin
        ):
            raise ValueError("Invalid sentence pinyin")
    elif pinyin or not re.search(r"[A-Za-z]", text) or any(
        char.isalpha() and "LATIN" not in unicodedata.name(char, "") for char in text
    ):
        raise ValueError("English sentence requires English text and empty pinyin")
    return {"language": language, "text": text, "pinyin": pinyin, "translation": translation}


def validate_word_id(value) -> int:
    if type(value) is not int or not 1 <= value <= MAX_SAFE_ID:
        raise ValueError("Invalid word ID")
    return value


def validate_ai_translations(payload) -> list[dict]:
    if not isinstance(payload, list) or not 1 <= len(payload) <= MAX_AI_TRANSLATIONS:
        raise ValueError("Expected one to three AI translations")
    translations = []
    seen = set()
    for item in payload:
        if not isinstance(item, dict) or set(item) != {"translation", "usage"}:
            raise ValueError("Invalid AI translation")
        translation = _field(item["translation"], MAX_AI_TRANSLATION_CHARS, collapse=True)
        usage = _field(item["usage"], MAX_AI_USAGE_CHARS, collapse=True)
        key = translation.casefold()
        if key in seen:
            raise ValueError("Duplicate AI translation")
        seen.add(key)
        translations.append({"translation": translation, "usage": usage})
    return translations


def _analysis_display(value, limit, *, pinyin=False):
    value = _field(value, limit, collapse=True)
    if HAN.search(value):
        raise ValueError("Han is not allowed in analysis display fields")
    if pinyin and (not any("LATIN" in unicodedata.name(char, "") for char in value) or any(
        char.isalpha() and "LATIN" not in unicodedata.name(char, "") for char in value
    )):
        raise ValueError("Invalid analysis pinyin")
    return value


def _coverage_text(value):
    # Ignore punctuation and whitespace, not digits/symbols or repeated Han.
    return "".join(char for char in value if not char.isspace() and not unicodedata.category(char).startswith("P"))


def _analysis_syllables(value):
    parts, token = [], ""
    for char in value:
        category = unicodedata.category(char)
        latin = "LATIN" in unicodedata.name(char, "")
        if latin or (category.startswith("M") and token):
            token += char
        elif char in "12345":
            if token:
                parts.append(token + char)
                token = ""
        elif category.startswith("P") or category == "Zs":
            if token:
                parts.append(token)
                token = ""
        else:
            raise ValueError("Invalid analysis pinyin character")
    if token:
        parts.append(token)
    if not parts:
        raise ValueError("Empty analysis pronunciation")
    return parts


def validate_analysis(payload, source, *, word=False):
    if not isinstance(payload, dict) or set(payload) != {"pinyin", "translation", "components", "grammar", "example"}:
        raise ValueError("Invalid analysis fields")
    if not HAN.search(source) or any(char.isalpha() and not HAN.fullmatch(char) for char in source):
        raise ValueError("Analysis requires Chinese source text")
    components = payload["components"]
    if not isinstance(components, list) or not 1 <= len(components) <= 120:
        raise ValueError("Invalid analysis components")
    normalized = []
    for component in components:
        if not isinstance(component, dict) or set(component) != {"text", "pinyin", "translation", "usage"}:
            raise ValueError("Invalid analysis component")
        text = _field(component["text"], 120, collapse=True)
        if not _coverage_text(text):
            raise ValueError("Empty analysis component")
        normalized.append({
            "text": text,
            "pinyin": _analysis_display(component["pinyin"], 120, pinyin=True),
            "translation": _analysis_display(component["translation"], 160),
            "usage": _analysis_display(component["usage"], 240),
        })
    if "".join(_coverage_text(item["text"]) for item in normalized) != _coverage_text(source):
        raise ValueError("Analysis components must cover source in order")
    example = payload["example"]
    if not isinstance(example, dict) or set(example) != {"pinyin", "translation"}:
        raise ValueError("Invalid analysis example")
    pronunciation = _analysis_display(payload["pinyin"], 120 if word else 500, pinyin=True)
    component_syllables = []
    for item in normalized:
        han = _coverage_text(item["text"])
        syllables = _analysis_syllables(item["pinyin"])
        if not all(HAN.fullmatch(char) for char in han) or len(han) != len(syllables):
            raise ValueError("Analysis pronunciation must cover each Han character")
        component_syllables.extend(syllables)
    if component_syllables != _analysis_syllables(pronunciation):
        raise ValueError("Analysis component pronunciation must match full pinyin")
    _analysis_syllables(_analysis_display(example["pinyin"], 300, pinyin=True))
    return {
        "pinyin": pronunciation,
        "translation": _analysis_display(payload["translation"], 1000),
        "components": normalized,
        "grammar": _analysis_display(payload["grammar"], 700),
        "example": {
            "pinyin": _analysis_display(example["pinyin"], 300, pinyin=True),
            "translation": _analysis_display(example["translation"], 300),
        },
    }


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
            # Schema upgrades must be serialized: concurrent first requests
            # against an old database must not race the ADD COLUMN migration.
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS words (
                    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id <= 9007199254740991),
                    language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
                    text TEXT NOT NULL,
                    pinyin TEXT NOT NULL,
                    translation TEXT NOT NULL,
                    explanation TEXT NOT NULL DEFAULT '',
                    ai_translations TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    learned INTEGER NOT NULL DEFAULT 0 CHECK (learned IN (0, 1)),
                    text_key TEXT NOT NULL,
                    pinyin_key TEXT NOT NULL,
                    UNIQUE (language, text_key, pinyin_key)
                )
            """)
            columns = {row[1] for row in connection.execute("PRAGMA table_info(words)")}
            if "learned" not in columns:
                connection.execute("ALTER TABLE words ADD COLUMN learned INTEGER NOT NULL DEFAULT 0 CHECK (learned IN (0, 1))")
            if "explanation" not in columns:
                connection.execute("ALTER TABLE words ADD COLUMN explanation TEXT NOT NULL DEFAULT ''")
            if "ai_translations" not in columns:
                connection.execute("ALTER TABLE words ADD COLUMN ai_translations TEXT NOT NULL DEFAULT '[]'")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS sentences (
                    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id <= 9007199254740991),
                    language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
                    text TEXT NOT NULL,
                    pinyin TEXT NOT NULL,
                    translation TEXT NOT NULL,
                    explanation TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    learned INTEGER NOT NULL DEFAULT 0 CHECK (learned IN (0, 1)),
                    text_key TEXT NOT NULL,
                    pinyin_key TEXT NOT NULL,
                    UNIQUE (language, text_key, pinyin_key)
                )
            """)
            for table in ("words", "sentences"):
                columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
                if "analysis" not in columns:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN analysis TEXT DEFAULT NULL")
            with connection:
                yield connection
        finally:
            connection.close()

    def list(self) -> list[dict]:
        with self._connection() as connection:
            # Contract is the complete list, not a silently capped first page.
            return [self._public_word(row) for row in connection.execute(
                f"SELECT {PUBLIC_WORD_COLUMNS} FROM words ORDER BY id DESC"
            )]

    @staticmethod
    def _public_word(row) -> dict:
        word = dict(row)
        word["learned"] = bool(word["learned"])
        if word.get("analysis") is not None:
            word["analysis"] = validate_analysis(json.loads(word["analysis"]), word["text"], word="ai_translations" in word)
        if "ai_translations" in word:
            try:
                word["ai_translations"] = validate_ai_translations(json.loads(word["ai_translations"])) if word["ai_translations"] != "[]" else []
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                raise ValueError("Invalid stored AI translations") from error
        return word

    def add(self, payload) -> dict:
        word = validate_word(payload)
        text_key = word["text"].lower() if word["language"] == "en" else word["text"]
        pinyin_key = word["pinyin"].lower()
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self._connection() as connection:
            existing = self._captured_or_current(connection, "words", PUBLIC_WORD_COLUMNS, word, text_key, pinyin_key)
            if existing is not None:
                return self._public_word(existing)
            connection.execute("""
                INSERT INTO words (language, text, pinyin, translation, created_at, text_key, pinyin_key)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (language, text_key, pinyin_key) DO NOTHING
            """, (word["language"], word["text"], word["pinyin"], word["translation"], created_at, text_key, pinyin_key))
            row = connection.execute(
                f"SELECT {PUBLIC_WORD_COLUMNS} FROM words WHERE language = ? AND text_key = ? AND pinyin_key = ?",
                (word["language"], text_key, pinyin_key),
            ).fetchone()
            return self._public_word(row)

    def list_sentences(self) -> list[dict]:
        with self._connection() as connection:
            return [self._public_word(row) for row in connection.execute(
                f"SELECT {PUBLIC_SENTENCE_COLUMNS} FROM sentences ORDER BY id DESC"
            )]

    def add_sentence(self, payload) -> dict:
        sentence = validate_sentence(payload)
        text_key = sentence["text"].lower() if sentence["language"] == "en" else sentence["text"]
        pinyin_key = sentence["pinyin"].lower()
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self._connection() as connection:
            existing = self._captured_or_current(connection, "sentences", PUBLIC_SENTENCE_COLUMNS, sentence, text_key, pinyin_key)
            if existing is not None:
                return self._public_word(existing)
            connection.execute("""
                INSERT INTO sentences (language, text, pinyin, translation, created_at, text_key, pinyin_key)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (language, text_key, pinyin_key) DO NOTHING
            """, (sentence["language"], sentence["text"], sentence["pinyin"], sentence["translation"],
                  created_at, text_key, pinyin_key))
            row = connection.execute(
                f"SELECT {PUBLIC_SENTENCE_COLUMNS} FROM sentences WHERE language = ? AND text_key = ? AND pinyin_key = ?",
                (sentence["language"], text_key, pinyin_key),
            ).fetchone()
            return self._public_word(row)

    @staticmethod
    def _captured_or_current(connection, table, columns, item, text_key, pinyin_key):
        # Immutable captured keys win ties. Unicode lower() is done in Python:
        # SQLite lower() does not fold accented pinyin. BEGIN IMMEDIATE makes
        # matching and insertion atomic across independent store instances.
        rows = connection.execute(
            f"SELECT {columns}, pinyin_key FROM {table} WHERE language = ? AND text_key = ? ORDER BY id",
            (item["language"], text_key),
        ).fetchall()
        match = next((row for row in rows if row["pinyin_key"] == pinyin_key), None)
        if match is None:
            match = next((row for row in rows if row["pinyin"].lower() == pinyin_key), None)
        if match is None:
            return None
        return {key: match[key] for key in match.keys() if key != "pinyin_key"}

    def set_analysis(self, identifier, analysis) -> dict | None:
        return self._set_analysis("words", PUBLIC_WORD_COLUMNS, identifier, analysis)

    def set_sentence_analysis(self, identifier, analysis) -> dict | None:
        return self._set_analysis("sentences", PUBLIC_SENTENCE_COLUMNS, identifier, analysis)

    def _set_analysis(self, table, columns, identifier, analysis):
        identifier = validate_word_id(identifier)
        with self._connection() as connection:
            row = connection.execute(
                f"SELECT {columns} FROM {table} WHERE id = ? AND language = 'zh'", (identifier,),
            ).fetchone()
            if row is None:
                return None
            analysis = validate_analysis(analysis, row["text"], word=table == "words")
            # Never rewrite text_key/pinyin_key: pronunciation corrections must
            # neither collide with another captured reading nor erase history.
            connection.execute(
                f"UPDATE {table} SET analysis = ?, pinyin = ?, translation = ?, explanation = ? WHERE id = ?",
                (json.dumps(analysis, ensure_ascii=False, separators=(",", ":")), analysis["pinyin"],
                 analysis["translation"], analysis["grammar"], identifier),
            )
            return self._public_word(connection.execute(
                f"SELECT {columns} FROM {table} WHERE id = ?", (identifier,),
            ).fetchone())

    def set_learned(self, identifier, learned: bool) -> dict | None:
        identifier = validate_word_id(identifier)
        if type(learned) is not bool:
            raise ValueError("Invalid learned state")
        with self._connection() as connection:
            connection.execute("UPDATE words SET learned = ? WHERE id = ?", (int(learned), identifier))
            row = connection.execute(
                f"SELECT {PUBLIC_WORD_COLUMNS} FROM words WHERE id = ?", (identifier,)
            ).fetchone()
            return self._public_word(row) if row else None

    def set_explanation(self, identifier, explanation: str) -> dict | None:
        identifier = validate_word_id(identifier)
        explanation = _field(explanation, MAX_EXPLANATION_CHARS)
        with self._connection() as connection:
            connection.execute("UPDATE words SET explanation = ? WHERE id = ?", (explanation, identifier))
            row = connection.execute(
                f"SELECT {PUBLIC_WORD_COLUMNS} FROM words WHERE id = ?", (identifier,)
            ).fetchone()
            return self._public_word(row) if row else None

    def set_ai_translations(self, identifier, translations) -> dict | None:
        identifier = validate_word_id(identifier)
        translations = validate_ai_translations(translations)
        encoded = json.dumps(translations, ensure_ascii=False, separators=(",", ":"))
        with self._connection() as connection:
            connection.execute("UPDATE words SET ai_translations = ? WHERE id = ? AND language = 'zh'", (encoded, identifier))
            row = connection.execute(
                f"SELECT {PUBLIC_WORD_COLUMNS} FROM words WHERE id = ? AND language = 'zh'", (identifier,)
            ).fetchone()
            return self._public_word(row) if row else None

    def set_sentence_learned(self, identifier, learned: bool) -> dict | None:
        identifier = validate_word_id(identifier)
        if type(learned) is not bool:
            raise ValueError("Invalid learned state")
        with self._connection() as connection:
            connection.execute("UPDATE sentences SET learned = ? WHERE id = ?", (int(learned), identifier))
            row = connection.execute(
                f"SELECT {PUBLIC_SENTENCE_COLUMNS} FROM sentences WHERE id = ?", (identifier,)
            ).fetchone()
            return self._public_word(row) if row else None

    def set_sentence_explanation(self, identifier, explanation: str) -> dict | None:
        identifier = validate_word_id(identifier)
        explanation = _field(explanation, MAX_EXPLANATION_CHARS)
        with self._connection() as connection:
            connection.execute("UPDATE sentences SET explanation = ? WHERE id = ?", (explanation, identifier))
            row = connection.execute(
                f"SELECT {PUBLIC_SENTENCE_COLUMNS} FROM sentences WHERE id = ?", (identifier,)
            ).fetchone()
            return self._public_word(row) if row else None

    def remove(self, identifier) -> bool:
        identifier = validate_word_id(identifier)
        with self._connection() as connection:
            return connection.execute("DELETE FROM words WHERE id = ?", (identifier,)).rowcount == 1

    def remove_sentence(self, identifier) -> bool:
        identifier = validate_word_id(identifier)
        with self._connection() as connection:
            return connection.execute("DELETE FROM sentences WHERE id = ?", (identifier,)).rowcount == 1
