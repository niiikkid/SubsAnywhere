#!/usr/bin/env python3
"""Import a Netscape cookie export from stdin into the private Docker volume."""

import argparse
import os
from pathlib import Path
import sys
import tempfile

MAX_COOKIE_BYTES = 5 * 1024 * 1024
INVALID_INPUT = "expected a UTF-8 Netscape cookie file with valid records."


class CookieImportError(ValueError):
    """Only fixed, non-sensitive messages belong in this CLI-safe exception."""


def validate_cookies(data: bytes) -> bytes:
    try:
        text = data.decode("utf-8-sig").replace("\r\n", "\n")
    except UnicodeError:
        raise CookieImportError(INVALID_INPUT) from None
    lines = text.split("\n")
    if (not lines or lines[0] not in ("# Netscape HTTP Cookie File", "# HTTP Cookie File")
            or any(ord(char) < 32 and char not in "\n\t" or ord(char) == 127 for char in text)):
        raise CookieImportError(INVALID_INPUT)
    records = 0
    for line in lines[1:]:
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif not line.strip() or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 7:
            raise CookieImportError(INVALID_INPUT)
        domain, subdomains, path, secure, expires, _name, _value = fields
        if (not domain or any(char.isspace() for char in domain)
                or subdomains not in ("TRUE", "FALSE")
                or (subdomains == "TRUE") != domain.startswith(".")
                or not path.startswith("/") or secure not in ("TRUE", "FALSE")
                or (expires and (not expires.isascii() or not expires.isdecimal()))):
            raise CookieImportError(INVALID_INPUT)
        records += 1
    if not records:
        raise CookieImportError(INVALID_INPUT)
    return text.encode("utf-8")


def import_cookies(source, target: Path) -> None:
    data = source.read(MAX_COOKIE_BYTES + 1)
    if len(data) > MAX_COOKIE_BYTES:
        raise CookieImportError("input exceeds the 5 MiB limit.")
    data = validate_cookies(data)
    # Stage on the same filesystem: readers see either complete version. The
    # file is private from creation, even with a permissive process umask.
    fd, name = tempfile.mkstemp(prefix=".cookie-import-", dir=target.parent)
    staging = Path(name)
    try:
        with os.fdopen(fd, "wb") as destination:
            os.fchmod(destination.fileno(), 0o600)
            destination.write(data)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(staging, target)
    finally:
        staging.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", type=Path, default=Path("/run/cookies/youtube.txt"))
    args = parser.parse_args()
    try:
        import_cookies(sys.stdin.buffer, args.target)
    except CookieImportError as error:
        parser.exit(1, f"Cookie import failed: {error}\n")
    except OSError:
        parser.exit(1, "Cookie import failed: cannot read stdin or write the cookie volume; "
                    "check permissions and free space.\n")
    print("Cookies imported. No network requests.")


if __name__ == "__main__":
    main()
