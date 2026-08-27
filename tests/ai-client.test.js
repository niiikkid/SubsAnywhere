import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiCredentialStore,
  DeepSeekClient,
  estimateAffineSync,
  normalizeCaptionTranslation,
  sampleCueList,
} from '../ai-client.js';

class MemoryStorage {
  constructor() { this.data = {}; }
  async get(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])]));
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
}

test('sampleCueList sends a bounded spread instead of the complete subtitle file', () => {
  const cues = Array.from({ length: 1000 }, (_, index) => ({ start: index * 2, end: index * 2 + 1, text: `Line ${index}` }));
  const samples = sampleCueList(cues, 18);

  assert.equal(samples.length, 18);
  assert.ok(samples[0].time > 0);
  assert.ok(samples.at(-1).time < cues.at(-1).start);
  assert.ok(samples.every((sample) => sample.text.length < 221));
});

test('estimateAffineSync derives constant offset and gradual drift from matched IDs', () => {
  const candidate = [
    { id: 'c0', time: 10, text: 'A' },
    { id: 'c1', time: 110, text: 'B' },
    { id: 'c2', time: 210, text: 'C' },
  ];
  const reference = candidate.map((cue, index) => ({ id: `r${index}`, time: cue.time * 1.001 + 2.5, text: cue.text }));
  const pairs = candidate.map((_cue, index) => ({ referenceId: `r${index}`, candidateId: `c${index}` }));

  const result = estimateAffineSync(reference, candidate, pairs);

  assert.ok(Math.abs(result.timeScale - 1.001) < 0.000001);
  assert.ok(Math.abs(result.offsetSeconds - 2.5) < 0.001);
  assert.equal(result.pairCount, 3);
  assert.ok(result.residualSeconds < 0.001);
});

test('AI credential store never exposes the saved key to the popup', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);

  const publicInfo = await credentials.patch({ apiKey: 'secret-key' });

  assert.deepEqual(publicInfo, { hasApiKey: true });
  assert.deepEqual(await credentials.publicInfo(), { hasApiKey: true });
  assert.equal((await credentials.get()).apiKey, 'secret-key');
  assert.equal('apiKey' in publicInfo, false);
});

test('DeepSeek request uses selected model and reasoning effort with JSON mode', async () => {
  const storage = new MemoryStorage();
  const credentials = new AiCredentialStore(storage);
  await credentials.patch({ apiKey: 'secret-key' });
  let request;
  const client = new DeepSeekClient(async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"englishSearchTitle":"The Test","alternateSearchTitles":["Test Movie"],"originalLanguage":"en","confidence":0.9}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, credentials);

  const result = await client.detectMedia({ title: 'Test' }, { model: 'deepseek-v4-pro', reasoningEffort: 'max' });

  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.body.model, 'deepseek-v4-pro');
  assert.equal(request.body.reasoning_effort, 'max');
  assert.deepEqual(request.body.thinking, { type: 'enabled' });
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.equal(result.englishSearchTitle, 'The Test');
  assert.deepEqual(result.alternateSearchTitles, ['Test Movie']);
  assert.equal(result.originalLanguage, 'en');
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
  await credentials.patch({ apiKey: 'secret-key' });
  let request;
  const client = new DeepSeekClient(async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"items":[{"text":"gave up","dictionary":"сдаваться","context":"сдался"}]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, credentials);

  const result = await client.translateCaption('I gave up.', { model: 'deepseek-v4-flash', reasoningEffort: 'low' });

  assert.deepEqual(result, [{ start: 2, end: 9, text: 'gave up', dictionary: 'сдаваться', context: 'сдался' }]);
  assert.equal(request.max_tokens, 400);
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in request, false);
  assert.match(request.messages[0].content, /phrases/i);
  assert.match(request.messages[0].content, /2-3 short Russian variants/i);
  assert.match(request.messages[1].content, /I gave up\./);
});
