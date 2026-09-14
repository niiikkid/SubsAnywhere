import importlib
import importlib.util
from pathlib import Path
import sys
import unittest

from unittest.mock import patch
import subprocess
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class ResourceBudgetTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec("resource_budget"), "resource_budget API is missing")
        return importlib.import_module("resource_budget")

    def test_default_is_one_third_with_floored_threads(self):
        resources = self.module()
        budget = resources.compute_budget(resources.ResourceCapacity(14, 24 * 1024**3))
        self.assertAlmostEqual(budget.cpu_quota, 14 / 3)
        self.assertEqual(budget.memory_bytes, 8 * 1024**3)
        self.assertEqual(budget.threads, 4)
        self.assertEqual(budget.fraction, 1 / 3)

    def test_fraction_validation_and_sub_cpu_minimum_thread(self):
        resources = self.module()
        for invalid in (0, -1, 1.001, float("nan"), float("inf"), "bad", None, True):
            with self.subTest(fraction=invalid), self.assertRaises(ValueError):
                resources.compute_budget(resources.ResourceCapacity(2, 3 * 1024**3), invalid)
        tiny = resources.compute_budget(resources.ResourceCapacity(1, 3 * 1024**3))
        self.assertEqual(tiny.threads, 1)
        self.assertAlmostEqual(tiny.cpu_quota, 1 / 3)
        full = resources.compute_budget(resources.ResourceCapacity(2.5, 100), 1)
        self.assertEqual((full.cpu_quota, full.memory_bytes, full.threads), (2.5, 100, 2))

    def test_detects_physical_host_capacity_without_asr_dependencies(self):
        resources = self.module()
        self.assertTrue(hasattr(resources, "detect_host_resources"), "host detector is missing")
        with patch.object(resources.os, "cpu_count", return_value=14):
            with patch.object(resources.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, str(24 * 1024**3))):
                self.assertEqual(resources.detect_host_resources(system="Darwin"), resources.ResourceCapacity(14, 24 * 1024**3))
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "meminfo").write_text("MemTotal:       25165824 kB\nMemAvailable: 42 kB\n")
                self.assertEqual(resources.detect_host_resources(system="Linux", proc_root=root), resources.ResourceCapacity(14, 24 * 1024**3))
            import ctypes
            from types import SimpleNamespace
            def memory_status(pointer):
                pointer._obj.ullTotalPhys = 24 * 1024**3
                return 1
            library = SimpleNamespace(GlobalMemoryStatusEx=memory_status)
            with patch.object(ctypes, "WinDLL", return_value=library, create=True):
                self.assertEqual(resources.detect_host_resources(system="Windows"), resources.ResourceCapacity(14, 24 * 1024**3))

    def test_unknown_or_invalid_capacity_fails_explicitly(self):
        resources = self.module()
        self.assertTrue(hasattr(resources, "ResourceDetectionError"), "explicit detection error is missing")
        for cpu, memory in ((None, 100), (0, 100), (float("nan"), 100), (2, 0), (2, -1), (2, None)):
            with self.subTest(cpu=cpu, memory=memory), self.assertRaises(resources.ResourceDetectionError):
                resources.ResourceCapacity(cpu, memory)
        with patch.object(resources.os, "cpu_count", return_value=None), self.assertRaises(resources.ResourceDetectionError):
            resources.detect_host_resources(system="Darwin")
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(resources.ResourceDetectionError):
                resources.detect_host_resources(system="Linux", proc_root=Path(temporary))
        with self.assertRaises(resources.ResourceDetectionError):
            resources.detect_host_resources(system="Unknown")
        with patch.object(resources.subprocess, "run", side_effect=subprocess.TimeoutExpired("sysctl", 5)):
            with self.assertRaises(resources.ResourceDetectionError):
                resources.detect_host_resources(system="Darwin")
        with self.assertRaises(ValueError):
            resources.compute_budget(resources.ResourceCapacity(1, 1), 0.001)

    def test_effective_linux_capacity_caps_by_affinity_and_nested_v2_cgroups(self):
        resources = self.module()
        self.assertTrue(hasattr(resources, "detect_effective_resources"), "effective detector is missing")
        host = resources.ResourceCapacity(14, 24 * 1024**3)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc, cgroup = root / "proc", root / "cgroup"
            (proc / "self").mkdir(parents=True)
            (proc / "self/cgroup").write_text("0::/group/worker\n")
            leaf = cgroup / "group/worker"
            leaf.mkdir(parents=True)
            (leaf / "cpu.max").write_text("max 100000")
            (leaf / "memory.max").write_text("max")
            (leaf / "cpuset.cpus.effective").write_text("0-2,7")
            (leaf.parent / "cpu.max").write_text("250000 100000")
            (leaf.parent / "memory.max").write_text(str(6 * 1024**3))
            with patch.object(resources.os, "sched_getaffinity", return_value={0, 1, 2}, create=True):
                effective = resources.detect_effective_resources(host, system="Linux", proc_root=proc, cgroup_root=cgroup)
            self.assertEqual(effective, resources.ResourceCapacity(2.5, 6 * 1024**3))
            with patch.object(resources.os, "sched_getaffinity", return_value={0}, create=True):
                effective = resources.detect_effective_resources(host, system="Linux", proc_root=proc, cgroup_root=cgroup)
            self.assertEqual(effective.cpu_count, 1)

    def test_effective_v1_custom_mounts_respect_namespace_root_and_ancestors(self):
        resources = self.module()
        host = resources.ResourceCapacity(14, 24 * 1024**3)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc, cgroup, mount = root / "proc", root / "cgroup", root / "custom"
            (proc / "self").mkdir(parents=True)
            (proc / "self/cgroup").write_text("2:cpu,cpuacct:/tenant/worker\n3:memory:/tenant/worker\n")
            (proc / "self/mountinfo").write_text(
                f"29 23 0:26 /tenant {mount} rw - cgroup cgroup rw,cpu,cpuacct,memory\n")
            leaf = mount / "worker"
            leaf.mkdir(parents=True)
            (leaf / "cpu.cfs_quota_us").write_text("-1")
            (leaf / "memory.limit_in_bytes").write_text(str(2**63 - 4096))
            (mount / "cpu.cfs_quota_us").write_text("150000")
            (mount / "cpu.cfs_period_us").write_text("100000")
            (mount / "memory.limit_in_bytes").write_text(str(5 * 1024**3))
            with patch.object(resources.os, "sched_getaffinity", return_value=set(range(14)), create=True):
                effective = resources.detect_effective_resources(host, system="Linux", proc_root=proc, cgroup_root=cgroup)
            self.assertEqual(effective, resources.ResourceCapacity(1.5, 5 * 1024**3))

    def test_host_fraction_is_capped_not_recomputed_from_vm(self):
        resources = self.module()
        budget = resources.compute_budget(resources.ResourceCapacity(14, 24 * 1024**3),
                                          ceiling=resources.ResourceCapacity(2.5, 6 * 1024**3))
        self.assertEqual((budget.cpu_quota, budget.memory_bytes, budget.threads),
                         (2.5, 6 * 1024**3, 2))

    def test_native_default_and_prebudgeted_container_environment(self):
        resources = self.module()
        self.assertTrue(hasattr(resources, "get_resource_budget"), "runtime budget API is missing")
        with patch.object(resources, "detect_effective_resources", return_value=resources.ResourceCapacity(14, 24 * 1024**3)):
            budget = resources.get_resource_budget(environ={})
            self.assertEqual((budget.threads, budget.memory_bytes), (4, 8 * 1024**3))
            self.assertEqual(resources.get_resource_budget(environ={"SUBSANYWHERE_RESOURCE_FRACTION": "0.5"}).threads, 7)
            for value in ("", "bad", "nan", "inf", "0", "-1", "1.1"):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    resources.get_resource_budget(environ={"SUBSANYWHERE_RESOURCE_FRACTION": value})
        with patch.object(resources, "detect_effective_resources", return_value=resources.ResourceCapacity(4.666666, 8 * 1024**3)):
            budget = resources.get_resource_budget(environ={"SUBSANYWHERE_RESOURCE_FRACTION": "1"})
            self.assertEqual((budget.cpu_quota, budget.memory_bytes, budget.threads), (4.666666, 8 * 1024**3, 4))

    def test_malformed_linux_metadata_raises_detection_error_not_index_error(self):
        resources = self.module()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "meminfo").write_text("MemTotal:")
            with self.assertRaises(resources.ResourceDetectionError):
                resources.detect_host_resources(system="Linux", proc_root=root)
            (root / "self").mkdir()
            (root / "self/mountinfo").write_text("invalid - cgroup2")
            with patch.object(resources.os, "sched_getaffinity", return_value={0}, create=True):
                with self.assertRaises(resources.ResourceDetectionError):
                    resources.detect_effective_resources(resources.ResourceCapacity(2, 1024),
                        system="Linux", proc_root=root, cgroup_root=root / "cgroup")


if __name__ == "__main__":
    unittest.main()
