import json
import hashlib
import http.client
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server
from caption_fixtures import metadata_response, missing_captions, mark_cache

VIDEO = "rwnyaH6cTDE"
VALID_SRT = "1\n00:00:00,000 --> 00:00:01,000\nCaptions\n"


class ReliabilityTests(unittest.TestCase):
    def test_directory_cleanup_failure_still_releases_job_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            pending = []
            service = server.SubtitleService(pathlib.Path(directory), start_background=pending.append,
                                             run_command=mock.Mock(side_effect=RuntimeError("failure")))
            service.generate(VIDEO)
            with mock.patch.object(pathlib.Path, "glob", side_effect=OSError("secret path")):
                pending.pop()()
            self.assertEqual(service.active_jobs, set())
            self.assertEqual(service.generate("abcdefghijk")["status"], "running")

    def test_managed_download_stops_when_working_files_exceed_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            target = root / "oversized.part"
            service = server.SubtitleService(root)
            script = "import pathlib,sys,time; pathlib.Path(sys.argv[-1]).write_bytes(b'x'*256); time.sleep(30)"
            with mock.patch.object(server, "MAX_AUDIO_BYTES", 64):
                with self.assertRaises(server.ServiceError) as caught:
                    service.run_command([sys.executable, "-c", script, "-o", str(target)], timeout=2)
            self.assertEqual(caught.exception.code, "too_large")
            self.assertEqual(service.processes, set())

    def test_reader_enrichment_cannot_overwrite_a_new_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = server.output_paths(root, VIDEO)
            paths.directory.mkdir(parents=True)
            paths.audio.write_bytes(b"cached")
            old_srt = VALID_SRT.replace("Captions", "旧字幕")
            paths.generated_srt.write_text(old_srt)
            entered, release, converted = threading.Event(), threading.Event(), threading.Event()
            new_srt = VALID_SRT.replace("Captions", "New captions")
            def enrich(text):
                if text == old_srt:
                    entered.set()
                    self.assertTrue(release.wait(2))
                else:
                    converted.set()
                return text
            def run(command, **kwargs):
                for flag in ("--srt", "--text", "--markdown"):
                    pathlib.Path(command[command.index(flag) + 1]).write_text(new_srt)
                return subprocess.CompletedProcess(command, 0, "", "")
            service = server.SubtitleService(root, run_command=run, pinyinize=enrich, start_background=lambda f: f())
            locks = {}
            service._subtitle_lock = lambda path: locks.setdefault(str(path), threading.Lock())
            reader = threading.Thread(target=lambda: service.generated(VIDEO))
            writer = threading.Thread(target=lambda: service.generate(VIDEO))
            reader.start()
            try:
                self.assertTrue(entered.wait(2))
                writer.start()
                self.assertTrue(converted.wait(2))
                # Ensure the unguarded writer has reached its commit boundary.
                time.sleep(0.05)
            finally:
                release.set()
                reader.join(2)
                writer.join(2)
            self.assertEqual(paths.generated_srt.read_text(), new_srt)

    def test_invalid_transcriber_output_cannot_replace_previous_subtitles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = server.output_paths(root, VIDEO)
            paths.directory.mkdir(parents=True)
            paths.audio.write_bytes(b"cached audio")
            paths.generated_srt.write_text(VALID_SRT)
            def run(command, **kwargs):
                for flag in ("--srt", "--text", "--markdown"):
                    pathlib.Path(command[command.index(flag) + 1]).write_text("not valid subtitles")
                return subprocess.CompletedProcess(command, 0, "", "")
            service = server.SubtitleService(root, run_command=run, start_background=lambda f: f(), pinyinize=lambda text: text)
            self.assertEqual(service.generate(VIDEO)["error_code"], "invalid_output")
            self.assertEqual(paths.generated_srt.read_text(), VALID_SRT)

    def test_atomic_write_failure_removes_its_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "saved.srt"
            path.write_text(VALID_SRT)
            with mock.patch.object(os, "fsync", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    server.SubtitleService._write_text_atomically(path, "replacement")
            self.assertEqual(path.read_text(), VALID_SRT)
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_failed_caption_command_cannot_publish_partial_subtitles(self):
        with tempfile.TemporaryDirectory() as directory:
            def fail(command, **kwargs):
                discovery = metadata_response(command)
                if discovery is not None:
                    return discovery
                target = pathlib.Path(command[command.index("-o") + 1].replace("%(ext)s", "zh-Hans.srt"))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("partial subtitle")
                return subprocess.CompletedProcess(command, 1, "", "secret token=abcd")
            service = server.SubtitleService(pathlib.Path(directory), run_command=fail, pinyinize=lambda text: text)
            with self.assertRaises(server.ServiceError) as caught:
                service.existing(VIDEO)
            self.assertEqual(caught.exception.code, "command_failed")
            self.assertFalse(server.output_paths(service.output_root, VIDEO).youtube_srt.exists())

    def test_terminal_status_cache_is_bounded_and_evicted_status_remains_durable(self):
        with tempfile.TemporaryDirectory() as directory:
            service = server.SubtitleService(pathlib.Path(directory), start_background=lambda f: f(),
                                             run_command=mock.Mock(side_effect=RuntimeError("fail")))
            for index in range(140):
                service.generate(f"{index:011d}")
            self.assertLessEqual(len(service.jobs), 128)
            self.assertEqual(service.generated("00000000000")["status"], "error")

    def test_read_only_cookie_mount_is_copied_privately_and_never_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            cookie = root / "fixture-cookies.txt"
            cookie.write_text("# Netscape HTTP Cookie File\n")
            cookie.chmod(0o400)
            marker = root / "used-path.txt"
            script = ("import pathlib,sys; p=pathlib.Path(sys.argv[-1]); "
                      "pathlib.Path(sys.argv[1]).write_text(str(p)); p.write_text('updated')")
            service = server.SubtitleService(root)
            result = service.run_command([sys.executable, "-c", script, str(marker), "--cookies", str(cookie)], timeout=2)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(cookie.read_text(), "# Netscape HTTP Cookie File\n")
            used = pathlib.Path(marker.read_text())
            self.assertNotEqual(used, cookie)
            self.assertFalse(used.exists())

    def test_instant_existing_job_ready_response_contains_srt(self):
        with tempfile.TemporaryDirectory() as directory:
            service = server.SubtitleService(pathlib.Path(directory), start_background=lambda f: f(), pinyinize=lambda text: text,
                                             run_command=mock.Mock(side_effect=AssertionError("unexpected cache miss")))
            paths = server.output_paths(service.output_root, VIDEO)
            paths.directory.mkdir(parents=True)
            paths.youtube_srt.write_text("captions")
            mark_cache(paths.youtube_srt)
            self.assertEqual(service.existing_job(VIDEO)["srt"], "captions")

    def test_oversized_srt_is_rejected_before_read_or_conversion(self):
        with tempfile.TemporaryDirectory() as directory:
            service = server.SubtitleService(pathlib.Path(directory), pinyinize=mock.Mock())
            path = server.output_paths(service.output_root, VIDEO).generated_srt
            path.parent.mkdir(parents=True)
            with path.open("wb") as output:
                output.truncate(5 * 1024 * 1024 + 1)
            with self.assertRaises(server.ServiceError) as caught:
                service.generated(VIDEO)
            self.assertEqual(caught.exception.code, "too_large")
            service.pinyinize.assert_not_called()

    def test_failed_download_is_never_cached_as_a_valid_audio_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            def fail(command, **kwargs):
                if "-o" in command:
                    target = pathlib.Path(command[command.index("-o") + 1].replace("%(ext)s", command[command.index("--audio-format") + 1]))
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(b"partial")
                return subprocess.CompletedProcess(command, 1, "", "secret")
            service = server.SubtitleService(root, run_command=fail, start_background=lambda f: f())
            self.assertEqual(service.generate(VIDEO)["status"], "error")
            self.assertFalse(server.output_paths(root, VIDEO).audio.exists())
            self.assertFalse(server.output_paths(root, VIDEO).lossless_audio.exists())

    def test_existing_async_polls_deduplicate_and_do_not_block_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            pending = []
            run = mock.Mock(side_effect=missing_captions)
            service = server.SubtitleService(pathlib.Path(directory), run_command=run, start_background=pending.append)
            self.assertEqual(service.existing_job(VIDEO)["status"], "running")
            self.assertEqual(service.existing_job(VIDEO)["status"], "running")
            self.assertEqual(len(pending), 1)
            with self.assertRaises(server.ServiceError):
                service.existing_job("abcdefghijk")
            self.assertEqual(service.generate("abcdefghijk")["status"], "running")
            pending.pop(0)()
            self.assertEqual(service.existing_job(VIDEO)["status"], "missing")
            self.assertEqual(service.existing_job(VIDEO)["status"], "missing")
            self.assertEqual(run.call_count, 1)

    def test_failed_status_write_and_cleanup_cannot_leave_a_running_job(self):
        with tempfile.TemporaryDirectory() as directory:
            service = server.SubtitleService(pathlib.Path(directory),
                run_command=mock.Mock(side_effect=RuntimeError("secret")), start_background=lambda f: f())
            write = service._write_text_atomically
            count = 0
            def disk_full(path, text):
                nonlocal count
                count += 1
                if count > 1:
                    raise OSError("disk full /private/key")
                write(path, text)
            with mock.patch.object(service, "_write_text_atomically", side_effect=disk_full):
                result = service.generate(VIDEO)
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["error_code"], "storage_error")
            self.assertEqual(service.active_jobs, set())
            self.assertNotIn("/private", json.dumps(result))

    def test_progress_file_cannot_override_status_source_or_inject_details(self):
        with tempfile.TemporaryDirectory() as directory:
            service = server.SubtitleService(pathlib.Path(directory), start_background=lambda f: None)
            service.generate(VIDEO)
            path = server.progress_path(server.output_paths(service.output_root, VIDEO))
            path.write_text(json.dumps({"status": "ready", "source": "secret", "srt": "secret",
                "error": "/private/key", "stage": "secret", "progress": 10000, "eta_seconds": -1}))
            result = service.generated(VIDEO)
            self.assertEqual(result["status"], "running")
            self.assertEqual(result["source"], "generated")
            self.assertNotIn("secret", json.dumps(result))
            self.assertLessEqual(result["progress"], 100)

    def test_cancel_preserves_published_ready_job_before_worker_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = server.output_paths(root, VIDEO)
            paths.directory.mkdir(parents=True)
            paths.audio.write_bytes(b"cached audio")
            published, release = threading.Event(), threading.Event()

            def run(command, **kwargs):
                for flag in ("--srt", "--text", "--markdown"):
                    pathlib.Path(command[command.index(flag) + 1]).write_text(VALID_SRT)
                return subprocess.CompletedProcess(command, 0, "", "")

            service = server.SubtitleService(root, run_command=run, pinyinize=lambda text: text, max_jobs=1)
            remove = service._remove_work_file

            def pause_cleanup(path):
                if path == server.progress_path(paths):
                    # Publication has released both locks, but still owns admission.
                    published.set()
                    self.assertTrue(release.wait(5), "worker cleanup was not released")
                remove(path)

            with mock.patch.object(service, "_remove_work_file", side_effect=pause_cleanup):
                try:
                    service.generate(VIDEO)
                    self.assertTrue(published.wait(2), "worker did not reach published cleanup")
                    ready = service.generated(VIDEO)
                    self.assertEqual(ready["status"], "ready")
                    self.assertEqual(ready["srt"], VALID_SRT)
                    with service.lock:
                        self.assertIn(VIDEO, service.active_jobs)
                        workers = list(service.threads)
                    self.assertFalse(service.slots.acquire(blocking=False))

                    self.assertEqual(service.cancel(VIDEO), ready)
                    self.assertEqual(service.generated(VIDEO), ready)
                    self.assertEqual(json.loads(server.job_path(paths).read_text()),
                                     {"status": "ready", "source": "generated", "language": "zh",
                                      "sha256": hashlib.sha256(VALID_SRT.encode()).hexdigest()})
                    self.assertEqual(server.SubtitleService(root, pinyinize=lambda text: text).generated(VIDEO), ready)
                    with service.lock:
                        self.assertIn(VIDEO, service.active_jobs)
                        self.assertFalse(service.cancel_events[VIDEO].is_set())
                    self.assertFalse(service.slots.acquire(blocking=False))
                finally:
                    release.set()
                    with service.lock:
                        cleanup_workers = list(service.threads)
                    for worker in cleanup_workers:
                        worker.join(2)
                    service.close()

            self.assertTrue(all(not worker.is_alive() for worker in workers))
            self.assertEqual(service.active_jobs, set())
            self.assertEqual(service.cancel_events, {})
            self.assertTrue(service.slots.acquire(blocking=False))
            service.slots.release()
            self.assertEqual(paths.generated_srt.read_text(), VALID_SRT)
            self.assertEqual(server.SubtitleService(root, pinyinize=lambda text: text).generated(VIDEO), ready)

    def test_close_preserves_published_ready_job_before_worker_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = server.output_paths(root, VIDEO)
            paths.directory.mkdir(parents=True)
            paths.audio.write_bytes(b"cached audio")
            published, release, joining = threading.Event(), threading.Event(), threading.Event()
            close_errors = []

            def run(command, **kwargs):
                for flag in ("--srt", "--text", "--markdown"):
                    pathlib.Path(command[command.index(flag) + 1]).write_text(VALID_SRT)
                return subprocess.CompletedProcess(command, 0, "", "")

            service = server.SubtitleService(root, run_command=run, pinyinize=lambda text: text, max_jobs=1)
            remove = service._remove_work_file

            def pause_cleanup(path):
                if path == server.progress_path(paths):
                    # Pause outside the publication locks, before releasing admission.
                    published.set()
                    self.assertTrue(release.wait(5), "worker cleanup was not released")
                remove(path)

            def close():
                try:
                    service.close()
                except BaseException as error:
                    close_errors.append(error)

            with mock.patch.object(service, "_remove_work_file", side_effect=pause_cleanup):
                try:
                    service.generate(VIDEO)
                    self.assertTrue(published.wait(2), "worker did not reach published cleanup")
                    ready = service.generated(VIDEO)
                    self.assertEqual(ready["status"], "ready")
                    self.assertEqual(ready["srt"], VALID_SRT)
                    with service.lock:
                        self.assertIn(VIDEO, service.active_jobs)
                        worker, = service.threads
                    self.assertFalse(service.slots.acquire(blocking=False))
                    join = worker.join

                    def join_worker(timeout=None):
                        # close() has finished its locked status transitions.
                        joining.set()
                        join(timeout)

                    with mock.patch.object(worker, "join", side_effect=join_worker):
                        closer = threading.Thread(target=close)
                        closer.start()
                        try:
                            self.assertTrue(joining.wait(2), "shutdown did not reach worker join")
                            self.assertTrue(service.closing.is_set())
                            self.assertTrue(closer.is_alive())
                            self.assertEqual(service.generated(VIDEO), ready)
                            self.assertEqual(json.loads(server.job_path(paths).read_text()),
                                             {"status": "ready", "source": "generated", "language": "zh",
                                              "sha256": hashlib.sha256(VALID_SRT.encode()).hexdigest()})
                            self.assertEqual(server.SubtitleService(root, pinyinize=lambda text: text).generated(VIDEO), ready)
                            with service.lock:
                                self.assertIn(VIDEO, service.active_jobs)
                                self.assertFalse(service.cancel_events[VIDEO].is_set())
                            self.assertFalse(service.slots.acquire(blocking=False))
                        finally:
                            release.set()
                            closer.join(2)
                            join(2)
                finally:
                    release.set()
                    service.close()

            self.assertFalse(closer.is_alive())
            self.assertFalse(worker.is_alive())
            self.assertEqual(close_errors, [])
            self.assertEqual(service.active_jobs, set())
            self.assertEqual(service.cancel_events, {})
            self.assertTrue(service.slots.acquire(blocking=False))
            service.slots.release()
            self.assertEqual(paths.generated_srt.read_text(), VALID_SRT)
            self.assertEqual(server.SubtitleService(root, pinyinize=lambda text: text).generated(VIDEO), ready)

    def test_cancel_stops_real_child_process_and_keeps_previous_srt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = server.output_paths(root, VIDEO)
            paths.directory.mkdir(parents=True)
            paths.audio.write_bytes(b"audio")
            paths.generated_srt.write_text("previous subtitle")
            worker_script = root / "slow-transcriber.py"
            worker_script.write_text("import time\ntime.sleep(30)\n")
            service = server.SubtitleService(root, asr_python=sys.executable, cookies_from_browser="")
            service.transcriber = worker_script
            self.addCleanup(service.close)
            self.assertEqual(service.generate(VIDEO)["status"], "running")
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                with service.process_lock:
                    processes = list(service.processes)
                if processes:
                    break
                time.sleep(0.01)
            self.assertTrue(processes, "real child must have started")
            result = service.cancel(VIDEO)
            self.assertEqual(result["error_code"], "cancelled")
            service.close()
            self.assertTrue(all(process.poll() is not None for process in processes))
            self.assertEqual(paths.generated_srt.read_text(), "previous subtitle")
            self.assertEqual(server.SubtitleService(root).generated(VIDEO)["error_code"], "cancelled")
            with self.assertRaises(server.ServiceError):
                service.generate("abcdefghijk")

    def test_managed_command_timeout_reaps_child_without_capturing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            service = server.SubtitleService(pathlib.Path(directory))
            self.addCleanup(service.close)
            with self.assertRaises(server.ServiceError) as caught:
                service.run_command([sys.executable, "-c", "import time; print('secret'*10000); time.sleep(30)"], timeout=0.1)
            self.assertEqual(caught.exception.code, "timeout")
            self.assertEqual(service.processes, set())

    def test_health_is_live_without_optional_asr_and_never_leaks_paths(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"SUBSANYWHERE_MODELS_DIR": directory}):
            service = server.SubtitleService(pathlib.Path(directory), asr_python="/secret/missing-python")
            health = service.health()
            self.assertEqual(health["ok"], True)
            self.assertEqual((health["service"], health["api_version"]), ("subsanywhere", 1))
            self.assertFalse(health["capabilities"]["asr"])
            for check in ("yt_dlp", "ffmpeg", "pinyin", "asr_python", "asr_dependencies", "models"):
                self.assertIsInstance(health["checks"][check], bool)
            self.assertNotIn("/secret", json.dumps(health))
            self.assertNotIn(directory, json.dumps(health))

    def test_docker_environment_configures_commands_without_host_browser_cookies(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {
            "SUBSANYWHERE_HOST": "0.0.0.0", "SUBSANYWHERE_PORT": "43000",
            "SUBSANYWHERE_OUTPUT_DIR": directory, "SUBSANYWHERE_MAX_JOBS": "2",
            "SUBSANYWHERE_ASR_PYTHON": sys.executable, "SUBSANYWHERE_COOKIES_BROWSER": "",
            "SUBSANYWHERE_COOKIES_FILE": "/read-only/cookies.txt",
            "SUBSANYWHERE_YTDLP_JS_RUNTIME": "node",
        }):
            args = server.parse_args([])
            self.assertEqual((args.host, args.port, args.output_dir), ("0.0.0.0", 43000, pathlib.Path(directory)))
            run = mock.Mock(side_effect=missing_captions)
            service = server.SubtitleService(args.output_dir, run_command=run)
            self.assertEqual(service.asr_python, sys.executable)
            self.assertEqual(service.max_jobs, 2)
            self.assertEqual(service.existing(VIDEO)["status"], "missing")
            command = run.call_args.args[0]
            self.assertNotIn("--cookies-from-browser", command)
            self.assertEqual(command[command.index("--cookies") + 1], "/read-only/cookies.txt")
            self.assertEqual(command[command.index("--js-runtimes") + 1], "node")

    def test_existing_requests_share_one_download_and_caption_job_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            entered, release = threading.Event(), threading.Event()
            calls, results, errors = [], [], []

            def run(command, **kwargs):
                discovery = metadata_response(command)
                if discovery is not None:
                    return discovery
                calls.append(command)
                entered.set()
                self.assertTrue(release.wait(2))
                pathlib.Path(command[command.index("-o") + 1].replace("%(ext)s", "zh-Hans.srt")).write_text(VALID_SRT)
                return subprocess.CompletedProcess(command, 0, "", "")

            service = server.SubtitleService(root, run_command=run, pinyinize=lambda text: text)
            def existing():
                try:
                    results.append(service.existing(VIDEO))
                except Exception as error:
                    errors.append(error)
            first, second = threading.Thread(target=existing), threading.Thread(target=existing)
            first.start()
            try:
                self.assertTrue(entered.wait(2))
                second.start()
                with self.assertRaises(server.ServiceError):
                    service.existing("abcdefghijk")
            finally:
                release.set()
                first.join(2)
                second.join(2)
            self.assertEqual(errors, [])
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(results), 2)

    def test_generation_limit_deduplicates_and_releases_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            pending = []
            service = server.SubtitleService(pathlib.Path(directory), max_jobs=1,
                                             start_background=pending.append,
                                             run_command=mock.Mock(side_effect=RuntimeError("fail")))
            self.assertEqual(service.generate(VIDEO)["status"], "running")
            self.assertEqual(service.generate(VIDEO)["status"], "running")
            self.assertEqual(len(pending), 1)
            with self.assertRaises(server.ServiceError) as caught:
                service.generate("abcdefghijk")
            self.assertEqual(caught.exception.code, "busy")
            self.assertEqual(service.generated("abcdefghijk")["status"], "missing")
            pending.pop()()
            self.assertEqual(service.generate("abcdefghijk")["status"], "running")

    def test_worker_failures_are_terminal_redacted_and_preserve_the_old_srt(self):
        failures = [
            (subprocess.TimeoutExpired(["/secret/python", "token=abcd"], 1), "timeout"),
            (FileNotFoundError("/secret/python"), "dependency_missing"),
            (RuntimeError("secret token=abcd"), "generation_failed"),
            (subprocess.CompletedProcess([], 1, "", "secret token=abcd"), "command_failed"),
        ]
        for failure, code in failures:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                paths = server.output_paths(root, VIDEO)
                paths.directory.mkdir(parents=True)
                paths.generated_srt.write_text("previous subtitle")
                run = mock.Mock(**({"side_effect": failure} if isinstance(failure, Exception)
                                   else {"return_value": failure}))
                service = server.SubtitleService(root, run_command=run, start_background=lambda f: f())
                result = service.generate(VIDEO)
                self.assertEqual(result["status"], "error")
                self.assertEqual(result["error_code"], code)
                self.assertNotIn("secret", json.dumps(result))
                self.assertNotIn("abcd", json.dumps(result))
                self.assertEqual(paths.generated_srt.read_text(), "previous subtitle")
                self.assertEqual(server.SubtitleService(root).generated(VIDEO), result)

    def test_start_failure_is_terminal_and_retryable_without_leaking_details(self):
        with tempfile.TemporaryDirectory() as directory:
            service = server.SubtitleService(
                pathlib.Path(directory),
                start_background=mock.Mock(side_effect=RuntimeError("secret /private/key token=abcd")),
            )
            result = service.generate(VIDEO)
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["error_code"], "start_failed")
            self.assertNotIn("secret", json.dumps(result))
            self.assertEqual(server.SubtitleService(pathlib.Path(directory)).generated(VIDEO), result)
            service.start_background = lambda target: None
            self.assertEqual(service.generate(VIDEO)["status"], "running")

    def test_restart_recovers_interrupted_job_and_preserves_previous_subtitle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = server.output_paths(root, VIDEO)
            paths.directory.mkdir(parents=True)
            paths.generated_srt.write_text("previous subtitle", encoding="utf-8")
            service = server.SubtitleService(root, start_background=lambda target: None)
            self.assertEqual(service.generate(VIDEO)["status"], "running")

            restarted = server.SubtitleService(root)
            result = restarted.generated(VIDEO)
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["error_code"], "interrupted")
            self.assertEqual(paths.generated_srt.read_text(), "previous subtitle")
            self.assertEqual(server.SubtitleService(root).generated(VIDEO), result)


if __name__ == "__main__":
    unittest.main()


class HttpSecurityTests(unittest.TestCase):
    def setUp(self):
        self.service = mock.Mock()
        self.service.generated.return_value = {"status": "missing"}
        self.httpd = server.create_server(self.service, "127.0.0.1", 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(2)

    def request(self, path="/api/subtitles/generated?video_id=" + VIDEO, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request(method, path, headers=headers or {}, body=body)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_rejects_rebinding_hosts_and_nonextension_origins_before_actions(self):
        invalid = [
            {"Host": f"attacker.example:{self.port}"},
            {"Host": "127.0.0.1:1"},
            {"Host": f"127.0.0.1.attacker.example:{self.port}"},
            {"Origin": "https://evil.example"}, {"Origin": "null"},
            {"Origin": "chrome-extension://fake"},
            {"Origin": "chrome-extension://" + "a" * 32 + ".evil.example"},
            {"Origin": "chrome-extension://" + "a" * 32 + "/"},
        ]
        for headers in invalid:
            with self.subTest(headers=headers):
                headers["X-SubsAnywhere-Client"] = "extension-v1"
                status, response_headers, body = self.request(headers=headers)
                self.assertEqual(status, 403)
                self.assertNotIn("Access-Control-Allow-Origin", response_headers)
                json.loads(body)
                self.assertEqual(self.request(path="/health", headers=headers)[0], 403)
        self.service.generated.assert_not_called()

    def test_accepts_only_well_formed_extension_preflight_and_cli_api(self):
        origin = "chrome-extension://" + "a" * 32
        for host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}", f"[::1]:{self.port}"):
            self.assertEqual(self.request(headers={"Host": host, "X-SubsAnywhere-Client": "extension-v1"})[0], 200)
        status, headers, _ = self.request(method="OPTIONS", headers={"Origin": origin,
            "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-SubsAnywhere-Client"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertEqual(self.request(headers={"Origin": origin})[0], 403)

    def test_rejects_bodies_ambiguous_query_and_large_requests(self):
        headers = {"X-SubsAnywhere-Client": "extension-v1"}
        self.assertEqual(self.request(method="POST", body="x", headers=headers)[0], 413)
        self.assertEqual(self.request(headers={**headers, "Transfer-Encoding": "chunked"})[0], 400)
        self.assertEqual(self.request(path="/" + "x" * 2050, headers=headers)[0], 414)
        self.assertEqual(self.request(path="/api/subtitles/generated?video_id=" + VIDEO + "&video_id=" + VIDEO,
                                     headers=headers)[0], 400)

    def test_http_errors_never_expose_exception_text(self):
        self.service.generated.side_effect = RuntimeError("token=secret /private/key")
        status, _, body = self.request(headers={"X-SubsAnywhere-Client": "extension-v1"})
        self.assertEqual(status, 500)
        self.assertNotIn(b"secret", body)
        self.assertNotIn(b"/private", body)

    def test_request_threads_are_bounded_with_immediate_overload_response(self):
        httpd = server.create_server(self.service, "127.0.0.1", 0, max_requests=1)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        # Occupy the only handler deterministically, without timing assumptions.
        self.assertTrue(httpd.request_slots.acquire(blocking=False))
        try:
            with socket.create_connection(httpd.server_address, timeout=2) as connection:
                response = connection.recv(4096)
                self.assertIn(b"503 Service Unavailable", response)
        finally:
            httpd.request_slots.release()

    def test_docker_wildcard_bind_accepts_mapped_loopback_port_not_domains(self):
        httpd = server.create_server(self.service, "0.0.0.0", 0)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            for host, expected in (("127.0.0.1:49123", 200), ("localhost:49123", 200),
                                   ("evil.example:49123", 403), ("127.0.0.1:99999", 403)):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=2)
                try:
                    connection.request("GET", "/api/subtitles/generated?video_id=" + VIDEO,
                                       headers={"Host": host, "X-SubsAnywhere-Client": "extension-v1"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                finally:
                    connection.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(2)