"""Synthetic-only regression tests for the offline stdin cookie importer."""

import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / "import_cookies.py"
_spec = importlib.util.spec_from_file_location("cookie_import", SCRIPT)
assert _spec is not None and _spec.loader is not None
cookie_import = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cookie_import)
MAX_BYTES = 5 * 1024 * 1024
COOKIES = (b"# Netscape HTTP Cookie File\n"
           b".example.test\tTRUE\t/\tTRUE\t2147483647\tsession\tsynthetic-cookie-only\n")


class CookieImportTests(unittest.TestCase):
    def run_import(self, data, target):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(target)], input=data,
            capture_output=True, timeout=10,
        )

    def test_imports_stdin_to_owner_only_file_without_changing_host_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "host-export.txt"
            source.write_bytes(COOKIES)
            source.chmod(0o600)
            target = directory / "youtube.txt"
            with source.open("rb") as stream:
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), str(target)], stdin=stream,
                    capture_output=True, timeout=10,
                )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.read_bytes(), COOKIES)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(target.stat().st_uid, os.getuid())
            self.assertEqual(source.read_bytes(), COOKIES)
            self.assertEqual(stat.S_IMODE(source.stat().st_mode), 0o600)
            self.assertNotIn(b"synthetic-cookie-only", result.stdout + result.stderr)
            self.assertNotIn(b"session", result.stdout + result.stderr)

    def test_invalid_netscape_input_preserves_existing_cookies_without_leaking_data(self):
        invalid = (
            b"", b" \n", b"# Netscape HTTP Cookie File\n",
            b'{"session":"synthetic-cookie-only"}',
            COOKIES.replace(b"# Netscape HTTP Cookie File", b"# Invalid header"),
            COOKIES.replace(b"\tTRUE\t/", b"\tMAYBE\t/"),
            COOKIES.replace(b"\tTRUE\t2147483647", b"\tMAYBE\t2147483647"),
            COOKIES.replace(b"2147483647", b"not-a-timestamp"),
            COOKIES.replace(b".example.test", b"example.test"),
            COOKIES.replace(b"\t/\t", b"\tnot-a-path\t"),
            COOKIES.replace(b"\tsession\t", b"\t"),
            COOKIES.replace(b"\tsession\t", b"\textra\tsession\t"),
            COOKIES.replace(b"synthetic-cookie-only", b"synthetic\x00cookie-only"),
            COOKIES.replace(b"synthetic-cookie-only", b"synthetic\xffcookie-only"),
        )
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "youtube.txt"
            for data in invalid:
                with self.subTest(index=invalid.index(data)):
                    target.write_bytes(COOKIES)
                    result = self.run_import(data, target)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(target.read_bytes(), COOKIES)
                    self.assertEqual(result.stdout, b"")
                    self.assertEqual(result.stderr, b"Cookie import failed: expected a UTF-8 Netscape cookie file with valid records.\n")
                    self.assertEqual(list(target.parent.iterdir()), [target])

    def test_input_read_is_bounded_and_oversize_import_preserves_previous_file(self):
        class BoundedStream(io.BytesIO):
            def read(stream, size: int | None = -1):
                assert size is not None
                self.assertGreater(size, 0, "stdin must not be read without a bound")
                self.assertLessEqual(size, MAX_BYTES + 1)
                return super().read(size)

        data = COOKIES + b"#" + b"x" * (MAX_BYTES - len(COOKIES) - 1)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "youtube.txt"
            cookie_import.import_cookies(BoundedStream(data), target)
            self.assertEqual(target.read_bytes(), data)
            with self.assertRaises(ValueError):
                cookie_import.import_cookies(BoundedStream(data + b"x"), target)
            self.assertEqual(target.read_bytes(), data)
            result = self.run_import(data + b"x", target)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b"Cookie import failed: input exceeds the 5 MiB limit.\n")
            self.assertEqual(target.read_bytes(), data)

    def test_explicit_reimport_atomically_replaces_file_for_new_readers(self):
        replacement = COOKIES.replace(b"synthetic-cookie-only", b"synthetic-rotation")
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "youtube.txt"
            target.write_bytes(COOKIES)
            with target.open("rb") as previous_reader:
                result = self.run_import(replacement, target)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(previous_reader.read(), COOKIES)
            self.assertEqual(target.read_bytes(), replacement)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_storage_errors_do_not_print_sensitive_paths_or_tracebacks(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "synthetic-cookie-only" / "youtube.txt"
            result = self.run_import(COOKIES, target)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b"Cookie import failed: cannot read stdin or write the cookie volume; check permissions and free space.\n")

    def test_write_or_publish_failure_cleans_private_staging_and_preserves_previous_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "youtube.txt"
            target.write_bytes(COOKIES)
            for operation in ("fsync", "replace"):
                with self.subTest(operation=operation):
                    def fail(*args):
                        staging = [p for p in target.parent.iterdir() if p != target]
                        self.assertEqual(len(staging), 1)
                        self.assertEqual(stat.S_IMODE(staging[0].stat().st_mode), 0o600)
                        raise OSError("synthetic-private-diagnostic")

                    with mock.patch.object(cookie_import.os, operation, side_effect=fail):
                        with self.assertRaises(OSError):
                            cookie_import.import_cookies(io.BytesIO(COOKIES), target)
                    self.assertEqual(target.read_bytes(), COOKIES)
                    self.assertEqual(list(target.parent.iterdir()), [target])

    def test_accepts_windows_utf8_bom_crlf_httponly_and_session_records(self):
        text = ("# Netscape HTTP Cookie File\r\n"
                "# Exported synthetic fixture\r\n"
                "#HttpOnly_.example.test\tTRUE\t/\tTRUE\t0\tsession\t测试\r\n"
                "example.test\tFALSE\t/\tFALSE\t\tnameless-value\t\r\n\r\n")
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "youtube.txt"
            result = self.run_import(b"\xef\xbb\xbf" + text.encode("utf-8"), target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.read_bytes(), text.replace("\r\n", "\n").encode("utf-8"))

    def test_import_replaces_symlink_without_modifying_its_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "host-export.txt"
            source.write_bytes(COOKIES)
            target = Path(temporary) / "youtube.txt"
            target.symlink_to(source)
            replacement = COOKIES.replace(b"synthetic-cookie-only", b"rotated-synthetic")
            result = self.run_import(replacement, target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(target.is_symlink())
            self.assertEqual(target.read_bytes(), replacement)
            self.assertEqual(source.read_bytes(), COOKIES)


class CookieComposeContractTests(unittest.TestCase):
    def test_default_server_reuses_the_persistent_cookie_volume(self):
        repository = SCRIPT.parents[1]
        compose = (repository / "compose.yaml").read_text()
        self.assertIn("SUBSANYWHERE_COOKIES_FILE: /run/cookies/youtube.txt", compose)
        self.assertIn("cookies:/run/cookies:ro", compose)
        self.assertRegex(compose, r"volumes:\n(?:.*\n)*?  cookies:")

    def test_overlay_uses_offline_stdin_volume_instead_of_host_secret(self):
        repository = SCRIPT.parents[1]
        overlay = (repository / "compose.cookies.yaml").read_text()
        self.assertNotIn("secrets:", overlay)
        self.assertNotIn("SUBSANYWHERE_COOKIES_SOURCE", overlay)
        self.assertIn("SUBSANYWHERE_COOKIES_FILE: /run/cookies/youtube.txt", overlay)
        self.assertIn("cookies:/run/cookies:ro", overlay)
        self.assertIn("cookie-import:", overlay)
        self.assertIn("profiles: [tools]", overlay)
        self.assertIn("network_mode: none", overlay)
        self.assertIn('user: "10001:10001"', overlay)
        self.assertIn("stdin_open: true", overlay)
        self.assertIn("read_only: true", overlay)
        self.assertIn("command: [python, import_cookies.py]", overlay)
        # An empty named volume copies the image mountpoint's ownership. Both
        # import-first and server-first must therefore use the owned directory.
        dockerfile = (repository / "Dockerfile").read_text()
        self.assertRegex(dockerfile, r"mkdir[^\n]* /run/cookies")
        self.assertRegex(dockerfile, r"chown[^\n]*10001:10001[^\n]* /run/cookies")


@unittest.skipUnless(os.environ.get("SUBSANYWHERE_COOKIE_TEST_IMAGE"),
                     "set SUBSANYWHERE_COOKIE_TEST_IMAGE to a locally built image for disposable Docker tests")
class CookieDockerTests(unittest.TestCase):
    def test_stdin_import_is_nonroot_readonly_and_works_in_either_start_order(self):
        # No pulls, browser access, server process, published ports or real data.
        image = os.environ["SUBSANYWHERE_COOKIE_TEST_IMAGE"]
        repository = SCRIPT.parents[1]
        inspected = subprocess.run(["docker", "image", "inspect", image],
                                   check=True, capture_output=True, timeout=30)
        self.assertEqual(json.loads(inspected.stdout)[0]["Config"]["User"], "10001:10001")
        for server_first in (True, False):
            with self.subTest(server_first=server_first), tempfile.TemporaryDirectory() as temporary:
                project = "subsanywhere-cookie-test-" + uuid.uuid4().hex[:12]
                directory = Path(temporary)
                override = directory / "probe.json"
                override.write_text(json.dumps({"services": {
                    "subtitles": {"image": image, "network_mode": "none", "healthcheck": {"disable": True}},
                    # Bind only this public script when testing a cached image.
                    "cookie-import": {"image": image, "volumes": [{"type": "bind", "source": str(SCRIPT),
                        "target": "/app/import_cookies.py", "read_only": True}]},
                }}))
                compose = ["docker", "compose", "-p", project, "-f", str(repository / "compose.yaml"),
                           "-f", str(repository / "compose.cookies.yaml"), "-f", str(override)]

                def run(*args, **kwargs):
                    return subprocess.run([*compose, *args], capture_output=True, timeout=90, **kwargs)

                def server_probe(expected):
                    code = ("import errno,os,stat; from pathlib import Path; "
                            "p=Path('/run/cookies/youtube.txt'); "
                            "assert os.getuid()==10001; "
                            "assert p.parent.stat().st_uid==10001; ")
                    if expected is None:
                        code += "assert not p.exists()"
                    else:
                        code += (f"assert p.read_bytes()=={expected!r}; "
                                 "assert p.stat().st_uid==10001; assert stat.S_IMODE(p.stat().st_mode)==0o600;\n"
                                 "try: p.write_bytes(b'not-allowed')\n"
                                 "except OSError as e: assert e.errno==errno.EROFS\n"
                                 "else: raise AssertionError('server cookie mount must be read-only')")
                    result = run("run", "--rm", "-T", "--no-deps", "--entrypoint", "python", "subtitles", "-c", code)
                    self.assertEqual(result.returncode, 0, result.stderr)

                try:
                    if server_first:
                        server_probe(None)
                    source = directory / "synthetic-source.txt"
                    source.write_bytes(COOKIES)
                    source.chmod(0o600)
                    with source.open("rb") as stream:
                        result = run("run", "--rm", "-T", "cookie-import", stdin=stream)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertNotIn(b"synthetic-cookie-only", result.stdout + result.stderr)
                    self.assertEqual(source.read_bytes(), COOKIES)
                    self.assertEqual(stat.S_IMODE(source.stat().st_mode), 0o600)
                    server_probe(COOKIES)
                    result = run("run", "--rm", "-T", "cookie-import", input=b"invalid-synthetic-cookie-only")
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertNotIn(b"invalid-synthetic-cookie-only", result.stdout + result.stderr)
                    server_probe(COOKIES)
                    rotated = COOKIES.replace(b"synthetic-cookie-only", b"synthetic-rotation")
                    result = run("run", "--rm", "-T", "cookie-import", input=rotated)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    server_probe(rotated)
                finally:
                    result = run("down", "--volumes", "--remove-orphans")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    remaining = subprocess.run(["docker", "volume", "ls", "-q", "--filter",
                                                "label=com.docker.compose.project=" + project],
                                               check=True, capture_output=True, timeout=30)
                    self.assertEqual(remaining.stdout.strip(), b"")


if __name__ == "__main__":
    unittest.main()
