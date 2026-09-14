import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatGenerationProgress,
  LocalSubtitleClient,
  localSubtitleTrack,
  youtubeVideoId,
} from '../local-subtitles-client.js';

test('formatGenerationProgress reports exact work and a useful ETA', () => {
  assert.deepEqual(formatGenerationProgress({
    status: 'running',
    stage: 'recognizing',
    progress: 42,
    completed_segments: 21,
    total_segments: 50,
    eta_seconds: 125,
  }), {
    visible: true,
    value: 42,
    label: 'Распознаю речь: 21 из 50 сегментов.',
    detail: '42% · осталось примерно 3 мин',
  });
  assert.equal(formatGenerationProgress({ status: 'running', stage: 'downloading' }).label, 'Скачиваю аудио…');
  assert.equal(formatGenerationProgress({ status: 'ready' }).visible, false);
});

test('streamed recognition reports work even without a total segment count', () => {
  const progress = formatGenerationProgress({ status: 'running', stage: 'recognizing',
    progress: 20, completed_segments: 2, total_segments: 0, eta_seconds: 120 });
  assert.equal(progress.label, 'Распознаю речь…');
  assert.equal(progress.detail, '20% · осталось примерно 2 мин');
  assert.equal(formatGenerationProgress({ status: 'running', stage: 'recognizing', progress: 0 }).label,
    'Определяю объём речи…');
});

test('youtubeVideoId accepts supported YouTube pages and rejects other URLs', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=rwnyaH6cTDE&t=3'), 'rwnyaH6cTDE');
  assert.equal(youtubeVideoId('https://youtu.be/rwnyaH6cTDE'), 'rwnyaH6cTDE');
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/rwnyaH6cTDE'), 'rwnyaH6cTDE');
  assert.equal(youtubeVideoId('https://example.com/watch?v=rwnyaH6cTDE'), '');
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=bad/id'), '');
});

test('localSubtitleTrack keeps a stable ID and a readable Chinese name', () => {
  const track = localSubtitleTrack('rwnyaH6cTDE', 'generated', [
    { start: 1, end: 2, text: '你好' },
  ]);

  assert.deepEqual(track, {
    id: 'youtube-rwnyaH6cTDE-generated',
    name: 'Китайские с пиньинем — распознаны локально',
    language: 'zh',
    cues: [{ start: 1, end: 2, text: '你好' }],
    offsetSeconds: 0,
    timeScale: 1,
    sourceType: 'local-server',
  });
});

test('localSubtitleTrack uses the original language and readable names', () => {
  const cues = [{ start: 0, end: 1, text: 'May I ask about AI?' }];
  const track = localSubtitleTrack('1evO3Nekrr8', 'youtube', cues, 'en');
  assert.equal(track.language, 'en');
  assert.equal(track.name, 'Английские — YouTube');
  assert.equal(track.id, 'youtube-1evO3Nekrr8-youtube');
  assert.deepEqual(track.cues, cues);
  assert.equal(localSubtitleTrack('1evO3Nekrr8', 'youtube', cues).language, 'en');
  assert.equal(localSubtitleTrack('0Zaxca2sUGs', 'youtube', [{ start: 0, end: 1, text: '你好' }], 'zh').name,
    'Китайские с пиньинем — YouTube');
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

test('generation forwards supported languages and defaults blank to Chinese', async () => {
  const calls = [];
  const client = new LocalSubtitleClient(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: 'running' }) };
  });
  for (const language of ['en', 'zh', '', undefined]) {
    await client.generate('0Zaxca2sUGs', language);
    assert.equal(new URL(calls.at(-1).url).searchParams.get('language'), language || 'zh');
    assert.equal(calls.at(-1).options.method, 'POST');
  }
  for (const invalid of ['fr', 'EN', 'en&other=value', null]) {
    await assert.rejects(async () => client.generate('0Zaxca2sUGs', invalid), /язык/i);
  }
  assert.equal(calls.length, 4);
  await client.status('0Zaxca2sUGs');
  assert.equal(new URL(calls.at(-1).url).searchParams.has('language'), false);
});

test('local requests reject malformed success payloads rather than silently stopping polling', async () => {
  const client = new LocalSubtitleClient(async () => ({ ok: true, json: async () => ({ status: 'unknown' }) }));
  await assert.rejects(() => client.status('rwnyaH6cTDE'), /неверный ответ/);
});

test('local requests carry bounded abort signals and never follow redirects', async () => {
  let captured;
  const client = new LocalSubtitleClient(async (_url, options) => {
    captured = options;
    return { ok: true, json: async () => ({ status: 'missing' }) };
  });
  await client.status('rwnyaH6cTDE');
  assert.ok(captured.signal instanceof AbortSignal);
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.credentials, 'omit');
  assert.equal(captured.cache, 'no-store');
});

test('server restart and resource failures explain recovery in Russian', async () => {
  const client = new LocalSubtitleClient(async () => ({
    ok: true,
    json: async () => ({ status: 'error', error_code: 'interrupted', error: 'Generation interrupted by server restart; retry.' }),
  }));
  await assert.rejects(() => client.status('rwnyaH6cTDE'), /Сервер перезапущен.*запустите.*заново/i);
});

test('memory-limit errors explain model and limit recovery without losing saved subtitles', async () => {
  const client = new LocalSubtitleClient(async () => ({
    ok: true,
    json: async () => ({ status: 'error', error_code: 'resource_limit', error: 'Memory limit exceeded' }),
  }));
  await assert.rejects(() => client.status('rwnyaH6cTDE'), /меньшую модель.*увеличьте лимит.*Прежние.*сохранены/);
});
