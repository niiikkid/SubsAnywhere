"""Vocabulary persistence and real-HTTP security regressions (offline)."""
import concurrent.futures
from contextlib import closing
import http.client
import json
import os
import pathlib
import socket
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server
from words import WordsStore, default_words_path

ZH = {"language": "zh", "text": "你好", "pinyin": "nǐ hǎo", "translation": "привет"}
EN = {"language": "en", "text": "hello", "pinyin": "", "translation": "привет"}
ZH_SENTENCE = {
    "language": "zh", "text": "我已经吃过饭了。", "pinyin": "wǒ yǐjīng chī guò fàn le.",
    "translation": "Я уже поел.",
}
CLIENT = {"X-SubsAnywhere-Client": "extension-v1"}


class WordsStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = pathlib.Path(self.temporary.name) / "nested" / "words.sqlite3"
        self.store = WordsStore(self.path)

    def test_persists_deduplicates_and_marks_words_learned_without_removing_them(self):
        self.assertFalse(self.path.exists())
        first = self.store.add(ZH)
        self.assertEqual(set(first), {"id", "language", "text", "pinyin", "translation", "explanation", "ai_translations", "analysis", "created_at", "learned"})
        self.assertIsNone(first["analysis"])
        self.assertFalse(first["learned"])
        self.assertEqual(first["explanation"], "")
        self.assertEqual(first["ai_translations"], [])
        self.assertRegex(first["created_at"], r"^\d{4}-\d{2}-\d{2}T.*Z$")
        reopened = WordsStore(self.path)
        duplicate = reopened.add({**ZH, "translation": "другое значение"})
        self.assertEqual(duplicate, first)
        self.assertEqual(reopened.list(), [first])
        second = reopened.add(EN)
        self.assertNotEqual(second["id"], first["id"])
        self.assertIsInstance(second["id"], int)
        self.assertGreater(second["id"], 0)
        learned = reopened.set_learned(first["id"], True)
        self.assertEqual(learned, {**first, "learned": True})
        self.assertEqual(reopened.list(), [second, learned])
        restored = reopened.set_learned(first["id"], False)
        self.assertEqual(restored, first)
        explained = reopened.set_explanation(first["id"], "你好 — обычное приветствие. 你 значит «ты», 好 — «хорошо».")
        self.assertEqual(explained["explanation"], "你好 — обычное приветствие. 你 значит «ты», 好 — «хорошо».")
        self.assertEqual(WordsStore(self.path).list()[1]["explanation"], explained["explanation"])
        self.assertIsNone(reopened.set_learned(9999, True))

    def test_migrates_existing_vocabulary_without_losing_words(self):
        self.path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("""CREATE TABLE words (
                id INTEGER PRIMARY KEY AUTOINCREMENT, language TEXT NOT NULL, text TEXT NOT NULL,
                pinyin TEXT NOT NULL, translation TEXT NOT NULL, created_at TEXT NOT NULL,
                text_key TEXT NOT NULL, pinyin_key TEXT NOT NULL,
                UNIQUE (language, text_key, pinyin_key)
            )""")
            connection.execute("""INSERT INTO words
                (language, text, pinyin, translation, created_at, text_key, pinyin_key)
                VALUES ('en', 'hello', '', 'привет', '2026-01-01T00:00:00.000Z', 'hello', '')""")
        words = self.store.list()
        self.assertEqual(len(words), 1)
        self.assertFalse(words[0]["learned"])
        self.assertEqual(words[0]["ai_translations"], [])
        self.assertIsNone(words[0]["analysis"])
        self.assertEqual(self.store.set_learned(words[0]["id"], True)["learned"], True)

    def test_concurrent_first_access_migrates_legacy_vocabulary_once(self):
        self.path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("""CREATE TABLE words (
                id INTEGER PRIMARY KEY AUTOINCREMENT, language TEXT NOT NULL, text TEXT NOT NULL,
                pinyin TEXT NOT NULL, translation TEXT NOT NULL, created_at TEXT NOT NULL,
                text_key TEXT NOT NULL, pinyin_key TEXT NOT NULL,
                UNIQUE (language, text_key, pinyin_key)
            )""")
        barrier = threading.Barrier(16)

        def list_words(_):
            barrier.wait()
            return WordsStore(self.path).list()

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            self.assertEqual(list(pool.map(list_words, range(16))), [[]] * 16)

    def test_concurrent_independent_stores_share_unique_constraint(self):
        def save(index):
            return WordsStore(self.path).add(ZH)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(save, range(24)))
        self.assertEqual(len({word["id"] for word in results}), 1)
        self.assertEqual(self.store.list(), [results[0]])

    def test_analysis_updates_canonical_fields_without_changing_captured_identity(self):
        analysis = {
            "pinyin": "ní hǎo", "translation": "hello", "grammar": "A greeting.",
            "components": [{"text": "你好", "pinyin": "ní hǎo", "translation": "hello", "usage": "Greeting"}],
            "characters": [{"text": "你", "pinyin": "ní", "translation": "ты"}, {"text": "好", "pinyin": "hǎo", "translation": "хорошо"}],
            "example": {"pinyin": "Nǐ hǎo!", "translation": "Hello!"},
        }
        for add, save, listing, learn in (
            (self.store.add, self.store.set_analysis, self.store.list, self.store.set_learned),
            (self.store.add_sentence, self.store.set_sentence_analysis, self.store.list_sentences, self.store.set_sentence_learned),
        ):
            first = add(ZH)
            conflict = add({**ZH, "pinyin": analysis["pinyin"]})
            learn(first["id"], True)
            saved = save(first["id"], analysis)
            self.assertEqual(saved["analysis"], analysis)
            self.assertEqual((saved["pinyin"], saved["translation"], saved["explanation"]),
                             (analysis["pinyin"], analysis["translation"], analysis["grammar"]))
            self.assertTrue(saved["learned"])
            for key in ("id", "created_at", "text", "language"):
                self.assertEqual(saved[key], first[key])
            self.assertEqual(add(ZH)["id"], first["id"])
            self.assertEqual(add({**ZH, "pinyin": analysis["pinyin"]})["id"], conflict["id"])
            self.assertEqual(len(listing()), 2)
            with self.assertRaises(ValueError):
                save(first["id"], {**analysis, "grammar": "汉字"})
            self.assertEqual(next(row for row in listing() if row["id"] == first["id"]), saved)
        reopened = WordsStore(self.path)
        self.assertEqual(reopened.list(), self.store.list())
        self.assertEqual(reopened.list_sentences(), self.store.list_sentences())

    def test_analysis_rejects_inconsistent_pronunciation(self):
        row = self.store.add({"language": "zh", "text": "你好", "pinyin": "nǐ hǎo", "translation": "Привет"})
        analysis = {
            "pinyin": "nǐ hǎo", "translation": "Привет", "grammar": "Приветствие.",
            "components": [{"text": "你好", "pinyin": "nǐ hǎo", "translation": "привет", "usage": "При встрече."}],
            "characters": [{"text": "你", "pinyin": "nǐ", "translation": "ты"}, {"text": "好", "pinyin": "hǎo", "translation": "хорошо"}],
            "example": {"pinyin": "nǐ hǎo", "translation": "Привет"},
        }
        for pronunciation in ["wrong", "nǐ", "nǐ hǎo$", "hǎo nǐ"]:
            invalid = {**analysis, "pinyin": pronunciation}
            with self.assertRaises(ValueError):
                self.store.set_analysis(row["id"], invalid)
        self.assertIsNone(self.store.list()[0]["analysis"])

    def test_analysis_coverage_limits_and_invalid_saves_are_atomic(self):
        component = {"text": "你", "pinyin": "nǐ", "translation": "you", "usage": "Subject"}
        analysis = {
            "pinyin": "nǐ nǐ hǎo", "translation": "hello", "grammar": "Greeting.",
            "components": [component, component, {**component, "text": "好", "pinyin": "hǎo"}],
            "characters": [{"text": "你", "pinyin": "nǐ", "translation": "ты"}, {"text": "你", "pinyin": "nǐ", "translation": "ты"}, {"text": "好", "pinyin": "hǎo", "translation": "хорошо"}],
            "example": {"pinyin": "Nǐ hǎo!", "translation": "Hello!"},
        }
        for add, save, listing in ((self.store.add, self.store.set_analysis, self.store.list),
                                   (self.store.add_sentence, self.store.set_sentence_analysis, self.store.list_sentences)):
            row = add({**ZH, "text": "你，你 好！"})
            saved = save(row["id"], analysis)
            invalids = [None, {}, {**analysis, "extra": 1}, {**analysis, "components": []},
                        {**analysis, "components": [component] * 121},
                        {**analysis, "components": analysis["components"][1:]},
                        {**analysis, "components": list(reversed(analysis["components"]))}]
            for field, limit in (("translation", 1000), ("grammar", 700), ("pinyin", 120 if add == self.store.add else 500)):
                invalids.extend({**analysis, field: value} for value in ("a" * (limit + 1), "汉", "", "bad\x00"))
            for field, limit in (("pinyin", 120), ("text", 120), ("translation", 160), ("usage", 240)):
                invalids.append({**analysis, "components": [{**component, field: "a" * (limit + 1)}, *analysis["components"][1:]]})
            for field in ("pinyin", "translation"):
                invalids.extend({**analysis, "example": {**analysis["example"], field: value}}
                                for value in ("a" * 301, "汉", ""))
            invalids.extend(({**analysis, "pinyin": "привет"},
                             {**analysis, "components": [{**component, "usage": "汉"}, *analysis["components"][1:]]}))
            for invalid in invalids:
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    save(row["id"], invalid)
                self.assertEqual(listing(), [saved])
            self.assertIsNone(save(add(EN)["id"], analysis))

    def test_analysis_recapture_matches_current_and_captured_pinyin_after_restart(self):
        analysis = {"pinyin": "ní hǎo", "translation": "hello", "grammar": "Greeting.",
                    "components": [{"text": "你好", "pinyin": "ní hǎo", "translation": "hello", "usage": "Greeting"}],
                    "characters": [{"text": "你", "pinyin": "ní", "translation": "ты"}, {"text": "好", "pinyin": "hǎo", "translation": "хорошо"}],
                    "example": {"pinyin": "Nǐ hǎo", "translation": "Hello"}}
        for add_name, save_name, list_name in (("add", "set_analysis", "list"),
                                              ("add_sentence", "set_sentence_analysis", "list_sentences")):
            original = getattr(self.store, add_name)(ZH)
            saved = getattr(self.store, save_name)(original["id"], analysis)
            reopened = WordsStore(self.path)
            for pinyin in (ZH["pinyin"], analysis["pinyin"].upper()):
                self.assertEqual(getattr(reopened, add_name)({**ZH, "pinyin": pinyin}), saved)
            self.assertEqual(getattr(reopened, list_name)(), [saved])
            table = "words" if add_name == "add" else "sentences"
            with closing(sqlite3.connect(self.path)) as connection, connection:
                self.assertEqual(connection.execute(f"SELECT text_key, pinyin_key FROM {table}").fetchone(),
                                 (ZH["text"], ZH["pinyin"]))
                connection.execute(f"CREATE TRIGGER fail_{table} BEFORE UPDATE ON {table} BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
            with self.assertRaises(sqlite3.IntegrityError):
                getattr(reopened, save_name)(original["id"], {**analysis, "translation": "changed"})
            self.assertEqual(getattr(reopened, list_name)(), [saved])

    def test_migrates_legacy_sentences_preserving_all_fields(self):
        self.path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("""CREATE TABLE sentences (
                id INTEGER PRIMARY KEY AUTOINCREMENT, language TEXT NOT NULL, text TEXT NOT NULL,
                pinyin TEXT NOT NULL, translation TEXT NOT NULL, explanation TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL, learned INTEGER NOT NULL DEFAULT 0,
                text_key TEXT NOT NULL, pinyin_key TEXT NOT NULL,
                UNIQUE (language, text_key, pinyin_key))""")
            connection.execute("""INSERT INTO sentences VALUES
                (17, 'zh', '你好', 'nǐ hǎo', 'hello', 'old grammar', 'original date', 1, '你好', 'nǐ hǎo')""")
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: WordsStore(self.path).list_sentences(), range(16)))
        expected = {**ZH, "translation": "hello", "id": 17, "explanation": "old grammar",
                    "created_at": "original date", "learned": True, "analysis": None}
        self.assertEqual(results, [[expected]] * 16)

    def test_legacy_analysis_without_characters_remains_readable_until_rebuilt(self):
        row = self.store.add(ZH)
        legacy = {
            "pinyin": "nǐ hǎo", "translation": "привет", "grammar": "Обычное приветствие.",
            "components": [{"text": "你好", "pinyin": "nǐ hǎo", "translation": "привет", "usage": "При встрече."}],
            "example": {"pinyin": "nǐ hǎo", "translation": "Привет"},
        }
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("UPDATE words SET analysis = ?, explanation = ? WHERE id = ?", (
                json.dumps(legacy, ensure_ascii=False), legacy["grammar"], row["id"],
            ))
        readable = WordsStore(self.path).list()[0]
        self.assertEqual(readable["analysis"], legacy)
        rebuilt = {**legacy, "characters": [
            {"text": "你", "pinyin": "nǐ", "translation": "ты"},
            {"text": "好", "pinyin": "hǎo", "translation": "хорошо"},
        ]}
        self.assertEqual(WordsStore(self.path).set_analysis(row["id"], rebuilt)["analysis"], rebuilt)

    def test_pinyin_is_part_of_identity(self):
        self.store.add({**ZH, "text": "行", "pinyin": "xíng"})
        self.store.add({**ZH, "text": "行", "pinyin": "háng"})
        self.assertEqual(len(self.store.list()), 2)

    def test_ai_translation_variants_are_persisted_separately_for_chinese_words(self):
        word = self.store.add({**ZH, "text": "行", "pinyin": "xíng", "translation": "старый перевод"})
        translations = [
            {"translation": "идти; быть в движении", "usage": "о движении или ходе процесса"},
            {"translation": "годится; можно", "usage": "когда что-то допустимо или подходит"},
        ]
        saved = self.store.set_ai_translations(word["id"], translations)
        self.assertEqual(saved["translation"], "старый перевод")
        self.assertEqual(saved["ai_translations"], translations)
        self.assertEqual(WordsStore(self.path).list()[0]["ai_translations"], translations)
        self.assertIsNone(self.store.set_ai_translations(self.store.add(EN)["id"], translations))
        for invalid in ([], [{"translation": "", "usage": "контекст"}],
                        [{"translation": "можно", "usage": "один"}, {"translation": "Можно", "usage": "два"}],
                        [{"translation": "значение", "usage": "x" * 241}]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.set_ai_translations(word["id"], invalid)

    def test_sentences_are_persisted_separately_with_learning_and_grammar_state(self):
        sentence = self.store.add_sentence(ZH_SENTENCE)
        self.assertEqual(set(sentence), {
            "id", "language", "text", "pinyin", "translation", "explanation", "analysis", "created_at", "learned",
        })
        self.assertFalse(sentence["learned"])
        self.assertEqual(self.store.list(), [])
        self.assertEqual(WordsStore(self.path).list_sentences(), [sentence])
        self.assertTrue(self.store.set_sentence_learned(sentence["id"], True)["learned"])
        explanation = "Yǐjīng и le показывают, что действие уже завершилось. По-русски это обычно передаётся словом «уже» и прошедшим временем."
        explained = self.store.set_sentence_explanation(sentence["id"], explanation)
        self.assertEqual(explained["explanation"], explanation)
        self.assertEqual(self.store.add_sentence({**ZH_SENTENCE, "translation": "Другой перевод"})["id"], sentence["id"])

    def test_words_and_sentences_are_permanently_deleted_from_their_own_lists(self):
        word = self.store.add(ZH)
        sentence = self.store.add_sentence(ZH_SENTENCE)
        self.assertTrue(self.store.remove(word["id"]))
        self.assertFalse(self.store.remove(word["id"]))
        self.assertEqual(self.store.list(), [])
        self.assertTrue(self.store.remove_sentence(sentence["id"]))
        self.assertFalse(self.store.remove_sentence(sentence["id"]))
        self.assertEqual(self.store.list_sentences(), [])

    def test_normalized_identity_preserves_first_display_and_translation(self):
        first = self.store.add({**EN, "text": "  Hello   World  "})
        duplicate = self.store.add({**EN, "text": "hello world", "translation": "другое"})
        self.assertEqual(duplicate, first)
        self.assertEqual(first["text"], "Hello World")
        chinese = self.store.add(ZH)
        self.assertEqual(self.store.add({**ZH, "pinyin": " NI\u030c   HA\u030cO "}), chinese)

    def test_invalid_bounded_fields_and_identity_are_rejected(self):
        invalid = [None, [], {}, {**ZH, "extra": True},
                   {**ZH, "language": "ru"}, {**ZH, "language": []},
                   {**ZH, "text": "ni hao"}, {**EN, "text": "你好"},
                   {**EN, "text": "привет"}, {**ZH, "text": "你好hello"},
                   {**ZH, "pinyin": ""}, {**ZH, "pinyin": "你好"},
                   {**EN, "pinyin": "hello"}, {**ZH, "translation": " "},
                   {**ZH, "text": 7}, {**ZH, "translation": "bad\x00"},
                   {**ZH, "translation": "bad\ud800"},
                   {**ZH, "text": "你" * 121}, {**ZH, "pinyin": "a" * 121},
                   {**ZH, "translation": "a" * 1001}]
        for item in invalid:
            with self.subTest(item=repr(item)[:120]), self.assertRaises(ValueError):
                self.store.add(item)
        for identifier in (None, [], True, 0, -1, 1.5, 9007199254740992, "1", "../words.sqlite3", "' OR 1=1"):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                self.store.remove(identifier)
        self.assertEqual(self.store.list(), [])

    def test_env_override_and_native_default(self):
        with mock.patch.dict(os.environ, {"SUBSANYWHERE_WORDS_DB": str(self.path)}):
            self.assertEqual(default_words_path(), self.path)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(default_words_path(), pathlib.Path.home() / ".local/share/SubsAnywhere/words.sqlite3")


class WordsHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = pathlib.Path(self.temporary.name)
        self.store = WordsStore(root / "words.sqlite3")
        self.service = server.SubtitleService(root / "subtitles", cookies_from_browser="")
        self.httpd = server.create_server(self.service, port=0, words_store=self.store)
        self.port = self.httpd.server_address[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)
        self.service.close()

    def request(self, method="GET", path="/api/words", payload=None, headers=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        request_headers = {**CLIENT, **(headers or {})}
        if payload is not None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        try:
            connection.request(method, path, body=raw, headers=request_headers)
            response = connection.getresponse()
            body = response.read()
            return response.status, dict(response.getheaders()), body
        finally:
            connection.close()

    def test_extension_and_same_origin_panel_lifecycle(self):
        self.assertEqual(json.loads(self.request()[2]), {"words": []})
        status, headers, body = self.request("POST", payload=ZH, headers={"Origin": "chrome-extension://" + "a" * 32})
        self.assertEqual(status, 200)
        self.assertIn("Access-Control-Allow-Origin", headers)
        word = json.loads(body)["word"]
        self.assertEqual(json.loads(self.request()[2]), {"words": [word]})
        self.assertEqual(json.loads(self.request(headers={"Origin": self.origin})[2]), {"words": [word]})
        self.assertEqual(WordsStore(self.store.path).list(), [word])
        self.assertEqual(json.loads(self.request("POST", payload=ZH)[2])["word"], word)
        status, _, body = self.request("POST", "/api/words/learned", {"id": word["id"], "learned": True}, {"Origin": self.origin})
        self.assertEqual((status, json.loads(body)), (200, {"word": {**word, "learned": True}}))
        explanation = "你好 — обычное приветствие. 你 значит «ты», 好 — «хорошо»."
        status, _, body = self.request("POST", "/api/words/explanation", {"id": word["id"], "explanation": explanation}, {"Origin": self.origin})
        explained = {**word, "learned": True, "explanation": explanation}
        self.assertEqual((status, json.loads(body)), (200, {"word": explained}))
        self.assertEqual(json.loads(self.request()[2]), {"words": [explained]})

    def test_extension_saves_ai_translation_variants_without_replacing_the_video_translation(self):
        extension_origin = "chrome-extension://" + "a" * 32
        word = json.loads(self.request("POST", payload={**ZH, "text": "行", "pinyin": "xíng", "translation": "старый перевод"}, headers={"Origin": extension_origin})[2])["word"]
        translations = [{"translation": "годится; можно", "usage": "когда что-то допустимо или подходит"}]
        status, _, body = self.request("POST", "/api/words/ai-translations", {"id": word["id"], "translations": translations}, {"Origin": extension_origin})
        saved = json.loads(body)["word"]
        self.assertEqual(status, 200)
        self.assertEqual(saved["translation"], "старый перевод")
        self.assertEqual(saved["ai_translations"], translations)
        self.assertEqual(self.request("POST", "/api/words/ai-translations", {"id": word["id"], "translations": translations}, {"Origin": self.origin})[0], 403)

    def test_analysis_routes_require_extension_and_preserve_failed_save(self):
        analysis = {
            "pinyin": "nǐ hǎo", "translation": "hello", "grammar": "Greeting.",
            "components": [{"text": "你好", "pinyin": "nǐ hǎo", "translation": "hello", "usage": "Greeting"}],
            "characters": [{"text": "你", "pinyin": "nǐ", "translation": "ты"}, {"text": "好", "pinyin": "hǎo", "translation": "хорошо"}],
            "example": {"pinyin": "Nǐ hǎo!", "translation": "Hello!"},
        }
        extension = {"Origin": "chrome-extension://" + "a" * 32}
        for kind, key, add in (("words", "word", self.store.add), ("sentences", "sentence", self.store.add_sentence)):
            row = add(ZH)
            route = f"/api/{kind}/analysis"
            payload = {"id": row["id"], "analysis": analysis}
            for headers in ({}, {"Origin": self.origin}, {"Origin": "https://evil.example"},
                            {**extension, "X-SubsAnywhere-Client": ""}):
                self.assertEqual(self.request("POST", route, payload, headers)[0], 403)
            preflight = {**extension, "Access-Control-Request-Method": "POST",
                         "Access-Control-Request-Headers": "X-SubsAnywhere-Client, Content-Type"}
            self.assertEqual(self.request("OPTIONS", route, headers=preflight)[0], 204)
            self.assertEqual(self.request("OPTIONS", route, headers={**preflight, "Origin": self.origin})[0], 403)
            status, _, body = self.request("POST", route, payload, extension)
            self.assertEqual(status, 200)
            saved = json.loads(body)[key]
            self.assertEqual(saved["analysis"], analysis)
            for invalid in ({**payload, "extra": 1}, {"id": True, "analysis": analysis},
                            {**payload, "analysis": {**analysis, "components": []}}):
                self.assertEqual(self.request("POST", route, invalid, extension)[0], 400)
            self.assertEqual(json.loads(self.request(path=f"/api/{kind}")[2])[kind], [saved])
            self.assertEqual(self.request("POST", route, {**payload, "id": 9999}, extension)[0], 404)
            english = add(EN)
            self.assertEqual(self.request("POST", route, {**payload, "id": english["id"]}, extension)[0], 404)

    def test_analysis_accepts_full_bounded_payload_but_not_oversized_body(self):
        component = {"text": "你", "pinyin": "nǐ", "translation": "я" * 160, "usage": "я" * 240}
        analysis = {"pinyin": " ".join(["nǐ"] * 120), "translation": "t" * 1000, "grammar": "g" * 700,
                    "components": [component] * 120,
                    "characters": [{"text": "你", "pinyin": "nǐ", "translation": "я" * 160}] * 120,
                    "example": {"pinyin": "n" * 300, "translation": "t" * 300}}
        row = self.store.add_sentence({**ZH, "text": "你" * 120})
        route = "/api/sentences/analysis"
        headers = {"Origin": "chrome-extension://" + "a" * 32, "Content-Type": "application/json"}
        raw = json.dumps({"id": row["id"], "analysis": analysis}).encode()
        self.assertGreater(len(raw), 16384)
        status, _, body = self.request("POST", route, headers=headers, raw=raw)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["sentence"]["analysis"], analysis)
        self.assertEqual(self.request("POST", route,
                                     headers={**headers, "Content-Length": str(server.MAX_ANALYSIS_BODY_BYTES + 1)},
                                     raw=b"")[0], 413)
        self.assertEqual(self.store.list_sentences()[0]["analysis"], analysis)

    def test_sentence_api_has_an_independent_lifecycle(self):
        status, _, body = self.request("POST", "/api/sentences", ZH_SENTENCE)
        self.assertEqual(status, 200)
        sentence = json.loads(body)["sentence"]
        self.assertEqual(json.loads(self.request(path="/api/sentences")[2]), {"sentences": [sentence]})
        status, _, body = self.request("POST", "/api/sentences/learned", {"id": sentence["id"], "learned": True})
        self.assertEqual((status, json.loads(body)["sentence"]["learned"]), (200, True))
        explanation = "Yǐjīng и le показывают уже завершившееся действие. По-русски смысл передаётся словом «уже» и прошедшим временем."
        status, _, body = self.request("POST", "/api/sentences/explanation", {"id": sentence["id"], "explanation": explanation})
        self.assertEqual((status, json.loads(body)["sentence"]["explanation"]), (200, explanation))
        self.assertEqual(self.store.list(), [])

    def test_panel_can_permanently_delete_words_and_sentences_after_confirmation(self):
        word = json.loads(self.request("POST", "/api/words", ZH, {"Origin": self.origin})[2])["word"]
        sentence = json.loads(self.request("POST", "/api/sentences", ZH_SENTENCE, {"Origin": self.origin})[2])["sentence"]
        status, _, body = self.request("POST", "/api/words/delete", {"id": word["id"]}, {"Origin": self.origin})
        self.assertEqual((status, json.loads(body)), (200, {"deleted": True}))
        self.assertEqual(json.loads(self.request(path="/api/words")[2]), {"words": []})
        status, _, body = self.request("POST", "/api/sentences/delete", {"id": sentence["id"]}, {"Origin": self.origin})
        self.assertEqual((status, json.loads(body)), (200, {"deleted": True}))
        self.assertEqual(json.loads(self.request(path="/api/sentences")[2]), {"sentences": []})

    def test_only_the_same_origin_panel_can_delete_vocabulary(self):
        word = self.store.add(ZH)
        extension_origin = "chrome-extension://" + "a" * 32
        status, _, _ = self.request("POST", "/api/words/delete", {"id": word["id"]}, {"Origin": extension_origin})
        self.assertEqual(status, 403)
        self.assertEqual(self.store.list(), [word])
        headers = {"Origin": extension_origin, "Access-Control-Request-Method": "POST",
                   "Access-Control-Request-Headers": "X-SubsAnywhere-Client, Content-Type"}
        self.assertEqual(self.request("OPTIONS", "/api/words/delete", headers=headers)[0], 403)
        self.assertEqual(self.request("POST", "/api/words/delete", {"id": word["id"]}, {"Origin": self.origin})[0], 200)

    def test_api_returns_complete_list_without_hidden_limit(self):
        saved = [self.store.add({**EN, "text": f"word {index}"}) for index in range(205)]
        status, _, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"words": list(reversed(saved))})

    def test_same_origin_panel_can_add_and_docker_mapped_port_is_exact(self):
        self.assertEqual(self.request("POST", payload=EN, headers={"Origin": self.origin})[0], 200)
        # Match the existing Host policy when Docker publishes a different port.
        with mock.patch.object(self.httpd, "server_address", ("0.0.0.0", self.port)):
            headers = {"Host": "127.0.0.1:49123", "Origin": "http://127.0.0.1:49123"}
            self.assertEqual(self.request("POST", payload=ZH, headers=headers)[0], 200)
            self.assertEqual(self.request("POST", payload=ZH, headers={**headers, "Origin": self.origin})[0], 403)
            self.assertEqual(self.request("POST", payload=ZH, headers={"Host": "evil.example:49123", "Origin": "http://evil.example:49123"})[0], 403)

    def test_missing_length_and_media_type_are_rejected(self):
        self.assertEqual(self.request("POST", raw=b"{}")[0], 415)
        request = (f"POST /api/words HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                   "X-SubsAnywhere-Client: extension-v1\r\nContent-Type: application/json\r\n\r\n").encode()
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as connection:
            connection.sendall(request)
            self.assertIn(b" 411 ", connection.recv(4096).split(b"\r\n")[0])

    def test_forbidden_hosts_origins_and_missing_client_never_write(self):
        for headers in ({"Host": "evil.example"}, {"Origin": "https://evil.example"},
                        {"Origin": "null"}, {"Origin": self.origin + ".evil.example"},
                        {"Origin": self.origin + "/"}, {"Origin": f"http://localhost:{self.port}"},
                        {"Origin": "https://127.0.0.1:" + str(self.port)},
                        {"X-SubsAnywhere-Client": ""},
                        {"Origin": self.origin, "X-SubsAnywhere-Client": ""}):
            with self.subTest(headers=headers):
                status, response_headers, _ = self.request("POST", payload=ZH, headers=headers)
                self.assertEqual(status, 403)
                self.assertNotIn("Access-Control-Allow-Origin", response_headers)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("POST", "/api/words", json.dumps(ZH), {"Content-Type": "application/json", "Origin": self.origin})
            self.assertEqual(connection.getresponse().status, 403)
        finally:
            connection.close()
        self.assertEqual(self.store.list(), [])

    def test_invalid_json_media_types_sizes_and_queries(self):
        for raw in (b"{", b"null", b"[]", b"\xff", b'{"id":NaN}', b'{"language":"zh","language":"en"}', b"[" * 2000):
            with self.subTest(raw=raw[:60]):
                self.assertEqual(self.request("POST", raw=raw, headers={"Content-Type": "application/json"})[0], 400)
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "application/json; charset=latin1"):
            self.assertEqual(self.request("POST", payload=ZH, headers={"Content-Type": content_type})[0], 415)
        self.assertEqual(self.request("POST", raw=b"x" * 16385, headers={"Content-Type": "application/json"})[0], 413)
        self.assertEqual(self.request("POST", payload=ZH, headers={"Transfer-Encoding": "chunked"})[0], 400)
        self.assertEqual(self.request("POST", "/api/words?x=1", payload=ZH)[0], 413)
        self.assertEqual(self.request(path="/api/words?x=1")[0], 404)
        self.assertEqual(self.request("GET", raw=b"{}", headers={"Content-Type": "application/json"})[0], 413)
        for payload in ({"id": 0, "learned": True}, {"id": True, "learned": True},
                        {"id": "1", "learned": True}, {"id": 1}, {"id": 1, "learned": 1},
                        {"id": 1, "learned": True, "extra": "x"}):
            self.assertEqual(self.request("POST", "/api/words/learned", payload=payload)[0], 400)
        for payload in ({"id": 0, "explanation": "объяснение"}, {"id": 1, "explanation": ""},
                        {"id": 1, "explanation": "x" * 1201}, {"id": 1, "explanation": 1}):
            self.assertEqual(self.request("POST", "/api/words/explanation", payload=payload)[0], 400)
        for payload in ({**EN, "text": "你好"}, {**ZH, "translation": "x" * 1001}, {**EN, "pinyin": "x"}):
            self.assertEqual(self.request("POST", payload=payload)[0], 400)
        self.assertEqual(self.store.list(), [])

    def test_duplicate_headers_and_truncated_body_are_rejected(self):
        body = json.dumps(EN).encode()
        for duplicate in ("Origin: " + self.origin, "Host: 127.0.0.1:" + str(self.port),
                          "Content-Length: " + str(len(body)), "X-SubsAnywhere-Client: extension-v1"):
            request = (f"POST /api/words HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                       f"Origin: {self.origin}\r\nX-SubsAnywhere-Client: extension-v1\r\n"
                       f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n{duplicate}\r\n\r\n").encode() + body
            with socket.create_connection(("127.0.0.1", self.port), timeout=5) as connection:
                connection.sendall(request)
                self.assertRegex(connection.recv(4096).split(b"\r\n")[0], rb"HTTP/1\.[01] (400|403)")
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as connection:
            connection.sendall((f"POST /api/words HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                                "X-SubsAnywhere-Client: extension-v1\r\nContent-Type: application/json\r\n"
                                "Content-Length: 100\r\n\r\n{}").encode())
            connection.shutdown(socket.SHUT_WR)
            self.assertIn(b" 400 ", connection.recv(4096).split(b"\r\n")[0])
        self.assertEqual(self.store.list(), [])

    def test_cors_json_is_limited_to_words_routes_and_subtitles_unchanged(self):
        origin = "chrome-extension://" + "a" * 32
        headers = {"Origin": origin, "Access-Control-Request-Method": "POST",
                   "Access-Control-Request-Headers": "X-SubsAnywhere-Client, Content-Type"}
        status, response_headers, _ = self.request("OPTIONS", headers=headers)
        self.assertEqual(status, 204)
        self.assertIn("Content-Type", response_headers["Access-Control-Allow-Headers"])
        for path in ("/api/subtitles/generate?video_id=rwnyaH6cTDE", "/health"):
            self.assertEqual(self.request("OPTIONS", path, headers=headers)[0], 403)
        subtitle = "/api/subtitles/generate?video_id=rwnyaH6cTDE"
        self.assertEqual(self.request("POST", subtitle, headers={"Origin": self.origin})[0], 403)
        self.assertEqual(self.request("POST", subtitle, payload=ZH)[0], 413)
        self.assertEqual(self.request("OPTIONS", headers={**headers, "Origin": "https://evil.example"})[0], 403)

    def test_static_panel_is_exact_allowlist_and_restrictive(self):
        for path, content_type in (("/words", "text/html"), ("/words/words.js", "text/javascript"),
                                   ("/words/words.css", "text/css")):
            status, headers, body = self.request(path=path, headers={"X-SubsAnywhere-Client": ""})
            self.assertEqual(status, 200)
            self.assertIn(content_type, headers["Content-Type"])
            self.assertIn("default-src 'none'", headers["Content-Security-Policy"])
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertNotIn("unsafe-inline", headers["Content-Security-Policy"])
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertGreater(len(body), 0)
        for path in ("/words/../server.py", "/words/%2e%2e/server.py", "/words/words.sqlite3", "/words/", "/words?x=1"):
            self.assertEqual(self.request(path=path)[0], 404)
        javascript = self.request(path="/words/words.js")[2].decode()
        self.assertNotIn("innerHTML", javascript)
        self.assertIn("textContent", javascript)
        self.assertFalse(self.store.path.exists())

    def test_storage_failures_do_not_leak_local_paths(self):
        with mock.patch.object(self.store, "list", side_effect=OSError("/secret/path")):
            status, headers, body = self.request()
        self.assertEqual(status, 503)
        self.assertNotIn(b"/secret/path", body)
        self.assertEqual(headers["Retry-After"], "2")


if __name__ == "__main__":
    unittest.main()
