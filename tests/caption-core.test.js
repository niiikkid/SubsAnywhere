import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt } from '../caption-core.js';

test('parseSrt reads comma and dot timestamps with multiline text', () => {
  const cues = parseSrt('\ufeff1\r\n00:00:01,250 --> 00:00:03.500\r\nHello\r\nworld\r\n\r\n2\r\n00:01:02,000 --> 00:01:04,000\r\nSecond');
  assert.deepEqual(cues, [
    { start: 1.25, end: 3.5, text: 'Hello\nworld' },
    { start: 62, end: 64, text: 'Second' },
  ]);
});

test('parseSrt rejects malformed or backwards cues without partial garbage', () => {
  assert.deepEqual(parseSrt('not an srt file'), []);
  assert.deepEqual(parseSrt('1\n00:00:05,000 --> 00:00:02,000\nBackwards'), []);
  assert.deepEqual(parseSrt('1\n00:00:01,000 --> broken\nBad end'), []);
  assert.deepEqual(parseSrt('1\n00:99:01,000 --> 00:99:02,000\nInvalid minutes'), []);
});
