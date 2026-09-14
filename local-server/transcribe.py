#!/usr/bin/env python3
"""Create local English/Chinese subtitles with bounded audio working sets."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import time
from pathlib import Path

from audio_stream import SAMPLE_RATE, audio_chunks, audio_duration_ms
from asr_runtime import MemoryGuard, configure_threads
from resource_budget import get_resource_budget


def srt_time(milliseconds: int) -> str:
    value = max(0, int(milliseconds))
    hours, value = divmod(value, 3_600_000)
    minutes, value = divmod(value, 60_000)
    seconds, millis = divmod(value, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def short_time(milliseconds: int) -> str:
    total_seconds = max(0, int(milliseconds)) // 1_000
    hours, remainder = divmod(total_seconds, 3_600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def cached_model_paths(home: Path | None = None) -> tuple[Path, Path]:
    configured = os.environ.get("SUBSANYWHERE_MODELS_DIR")
    cache = Path(configured).expanduser() if configured and home is None else (
        (home or Path.home()) / ".cache/modelscope/hub/models/iic"
    )
    model = cache / "SenseVoiceSmall"
    vad = cache / "speech_fsmn_vad_zh-cn-16k-common-pytorch"
    if not model.is_dir() or not vad.is_dir():
        raise RuntimeError("Required FunASR models are not cached locally")
    return model, vad


def write_outputs(
    segments: list[tuple[int, int, str]],
    srt_path: Path,
    text_path: Path,
    markdown_path: Path,
    source_name: str,
) -> int:
    rows = [
        (int(start), int(end), str(text).strip())
        for start, end, text in segments
        if int(end) > int(start) and str(text).strip()
    ]
    if not rows:
        raise RuntimeError("FunASR returned no timestamped subtitle segments")
    for path in (srt_path, text_path, markdown_path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    srt_blocks = [
        f"{index}\n{srt_time(start)} --> {srt_time(end)}\n{text}"
        for index, (start, end, text) in enumerate(rows, 1)
    ]
    Path(srt_path).write_text("\n\n".join(srt_blocks) + "\n", encoding="utf-8")
    Path(text_path).write_text("\n".join(text for _, _, text in rows) + "\n", encoding="utf-8")
    markdown = [f"# Transcript: {source_name}", ""]
    markdown.extend(
        f"[{short_time(start)}–{short_time(end)}] {text}"
        for start, end, text in rows
    )
    Path(markdown_path).write_text("\n\n".join(markdown) + "\n", encoding="utf-8")
    return len(rows)


def install_progress_tracking(model, callback):
    original_inference = model.inference
    state = {
        "completed_segments": 0,
        "total_segments": 0,
        "completed_ms": 0,
        "total_ms": 0,
    }

    def tracked_inference(input_value, *args, **kwargs):
        result = original_inference(input_value, *args, **kwargs)
        target_model = kwargs.get("model")
        if target_model is model.vad_model:
            segments = [
                segment
                for item in result
                for segment in item.get("value", [])
                if isinstance(segment, (list, tuple)) and len(segment) >= 2
            ]
            state["total_segments"] = len(segments)
            state["total_ms"] = sum(max(0, int(segment[1]) - int(segment[0])) for segment in segments)
            callback(dict(state))
        elif target_model is model.model and state["total_segments"]:
            samples = input_value if isinstance(input_value, (list, tuple)) else [input_value]
            processed_samples = sum(len(sample) for sample in samples if hasattr(sample, "__len__"))
            state["completed_segments"] = min(
                state["total_segments"],
                state["completed_segments"] + len(result),
            )
            state["completed_ms"] = min(
                state["total_ms"],
                state["completed_ms"] + round(processed_samples / 16),
            )
            callback(dict(state))
        return result

    model.inference = tracked_inference

    def restore():
        model.inference = original_inference

    return restore


class ProgressWriter:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.started_at = None

    def __call__(self, update: dict) -> None:
        completed_ms = int(update.get("completed_ms", 0))
        total_ms = int(update.get("total_ms", 0))
        if total_ms and self.started_at is None:
            self.started_at = time.monotonic()
        progress = round(completed_ms * 100 / total_ms) if total_ms else 0
        payload = {
            "stage": "recognizing",
            "progress": max(0, min(100, progress)),
            "completed_segments": int(update.get("completed_segments", 0)),
            "total_segments": int(update.get("total_segments", 0)),
        }
        if (
            completed_ms
            and total_ms
            and completed_ms / total_ms >= 0.03
            and self.started_at is not None
        ):
            elapsed = time.monotonic() - self.started_at
            if elapsed >= 10:
                payload["eta_seconds"] = max(
                    0,
                    round(elapsed * (total_ms - completed_ms) / completed_ms),
                )
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(temporary, self.path)


def recognition_options(engine, language):
    if engine == "sensevoice":
        return {}, {"language": language, "use_itn": True}
    if engine != "nano":
        raise ValueError("Unsupported recognition model")
    mounted = os.environ.get("SUBSANYWHERE_MODELS_DIR")
    default = Path(mounted) / "Fun-ASR-Nano-2512" if mounted else (
        Path.home() / ".cache/modelscope/hub/models/FunAudioLLM/Fun-ASR-Nano-2512")
    path = Path(os.environ.get("SUBSANYWHERE_NANO_MODEL_DIR", str(default))).expanduser().resolve()
    if not all((path / name).is_file() and (path / name).stat().st_size
               for name in ("model.pt", "config.yaml", "Qwen3-0.6B/config.json")):
        raise RuntimeError("Nano model is not cached locally; no automatic downloads")
    return {
        "model": str(path),
        "llm_conf": {"llm_dtype": "fp32", "init_param_path": str(path / "Qwen3-0.6B")},
    }, {
        "language": {"en": "英文", "zh": "中文"}[language], "itn": True,
        "llm_dtype": "fp32", "max_length": 256,
        "llm_kwargs": {"do_sample": False, "num_beams": 1},
    }


def transcribe(audio: Path, device: str, progress=None, language="zh", ncpu=4,
               engine="sensevoice") -> list[tuple[int, int, str]]:
    if language not in {"en", "zh"}:
        raise ValueError("Unsupported recognition language")
    if not isinstance(ncpu, int) or ncpu < 1:
        raise ValueError("Invalid recognition thread count")
    if engine == "nano" and device != "cpu":
        raise ValueError("Nano is supported on CPU only")
    extra_init, extra_generate = recognition_options(engine, language)
    AutoModel = importlib.import_module("funasr").AutoModel
    numpy = importlib.import_module("numpy")
    rich_transcription_postprocess = importlib.import_module(
        "funasr.utils.postprocess_utils"
    ).rich_transcription_postprocess
    model_path, vad_path = cached_model_paths()

    model = AutoModel(
        model=extra_init.pop("model", str(model_path)),
        vad_model=str(vad_path),
        # Split on audible pauses rather than estimating times from text length.
        # Cap continuous speech so a whole paragraph cannot become one cue.
        vad_kwargs={
            "max_single_segment_time": 8000,
            "max_end_silence_time": 400,
        },
        device=device,
        ncpu=ncpu,
        disable_update=True,
        disable_pbar=True,
        trust_remote_code=False,
        **extra_init,
    )
    total_ms = audio_duration_ms(audio)
    chunks = audio_chunks(audio)
    segments = []
    try:
        for offset, samples in chunks:
            chunk_ms = round(len(samples) * 1000 / SAMPLE_RATE)

            def report(update):
                if progress is None:
                    return
                speech_ms = update.get("total_ms", 0)
                fraction = update.get("completed_ms", 0) / speech_ms if speech_ms else 0
                progress({"completed_ms": min(total_ms, offset + round(chunk_ms * fraction)),
                          "total_ms": total_ms})

            restore_progress = install_progress_tracking(model, report) if progress else lambda: None
            try:
                result = model.generate(
                    input=numpy.asarray(samples, dtype="float32") / 32768.0,
                    cache={}, batch_size=1,
                    batch_size_s=30,
                    sentence_timestamp=True,
                    merge_vad=False,
                    **extra_generate,
                )
            finally:
                restore_progress()
            sentence_info = result[0].get("sentence_info", []) if result else []
            for item in sentence_info:
                text = rich_transcription_postprocess(
                    item.get("sentence") or item.get("text") or ""
                )
                text = re.sub(r"\s+", " ", text).strip()
                start = max(0, int(item.get("start", 0)))
                end = min(chunk_ms, int(item.get("end", 0)))
                if text and end > start:
                    segments.append((offset + start, offset + end, text))
            if progress:
                progress({"completed_ms": min(total_ms, offset + chunk_ms), "total_ms": total_ms})
    finally:
        close = getattr(chunks, "close", None)
        if close:
            close()
    return segments


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("--srt", type=Path, required=True)
    parser.add_argument("--text", type=Path, required=True)
    parser.add_argument("--markdown", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "mps"), default="cpu")
    parser.add_argument("--progress", type=Path)
    parser.add_argument("--language", choices=("en", "zh"), default="zh")
    parser.add_argument("--model", choices=("sensevoice", "nano"),
                        default=os.environ.get("SUBSANYWHERE_ASR_MODEL", "sensevoice"))
    args = parser.parse_args()
    audio = args.audio.expanduser().resolve()
    if not audio.is_file() or not audio.stat().st_size:
        raise SystemExit(f"Audio file not found: {audio}")
    progress = ProgressWriter(args.progress) if args.progress else None
    budget = get_resource_budget()
    configure_threads(budget.threads)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["MODELSCOPE_OFFLINE"] = "1"
    with MemoryGuard(budget.memory_bytes):
        segments = transcribe(audio, args.device, progress, language=args.language,
                              ncpu=budget.threads, engine=args.model)
    count = write_outputs(
        segments,
        args.srt,
        args.text,
        args.markdown,
        audio.name,
    )
    print(f"segments={count}")
    print(f"srt={args.srt}")


if __name__ == "__main__":
    main()
