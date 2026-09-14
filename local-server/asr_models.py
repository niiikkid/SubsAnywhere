"""Lightweight model selection shared by the runner, health and offline import."""

import os
from pathlib import Path

NANO_NAME = "Fun-ASR-Nano-2512"
NANO_REQUIRED_FILES = ("model.pt", "config.yaml", "configuration.json",
                       "Qwen3-0.6B/config.json", "Qwen3-0.6B/tokenizer.json",
                       "Qwen3-0.6B/tokenizer_config.json")


def select_engine(engine, language):
    if language not in ("en", "zh") or engine not in ("auto", "nano", "sensevoice"):
        raise ValueError("Unsupported recognition model or language")
    return ("nano" if language == "zh" else "sensevoice") if engine == "auto" else engine


def nano_model_path():
    mounted = os.environ.get("SUBSANYWHERE_MODELS_DIR")
    default = Path(mounted) / NANO_NAME if mounted else (
        Path.home() / ".cache/modelscope/hub/models/FunAudioLLM" / NANO_NAME)
    return Path(os.environ.get("SUBSANYWHERE_NANO_MODEL_DIR", str(default))).expanduser().resolve()


def nano_model_available(path=None):
    path = nano_model_path() if path is None else Path(path)
    return all((path / name).is_file() and (path / name).stat().st_size
               for name in NANO_REQUIRED_FILES)
