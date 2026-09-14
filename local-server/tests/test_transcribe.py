import pathlib
import os
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import transcribe


class TranscribeOutputTests(unittest.TestCase):
    def test_nano_is_explicit_offline_cpu_float32_without_sampling(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'Qwen3-0.6B').mkdir()
            for name in ('model.pt', 'config.yaml', 'Qwen3-0.6B/config.json'):
                (root / name).write_text('fixture')
            with patch.dict(os.environ, {'SUBSANYWHERE_NANO_MODEL_DIR': temporary}):
                init, generate = transcribe.recognition_options('nano', 'zh')
                self.assertEqual(init['model'], str(root.resolve()))
                self.assertEqual(init['llm_conf']['llm_dtype'], 'fp32')
                self.assertEqual(generate['language'], '中文')
                self.assertEqual(generate['llm_kwargs'], {'do_sample': False, 'num_beams': 1})
                self.assertEqual(transcribe.recognition_options('nano', 'en')[1]['language'], '英文')
                (root / 'model.pt').unlink()
                with self.assertRaisesRegex(RuntimeError, 'cached'):
                    transcribe.recognition_options('nano', 'zh')
        with self.assertRaises(ValueError):
            transcribe.recognition_options('unknown', 'zh')

    def test_cli_applies_budget_before_loading_the_model(self):
        from resource_budget import ResourceBudget
        with tempfile.TemporaryDirectory() as temporary:
            audio = pathlib.Path(temporary) / 'audio.wav'
            audio.write_bytes(b'audio')
            argv = ['transcribe', str(audio), '--srt', temporary + '/out.srt',
                    '--text', temporary + '/out.txt', '--markdown', temporary + '/out.md']
            events = []
            guard = Mock()
            guard.__enter__ = Mock(side_effect=lambda: events.append('guard'))
            guard.__exit__ = Mock(return_value=False)
            with patch.object(sys, 'argv', argv), \
                    patch.object(transcribe, 'get_resource_budget', return_value=ResourceBudget(2.5, 8000, 2, 1/3), create=True), \
                    patch.object(transcribe, 'configure_threads', side_effect=lambda n: events.append(('threads', n)), create=True), \
                    patch.object(transcribe, 'MemoryGuard', return_value=guard, create=True) as factory, \
                    patch.object(transcribe, 'transcribe', side_effect=lambda *a, **k: events.append(('model', k)) or [(0, 1000, '你好')]):
                transcribe.main()
            self.assertEqual(events[:2], [('threads', 2), 'guard'])
            self.assertEqual(events[2][1]['ncpu'], 2)
            factory.assert_called_once_with(8000)

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
            "numpy": Mock(asarray=lambda samples, dtype: 0.0),
            "funasr.utils.postprocess_utils": Mock(
                rich_transcription_postprocess=lambda text: text,
            ),
        }
        with patch.object(transcribe.importlib, "import_module", side_effect=modules.__getitem__), \
                patch.object(transcribe, "audio_chunks", return_value=iter([(0, [0] * 80000), (5000, [0] * 80000)]), create=True), \
                patch.object(transcribe, "audio_duration_ms", return_value=10000, create=True), \
                patch.object(transcribe, "cached_model_paths", return_value=(pathlib.Path("model"), pathlib.Path("vad"))):
            segments = transcribe.transcribe(pathlib.Path("speech.wav"), "cpu", language="en", ncpu=2)

        self.assertEqual(segments, [(200, 2100, "你好。"), (2600, 4300, "再见。"),
                                    (5200, 7100, "你好。"), (7600, 9300, "再见。")])
        self.assertEqual(factory.call_args.kwargs.get("ncpu"), 2)
        self.assertEqual(model.generate.call_args.kwargs.get("language"), "en")
        self.assertIs(model.generate.call_args.kwargs.get("use_itn"), True)
        self.assertEqual(model.generate.call_count, 2)
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
