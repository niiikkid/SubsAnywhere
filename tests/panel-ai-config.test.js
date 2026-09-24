import test from 'node:test';
import assert from 'node:assert/strict';
import * as ai from '../ai-client.js';
import { BackgroundController } from '../background-controller.js';
import { MESSAGE } from '../protocol.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function fixture() {
  const data = { [ai.AI_CONFIG_KEY]: { activeProvider: 'deepseek', providers: {
    deepseek: { apiKey: 'test-deepseek', model: 'deepseek-chat' },
    openai: { apiKey: 'test-openai', model: 'gpt-5' },
  } } };
  const writes = [];
  const storage = {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])),
    set: async (patch) => { writes.push(structuredClone(patch)); Object.assign(data, structuredClone(patch)); },
    remove: async k => { delete data[k]; },
  };
  const credentials = new ai.AiCredentialStore(storage);
  return { data, writes, storage, credentials };
}

const sender = { id: 'extension', tab: { id: 1 }, frameId: 0, url: 'http://127.0.0.1:43817/words' };
const chrome = { runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}` } };
const analysis = { pinyin: 'nǐ', translation: 'ты', components: [{ text: '你', pinyin: 'nǐ', translation: 'ты', usage: 'Обращение.' }], characters: [{ text: '你', pinyin: 'nǐ', translation: 'ты' }], grammar: 'Обращение к человеку.', example: { pinyin: 'nǐ hǎo', translation: 'Привет.' } };
const pronunciation = { characters: [{ text: '你', pinyin: 'nǐ' }] };

test('two-step analysis snapshots credentials while panel settings change', async () => {
  let reads = 0; const calls = [];
  const client = new ai.AIClient(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json({ choices: [{ message: { content: JSON.stringify(calls.length === 1 ? pronunciation : analysis) } }] });
  }, { getActive: async () => ++reads === 1
    ? { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test' }
    : { provider: 'openai', model: 'gpt-5', apiKey: 'changed' } });
  assert.deepEqual(await client.analyzeChinese({ language: 'zh', text: '你' }), analysis);
  assert.equal(reads, 1);
  assert.ok(calls.every(c => c.body.model === 'deepseek-chat'));
});

test('panel config messages are exact-sender-only and route independently', async () => {
  const f = fixture(); const panelConfigStore = new ai.PanelAiConfigStore(f.storage, f.credentials);
  const panelAiClient = new ai.AIClient(async () => Response.json({ data: [{ id: 'gpt-5' }] }), panelConfigStore);
  const controller = new BackgroundController(chrome, {}, { panelConfigStore, panelAiClient });
  assert.equal(typeof MESSAGE.PANEL_AI_GET, 'string');
  for (const type of [MESSAGE.PANEL_AI_GET, MESSAGE.PANEL_AI_MODELS, MESSAGE.PANEL_AI_SAVE]) {
    for (const bad of [ { ...sender, id: 'other' }, { ...sender, url: `${sender.url}?x=1` }, { ...sender, url: 'http://localhost:43817/words' }, { ...sender, url: 'https://evil.test/words' }, { id: 'extension', url: chrome.runtime.getURL('popup.html') } ]) {
      assert.equal((await controller.handle({ type, provider: 'openai', model: 'gpt-5' }, bad)).ok, false);
    }
  }
  const result = await controller.handle({ type: MESSAGE.PANEL_AI_GET }, sender);
  assert.equal(result.ok, true); assert.equal(result.data.settings.provider, 'deepseek');
  assert.equal((await controller.handle({ type: MESSAGE.PANEL_AI_SAVE, provider: 'openai', model: 'gpt-5' }, sender)).ok, false);
  assert.deepEqual(await controller.handle({ type: MESSAGE.PANEL_AI_MODELS, provider: 'openai' }, sender), { ok: true, data: { provider: 'openai', models: ['gpt-5'] } });
  assert.equal((await controller.handle({ type: MESSAGE.PANEL_AI_SAVE, provider: 'openai', model: 'gpt-5' }, sender)).data.settings.provider, 'openai');
  assert.equal((await controller.handle({ type: MESSAGE.PANEL_AI_SAVE, provider: 'openai', model: 'gpt-5', apiKey: 'injected' }, sender)).ok, false);
});

test('panel bridge supports config contract without automatic traffic or credential forwarding', async () => {
  const messages = []; const replies = []; let listener;
  const window = { addEventListener: (_, fn) => { listener = fn; }, postMessage: m => replies.push(m) };
  vm.runInNewContext(await readFile(new URL('../words-bridge.js', import.meta.url), 'utf8'), {
    location: new URL(sender.url), window, chrome: { runtime: { sendMessage: async message => {
      messages.push(message); return { ok: true, data: { settings: { provider: 'openai', model: 'gpt-5', providers: {} } } };
    } } },
  });
  assert.equal(messages.length, 0);
  for (const [action, fields, type] of [['get', {}, 'dualCaptions.panel.ai.get'], ['models', { provider: 'openai' }, 'dualCaptions.panel.ai.models'], ['save', { provider: 'openai', model: 'gpt-5' }, 'dualCaptions.panel.ai.save']]) {
    await listener({ source: window, origin: 'http://127.0.0.1:43817', data: { type: `subsanywhere.panel.ai.${action}`, requestId: action, ...fields } });
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type, ...fields });
    assert.equal(replies.at(-1).type, `subsanywhere.panel.ai.${action}.result`);
    assert.equal(replies.at(-1).ok, true);
  }
  await listener({ source: window, origin: 'http://127.0.0.1:43817', data: { type: 'subsanywhere.panel.ai.save', requestId: 'bad', provider: 'openai', model: 'gpt-5', apiKey: 'no' } });
  assert.equal(messages.length, 3);
});

test('all learning inference routes use panel client, never subtitle client', async () => {
  const item = { id: 1, language: 'zh', text: '你', pinyin: 'nǐ', translation: 'ты' };
  const calls = [];
  const panelAiClient = Object.fromEntries(['analyzeChinese', 'explainWord', 'explainSentence', 'translateSavedChineseWord'].map(method => [method, async record => {
    assert.deepEqual(record, item); calls.push(method); return method === 'analyzeChinese' ? analysis : 'result';
  }]));
  const controller = new BackgroundController(chrome, {}, {
    aiClient: new Proxy({}, { get: () => { throw new Error('Subtitle client must not be used'); } }), panelAiClient,
    vocabulary: { list: async () => ({ words: [item] }), listSentences: async () => ({ sentences: [item] }),
      saveAnalysis: async () => ({}), saveExplanation: async () => ({}), saveSentenceExplanation: async () => ({}), saveAiTranslations: async () => ({}) },
  });
  for (const type of [MESSAGE.WORD_ANALYZE, MESSAGE.SENTENCE_ANALYZE, MESSAGE.WORD_EXPLAIN, MESSAGE.SENTENCE_EXPLAIN, MESSAGE.WORD_TRANSLATE]) {
    assert.equal((await controller.handle({ type, id: 1 }, sender)).ok, true);
  }
  assert.deepEqual(calls, ['analyzeChinese', 'analyzeChinese', 'explainWord', 'explainSentence', 'translateSavedChineseWord']);
});

test('failed storage protection blocks all panel config and learning inference messages', async () => {
  let listener; let dispatched = 0;
  const source = (await readFile(new URL('../background.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  class Stub {}
  class Controller {
    initialize() { return Promise.resolve(); }
    handle() { dispatched++; return { ok: true }; }
  }
  vm.runInNewContext(source, {
    chrome: { storage: { local: { setAccessLevel: async () => { throw new Error('denied'); } } },
      runtime: { onMessage: { addListener: fn => { listener = fn; } } },
      tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } }, permissions: {} },
    AIClient: Stub, AiCredentialStore: Stub, PanelAiConfigStore: Stub, BackgroundController: Controller,
    StateStore: Stub, LocalSubtitleClient: Stub, VocabularyClient: Stub, SpeechService: Stub,
    fetch: async () => { throw new Error('No network'); }, MESSAGE, ok: data => ({ ok: true, data }), failure: error => ({ ok: false, error: error.message }),
  });
  for (const type of [MESSAGE.PANEL_AI_GET, MESSAGE.PANEL_AI_MODELS, MESSAGE.PANEL_AI_SAVE,
    MESSAGE.WORD_ANALYZE, MESSAGE.SENTENCE_ANALYZE, MESSAGE.WORD_TRANSLATE, MESSAGE.WORD_EXPLAIN, MESSAGE.SENTENCE_EXPLAIN]) {
    const response = await new Promise(resolve => listener({ type }, sender, resolve));
    assert.equal(response.ok, false); assert.match(response.error, /хранилище/);
  }
  assert.equal(dispatched, 0);
});

test('catalog discovery is explicit, requires a saved key and is invalidated by key replacement', async () => {
  const f = fixture(); const panel = new ai.PanelAiConfigStore(f.storage, f.credentials); let network = 0;
  const client = new ai.AIClient(async () => { network++; return Response.json({ data: [{ id: 'gpt-5' }] }); }, panel);
  await panel.listModels('openai', client);
  await f.credentials.patch({ provider: 'openai', apiKey: 'replacement' });
  await assert.rejects(panel.save({ provider: 'openai', model: 'gpt-5' }));
  await f.credentials.patch({ provider: 'openai', clearApiKey: true });
  await assert.rejects(panel.listModels('openai', client));
  assert.equal(network, 1); assert.equal(f.data[ai.PANEL_AI_CONFIG_KEY], undefined);
});

test('panel config inherits without writes then saves separately using discovered models and shared keys', async () => {
  assert.equal(typeof ai.PanelAiConfigStore, 'function');
  const f = fixture(); let catalogCalls = 0;
  const panel = new ai.PanelAiConfigStore(f.storage, f.credentials);
  const catalog = new ai.AIClient(async () => { catalogCalls++; return Response.json({ data: [{ id: 'gpt-5' }] }); }, f.credentials);
  const before = structuredClone(f.data[ai.AI_CONFIG_KEY]);
  assert.deepEqual(await panel.publicInfo(), { provider: 'deepseek', model: 'deepseek-chat', providers: { deepseek: { hasApiKey: true }, openai: { hasApiKey: true } } });
  assert.equal(f.writes.length, 0); assert.equal(catalogCalls, 0);
  await assert.rejects(panel.save({ provider: 'openai', model: 'gpt-5' }));
  assert.deepEqual(await panel.listModels('openai', catalog), ['gpt-5']);
  await assert.rejects(panel.save({ provider: 'openai', model: 'gpt-5-invented' }));
  await panel.save({ provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(f.data[ai.AI_CONFIG_KEY], before);
  assert.deepEqual(f.data[ai.PANEL_AI_CONFIG_KEY], { provider: 'openai', model: 'gpt-5' });
  const restarted = new ai.PanelAiConfigStore(f.storage, f.credentials);
  assert.equal((await restarted.getActive()).apiKey, 'test-openai');
  await f.credentials.patch({ provider: 'deepseek', model: 'deepseek-new', activate: true });
  assert.equal((await restarted.publicInfo()).model, 'gpt-5');
  assert.equal(JSON.stringify(await restarted.publicInfo()).includes('test-openai'), false);
  assert.equal(catalogCalls, 1);
});
