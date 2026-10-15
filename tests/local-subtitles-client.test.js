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

test('localSubtitleTrack uses the original language and readable names', () => {
  const cues = [{ start: 0, end: 1, text: 'May I ask about AI?' }];
  const track = localSubtitleTrack('1evO3Nekrr8', 'youtube', cues, 'en');
  assert.equal(track.language, 'en');
  assert.equal(track.name, 'Английские — YouTube');
  assert.equal(track.id, 'youtube-1evO3Nekrr8-youtube-en');
  assert.deepEqual(track.cues, cues);
  assert.equal(localSubtitleTrack('1evO3Nekrr8', 'youtube', cues).language, 'en');
  assert.equal(localSubtitleTrack('0Zaxca2sUGs', 'youtube', [{ start: 0, end: 1, text: '你好' }], 'zh').name,
    'Китайские с пиньинем — YouTube');
});

test('localSubtitleTrack keeps English and Chinese tracks for the same video and source distinct', () => {
  for (const source of ['youtube']) {
    const english = localSubtitleTrack('1evO3Nekrr8', source, [{ start: 0, end: 1, text: 'Hello' }], 'en');
    const chinese = localSubtitleTrack('1evO3Nekrr8', source, [{ start: 0, end: 1, text: '你好' }], 'zh');
    const saved = new Map([english, chinese].map((track) => [track.id, track]));
    assert.equal(saved.size, 2);
    assert.equal(saved.get(`youtube-1evO3Nekrr8-${source}-en`), english);
    assert.equal(saved.get(`youtube-1evO3Nekrr8-${source}-zh`), chinese);
    assert.equal(localSubtitleTrack('1evO3Nekrr8', source, english.cues).id, english.id);
    assert.equal(localSubtitleTrack('1evO3Nekrr8', source, chinese.cues).id, chinese.id);
  }
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
  await assert.rejects(() => client.existing('../escape'), /YouTube video ID/i);
});

test('caption language overrides are validated and sent to the server', async () => {
  const urls = [];
  const client = new LocalSubtitleClient(async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ status: 'missing' }) };
  });
  await client.existing('0Zaxca2sUGs', 'zh');
  assert.match(urls[0], /&language=zh$/);
  await assert.rejects(async () => client.existing('0Zaxca2sUGs', 'bad'), /язык/i);
  assert.equal(urls.length, 1);
});

test('local requests reject malformed success payloads rather than silently stopping polling', async () => {
  const client = new LocalSubtitleClient(async () => ({ ok: true, json: async () => ({ status: 'unknown' }) }));
  await assert.rejects(() => client.existing('rwnyaH6cTDE'), /неверный ответ/);
});

test('local requests carry bounded abort signals and never follow redirects', async () => {
  let captured;
  const client = new LocalSubtitleClient(async (_url, options) => {
    captured = options;
    return { ok: true, json: async () => ({ status: 'missing' }) };
  });
  await client.existing('rwnyaH6cTDE');
  assert.ok(captured.signal instanceof AbortSignal);
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.credentials, 'omit');
  assert.equal(captured.cache, 'no-store');
});

test('HTTP errors still reject instead of becoming saved job statuses', async () => {
  const client = new LocalSubtitleClient(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ status: 'error', error_code: 'busy', error: 'Server busy' }),
  }));
  await assert.rejects(() => client.existing('rwnyaH6cTDE'), /Сервер занят/);
});
