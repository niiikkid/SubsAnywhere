"""Native worker safeguards; Docker/cgroups are required for hard RAM quotas."""

import os
import sys
import threading

RESOURCE_EXIT_CODE = 73


def configure_threads(count):
    if type(count) is not int or count < 1:
        raise ValueError('Invalid ASR thread budget')
    # Apply before importing NumPy/Torch. AutoModel also receives ncpu explicitly.
    for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
                 'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
        os.environ[name] = str(count)
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'


def peak_memory_bytes():
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
                        ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        api = ctypes.WinDLL('psapi', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        api.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        api.GetProcessMemoryInfo.restype = wintypes.BOOL
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if not api.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            raise OSError('Cannot inspect worker memory')
        return int(counters.PeakWorkingSetSize)
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak if sys.platform == 'darwin' else peak * 1024)


class MemoryGuard:
    """Stop at 90% to reserve space for the server/decoder. Not a hard OS limit.

    A sampled watchdog cannot prevent transient allocations or account for all
    other processes. Never describe this fallback as a strict memory ceiling.
    """
    def __init__(self, memory_bytes, usage=peak_memory_bytes, terminate=os._exit):
        if memory_bytes <= 0:
            raise ValueError('Invalid ASR memory budget')
        self.ceiling = int(memory_bytes * 0.9)
        self.usage = usage
        self.terminate = terminate
        self.stopped = threading.Event()
        self.thread = None

    def check(self):
        if self.usage() >= self.ceiling:
            self.terminate(RESOURCE_EXIT_CODE)

    def __enter__(self):
        self.check()  # Fail visibly if resource inspection is unavailable.

        def watch():
            while not self.stopped.wait(0.1):
                try:
                    self.check()
                except OSError:
                    self.terminate(RESOURCE_EXIT_CODE)
        self.thread = threading.Thread(target=watch, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stopped.set()
        if self.thread is not None:
            self.thread.join(timeout=1)
