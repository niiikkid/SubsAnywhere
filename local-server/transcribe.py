#!/usr/bin/env python3
"""Create Chinese subtitle files with the installed FunASR model."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import time
from pathlib import Path


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


def transcribe(audio: Path, device: str, progress=None) -> list[tuple[int, int, str]]:
    AutoModel = importlib.import_module("funasr").AutoModel
    rich_transcription_postprocess = importlib.import_module(
        "funasr.utils.postprocess_utils"
    ).rich_transcription_postprocess
    model_path, vad_path = cached_model_paths()

    model = AutoModel(
        model=str(model_path),
        vad_model=str(vad_path),
        # Split on audible pauses rather than estimating times from text length.
        # Cap continuous speech so a whole paragraph cannot become one cue.
        vad_kwargs={
            "max_single_segment_time": 8000,
            "max_end_silence_time": 400,
        },
        device=device,
        disable_update=True,
        disable_pbar=True,
    )
    restore_progress = install_progress_tracking(model, progress) if progress else lambda: None
    try:
        result = model.generate(
            input=str(audio),
            batch_size_s=300,
            sentence_timestamp=True,
            merge_vad=False,
        )
    finally:
        restore_progress()
    sentence_info = result[0].get("sentence_info", []) if result else []
    segments = []
    for item in sentence_info:
        text = rich_transcription_postprocess(
            item.get("sentence") or item.get("text") or ""
        )
        text = re.sub(r"\s+", " ", text).strip()
        start = int(item.get("start", 0))
        end = int(item.get("end", 0))
        if text and end > start:
            segments.append((start, end, text))
    return segments


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("--srt", type=Path, required=True)
    parser.add_argument("--text", type=Path, required=True)
    parser.add_argument("--markdown", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "mps"), default="cpu")
    parser.add_argument("--progress", type=Path)
    args = parser.parse_args()
    audio = args.audio.expanduser().resolve()
    if not audio.is_file() or not audio.stat().st_size:
        raise SystemExit(f"Audio file not found: {audio}")
    progress = ProgressWriter(args.progress) if args.progress else None
    segments = transcribe(audio, args.device, progress)
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
