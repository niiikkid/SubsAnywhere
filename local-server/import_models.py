#!/usr/bin/env python3
"""Copy an existing model cache into a Docker volume without downloading."""

import argparse
import shutil
import tempfile
from pathlib import Path

from asr_models import NANO_NAME, NANO_REQUIRED_FILES

MODEL_NAMES = ("SenseVoiceSmall", "speech_fsmn_vad_zh-cn-16k-common-pytorch")


def import_models(source: Path, target: Path, nano=False) -> None:
    source, target = source.expanduser().resolve(), target.expanduser().resolve()
    names = (NANO_NAME,) if nano else MODEL_NAMES
    required = NANO_REQUIRED_FILES if nano else ("model.pt", "configuration.json")
    for name in names:
        directory = source / name
        if not all((directory / item).is_file() and (directory / item).stat().st_size
                   for item in required):
            raise ValueError(f"Incomplete cached model: {name}. Supply its complete local parent directory.")
        if (target / name).exists():
            raise ValueError(f"Model already exists: {name}. Existing models are never overwritten.")
    target.mkdir(parents=True, exist_ok=True)
    # Copy the complete set before publishing any directory. Failed copies stay
    # out of the live paths; TemporaryDirectory removes the staging data.
    with tempfile.TemporaryDirectory(prefix=".import-", dir=target) as staging:
        for name in names:
            shutil.copytree(source / name, Path(staging) / name)
        for name in names:
            (Path(staging) / name).rename(target / name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--nano", action="store_true", help="Add Nano from its local parent directory")
    args = parser.parse_args()
    try:
        import_models(args.source, args.target, nano=args.nano)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Model import failed: {error}\n")
    print(f"Imported {'Nano' if args.nano else 'SenseVoiceSmall and FSMN VAD'} from the local cache. No downloads.")


if __name__ == "__main__":
    main()
