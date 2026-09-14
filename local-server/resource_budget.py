"""Stdlib-only CPU/RAM budgets; calculating a budget does not enforce it."""
from __future__ import annotations

from dataclasses import dataclass
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import ctypes

DEFAULT_FRACTION = 1 / 3


class ResourceDetectionError(RuntimeError):
    """Required CPU or memory information is missing or invalid."""


def detect_host_resources(*, system: str | None = None,
                          proc_root: Path = Path("/proc")) -> ResourceCapacity:
    """Physical resources visible to this OS (inside a VM, that means the VM)."""
    try:
        return _detect_host_resources(system=system, proc_root=proc_root)
    except (OSError, ValueError, IndexError, StopIteration, subprocess.SubprocessError) as error:
        raise ResourceDetectionError("Could not detect host CPU/RAM") from error


def _detect_host_resources(*, system, proc_root):
    system = system or platform.system()
    cpu_count = os.cpu_count()
    if not cpu_count:
        raise ResourceDetectionError("Could not detect logical CPU count")
    if system == "Darwin":
        result = subprocess.run(["/usr/sbin/sysctl", "-n", "hw.memsize"],
                                check=True, capture_output=True, text=True, timeout=5)
        memory = int(result.stdout.strip())
    elif system == "Linux":
        rows = (Path(proc_root) / "meminfo").read_text().splitlines()
        memory = next(int(row.split()[1]) * 1024 for row in rows if row.startswith("MemTotal:"))
    elif system == "Windows":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32)] + [
                (name, ctypes.c_uint64) for name in (
                    "ullTotalPhys", "ullAvailPhys", "ullTotalPageFile", "ullAvailPageFile",
                    "ullTotalVirtual", "ullAvailVirtual", "ullAvailExtendedVirtual")]
        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(status)
        kernel = getattr(ctypes, "WinDLL")("kernel32", use_last_error=True)
        if not kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
            raise OSError("GlobalMemoryStatusEx failed")
        memory = status.ullTotalPhys
    else:
        raise ResourceDetectionError(f"Unsupported resource detection platform: {system}")
    return ResourceCapacity(cpu_count, memory)


@dataclass(frozen=True)
class ResourceCapacity:
    cpu_count: float
    memory_bytes: int

    def __post_init__(self):
        if (isinstance(self.cpu_count, bool) or not isinstance(self.cpu_count, (int, float))
                or not math.isfinite(self.cpu_count) or self.cpu_count <= 0
                or isinstance(self.memory_bytes, bool) or not isinstance(self.memory_bytes, int)
                or self.memory_bytes <= 0):
            raise ResourceDetectionError("CPU count and memory bytes must be finite and positive")


@dataclass(frozen=True)
class ResourceBudget:
    cpu_quota: float
    memory_bytes: int
    threads: int
    fraction: float


def _read_optional(path: Path) -> str:
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        return ""
    except OSError as error:
        raise ResourceDetectionError(f"Cannot read resource limit: {path}") from error


def _cgroup_directories(proc_root: Path, cgroup_root: Path):
    roots = [(cgroup_root, cgroup_root)]
    memberships = []
    for line in _read_optional(proc_root / "self/cgroup").splitlines():
        _, controllers, group = line.split(":", 2)
        if ".." in Path(group).parts:
            continue  # Namespace paths can refer to inaccessible host ancestors.
        memberships.append((set(controllers.split(",")) if controllers else set(), Path(group)))
        mounts = [cgroup_root] if not controllers else [
            cgroup_root / controllers, *(cgroup_root / name for name in controllers.split(","))]
        roots.extend((mount / group.lstrip("/"), mount) for mount in mounts)
    for line in _read_optional(proc_root / "self/mountinfo").splitlines():
        before, after = line.split(" - ", 1)
        fields, fs = before.split(), after.split()
        if fs[0] not in {"cgroup", "cgroup2"}:
            continue
        decode = lambda value: re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), value)
        base, mount = Path(decode(fields[3])), Path(decode(fields[4]))
        roots.append((mount, mount))
        for controllers, group in memberships:
            matches = (not controllers and fs[0] == "cgroup2") or (
                fs[0] == "cgroup" and bool(controllers.intersection(fs[2].split(","))))
            if matches:
                if group.is_relative_to(base):
                    roots.append((mount / group.relative_to(base), mount))
                elif group == Path("/"):
                    roots.append((mount, mount))
    seen = set()
    for leaf, mount in roots:
        for directory in (leaf, *leaf.parents):
            if not directory.is_relative_to(mount):
                break
            if directory not in seen:
                seen.add(directory)
                yield directory


def _cpuset_count(value: str) -> int:
    count = 0
    for item in value.split(","):
        bounds = item.split("-")
        start, end = int(bounds[0]), int(bounds[-1])
        if start < 0 or end < start or len(bounds) > 2:
            raise ValueError("Invalid cpuset range")
        count += end - start + 1
    return count


def detect_effective_resources(host: ResourceCapacity | None = None, *,
                               system: str | None = None,
                               proc_root: Path = Path("/proc"),
                               cgroup_root: Path = Path("/sys/fs/cgroup")) -> ResourceCapacity:
    """Cap visible physical capacity by Linux affinity and readable cgroup limits."""
    system = system or platform.system()
    host = host or detect_host_resources(system=system, proc_root=proc_root)
    cpu, memory = host.cpu_count, host.memory_bytes
    if system != "Linux":
        return host
    affinity = getattr(os, "sched_getaffinity", None)
    if affinity is not None:
        try:
            cpu = min(cpu, len(affinity(0)))
        except OSError as error:
            raise ResourceDetectionError("Cannot read CPU affinity") from error
    try:
        for directory in _cgroup_directories(Path(proc_root), Path(cgroup_root)):
            quota = _read_optional(directory / "cpu.max")
            if quota:
                amount, period = quota.split()
                if amount != "max":
                    cpu = min(cpu, int(amount) / int(period))
            limit = _read_optional(directory / "memory.max")
            if limit and limit != "max":
                memory = min(memory, int(limit))
            old_quota = _read_optional(directory / "cpu.cfs_quota_us")
            if old_quota and int(old_quota) != -1:
                period = _read_optional(directory / "cpu.cfs_period_us")
                cpu = min(cpu, int(old_quota) / int(period))
            old_memory = _read_optional(directory / "memory.limit_in_bytes")
            if old_memory and int(old_memory) != -1:
                memory = min(memory, int(old_memory))
            cpuset = (_read_optional(directory / "cpuset.cpus.effective")
                      or _read_optional(directory / "cpuset.cpus"))
            if cpuset:
                cpu = min(cpu, _cpuset_count(cpuset))
    except (ValueError, IndexError, ZeroDivisionError) as error:
        raise ResourceDetectionError("Malformed Linux cgroup resource limit") from error
    return ResourceCapacity(cpu, memory)


def get_resource_budget(*, environ=None) -> ResourceBudget:
    """Runtime budget. Native default: 1/3 effective CPU/RAM; Compose sets fraction=1.

    Read SUBSANYWHERE_RESOURCE_FRACTION on every call. Invalid configuration raises
    ValueError; unavailable/invalid platform capacity raises ResourceDetectionError.
    This function neither changes thread settings nor installs an OS memory limit.
    """
    environ = os.environ if environ is None else environ
    fraction = float(environ.get("SUBSANYWHERE_RESOURCE_FRACTION", DEFAULT_FRACTION))
    return compute_budget(detect_effective_resources(), fraction)


def compute_budget(capacity: ResourceCapacity, fraction: float = DEFAULT_FRACTION, *,
                   ceiling: ResourceCapacity | None = None) -> ResourceBudget:
    """Allocate a fraction of capacity, flooring threads but never below one."""
    if isinstance(fraction, bool) or not isinstance(fraction, (int, float)) or not 0 < fraction <= 1:
        raise ValueError("Resource fraction must be finite and 0 < fraction <= 1")
    cpu_quota = capacity.cpu_count * fraction
    memory_bytes = math.floor(capacity.memory_bytes * fraction)
    if ceiling is not None:
        cpu_quota = min(cpu_quota, ceiling.cpu_count)
        memory_bytes = min(memory_bytes, ceiling.memory_bytes)
    if memory_bytes < 1 or cpu_quota <= 0:
        raise ValueError("Resource fraction is too small for this capacity")
    return ResourceBudget(cpu_quota, memory_bytes,
                          max(1, math.floor(cpu_quota)), fraction)
