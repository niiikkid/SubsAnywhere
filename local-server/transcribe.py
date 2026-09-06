#!/usr/bin/env python3
"""Create Chinese subtitle files with the installed FunASR model."""

from __future__ import annotations

import argparse
import importlib
import re
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
    cache = (home or Path.home()) / ".cache/modelscope/hub/models/iic"
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


def transcribe(audio: Path, device: str) -> list[tuple[int, int, str]]:
    AutoModel = importlib.import_module("funasr").AutoModel
    rich_transcription_postprocess = importlib.import_module(
        "funasr.utils.postprocess_utils"
    ).rich_transcription_postprocess
    model_path, vad_path = cached_model_paths()

    model = AutoModel(
        model=str(model_path),
        vad_model=str(vad_path),
        device=device,
        disable_update=True,
    )
    result = model.generate(
        input=str(audio),
        batch_size_s=300,
        sentence_timestamp=True,
    )
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
    args = parser.parse_args()
    audio = args.audio.expanduser().resolve()
    if not audio.is_file() or not audio.stat().st_size:
        raise SystemExit(f"Audio file not found: {audio}")
    segments = transcribe(audio, args.device)
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
