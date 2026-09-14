"""Offline metadata responses shared by caption subprocess fakes."""
import hashlib
import json
import pathlib
import subprocess


def metadata_response(command, *, empty=False):
    if "--write-info-json" not in command:
        return None
    tracks = {"zh": [{"ext": "srt", "url": "https://example.invalid/captions?lang=zh"}]}
    metadata = {"language": "zh", "subtitles": {} if empty else tracks,
                "automatic_captions": {} if empty else tracks}
    target = pathlib.Path(command[command.index("-o") + 1].replace("%(ext)s", "info.json"))
    target.write_text(json.dumps(metadata), encoding="utf-8")
    return subprocess.CompletedProcess(command, 0, "", "")


def missing_captions(command, **kwargs):
    return metadata_response(command, empty=True) or subprocess.CompletedProcess(command, 0, "", "")


def mark_cache(path, language="zh"):
    path.with_suffix(".language.json").write_text(json.dumps({
        "version": 1, "language": language, "requested_language": "",
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }))
