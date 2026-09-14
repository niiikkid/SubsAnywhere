import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "local-server"))
import resource_budget as resources


class ConfigureResourcesTests(unittest.TestCase):
    def script(self):
        path = ROOT / "scripts/configure-resources.py"
        self.assertTrue(path.is_file(), "resource configuration script is missing")
        spec = importlib.util.spec_from_file_location("configure_resources", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_dry_run_outputs_one_third_host_capped_by_docker_without_writing(self):
        script = self.script()
        host = resources.ResourceCapacity(14, 24 * 1024**3)
        docker = resources.ResourceCapacity(8, 6 * 1024**3)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "budget.yaml"
            stdout = io.StringIO()
            with patch.object(script, "detect_host_resources", return_value=host), \
                 patch.object(script, "detect_effective_resources", return_value=host), \
                 patch.object(script, "detect_docker_resources", return_value=docker), \
                 contextlib.redirect_stdout(stdout):
                result = script.main(["--dry-run", "--output", str(target)])
            self.assertEqual(result, 0)
            self.assertFalse(target.exists())
            output = stdout.getvalue()
            self.assertIn("services:\n  subtitles:\n", output)
            self.assertIn('cpus: "4.666666"', output)
            self.assertIn(f"mem_limit: {6 * 1024**3}", output)
            self.assertIn(f"memswap_limit: {6 * 1024**3}", output)
            self.assertIn('SUBSANYWHERE_RESOURCE_FRACTION: "1"', output)
            self.assertIn('OMP_NUM_THREADS: "4"', output)

    def test_probe_reads_only_local_docker_context_and_info_with_timeout(self):
        script = self.script()
        import json
        answers = [subprocess.CompletedProcess([], 0, json.dumps("unix:///var/run/docker.sock")),
                   subprocess.CompletedProcess([], 0, json.dumps({"NCPU": 8, "MemTotal": 6 * 1024**3, "OSType": "linux"}))]
        with patch.dict("os.environ", {}, clear=True), \
             patch("subprocess.run", side_effect=answers) as run:
            capacity = script.detect_docker_resources()
        self.assertEqual(capacity, resources.ResourceCapacity(8, 6 * 1024**3))
        self.assertEqual([call.args[0][1] for call in run.call_args_list], ["context", "info"])
        self.assertTrue(all(call.kwargs["timeout"] <= 5 for call in run.call_args_list))
        with patch.dict("os.environ", {"DOCKER_HOST": "tcp://remote:2375"}, clear=True), \
             patch("subprocess.run") as run:
            with self.assertRaisesRegex(ValueError, "local Docker"):
                script.detect_docker_resources()
        run.assert_not_called()
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("docker", 5)):
            with patch.dict("os.environ", {}, clear=True), patch("subprocess.run", side_effect=error), \
                 contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertIsNone(script.detect_docker_resources())
            self.assertIn("not detected", stderr.getvalue())

    def test_writes_override_with_requested_percent_and_preserves_dry_run_target(self):
        script = self.script()
        host = resources.ResourceCapacity(14, 24 * 1024**3)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "budget.yaml"
            stdout = io.StringIO()
            with patch.object(script, "detect_host_resources", return_value=host), \
                 patch.object(script, "detect_effective_resources", return_value=host), \
                 patch.object(script, "detect_docker_resources", return_value=None), \
                 contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(script.main(["--percent", "25", "--output", str(target)]), 0)
                self.assertTrue(target.exists(), "non-dry-run must write the override")
                self.assertEqual(target.read_text(), stdout.getvalue())
                self.assertIn('cpus: "3.500000"', target.read_text())
                self.assertIn(f"mem_limit: {6 * 1024**3}", target.read_text())
                target.write_text("existing content")
                self.assertEqual(script.main(["--dry-run", "--output", str(target)]), 0)
                self.assertEqual(target.read_text(), "existing content")
                self.assertEqual(list(Path(temporary).iterdir()), [target])

    def test_invalid_percent_fails_before_detection_without_changing_file(self):
        script = self.script()
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "budget.yaml"
            target.write_text("keep")
            for percent in ("0", "-1", "101", "nan", "inf", "bad"):
                with self.subTest(percent=percent), patch.object(script, "detect_host_resources") as detect, \
                     contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as failure:
                    script.main(["--percent", percent, "--output", str(target)])
                self.assertEqual(failure.exception.code, 2)
                detect.assert_not_called()
                self.assertEqual(target.read_text(), "keep")

    def test_detection_failure_and_unusable_docker_budget_do_not_write(self):
        script = self.script()
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "budget.yaml"
            target.write_text("keep")
            with patch.object(script, "detect_host_resources", side_effect=resources.ResourceDetectionError("no memory")), \
                 contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(script.main(["--output", str(target)]), 1)
            self.assertIn("no memory", stderr.getvalue())
            self.assertEqual(target.read_text(), "keep")
        for capacity in (resources.ResourceCapacity(0.001, 8 * 1024**3), resources.ResourceCapacity(2, 1024)):
            with self.subTest(capacity=capacity), self.assertRaisesRegex(ValueError, "Docker"):
                script.render_override(resources.compute_budget(capacity, 1))

    def test_compose_fallback_disables_swap_and_does_not_divide_budget_twice(self):
        compose = (ROOT / "compose.yaml").read_text()
        self.assertIn('SUBSANYWHERE_RESOURCE_FRACTION: "1"', compose)
        self.assertIn("    mem_limit: 8g\n    memswap_limit: 8g\n    cpus: 4", compose)
        script = self.script()
        ignored = subprocess.run(["git", "check-ignore", str(script.DEFAULT_OUTPUT)],
                                 cwd=ROOT, capture_output=True, text=True, timeout=5)
        self.assertEqual(ignored.returncode, 0, "generated host override must be gitignored")


if __name__ == "__main__":
    unittest.main()
