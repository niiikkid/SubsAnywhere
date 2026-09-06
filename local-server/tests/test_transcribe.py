import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import transcribe


class TranscribeOutputTests(unittest.TestCase):
    def test_cached_model_paths_require_both_local_models(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            model = home / ".cache/modelscope/hub/models/iic/SenseVoiceSmall"
            vad = home / ".cache/modelscope/hub/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
            model.mkdir(parents=True)
            vad.mkdir(parents=True)

            self.assertEqual(transcribe.cached_model_paths(home), (model, vad))
            vad.rmdir()
            with self.assertRaisesRegex(RuntimeError, "cached"):
                transcribe.cached_model_paths(home)

    def test_write_outputs_creates_valid_english_named_deliverables(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            srt = root / "youtube-rwnyaH6cTDE-generated.srt"
            text = root / "youtube-rwnyaH6cTDE-generated.txt"
            markdown = root / "youtube-rwnyaH6cTDE-generated.timestamps.md"
            count = transcribe.write_outputs(
                [(1260, 2410, "你好"), (3000, 4500, "谢谢")],
                srt,
                text,
                markdown,
                "youtube-rwnyaH6cTDE-audio.mp3",
            )

            self.assertEqual(count, 2)
            self.assertIn("00:00:01,260 --> 00:00:02,410", srt.read_text(encoding="utf-8"))
            self.assertEqual(text.read_text(encoding="utf-8"), "你好\n谢谢\n")
            self.assertIn("[00:00:03–00:00:04] 谢谢", markdown.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
