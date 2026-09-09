import pathlib
import os
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import transcribe


class TranscribeOutputTests(unittest.TestCase):
    def test_model_directory_can_be_mounted_outside_a_user_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            model = root / "SenseVoiceSmall"
            vad = root / "speech_fsmn_vad_zh-cn-16k-common-pytorch"
            model.mkdir()
            vad.mkdir()
            with patch.dict(os.environ, {"SUBSANYWHERE_MODELS_DIR": str(root)}):
                self.assertEqual(transcribe.cached_model_paths(), (model, vad))

    def test_progress_tracking_counts_vad_segments_and_processed_audio(self):
        vad_model = object()
        asr_model = object()

        class FakeModel:
            def __init__(self):
                self.vad_model = vad_model
                self.model = asr_model

            def inference(self, input_value, **kwargs):
                if kwargs.get("model") is vad_model:
                    return [{"value": [[0, 1000], [1500, 3500]]}]
                return [{"text": "ok"} for _ in input_value]

        model = FakeModel()
        updates = []
        restore = transcribe.install_progress_tracking(model, updates.append)
        try:
            model.inference("audio", model=vad_model)
            model.inference([[0] * 16000], model=asr_model)
            model.inference([[0] * 32000], model=asr_model)
        finally:
            restore()

        self.assertEqual(updates, [
            {"completed_segments": 0, "total_segments": 2, "completed_ms": 0, "total_ms": 3000},
            {"completed_segments": 1, "total_segments": 2, "completed_ms": 1000, "total_ms": 3000},
            {"completed_segments": 2, "total_segments": 2, "completed_ms": 3000, "total_ms": 3000},
        ])

    def test_transcribe_uses_short_pause_aware_segments_without_merging(self):
        model = Mock()
        model.generate.return_value = [{"sentence_info": [
            {"start": 200, "end": 2100, "text": "你好。"},
            {"start": 2600, "end": 4300, "text": "再见。"},
        ]}]
        factory = Mock(return_value=model)
        modules = {
            "funasr": Mock(AutoModel=factory),
            "funasr.utils.postprocess_utils": Mock(
                rich_transcription_postprocess=lambda text: text,
            ),
        }
        with patch.object(transcribe.importlib, "import_module", side_effect=modules.__getitem__), \
                patch.object(transcribe, "cached_model_paths", return_value=(pathlib.Path("model"), pathlib.Path("vad"))):
            segments = transcribe.transcribe(pathlib.Path("speech.wav"), "cpu")

        self.assertEqual(segments, [(200, 2100, "你好。"), (2600, 4300, "再见。")])
        self.assertEqual(factory.call_args.kwargs.get("vad_kwargs"), {
            "max_single_segment_time": 8000,
            "max_end_silence_time": 400,
        })
        self.assertIs(model.generate.call_args.kwargs.get("merge_vad"), False)

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
