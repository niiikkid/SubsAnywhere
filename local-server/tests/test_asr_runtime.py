import os
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import asr_runtime


class RuntimeTests(unittest.TestCase):
    def test_memory_guard_stops_before_configured_total_ceiling(self):
        calls = []
        guard = asr_runtime.MemoryGuard(1000, usage=lambda: 901, terminate=calls.append)
        guard.check()
        self.assertEqual(calls, [asr_runtime.RESOURCE_EXIT_CODE])
        calls.clear()
        guard = asr_runtime.MemoryGuard(1000, usage=lambda: 700, terminate=calls.append)
        guard.check()
        self.assertEqual(calls, [])

    def test_thread_settings_replace_inherited_unbounded_values(self):
        with patch.dict(os.environ, {'OMP_NUM_THREADS': '32'}, clear=False):
            asr_runtime.configure_threads(2)
            for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
                         'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
                self.assertEqual(os.environ[name], '2')

    def test_invalid_budget_is_rejected(self):
        for value in (0, -1):
            with self.assertRaises(ValueError):
                asr_runtime.MemoryGuard(value)
            with self.assertRaises(ValueError):
                asr_runtime.configure_threads(value)


if __name__ == '__main__':
    unittest.main()
