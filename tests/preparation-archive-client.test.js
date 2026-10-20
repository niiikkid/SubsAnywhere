import test from 'node:test';
import assert from 'node:assert/strict';
import { PreparationArchiveClient, LocalSubtitleClient } from '../local-subtitles-client.js';

const id = 'a'.repeat(64);

test('archive writes are confirmed by reading the exact saved target', async () => {
  const calls = [];
  const job = { id, status: 'ready', results: { cue: { items: [{ dictionary: 'Тест' }] } } };
  const client = new PreparationArchiveClient(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: options.method === 'PUT' ? 'saved' : 'ready', job }) };
  });
  assert.deepEqual(await client.save(job), job);
  assert.deepEqual(calls.map((call) => call.options.method), ['PUT', 'GET']);
  assert.equal(calls[0].url, `http://127.0.0.1:43817/api/preparations/${id}`);
  assert.equal(calls[1].url, calls[0].url);
  assert.equal(calls[0].options.headers['X-SubsAnywhere-Client'], 'extension-v1');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].options.body), job);
  await assert.rejects(() => client.get('../escape'), /идентификатор/);
});

test('an acknowledged archive write is not enough when readback is missing', async () => {
  const client = new PreparationArchiveClient(async (_url, options) => ({ ok: true,
    json: async () => options.method === 'PUT' ? { status: 'saved', job: { id } } : { status: 'missing' },
  }));
  await assert.rejects(() => client.save({ id, status: 'ready', results: {} }), /подтвердить/);
});

test('page subtitles are archived through a bounded local JSON request without provider credentials', async () => {
  let captured;
  const client = new LocalSubtitleClient(async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ status: 'saved' }) };
  });
  await client.cachePageCaptions('GgXaTa4k_QU', 'zh', '1\n00:00:01,000 --> 00:00:02,000\n你好\n');
  assert.equal(captured.url, 'http://127.0.0.1:43817/api/subtitles/cache');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.equal(captured.options.signal instanceof AbortSignal, true);
  assert.equal(JSON.parse(captured.options.body).source, 'page');
  assert.equal(JSON.parse(captured.options.body).videoId, 'GgXaTa4k_QU');
});
