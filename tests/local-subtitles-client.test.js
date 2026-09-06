import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalSubtitleClient,
  localSubtitleTrack,
  youtubeVideoId,
} from '../local-subtitles-client.js';

test('youtubeVideoId accepts supported YouTube pages and rejects other URLs', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=rwnyaH6cTDE&t=3'), 'rwnyaH6cTDE');
  assert.equal(youtubeVideoId('https://youtu.be/rwnyaH6cTDE'), 'rwnyaH6cTDE');
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/rwnyaH6cTDE'), 'rwnyaH6cTDE');
  assert.equal(youtubeVideoId('https://example.com/watch?v=rwnyaH6cTDE'), '');
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=bad/id'), '');
});

test('localSubtitleTrack uses deterministic English-only metadata', () => {
  const track = localSubtitleTrack('rwnyaH6cTDE', 'generated', [
    { start: 1, end: 2, text: '你好' },
  ]);

  assert.deepEqual(track, {
    id: 'youtube-rwnyaH6cTDE-generated',
    name: 'YouTube rwnyaH6cTDE generated Chinese',
    language: 'zh',
    cues: [{ start: 1, end: 2, text: '你好' }],
    offsetSeconds: 0,
    timeScale: 1,
    sourceType: 'local-server',
  });
});

test('LocalSubtitleClient sends only validated video ids to the fixed local server', async () => {
  const calls = [];
  const client = new LocalSubtitleClient(async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() { return { status: 'ready', source: 'youtube', srt: '1\n00:00:00,000 --> 00:00:01,000\n你好\n' }; },
    };
  });

  const result = await client.existing('rwnyaH6cTDE');

  assert.equal(result.status, 'ready');
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:43817\/api\/subtitles\/existing\?video_id=rwnyaH6cTDE$/);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers['X-SubsAnywhere-Client'], 'extension-v1');
  await assert.rejects(() => client.generate('../escape'), /YouTube video ID/i);
});
