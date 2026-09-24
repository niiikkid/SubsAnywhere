import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor() { this.children = []; this.value = ''; this.disabled = false; this.listeners = {}; this.classes = new Set(); this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) }; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(node => node.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  click() { if (!this.disabled) this.listeners.click?.(); }
  change(value) { this.value = value; this.listeners.change?.(); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const settings = (provider = 'deepseek', model = 'saved-model', hasApiKey = true) => ({ provider, model, providers: { deepseek: { hasApiKey }, openai: { hasApiKey } } });
async function boot() {
  const html = readFileSync(new URL('../local-server/web/index.html', import.meta.url), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  elements['study-mode'].hidden = true;
  const messages = [], listeners = new Map(), timers = new Map();
  let sequence = 0;
  const window = {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    postMessage(data) { messages.push(data); },
  };
  vm.runInNewContext(readFileSync(new URL('../local-server/web/words.js', import.meta.url), 'utf8').replace(/^export /gm, ''), {
    window, document: { getElementById: id => elements[id], createElement: () => new Element(), createElementNS: () => new Element(), createDocumentFragment: () => new Element() },
    location: { origin: 'http://127.0.0.1:43817' }, crypto: { randomUUID: () => `req${++sequence}` },
    localStorage: { getItem: () => null }, AbortSignal,
    setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async path => ({ ok: true, json: async () => path === '/api/words' ? { words: [] } : { sentences: [] } }),
  });
  await tick();
  return { elements, html, messages, timers,
    requests: action => messages.filter(message => message.type === `subsanywhere.panel.ai.${action}`),
    async respond(request, result, origin = 'http://127.0.0.1:43817') {
      assert.ok(request, 'expected bridge request');
      for (const fn of [...(listeners.get('message') || [])]) fn({ source: window, origin, data: { type: `${request.type}.result`, requestId: request.requestId, ...result } });
      await tick();
    },
    async focus() { for (const fn of listeners.get('focus') || []) fn(); await tick(); },
  };
}

test('explicit catalog load offers only returned string IDs and explicit save is confirmed by readback', async () => {
  const panel = await boot();
  const el = panel.elements;
  await panel.respond(panel.requests('get')[0], { ok: true, settings: settings() });
  el['panel-ai-load'].click();
  assert.equal(panel.requests('models').length, 1);
  assert.deepEqual(Object.keys(panel.requests('models')[0]).sort(), ['provider', 'requestId', 'type']);
  assert.equal(el['panel-ai-save'].disabled, true);
  await panel.respond(panel.requests('models')[0], { ok: true, provider: 'deepseek', models: ['catalog-a', 'catalog-b'] });
  assert.deepEqual(el['panel-ai-model'].children.map(option => option.value), ['', 'catalog-a', 'catalog-b']);
  el['panel-ai-model'].change('saved-model');
  assert.equal(el['panel-ai-save'].disabled, true);
  el['panel-ai-model'].change('catalog-b');
  assert.equal(panel.requests('save').length, 0);
  el['panel-ai-save'].click();
  const save = panel.requests('save')[0];
  assert.deepEqual(JSON.parse(JSON.stringify(save)), { type: 'subsanywhere.panel.ai.save', requestId: save.requestId, provider: 'deepseek', model: 'catalog-b' });
  await panel.respond(save, { ok: true, settings: settings('deepseek', 'catalog-b') });
  assert.equal(panel.requests('get').length, 2);
  await panel.respond(panel.requests('get')[1], { ok: true, settings: settings('deepseek', 'catalog-b') });
  assert.match(el['panel-ai-saved'].textContent, /catalog-b/);
  assert.match(el['panel-ai-status'].textContent, /сохранены/);
  assert.equal(el['panel-ai-model'].value, 'catalog-b');
});

test('missing keys are actionable and prevent catalog requests', async () => {
  const panel = await boot();
  await panel.respond(panel.requests('get')[0], { ok: true, settings: settings('openai', '', false) });
  assert.match(panel.elements['panel-ai-status'].textContent, /API-ключ OpenAI.*расширения/);
  assert.equal(panel.elements['panel-ai-load'].disabled, true);
  panel.elements['panel-ai-load'].click();
  assert.equal(panel.requests('models').length, 0);
  assert.equal(panel.elements['panel-ai-save'].disabled, true);
  assert.doesNotMatch(panel.html, /id="panel-ai-(?:key|reasoning)"/);
});

test('late provider catalog replies cannot replace the current provider catalog', async () => {
  const panel = await boot();
  const el = panel.elements;
  await panel.respond(panel.requests('get')[0], { ok: true, settings: settings() });
  el['panel-ai-load'].click();
  const oldRequest = panel.requests('models')[0];
  el['panel-ai-provider'].change('openai');
  assert.equal(el['panel-ai-save'].disabled, true);
  el['panel-ai-load'].click();
  await panel.respond(panel.requests('models')[1], { ok: true, provider: 'openai', models: ['openai-catalog'] });
  el['panel-ai-model'].change('openai-catalog');
  await panel.respond(oldRequest, { ok: true, provider: 'deepseek', models: ['stale-model'] });
  assert.equal(el['panel-ai-provider'].value, 'openai');
  assert.equal(el['panel-ai-model'].value, 'openai-catalog');
  assert.equal(el['panel-ai-save'].disabled, false);
  assert.doesNotMatch(el['panel-ai-model'].textContent, /stale-model/);
  assert.match(el['panel-ai-saved'].textContent, /saved-model/);
});

for (const result of [
  { ok: false, error: 'Каталог недоступен' },
  { ok: true, provider: 'deepseek', models: [] },
  { ok: true, provider: 'openai', models: ['wrong-provider'] },
  { ok: true, provider: 'deepseek', models: [{ id: 'not-the-contract' }] },
]) test(`catalog failure keeps Save disabled: ${JSON.stringify(result)}`, async () => {
  const panel = await boot();
  await panel.respond(panel.requests('get')[0], { ok: true, settings: settings() });
  panel.elements['panel-ai-load'].click();
  await panel.respond(panel.requests('models')[0], result);
  assert.equal(panel.elements['panel-ai-save'].disabled, true);
  assert.equal(panel.elements['panel-ai-load'].disabled, false);
  assert.ok(panel.elements['panel-ai-status'].classes.has('error'));
});

test('failed explicit save retains draft, catalog, saved label and visible error for retry', async () => {
  const panel = await boot();
  const el = panel.elements;
  await panel.respond(panel.requests('get')[0], { ok: true, settings: settings() });
  el['panel-ai-load'].click();
  await panel.respond(panel.requests('models')[0], { ok: true, provider: 'deepseek', models: ['new-model'] });
  el['panel-ai-model'].change('new-model');
  el['panel-ai-save'].click();
  assert.equal(el['panel-ai-provider'].disabled, true);
  assert.equal(el['panel-ai-model'].disabled, true);
  await panel.respond(panel.requests('save')[0], { ok: false, error: 'Не удалось сохранить' });
  assert.equal(el['panel-ai-model'].value, 'new-model');
  assert.equal(el['panel-ai-save'].disabled, false);
  assert.match(el['panel-ai-saved'].textContent, /saved-model/);
  assert.equal(el['panel-ai-status'].textContent, 'Не удалось сохранить');
  assert.ok(el['panel-ai-status'].classes.has('error'));
  el['panel-ai-save'].click();
  assert.equal(panel.requests('save').length, 2);
});

test('wrong-origin hydration is ignored; startup controls stay locked until settings arrive', async () => {
  const panel = await boot();
  assert.equal(panel.elements['panel-ai-provider'].disabled, true);
  await panel.respond(panel.requests('get')[0], { ok: true, settings: settings() }, 'https://wrong.test');
  assert.equal(panel.elements['panel-ai-provider'].disabled, true);
  await panel.respond(panel.requests('get')[0], { ok: true, settings: settings() });
  assert.equal(panel.elements['panel-ai-provider'].disabled, false);
});

test('timeout reports an actionable error and late hydration cannot silently activate settings', async () => {
  const panel = await boot();
  for (const fn of [...panel.timers.values()]) fn();
  await tick();
  assert.match(panel.elements['panel-ai-status'].textContent, /chrome:\/\/extensions/);
  await panel.respond(panel.requests('get')[0], { ok: true, settings: settings() });
  assert.equal(panel.elements['panel-ai-provider'].disabled, true);
  assert.equal(panel.requests('models').length, 0);
});

test('panel settings hydrate once without fetching a catalog; saved model cannot yet be saved', async () => {
  const panel = await boot();
  assert.equal(panel.requests('get').length, 1);
  assert.deepEqual(Object.keys(panel.requests('get')[0]).sort(), ['requestId', 'type']);
  await panel.respond(panel.requests('get')[0], { ok: true, settings: settings() });
  assert.equal(panel.elements['panel-ai-provider'].value, 'deepseek');
  assert.equal(panel.elements['panel-ai-model'].value, 'saved-model');
  assert.equal(panel.elements['panel-ai-model'].disabled, true);
  assert.equal(panel.elements['panel-ai-save'].disabled, true);
  assert.match(panel.elements['panel-ai-saved'].textContent, /saved-model/);
  await panel.focus();
  panel.elements['panel-ai-provider'].change('openai');
  assert.equal(panel.requests('get').length, 1);
  assert.equal(panel.requests('models').length, 0);
  assert.equal(panel.requests('save').length, 0);
});
