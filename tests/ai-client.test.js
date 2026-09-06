import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiCredentialStore,
  DeepSeekClient,
  normalizeCaptionTranslation,
} from '../ai-client.js';

class MemoryStorage {
  constructor() { this.data = {}; }
  async get(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])]));
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
}


test('AI credential store never exposes the saved key to the popup', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);

  const publicInfo = await credentials.patch({ apiKey: 'secret-key' });

  assert.deepEqual(publicInfo, { hasApiKey: true, model: 'deepseek-v4-flash' });
  assert.deepEqual(await credentials.publicInfo(), { hasApiKey: true, model: 'deepseek-v4-flash' });
  assert.equal((await credentials.get()).apiKey, 'secret-key');
  assert.equal('apiKey' in publicInfo, false);
});

test('AI credential store saves the chosen DeepSeek model for translation', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);

  const publicInfo = await credentials.patch({ apiKey: 'secret-key', model: 'deepseek-v4-pro' });

  assert.deepEqual(publicInfo, { hasApiKey: true, model: 'deepseek-v4-pro' });
  assert.deepEqual(await credentials.publicInfo(), { hasApiKey: true, model: 'deepseek-v4-pro' });
  assert.equal((await credentials.get()).model, 'deepseek-v4-pro');
});


test('caption translation keeps only ordered phrase spans from the displayed subtitle', () => {
  const result = normalizeCaptionTranslation('I gave up at last.', {
    items: [
      { text: 'gave up', dictionary: 'сдаваться', context: 'сдался' },
      { text: 'at last', dictionary: 'наконец', context: 'наконец-то' },
      { text: 'invented phrase', dictionary: 'x', context: 'x' },
      { text: 'I', dictionary: 'я', context: 'я' },
    ],
  });

  assert.deepEqual(result, [
    { start: 0, end: 1, text: 'I', dictionary: 'я', context: 'я' },
    { start: 2, end: 9, text: 'gave up', dictionary: 'сдаваться', context: 'сдался' },
    { start: 10, end: 17, text: 'at last', dictionary: 'наконец', context: 'наконец-то' },
  ]);
});

test('caption translation never matches a word inside another word and handles repeats', () => {
  const result = normalizeCaptionTranslation('The he said he.', {
    items: [{ text: 'he', dictionary: 'он', context: 'он' }],
  });

  assert.deepEqual(result, [
    { start: 4, end: 6, text: 'he', dictionary: 'он', context: 'он' },
    { start: 12, end: 14, text: 'he', dictionary: 'он', context: 'он' },
  ]);
});

test('caption translation prefers a complete phrase even when AI returns its words first', () => {
  const result = normalizeCaptionTranslation('You should look after him.', {
    items: [
      { text: 'look', dictionary: 'смотреть', context: 'следить' },
      { text: 'after', dictionary: 'после', context: 'за' },
      { text: 'look after', dictionary: 'заботиться, присматривать', context: 'присмотреть за' },
      { text: 'him', dictionary: 'он, ему', context: 'ним' },
    ],
  });

  assert.deepEqual(result, [
    { start: 11, end: 21, text: 'look after', dictionary: 'заботиться, присматривать', context: 'присмотреть за' },
    { start: 22, end: 25, text: 'him', dictionary: 'он, ему', context: 'ним' },
  ]);
});

test('caption translation accepts concise common response field names from AI', () => {
  const result = normalizeCaptionTranslation('I gave up.', {
    phrases: [{ phrase: 'gave up', translation: 'сдаться', contextTranslation: 'сдался' }],
  });

  assert.deepEqual(result, [{
    start: 2, end: 9, text: 'gave up', dictionary: 'сдаться', context: 'сдался',
  }]);
});

test('DeepSeek prepares concise click translations for one caption only', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);
  await credentials.patch({ apiKey: 'secret-key', model: 'deepseek-v4-pro' });
  let request;
  const client = new DeepSeekClient(async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"items":[{"text":"gave up","dictionary":"сдаваться","context":"сдался"}]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, credentials);

  const result = await client.translateCaption('I gave up.');

  assert.deepEqual(result, [{ start: 2, end: 9, text: 'gave up', dictionary: 'сдаваться', context: 'сдался' }]);
  assert.equal(request.max_tokens, 800);
  assert.equal(request.model, 'deepseek-v4-pro');
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in request, false);
  assert.match(request.messages[0].content, /phrases/i);
  assert.match(request.messages[0].content, /every English word exactly once/i);
  assert.match(request.messages[0].content, /multi-word/i);
  assert.match(request.messages[0].content, /2-3 short Russian variants/i);
  assert.match(request.messages[1].content, /I gave up\./);
});

test('DeepSeek translates a linked Chinese sentence in one request', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);
  await credentials.patch({ apiKey: 'secret-key' });
  let request;
  const client = new DeepSeekClient(async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"translation":"Привет, мир","glossary":[{"pinyin":"nǐ hǎo","translation":"здравствуйте"},{"pinyin":"shì jiè","translation":"мир"}]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, credentials);

  const result = await client.translateChineseCaption('你好，世界', 'nǐ hǎo, shì jiè');

  assert.deepEqual(result, {
    dictionary: 'Привет, мир',
    context: 'Привет, мир',
    glossary: [
      { pinyin: 'nǐ hǎo', translation: 'здравствуйте' },
      { pinyin: 'shì jiè', translation: 'мир' },
    ],
  });
  assert.equal(request.max_tokens, 500);
  assert.match(request.messages[0].content, /Chinese subtitle sentence/i);
  assert.match(request.messages[1].content, /你好，世界/);
  assert.match(request.messages[1].content, /nǐ hǎo, shì jiè/);
});

test('DeepSeek rejects model glossary terms that are not exact displayed pinyin phrases', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);
  await credentials.patch({ apiKey: 'secret-key' });
  const client = new DeepSeekClient(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      translation: 'Привет, мир',
      glossary: [
        { pinyin: ' nǐ   hǎo ', translation: 'здравствуйте' },
        { pinyin: 'shì jiè', translation: 'мир' },
        { pinyin: 'nǐ hǎo shì', translation: 'выдуманный переход через запятую' },
        { pinyin: 'hǎ', translation: 'обрезанный слог' },
        { pinyin: 'jiè le', translation: 'выдуманное слово' },
      ],
    }) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }), credentials);

  const result = await client.translateChineseCaption('你好，世界', 'nǐ hǎo, shì jiè');

  assert.deepEqual(result.glossary, [
    { pinyin: 'nǐ hǎo', translation: 'здравствуйте' },
    { pinyin: 'shì jiè', translation: 'мир' },
  ]);
});
