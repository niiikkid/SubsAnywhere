import test from 'node:test';
import assert from 'node:assert/strict';
import { VocabularyClient } from '../vocabulary-client.js';

const entry = { language: 'zh', text: '你好', pinyin: 'nǐ hǎo', translation: 'привет' };
const saved = { ...entry, id: 1, created_at: '2026-01-01T00:00:00Z', learned: false, explanation: '' };
const sentenceEntry = { language: 'zh', text: '我已经吃过饭了。', pinyin: 'wǒ yǐjīng chī guò fàn le.', translation: 'Я уже поел.' };
const savedSentence = { ...sentenceEntry, id: 7, created_at: '2026-01-02T00:00:00Z', learned: false, explanation: '' };

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
  const invalidLearnedState = new VocabularyClient(async () => Response.json({ words: [{ ...saved, learned: 0 }] }));
  await assert.rejects(invalidLearnedState.list(), /ответ/);
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

test('vocabulary saves an explanation only after the server confirms it in the word list', async () => {
  const explanation = '你好 — обычное приветствие. Подходит и знакомым, и незнакомым.';
  const explained = { ...saved, explanation };
  const calls = [];
  const client = new VocabularyClient(async (url, options) => {
    calls.push({ url, options });
    return Response.json(options.method === 'POST' ? { word: explained } : { words: [explained] });
  });

  assert.deepEqual(await client.saveExplanation(saved.id, explanation), { word: explained });
  assert.equal(calls[0].url, 'http://127.0.0.1:43817/api/words/explanation');
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: saved.id, explanation });
  assert.equal(calls[1].options.method, 'GET');
});

test('sentences use their own API and are confirmed by reading the sentence list back', async () => {
  const calls = [];
  const client = new VocabularyClient(async (url, options) => {
    calls.push({ url, options });
    return Response.json(options.method === 'POST' ? { sentence: savedSentence } : { sentences: [savedSentence] });
  });
  assert.deepEqual(await client.saveSentence(sentenceEntry), { sentence: savedSentence });
  assert.equal(calls[0].url, 'http://127.0.0.1:43817/api/sentences');
  assert.deepEqual(JSON.parse(calls[0].options.body), sentenceEntry);
  assert.equal(calls[1].url, 'http://127.0.0.1:43817/api/sentences');
});

test('sentence grammar explanations are saved only after readback confirmation', async () => {
  const explanation = 'Yǐjīng и le показывают уже завершившееся действие. По-русски смысл передаётся словом «уже» и прошедшим временем.';
  const explained = { ...savedSentence, explanation };
  const calls = [];
  const client = new VocabularyClient(async (url, options) => {
    calls.push({ url, options });
    return Response.json(options.method === 'POST' ? { sentence: explained } : { sentences: [explained] });
  });
  assert.deepEqual(await client.saveSentenceExplanation(savedSentence.id, explanation), { sentence: explained });
  assert.equal(calls[0].url, 'http://127.0.0.1:43817/api/sentences/explanation');
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: savedSentence.id, explanation });
});

test('AI translation variants are saved separately and confirmed through the canonical word list', async () => {
  const translations = [
    { translation: 'идти; быть в движении', usage: 'о движении или ходе процесса' },
    { translation: 'годится; можно', usage: 'когда что-то допустимо или подходит' },
  ];
  const translated = { ...saved, ai_translations: translations };
  const calls = [];
  const client = new VocabularyClient(async (url, options) => {
    calls.push({ url, options });
    return Response.json(options.method === 'POST' ? { word: translated } : { words: [translated] });
  });

  assert.deepEqual(await client.saveAiTranslations(saved.id, translations), { word: translated });
  assert.equal(calls[0].url, 'http://127.0.0.1:43817/api/words/ai-translations');
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: saved.id, translations });
  assert.equal(calls[1].options.method, 'GET');
});
