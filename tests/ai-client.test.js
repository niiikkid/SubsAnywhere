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


test('caption translation keeps a full sentence translation and exact source phrases', () => {
  const result = normalizeCaptionTranslation('I gave up at last.', {
    translation: 'В конце концов я сдался.',
    glossary: [
      { text: 'at last', translation: 'в конце концов' },
      { text: 'invented phrase', translation: 'выдумано' },
      { text: 'gave up', translation: 'сдался' },
    ],
  });

  assert.deepEqual(result, {
    translation: 'В конце концов я сдался.',
    glossary: [
      { text: 'gave up', translation: 'сдался' },
      { text: 'at last', translation: 'в конце концов' },
    ],
  });
});

test('caption translation rejects glossary text inside another word', () => {
  const result = normalizeCaptionTranslation('The therapist helped.', {
    translation: 'Терапевт помог.',
    glossary: [{ text: 'he', translation: 'он' }, { text: 'therapist', translation: 'терапевт' }],
  });

  assert.deepEqual(result.glossary, [{ text: 'therapist', translation: 'терапевт' }]);
});

test('caption translation prefers a complete phrase over its component words', () => {
  const result = normalizeCaptionTranslation('You should look after him.', {
    translation: 'Тебе следует присмотреть за ним.',
    glossary: [
      { text: 'look', translation: 'смотреть' },
      { text: 'after', translation: 'после' },
      { text: 'look after', translation: 'присмотреть за' },
    ],
  });

  assert.deepEqual(result.glossary, [{ text: 'look after', translation: 'присмотреть за' }]);
});

test('caption translation accepts concise common response field names from AI', () => {
  const result = normalizeCaptionTranslation('I gave up.', {
    context: 'Я сдался.',
    phrases: [{ phrase: 'gave up', meaning: 'сдался' }],
  });

  assert.deepEqual(result, {
    translation: 'Я сдался.',
    glossary: [{ text: 'gave up', translation: 'сдался' }],
  });
});

test('caption translation never truncates the complete sentence translation', () => {
  const translation = `Полный перевод: ${'длинная фраза '.repeat(30)}`.trim();

  assert.equal(normalizeCaptionTranslation('A long complete sentence.', {
    translation,
    glossary: [],
  }).translation, translation);
});

test('DeepSeek prepares concise click translations for one caption only', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);
  await credentials.patch({ apiKey: 'secret-key', model: 'deepseek-v4-pro' });
  let request;
  const client = new DeepSeekClient(async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"translation":"Я сдался.","glossary":[{"text":"gave up","translation":"сдался"}]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, credentials);

  const result = await client.translateCaption('I gave up.');

  assert.deepEqual(result, {
    translation: 'Я сдался.',
    glossary: [{ text: 'gave up', translation: 'сдался' }],
  });
  assert.equal(request.max_tokens, 1600);
  assert.equal(request.model, 'deepseek-v4-pro');
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in request, false);
  assert.match(request.messages[0].content, /entire English subtitle sentence/i);
  assert.match(request.messages[0].content, /natural Russian/i);
  assert.match(request.messages[0].content, /phrases, not a word-by-word breakdown/i);
  assert.match(request.messages[0].content, /Before returning JSON/i);
  assert.match(request.messages[0].content, /Example input:/);
  assert.deepEqual(JSON.parse(request.messages[1].content), { caption: 'I gave up.' });
  assert.match(request.messages[1].content, /I gave up\./);
});

test('DeepSeek keeps a valid sentence translation without a repair request', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);
  await credentials.patch({ apiKey: 'test-key' });
  const requests = [];
  const replies = [
    { translation: 'Я сдался.', glossary: [] },
  ];
  const client = new DeepSeekClient(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(replies.shift()) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, credentials);

  const result = await client.translateCaption('I gave up.');

  assert.equal(requests.length, 1);
  assert.deepEqual(result, { translation: 'Я сдался.', glossary: [] });
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
  assert.equal(request.max_tokens, 1600);
  assert.match(request.messages[0].content, /Chinese subtitle sentence/i);
  assert.match(request.messages[0].content, /Before returning JSON/i);
  assert.match(request.messages[0].content, /Example input:/);
  assert.deepEqual(JSON.parse(request.messages[1].content), { caption: '你好，世界', pinyin: 'nǐ hǎo, shì jiè' });
  assert.match(request.messages[1].content, /你好，世界/);
  assert.match(request.messages[1].content, /nǐ hǎo, shì jiè/);
});

test('DeepSeek keeps every valid Chinese glossary term returned for a caption', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);
  await credentials.patch({ apiKey: 'secret-key' });
  const glossary = Array.from({ length: 13 }, (_, index) => ({
    pinyin: `cí${index + 1}`,
    translation: `слово ${index + 1}`,
  }));
  const client = new DeepSeekClient(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ translation: 'Полная фраза', glossary }) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }), credentials);

  const result = await client.translateChineseCaption('完整句子', glossary.map((term) => term.pinyin).join(' '));

  assert.deepEqual(result.glossary, glossary);
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
