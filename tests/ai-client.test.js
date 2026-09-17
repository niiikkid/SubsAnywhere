import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiCredentialStore,
  buildAIRequest,
  buildModelListRequest,
  DeepSeekClient,
  extractAIText,
  filterAvailableModels,
  normalizeCaptionTranslation,
} from '../ai-client.js';

class MemoryStorage {
  constructor() { this.data = {}; }
  async get(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])]));
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
  async remove(key) { delete this.data[key]; }
}


test('AI credential store never exposes the saved key to the popup', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);

  const publicInfo = await credentials.patch({ provider: 'deepseek', apiKey: 'secret-key', model: 'deepseek-chat', activate: true });

  assert.deepEqual(publicInfo, {
    activeProvider: 'deepseek',
    providers: {
      deepseek: { hasApiKey: true, model: 'deepseek-chat' },
      openai: { hasApiKey: false, model: '' },
    },
  });
  assert.deepEqual(await credentials.publicInfo(), publicInfo);
  assert.equal((await credentials.get()).apiKey, 'secret-key');
  assert.equal('apiKey' in publicInfo, false);
});

test('AI credential store saves the chosen DeepSeek model for translation', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);

  const publicInfo = await credentials.patch({ provider: 'deepseek', apiKey: 'secret-key', model: 'deepseek-v4-pro', activate: true });

  assert.deepEqual(publicInfo.providers.deepseek, { hasApiKey: true, model: 'deepseek-v4-pro' });
  assert.deepEqual((await credentials.publicInfo()).providers.deepseek, { hasApiKey: true, model: 'deepseek-v4-pro' });
  assert.equal((await credentials.get()).model, 'deepseek-v4-pro');
});

test('AI credential store keeps OpenAI and DeepSeek credentials separate and activates one provider', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);

  await credentials.patch({ provider: 'deepseek', apiKey: 'deepseek-secret', model: 'deepseek-chat' });
  await credentials.patch({ provider: 'openai', apiKey: 'openai-secret', model: 'gpt-5-mini', activate: true });

  assert.deepEqual(await credentials.publicInfo(), {
    activeProvider: 'openai',
    providers: {
      deepseek: { hasApiKey: true, model: 'deepseek-chat' },
      openai: { hasApiKey: true, model: 'gpt-5-mini' },
    },
  });
  assert.deepEqual(await credentials.getActive(), {
    provider: 'openai', apiKey: 'openai-secret', model: 'gpt-5-mini',
  });
});

test('legacy DeepSeek settings migrate without exposing the key', async () => {
  const storage = new MemoryStorage();
  storage.data.subsAnywhereDeepSeek = { apiKey: 'legacy-secret', model: 'deepseek-v4-pro' };
  const credentials = new AiCredentialStore(storage);

  const info = await credentials.publicInfo();

  assert.equal(info.activeProvider, 'deepseek');
  assert.deepEqual(info.providers.deepseek, { hasApiKey: true, model: 'deepseek-v4-pro' });
  assert.equal(JSON.stringify(info).includes('legacy-secret'), false);
});

test('deleting a migrated DeepSeek key removes the legacy credential too', async () => {
  const storage = new MemoryStorage();
  storage.data.subsAnywhereDeepSeek = { apiKey: 'legacy-secret', model: 'deepseek-v4-pro' };
  const credentials = new AiCredentialStore(storage);

  await credentials.patch({ provider: 'deepseek', clearApiKey: true });

  assert.equal('subsAnywhereDeepSeek' in storage.data, false);
  assert.equal((await credentials.get('deepseek')).apiKey, '');
});

test('provider model catalogs use saved-key endpoints and keep only translation text models', () => {
  assert.deepEqual(buildModelListRequest('openai', 'openai-secret'), {
    url: 'https://api.openai.com/v1/models',
    options: { headers: { Authorization: 'Bearer openai-secret' } },
  });
  assert.deepEqual(buildModelListRequest('deepseek', 'deepseek-secret'), {
    url: 'https://api.deepseek.com/models',
    options: { headers: { Authorization: 'Bearer deepseek-secret' } },
  });
  assert.deepEqual(filterAvailableModels('openai', { data: [
    { id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: 'gpt-5-image' },
    { id: 'gpt-5-audio' }, { id: 'gpt-5-codex' }, { id: 'gpt-6-astra' },
    { id: 'gpt-4.1' }, { id: 'whisper-1' },
  ] }), ['gpt-5', 'gpt-5-mini', 'gpt-6-astra']);
  assert.deepEqual(filterAvailableModels('deepseek', { data: [
    { id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-vision' },
  ] }), ['deepseek-chat', 'deepseek-reasoner']);
});

test('model discovery refuses network access until that provider key is saved', async () => {
  let requests = 0;
  const credentials = new AiCredentialStore(new MemoryStorage());
  const client = new DeepSeekClient(async () => { requests += 1; }, credentials);

  await assert.rejects(() => client.listModels('openai'), /Сначала сохраните API-ключ OpenAI/);
  assert.equal(requests, 0);
});

test('OpenAI translation requests use its selected text model and response shape', () => {
  const request = buildAIRequest({ provider: 'openai', model: 'gpt-5-mini', system: 'Translate', user: '{"caption":"Hi"}', maxTokens: 1600 });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.model, 'gpt-5-mini');
  assert.equal(request.body.max_output_tokens, 1600);
  assert.equal(request.body.instructions, 'Translate');
  assert.equal(request.body.input, '{"caption":"Hi"}');
  assert.equal('thinking' in request.body, false);
  assert.equal(extractAIText('openai', { output: [{ content: [{ type: 'output_text', text: '{"translation":"Привет"}' }] }] }), '{"translation":"Привет"}');
});

test('active OpenAI settings drive the real translation client path', async () => {
  const credentials = new AiCredentialStore(new MemoryStorage());
  await credentials.patch({ provider: 'openai', apiKey: 'openai-secret', model: 'gpt-5-mini', activate: true });
  let requestUrl;
  let requestBody;
  const client = new DeepSeekClient(async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: '{"translation":"Привет","glossary":[]}' }] }],
    }));
  }, credentials);

  assert.deepEqual(await client.translateCaption('Hello'), { translation: 'Привет', glossary: [] });
  assert.equal(requestUrl, 'https://api.openai.com/v1/responses');
  assert.equal(requestBody.model, 'gpt-5-mini');
  assert.equal(requestBody.max_output_tokens, 1600);
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
  await credentials.patch({ provider: 'deepseek', apiKey: 'secret-key', model: 'deepseek-v4-pro', activate: true });
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
  await credentials.patch({ provider: 'deepseek', apiKey: 'secret-key', model: 'deepseek-chat', activate: true });
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
  await credentials.patch({ provider: 'deepseek', apiKey: 'secret-key', model: 'deepseek-chat', activate: true });
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
  await credentials.patch({ provider: 'deepseek', apiKey: 'secret-key', model: 'deepseek-chat', activate: true });
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
  await credentials.patch({ provider: 'deepseek', apiKey: 'secret-key', model: 'deepseek-chat', activate: true });
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

async function chineseGlossaryFixture(caption, pinyin, glossary) {
  const requests = [];
  const client = new DeepSeekClient(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ translation: 'Полный перевод', glossary }) } }],
    }));
  }, { get: async () => ({ provider: 'deepseek', apiKey: 'offline-fixture', model: 'deepseek-chat' }) });
  const result = await client.translateChineseCaption(caption, pinyin);
  assert.equal(requests.length, 1, 'source mapping must not cause a repair or per-term request');
  return { result, request: requests[0] };
}

test('Chinese glossary requests exact Han source identity in the same completion', async () => {
  const { result, request } = await chineseGlossaryFixture('你好，世界', 'nǐ hǎo, shì jiè', [
    { text: '你好', pinyin: 'nǐ hǎo', translation: 'привет' },
    { text: '世界', pinyin: 'shì jiè', translation: 'мир' },
  ]);

  assert.deepEqual(result.glossary, [
    { text: '你好', pinyin: 'nǐ hǎo', translation: 'привет', pinyinStart: 0, pinyinEnd: 6 },
    { text: '世界', pinyin: 'shì jiè', translation: 'мир', pinyinStart: 8, pinyinEnd: 15 },
  ]);
  assert.match(request.messages[0].content, /"text":"exact Chinese source phrase"/);
  assert.match(request.messages[0].content, /Never infer Chinese characters from pinyin/i);
  assert.match(request.messages[0].content, /repeated occurrences/i);
  assert.deepEqual(JSON.parse(request.messages[1].content), { caption: '你好，世界', pinyin: 'nǐ hǎo, shì jiè' });
});

test('untrustworthy Chinese source text never destroys a valid glossary translation', async () => {
  for (const text of [undefined, null, 123, {}, '', '世界', '你世界好', '你 好', '<b>你好</b>', '你好\u200b', '你好'.repeat(61)]) {
    const { result } = await chineseGlossaryFixture('你好', 'nǐ hǎo', [
      { text, pinyin: 'nǐ hǎo', translation: 'привет' },
    ]);
    assert.deepEqual(result, {
      dictionary: 'Полный перевод', context: 'Полный перевод',
      glossary: [{ pinyin: 'nǐ hǎo', translation: 'привет' }],
    });
  }
});

test('Chinese source validation rejects markup and non-Han text even when present in caption', async () => {
  for (const text of ['<b>你好</b>', 'hello', '你好123', '你好\u0000']) {
    const { result } = await chineseGlossaryFixture(text, 'nǐ hǎo', [
      { text, pinyin: 'nǐ hǎo', translation: 'привет' },
    ]);
    assert.deepEqual(result.glossary, [{ pinyin: 'nǐ hǎo', translation: 'привет' }]);
  }
});

test('Chinese source identity preserves exact punctuation and supplementary Han', async () => {
  const { result } = await chineseGlossaryFixture('𠮷，你好！', 'jí, nǐ hǎo!', [
    { text: '𠮷，你好！', pinyin: 'jí, nǐ hǎo!', translation: 'привет' },
  ]);
  assert.deepEqual(result.glossary, [
    { text: '𠮷，你好！', pinyin: 'jí, nǐ hǎo!', translation: 'привет', pinyinStart: 0, pinyinEnd: 11 },
  ]);
});

test('Chinese homophones and repetitions keep occurrence-specific pinyin offsets', async () => {
  const { result } = await chineseGlossaryFixture('她他她', 'tā tā tā', [
    { text: '她', pinyin: 'tā', translation: 'она' },
    { text: '他', pinyin: 'tā', translation: 'он' },
    { text: '她', pinyin: 'tā', translation: 'она снова' },
  ]);
  assert.deepEqual(result.glossary, [
    { text: '她', pinyin: 'tā', translation: 'она', pinyinStart: 0, pinyinEnd: 2 },
    { text: '他', pinyin: 'tā', translation: 'он', pinyinStart: 3, pinyinEnd: 5 },
    { text: '她', pinyin: 'tā', translation: 'она снова', pinyinStart: 6, pinyinEnd: 8 },
  ]);
});

test('partial and reordered homophone glossaries identify the actual Chinese occurrence', async () => {
  const { result } = await chineseGlossaryFixture('她他', 'tā tā', [
    { text: '他', pinyin: 'tā', translation: 'он' },
    { text: '她', pinyin: 'tā', translation: 'она' },
  ]);
  assert.deepEqual(result.glossary, [
    { text: '他', pinyin: 'tā', translation: 'он', pinyinStart: 3, pinyinEnd: 5 },
    { text: '她', pinyin: 'tā', translation: 'она', pinyinStart: 0, pinyinEnd: 2 },
  ]);
  const partial = await chineseGlossaryFixture('她他', 'tā tā', [{ text: '他', pinyin: 'tā', translation: 'он' }]);
  assert.deepEqual(partial.result.glossary, [result.glossary[0]]);
});

test('Chinese mapping refuses mismatched syllable positions and exhausted repetitions', async () => {
  const { result } = await chineseGlossaryFixture('你好', 'nǐ hǎo', [
    { text: '好', pinyin: 'nǐ', translation: 'ты' },
    { text: '你好', pinyin: 'nǐ hǎo', translation: 'привет' },
    { text: '你好', pinyin: 'nǐ hǎo', translation: 'привет снова' },
  ]);
  assert.deepEqual(result.glossary, [
    { pinyin: 'nǐ', translation: 'ты' },
    { text: '你好', pinyin: 'nǐ hǎo', translation: 'привет', pinyinStart: 0, pinyinEnd: 6 },
    { pinyin: 'nǐ hǎo', translation: 'привет снова' },
  ]);
});

test('joined pinyin allows unique source identity but not ambiguous repeated homophones', async () => {
  const unique = await chineseGlossaryFixture('你好', 'nǐhǎo', [{ text: '你好', pinyin: 'nǐhǎo', translation: 'привет' }]);
  assert.deepEqual(unique.result.glossary, [
    { text: '你好', pinyin: 'nǐhǎo', translation: 'привет', pinyinStart: 0, pinyinEnd: 5 },
  ]);
  const ambiguous = await chineseGlossaryFixture('你好拟好', 'nǐhǎo nǐhǎo', [{ text: '拟好', pinyin: 'nǐhǎo', translation: 'подготовить' }]);
  assert.deepEqual(ambiguous.result.glossary, [{ pinyin: 'nǐhǎo', translation: 'подготовить' }]);
});

test('Chinese source identity ignores model offsets and never trusts offsets without text', async () => {
  const { result } = await chineseGlossaryFixture('她他', 'tā tā', [
    { text: '他', pinyin: 'tā', translation: 'он', pinyinStart: 0, pinyinEnd: 2 },
    { pinyin: 'tā', translation: 'она', pinyinStart: 3, pinyinEnd: 5 },
  ]);
  assert.deepEqual(result.glossary, [
    { text: '他', pinyin: 'tā', translation: 'он', pinyinStart: 3, pinyinEnd: 5 },
    { pinyin: 'tā', translation: 'она' },
  ]);
});

test('Chinese source identity never truncates an oversized source into a savable term', async () => {
  const text = '你'.repeat(121);
  const { result } = await chineseGlossaryFixture(text, 'nǐ', [{ text, pinyin: 'nǐ', translation: 'ты' }]);
  assert.deepEqual(result.glossary, [{ pinyin: 'nǐ', translation: 'ты' }]);
});

test('punctuation-only labels cannot acquire savable Han through unique-match fallback', async () => {
  const { result } = await chineseGlossaryFixture('你好', 'nǐhǎo ,', [{ text: '你好', pinyin: ',', translation: 'запятая' }]);
  assert.equal(result.glossary.some((term) => 'text' in term), false);
});
