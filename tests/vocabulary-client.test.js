import test from 'node:test';
import assert from 'node:assert/strict';
import { VocabularyClient } from '../vocabulary-client.js';

const entry = { language: 'zh', text: '你好', pinyin: 'nǐ hǎo', translation: 'привет' };
const saved = { ...entry, id: 1, created_at: '2026-01-01T00:00:00Z' };

test('vocabulary saves bounded JSON and verifies the persisted entry by reading it back', async () => {
  const calls = [];
  const client = new VocabularyClient(async (url, options) => {
    calls.push({ url, options });
    return Response.json(options.method === 'POST' ? { word: saved } : { words: [saved] });
  });
  assert.deepEqual(await client.save(entry), { word: saved });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:43817/api/words');
  assert.equal(calls[0].options.headers['X-SubsAnywhere-Client'], 'extension-v1');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), entry);
  assert.equal(calls[1].options.method, 'GET');
});

test('vocabulary never confirms a lost write or malformed response', async () => {
  const missing = new VocabularyClient(async (_url, options) => Response.json(
    options.method === 'POST' ? { word: saved } : { words: [] },
  ));
  await assert.rejects(missing.save(entry), /подтвердить/);
  const invalid = new VocabularyClient(async () => Response.json({ words: [{ ...saved, text: '' }] }));
  await assert.rejects(invalid.list(), /ответ/);
  const offline = new VocabularyClient(async () => { throw new Error('offline'); });
  await assert.rejects(offline.save(entry), /Docker/);
});

test('vocabulary rejects invalid identities before touching the server', async () => {
  let calls = 0;
  const client = new VocabularyClient(async () => { calls += 1; });
  for (const word of [null, {}, { ...entry, text: 'not Han' }, { ...entry, pinyin: '' },
    { ...entry, language: 'ru' }, { ...entry, translation: 'x'.repeat(1001) }]) {
    await assert.rejects(client.save(word));
  }
  assert.equal(calls, 0);
});
