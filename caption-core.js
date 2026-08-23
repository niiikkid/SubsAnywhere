export function parseSrtTimestamp(value) {
  const match = String(value).trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return null;
  const [, hours = '0', minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) return null;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(milliseconds.padEnd(3, '0')) / 1000;
}

export function parseSrt(source) {
  const normalized = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const cues = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [rawStart, rawEnd] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/)[0]);
    const start = parseSrtTimestamp(rawStart);
    const end = parseSrtTimestamp(rawEnd);
    const text = lines.slice(timingIndex + 1).join('\n').trim();
    if (start === null || end === null || end <= start || !text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}
