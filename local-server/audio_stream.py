"""Bounded mono PCM decoding: do not load a multi-hour recording into RAM."""

import array
import subprocess
import sys

SAMPLE_RATE = 16_000


def pcm_chunks(stream, sample_rate=SAMPLE_RATE, seconds=60):
    """Yield contiguous (offset_ms, int16 samples), cutting near quiet pauses.

    A hard boundary is still necessary for continuous speech. No samples are
    skipped or duplicated and no subtitle times are guessed from text length.
    """
    capacity = int(sample_rate * seconds)
    if sample_rate <= 0 or capacity < 1:
        raise ValueError('Invalid PCM chunk size')
    pending = bytearray()
    consumed = 0
    eof = False
    while True:
        while len(pending) < capacity * 2 and not eof:
            block = stream.read(capacity * 2 - len(pending))
            if not block:
                eof = True
            else:
                pending.extend(block)
        if not pending:
            return
        if len(pending) % 2:
            raise ValueError('Truncated PCM sample')
        samples = array.array('h')
        samples.frombytes(pending)
        if sys.byteorder != 'little':
            samples.byteswap()
        boundary = len(samples)
        # Prefer a real quiet 100 ms window in the final 10 seconds. Without
        # one, retain the full chunk instead of selecting a loud word boundary.
        if len(samples) == capacity:
            window = max(1, sample_rate // 10)
            first = max(window, capacity - min(10 * sample_rate, capacity // 4))
            for position in range(capacity - window, first - 1, -window):
                if max(abs(value) for value in samples[position:position + window]) < 200:
                    boundary = position + window // 2
                    break
        yield round(consumed * 1000 / sample_rate), samples[:boundary]
        consumed += boundary
        del pending[:boundary * 2]


def audio_chunks(path):
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', str(path),
               '-vn', '-ac', '1', '-ar', str(SAMPLE_RATE), '-threads', '1',
               '-f', 's16le', 'pipe:1']
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL)
    assert process.stdout is not None
    try:
        yield from pcm_chunks(process.stdout)
        if process.wait(timeout=30):
            raise RuntimeError('Audio decoding failed')
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def audio_duration_ms(path):
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=noprint_wrappers=1:nokey=1', str(path)],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15, check=True,
    )
    duration = float(result.stdout.strip())
    if not 0 < duration < float('inf'):
        raise ValueError('Invalid audio duration')
    return round(duration * 1000)
