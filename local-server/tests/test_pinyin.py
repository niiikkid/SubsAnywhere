import pathlib
import json
import subprocess
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import pinyin


class PinyinSubtitleTests(unittest.TestCase):
    def test_bilingual_srt_places_pinyin_before_its_source_characters(self):
        source = "1\n00:00:01,000 --> 00:00:03,000\n你好，世界！\n"

        converted = pinyin.bilingual_srt(source, convert_many=lambda texts: ["nǐ hǎo, shì jiè!"])

        self.assertEqual(
            converted,
            "1\n00:00:01,000 --> 00:00:03,000\n\u2063nǐ hǎo, shì jiè!\n\u2064你好，世界！\n",
        )

    def test_bilingual_srt_does_not_mistake_raw_latin_and_han_lines_for_pinyin(self):
        source = "1\n00:00:01,000 --> 00:00:03,000\nHello\n你好\n"
        batches = []

        converted = pinyin.bilingual_srt(
            source,
            convert_many=lambda texts: batches.append(texts) or ["Hello\nnǐ hǎo"],
        )

        self.assertEqual(batches, [["Hello\n你好"]])
        self.assertEqual(
            converted,
            "1\n00:00:01,000 --> 00:00:03,000\n\u2063Hello nǐ hǎo\n\u2064Hello\n你好\n",
        )

    def test_bilingual_srt_migrates_a_legacy_pinyin_line_without_duplication(self):
        source = "1\n00:00:01,000 --> 00:00:03,000\nnǐ hǎo\n你好\n"
        batches = []

        converted = pinyin.bilingual_srt(
            source,
            convert_many=lambda texts: batches.append(texts) or ["nǐ hǎo"],
        )

        self.assertEqual(batches, [["你好"]])
        self.assertEqual(
            converted,
            "1\n00:00:01,000 --> 00:00:03,000\n\u2063nǐ hǎo\n\u2064你好\n",
        )

    def test_bilingual_srt_preserves_only_well_formed_adjacent_multiline_marker_frames(self):
        valid = "1\n00:00:01,000 --> 00:00:03,000\n\u2063nǐ hǎo\n\u2064你好，\n世界\n"
        malformed = "2\n00:00:04,000 --> 00:00:05,000\n\u2063nǐ hǎo\nnot a source marker\n\u2064你好\n"
        batches = []

        converted = pinyin.bilingual_srt(
            valid + "\n" + malformed,
            convert_many=lambda texts: batches.append(texts) or ["unused"],
        )

        self.assertEqual(converted, valid + "\n" + malformed)
        self.assertEqual(batches, [])

    def test_bilingual_srt_batches_all_cues_through_one_converter_and_preserves_timings(self):
        source = (
            "1\n00:00:01,000 --> 00:00:03,000\n<i>你好</i>\n\n"
            "2\n00:00:04,000 --> 00:00:05,000\n再见\n"
        )
        batches = []

        converted = pinyin.bilingual_srt(
            source,
            convert_many=lambda texts: batches.append(texts) or ["nǐ hǎo", "zài jiàn"],
        )

        self.assertEqual(batches, [["你好", "再见"]])
        self.assertEqual(
            converted,
            "1\n00:00:01,000 --> 00:00:03,000\n\u2063nǐ hǎo\n\u2064你好\n\n"
            "2\n00:00:04,000 --> 00:00:05,000\n\u2063zài jiàn\n\u2064再见\n",
        )

    def test_convert_many_starts_swift_once_and_keeps_each_caption_in_order(self):
        calls = []

        def run(command, **kwargs):
            calls.append((command, kwargs))
            return subprocess.CompletedProcess(command, 0, json.dumps(["nǐ hǎo", "zài jiàn"]), "")

        converted = pinyin.convert_many_to_pinyin(["你好", "再见"], run_command=run)

        self.assertEqual(converted, ["nǐ hǎo", "zài jiàn"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0][0], "/usr/bin/swift")
        self.assertEqual(json.loads(calls[0][1]["input"]), ["你好", "再见"])


if __name__ == "__main__":
    unittest.main()
