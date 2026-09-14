import array
import pathlib
import sys
import unittest
from io import BytesIO

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import audio_stream


class AudioStreamTests(unittest.TestCase):
    def test_chunks_preserve_every_sample_and_choose_quiet_boundary(self):
        # Low sample rate keeps the test small; production uses 16 kHz.
        samples = array.array('h', [1000] * 500 + [0] * 50 + [1000] * 700)
        if sys.byteorder != 'little':
            samples.byteswap()
        chunks = list(audio_stream.pcm_chunks(BytesIO(samples.tobytes()), sample_rate=10, seconds=60))
        self.assertEqual(chunks[0][0], 0)
        self.assertGreaterEqual(len(chunks[0][1]), 500)
        self.assertLessEqual(len(chunks[0][1]), 550)
        joined = [sample for _, data in chunks for sample in data]
        self.assertEqual(joined, [1000] * 500 + [0] * 50 + [1000] * 700)
        consumed = 0
        for offset, data in chunks:
            self.assertEqual(offset, consumed * 100)
            self.assertLessEqual(len(data), 600)
            consumed += len(data)

    def test_truncated_sample_is_rejected_not_silently_dropped(self):
        with self.assertRaisesRegex(ValueError, 'PCM'):
            list(audio_stream.pcm_chunks(BytesIO(b'\x00'), sample_rate=10))

    def test_short_reads_do_not_truncate_audio(self):
        class ShortReader(BytesIO):
            def read(self, size=-1):
                return super().read(min(size, 7))
        samples = array.array('h', range(200))
        chunks = list(audio_stream.pcm_chunks(ShortReader(samples.tobytes()), sample_rate=10, seconds=10))
        self.assertEqual(sum(len(data) for _, data in chunks), 200)


if __name__ == '__main__':
    unittest.main()
