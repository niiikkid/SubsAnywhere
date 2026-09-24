import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { AIClient } from '../ai-client.js';
import { VocabularyClient } from '../vocabulary-client.js';
import { BackgroundController } from '../background-controller.js';
import { MESSAGE, validateChineseAnalysis } from '../protocol.js';

const text = '你呢，你呢？';
const analysis = {
  pinyin: 'nǐ ne，nǐ ne？', translation: 'А ты? А ты?',
  components: [
    { text: '你', pinyin: 'nǐ', translation: 'ты', usage: 'Обращение к собеседнику.' },
    { text: '呢', pinyin: 'ne', translation: 'а?', usage: 'Возвращает вопрос собеседнику.' },
    { text: '你', pinyin: 'nǐ', translation: 'ты', usage: 'Повторное обращение.' },
    { text: '呢', pinyin: 'ne', translation: 'а?', usage: 'Снова задаёт встречный вопрос.' },
  ],
  characters: [
    { text: '你', pinyin: 'nǐ', translation: 'ты' },
    { text: '呢', pinyin: 'ne', translation: 'а; в конце возвращает вопрос' },
    { text: '你', pinyin: 'nǐ', translation: 'ты' },
    { text: '呢', pinyin: 'ne', translation: 'а; в конце возвращает вопрос' },
  ],
  grammar: 'Ne в конце возвращает вопрос: «А ты?». В русском для этого обычно нужно слово «а».',
  example: { pinyin: 'wǒ hěn hǎo, nǐ ne?', translation: 'У меня всё хорошо, а у тебя?' },
};
const pronunciation = { characters: analysis.characters.map(({ text, pinyin }) => ({ text, pinyin })) };
const record = { id: 3, language: 'zh', text, pinyin: 'broken', translation: 'old', created_at: '2026-01-01', learned: false, explanation: '' };
const updated = { ...record, pinyin: analysis.pinyin, translation: analysis.translation, analysis };
const sender = { id: 'extension', tab: { id: 9 }, frameId: 0, url: 'http://127.0.0.1:43817/words' };
const chrome = { runtime: { id: 'extension', getURL: (path) => `chrome-extension://extension/${path}` } };

function aiFixture(outputs) {
  const requests = [];
  const client = new AIClient(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
  }, { get: async () => ({ provider: 'deepseek', apiKey: 'offline-fixture', model: 'deepseek-chat' }) });
  return { client, requests };
}

test('analysis uses exactly two sequential requests: canonical Han then Han plus corrected pinyin', async () => {
  const { client, requests } = aiFixture([pronunciation, analysis]);
  assert.deepEqual(await client.analyzeChinese({ ...record, analysis: { malicious: true } }), analysis);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content), { text });
  assert.deepEqual(JSON.parse(requests[1].messages[1].content), { text, pinyin: analysis.pinyin });
  assert.match(requests[1].messages[0].content, /12-year-old/);
  assert.match(requests[1].messages[0].content, /ALL particles/);
  assert.match(requests[1].messages[0].content, /without linguistic jargon/);
});

test('analysis receives pronunciation per Han character instead of relying on word spacing', async () => {
  const pinyin = 'nǐ ne，nǐ ne？';
  const expected = { ...analysis, pinyin };
  const characters = [...text].filter(char => /\p{Script=Han}/u.test(char));
  const { client, requests } = aiFixture([
    { characters: characters.map((text, index) => ({ text, pinyin: index % 2 ? 'ne' : 'nǐ' })) },
    expected,
  ]);
  assert.deepEqual(await client.analyzeChinese(record), expected);
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /characters/);
});

test('analysis accepts joined word spelling only when it matches verified per-character readings', async () => {
  const expected = {
    ...analysis, pinyin: 'zhōng wén',
    components: [{ text: '中文', pinyin: 'zhōng wén', translation: 'китайский язык', usage: 'Название языка.' }],
    characters: [{ text: '中', pinyin: 'zhōng', translation: 'середина' }, { text: '文', pinyin: 'wén', translation: 'письменный знак; культура' }],
  };
  const characters = [{ text: '中', pinyin: 'zhōng' }, { text: '文', pinyin: 'wén' }];
  const joined = { ...expected, pinyin: 'Zhōngwén', components: [{ ...expected.components[0], pinyin: 'zhōngwén' }] };
  const { client } = aiFixture([{ characters }, joined]);
  assert.deepEqual(await client.analyzeChinese({ ...record, text: '中文' }), expected);
  const missing = aiFixture([{ characters }, { ...joined, pinyin: 'zhōng' }]);
  await assert.rejects(missing.client.analyzeChinese({ ...record, text: '中文' }));
});

test('analysis rejects missing or reordered character pronunciations before requesting translation', async () => {
  for (const characters of [
    [{ text: '你', pinyin: 'nǐ' }],
    [{ text: '呢', pinyin: 'ne' }, { text: '你', pinyin: 'nǐ' }, { text: '你', pinyin: 'nǐ' }, { text: '呢', pinyin: 'ne' }],
  ]) {
    const { client, requests } = aiFixture([{ characters }]);
    await assert.rejects(client.analyzeChinese(record));
    assert.equal(requests.length, 1);
  }
});

test('analysis stops on invalid pronunciation or non-Chinese source without repair calls', async () => {
  for (const pinyin of ['nǐ', '你呢你呢', 'nǐ ne nǐ ne'.repeat(100), null]) {
    const { client, requests } = aiFixture([{ pinyin }, analysis]);
    await assert.rejects(client.analyzeChinese(record));
    assert.equal(requests.length, 1);
  }
  const { client, requests } = aiFixture([]);
  await assert.rejects(client.analyzeChinese({ ...record, language: 'en' }));
  assert.equal(requests.length, 0);
});

test('analysis rejects missing particles, repeated-occurrence collapse, reordered parts and rewritten pinyin', async () => {
  const mutations = [
    (a) => { a.components.splice(1, 1); },
    (a) => { a.components.splice(2); },
    (a) => { a.components.reverse(); },
    (a) => { a.components[1].text = '吗'; },
    (a) => { a.pinyin = 'ní ne, nǐ ne?'; },
    (a) => { a.components[0].pinyin = 'ní'; },
    (a) => { a.characters[0].pinyin = 'ní'; },
    (a) => { a.characters.reverse(); },
    (a) => { a.characters.splice(2); },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(analysis); mutate(bad);
    const { client, requests } = aiFixture([pronunciation, bad]);
    await assert.rejects(client.analyzeChinese(record));
    assert.equal(requests.length, 2);
  }
});

test('strict analysis contract rejects every overlong field, Han display text and unknown keys without mutation', () => {
  assert.deepEqual(validateChineseAnalysis(analysis, { text }), analysis);
  const fields = [
    ['pinyin', 500], ['translation', 1000], ['grammar', 700],
    ['components.0.text', 120], ['components.0.pinyin', 120], ['components.0.translation', 160], ['components.0.usage', 240],
    ['characters.0.text', 2], ['characters.0.pinyin', 120], ['characters.0.translation', 160],
    ['example.pinyin', 300], ['example.translation', 300],
  ];
  for (const [path, limit] of fields) {
    for (const value of ['x'.repeat(limit + 1), '', ...(path.endsWith('.text') ? [] : ['你'])]) {
      const bad = structuredClone(analysis);
      const keys = path.split('.'); const key = keys.pop();
      const target = keys.reduce((current, part) => current[part], bad); target[key] = value;
      const before = structuredClone(bad);
      assert.throws(() => validateChineseAnalysis(bad, { text }), /разбор/);
      assert.deepEqual(bad, before);
    }
  }
  for (const patch of [{ components: [] }, { characters: [] }, { characters: [...analysis.characters].reverse() }, { components: Array(121).fill(analysis.components[0]) }, { extra: true }, { example: { ...analysis.example, text: '你好' } }]) {
    assert.throws(() => validateChineseAnalysis({ ...analysis, ...patch }, { text }));
  }
});

test('both analysis endpoints send explicit contract and verify updated canonical fields by readback', async () => {
  for (const kind of ['words', 'sentences']) {
    const key = kind === 'words' ? 'word' : 'sentence';
    const calls = [];
    const client = new VocabularyClient(async (url, options) => {
      calls.push({ url, options });
      return Response.json(options.method === 'POST' ? { [key]: updated } : { [kind]: [updated] });
    });
    assert.deepEqual(await client.saveAnalysis(kind, 3, analysis), { [key]: updated });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `http://127.0.0.1:43817/api/${kind}/analysis`);
    assert.deepEqual(JSON.parse(calls[0].options.body), { id: 3, analysis });
    assert.equal(calls[1].options.method, 'GET');
    for (const mismatch of [{ ...updated, pinyin: 'wrong' }, { ...updated, translation: 'wrong' }, record, { ...updated, id: 4 }]) {
      const lost = new VocabularyClient(async (_url, options) => Response.json(
        options.method === 'POST' ? { [key]: updated } : { [kind]: [mismatch] },
      ));
      await assert.rejects(lost.saveAnalysis(kind, 3, analysis));
    }
  }
});

test('legacy saved analysis without characters remains readable while new saves require characters', async () => {
  const legacy = structuredClone(analysis); delete legacy.characters;
  const legacyRecord = { ...updated, analysis: legacy };
  const client = new VocabularyClient(async () => Response.json({ words: [legacyRecord] }));
  assert.deepEqual(await client.list(), { words: [legacyRecord] });
  await assert.rejects(client.saveAnalysis('words', 3, legacy), /разбор/);
});

test('recapture confirms the same Han record after its pinyin was corrected', async () => {
  const client = new VocabularyClient(async (_url, options) => Response.json(
    options.method === 'POST' ? { word: updated } : { words: [updated] },
  ));
  assert.deepEqual(await client.save(record), { word: updated });
});

test('analysis canonicalizes whitespace and Unicode before persistence comparison', () => {
  const value = { ...analysis, grammar: '  Два  слова.  ', translation: 'А ты? А ты?'.normalize('NFD') };
  assert.equal(validateChineseAnalysis(value, { text }).grammar, 'Два слова.');
  assert.equal(validateChineseAnalysis(value, { text }).translation, analysis.translation);
});

test('word analysis pinyin save cap is 120, sentence cap is 500', async () => {
  const long = { ...analysis, pinyin: Array(30).fill('hǎo').join(' ') + ' hǎo', components: Array.from({ length: 31 }, () => ({ text: '好', pinyin: 'hǎo', translation: 'хорошо', usage: 'Оценка.' })), characters: Array.from({ length: 31 }, () => ({ text: '好', pinyin: 'hǎo', translation: 'хорошо' })) };
  let calls = 0;
  const client = new VocabularyClient(async () => { calls++; throw new Error('offline'); });
  await assert.rejects(client.saveAnalysis('words', 3, long), /разбор/);
  assert.equal(calls, 0);
  await assert.rejects(client.saveAnalysis('sentences', 3, long), /Docker/);
  assert.equal(calls, 1);
});

test('background reloads canonical Chinese record, deduplicates concurrent calls and allows explicit refresh', async () => {
  let reads = 0; let aiCalls = 0; const saves = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const controller = new BackgroundController(chrome, {}, {
    vocabulary: {
      list: async () => { reads++; return { words: [record] }; },
      listSentences: async () => ({ sentences: [record] }),
      saveAnalysis: async (...args) => { saves.push(args); return { [args[0] === 'words' ? 'word' : 'sentence']: updated }; },
    },
    aiClient: { analyzeChinese: async (item) => { assert.deepEqual(item, record); aiCalls++; await gate; return analysis; } },
  });
  const message = { type: MESSAGE.WORD_ANALYZE, id: 3, text: '伪造', pinyin: 'fake', translation: 'fake' };
  const first = controller.handle(message, sender);
  const second = controller.handle(message, sender);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aiCalls, 1); assert.equal(reads, 1);
  release();
  for (const result of await Promise.all([first, second])) assert.deepEqual(result, { ok: true, data: { word: updated } });
  assert.deepEqual(saves, [['words', 3, analysis]]);
  assert.equal((await controller.handle(message, sender)).ok, true);
  assert.equal(aiCalls, 2);
  assert.equal((await controller.handle({ type: MESSAGE.SENTENCE_ANALYZE, id: 3 }, sender)).ok, true);
  assert.equal(saves.at(-1)[0], 'sentences');
});

test('background rejects untrusted senders, invalid ids, English and missing entities before AI', async () => {
  let calls = 0;
  const controller = new BackgroundController(chrome, {}, {
    vocabulary: { list: async () => ({ words: [{ ...record, language: 'en' }] }) },
    aiClient: { analyzeChinese: async () => { calls++; } },
  });
  for (const [id, origin] of [[3, sender], [4, sender], [0, sender], ['3', sender], [3, { ...sender, url: 'https://evil.example/words' }], [3, { ...sender, id: 'other' }]]) {
    assert.equal((await controller.handle({ type: MESSAGE.WORD_ANALYZE, id }, origin)).ok, false);
  }
  assert.equal(calls, 0);
});

test('background failures clear dedup and never save partial analysis', async () => {
  let calls = 0; let saves = 0;
  const controller = new BackgroundController(chrome, {}, {
    vocabulary: { list: async () => ({ words: [record] }), saveAnalysis: async () => { saves++; } },
    aiClient: { analyzeChinese: async () => { calls++; throw new Error('fixture failure'); } },
  });
  for (let i = 0; i < 2; i++) assert.equal((await controller.handle({ type: MESSAGE.WORD_ANALYZE, id: 3 }, sender)).ok, false);
  assert.equal(calls, 2); assert.equal(saves, 0);
});

test('panel bridge forwards only entity ID and returns the matching analysis response', async () => {
  const source = await fs.readFile(new URL('../words-bridge.js', import.meta.url), 'utf8');
  const messages = []; const replies = []; let listener;
  const window = { addEventListener: (_name, fn) => { listener = fn; }, postMessage: (...args) => replies.push(args) };
  vm.runInNewContext(source, {
    location: new URL(sender.url), window,
    chrome: { runtime: { sendMessage: async (message) => { messages.push(message); return { ok: true, data: { word: updated, sentence: updated } }; } } },
  });
  assert.equal(messages.length, 0);
  for (const kind of ['words', 'sentences']) {
    await listener({ source: window, origin: 'http://127.0.0.1:43817', data: { type: 'subsanywhere.words.analyze', requestId: kind, kind, id: 3, text: '伪造', analysis: {} } });
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: `dualCaptions.${kind}.analyze`, id: 3 });
    assert.equal(replies.at(-1)[0].type, 'subsanywhere.words.analyze.result');
    assert.equal(replies.at(-1)[0][kind === 'words' ? 'word' : 'sentence'].id, 3);
  }
  for (const data of [{ kind: 'bad', id: 3 }, { kind: 'words', id: '3' }]) {
    await listener({ source: window, origin: 'http://127.0.0.1:43817', data: { type: 'subsanywhere.words.analyze', requestId: 'bad', ...data } });
  }
  assert.equal(messages.length, 2);
});
