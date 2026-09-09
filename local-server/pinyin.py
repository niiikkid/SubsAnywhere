"""Offline Chinese pinyin conversion, portable with pypinyin."""

from __future__ import annotations

import json
import re
import subprocess
import sys

HAN_PATTERN = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
TAG_PATTERN = re.compile(r"<[^>]*>")
PINYIN_TONE_PATTERN = re.compile(r"[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]")
PINYIN_MARKER = "\u2063"
SOURCE_MARKER = "\u2064"
SWIFT_TRANSLITERATOR = """import Foundation
let data = FileHandle.standardInput.readDataToEndOfFile()
let sources = try! JSONDecoder().decode([String].self, from: data)
let converted = sources.map { $0.applyingTransform(.toLatin, reverse: false) ?? $0 }
FileHandle.standardOutput.write(try! JSONEncoder().encode(converted))
"""


def clean_caption(value: str) -> str:
    return TAG_PATTERN.sub("", str(value)).replace("\r", "").strip()


def contains_han(value: str) -> bool:
    return bool(HAN_PATTERN.search(value))


def has_marker_frame(lines: list[str]) -> bool:
    return any(line.startswith((PINYIN_MARKER, SOURCE_MARKER)) for line in lines)


def is_linked_pinyin(lines: list[str]) -> bool:
    return (
        len(lines) >= 2
        and lines[0].startswith(PINYIN_MARKER)
        and lines[1].startswith(SOURCE_MARKER)
        and bool(lines[0][len(PINYIN_MARKER):].strip())
        and not has_marker_frame(lines[2:])
        and contains_han("\n".join([lines[1][len(SOURCE_MARKER):], *lines[2:]]))
    )


def pinyin_signature(value: str) -> str:
    return re.sub(r"[\W_]+", "", value.casefold(), flags=re.UNICODE)


def convert_many_to_pinyin(values: list[str], run_command=subprocess.run) -> list[str]:
    sources = [clean_caption(value) for value in values]
    if not sources:
        return []
    try:
        from pypinyin import Style, lazy_pinyin
    except ImportError as error:
        if sys.platform != "darwin":
            raise RuntimeError("Pinyin dependency is missing. Rebuild the subtitle server image.") from error
    else:
        return [
            " ".join(" ".join(lazy_pinyin(source, style=Style.TONE, errors=lambda text: [text])).split())
            for source in sources
        ]
    # Preserve the existing dependency-free native macOS launch.
    result = run_command(
        ["/usr/bin/swift", "-e", SWIFT_TRANSLITERATOR],
        input=json.dumps(sources, ensure_ascii=False),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout or "macOS pinyin conversion failed").strip()
        raise RuntimeError(detail)
    try:
        converted = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("macOS pinyin conversion returned invalid JSON") from error
    if not isinstance(converted, list) or len(converted) != len(sources) or not all(isinstance(value, str) for value in converted):
        raise RuntimeError("macOS pinyin conversion returned an invalid result count")
    converted = [" ".join(value.split()) for value in converted]
    if not all(converted):
        raise RuntimeError("macOS pinyin conversion returned an empty result")
    return converted


def bilingual_srt(source: str, convert_many=convert_many_to_pinyin) -> str:
    normalized = str(source).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return ""
    blocks = normalized.split("\n\n")
    pending = []
    for block_index, block in enumerate(blocks):
        lines = block.split("\n")
        timing_index = next((index for index, line in enumerate(lines) if "-->" in line), -1)
        if timing_index < 0:
            continue
        caption_lines = [clean_caption(line) for line in lines[timing_index + 1:]]
        if not caption_lines or is_linked_pinyin(caption_lines) or has_marker_frame(caption_lines) or not contains_han("\n".join(caption_lines)):
            continue
        legacy_pinyin = None
        characters = "\n".join(caption_lines)
        if (
            len(caption_lines) >= 2
            and PINYIN_TONE_PATTERN.search(caption_lines[0])
            and not contains_han(caption_lines[0])
            and contains_han("\n".join(caption_lines[1:]))
        ):
            legacy_pinyin = caption_lines[0]
            characters = "\n".join(caption_lines[1:])
        pending.append((block_index, lines[:timing_index + 1], characters, legacy_pinyin, caption_lines))
    converted = convert_many([characters for _, _, characters, _, _ in pending]) if pending else []
    if len(converted) != len(pending):
        raise RuntimeError("macOS pinyin conversion returned an invalid result count")
    for (block_index, prefix, characters, legacy_pinyin, caption_lines), pinyin in zip(pending, converted, strict=True):
        pinyin = " ".join(clean_caption(pinyin).split())
        if legacy_pinyin:
            if pinyin_signature(legacy_pinyin) == pinyin_signature(pinyin):
                pinyin = legacy_pinyin
            else:
                pinyin = f"{legacy_pinyin} {pinyin}"
                characters = "\n".join(caption_lines)
        blocks[block_index] = "\n".join([
            *prefix,
            f"{PINYIN_MARKER}{pinyin}",
            f"{SOURCE_MARKER}{characters}",
        ])
    return "\n\n".join(blocks) + "\n"
