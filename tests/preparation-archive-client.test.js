import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSubtitleClient } from '../local-subtitles-client.js';

test('page subtitles are cached through a bounded local JSON request without provider credentials', async () => {
  let captured;
  const client = new LocalSubtitleClient(async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ status: 'saved' }) };
  });
  await client.cachePageCaptions('GgXaTa4k_QU', 'zh', '1\n00:00:01,000 --> 00:00:02,000\n你好\n');
  assert.equal(captured.url, 'http://127.0.0.1:43817/api/subtitles/cache');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.equal(captured.options.headers['X-SubsAnywhere-Client'], 'extension-v1');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.credentials, 'omit');
  assert.equal(captured.options.cache, 'no-store');
  assert.equal(captured.options.headers.Authorization, undefined);
  assert.equal(captured.options.signal instanceof AbortSignal, true);
  assert.equal(JSON.parse(captured.options.body).source, 'page');
  assert.equal(JSON.parse(captured.options.body).videoId, 'GgXaTa4k_QU');
});

test('page subtitle cache accepts the server ready response and preserves exact SRT', async () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n';
  const ready = { status: 'ready', source: 'page', language: 'zh', srt };
  const client = new LocalSubtitleClient(async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { videoId: 'GgXaTa4k_QU', language: 'zh', srt, source: 'page' });
    return { ok: true, json: async () => ready };
  });
  assert.deepEqual(await client.cachePageCaptions('GgXaTa4k_QU', 'zh', srt), ready);
});

test('page subtitle cache rejects an invalid video ID without making a request', async () => {
  let calls = 0;
  const client = new LocalSubtitleClient(async () => { calls += 1; });
  await assert.rejects(() => client.cachePageCaptions('../escape', 'en', 'fixture'), /video ID/);
  assert.equal(calls, 0);
});

test('page subtitle cache surfaces transport, JSON, HTTP and acknowledgement failures', async () => {
  const cases = [
    [async () => { throw new Error('offline'); }, /связаться с сервером субтитров/],
    [async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }), /неверный ответ/],
    [async () => ({ ok: false, json: async () => ({ error: 'fixture' }) }), /сохранить субтитры/],
    [async () => ({ ok: true, json: async () => ({ status: 'missing' }) }), /не подтвердил/],
  ];
  for (const [fetchImpl, message] of cases) {
    const client = new LocalSubtitleClient(fetchImpl);
    await assert.rejects(() => client.cachePageCaptions('GgXaTa4k_QU', 'en', 'fixture'), message);
  }
});
