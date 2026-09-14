import test from 'node:test';
import assert from 'node:assert/strict';

class FakeClassList {
  values = new Set();
  toggle(name, force) { if (force) this.values.add(name); else this.values.delete(name); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() { this.focused = true; }
}

function makeDocument() {
  const ids = [
    'controls', 'status', 'player', 'originalTrack',
    'fontSize', 'subtitleColor', 'subtitleBackground', 'subtitleBackgroundColor', 'subtitleBackgroundOpacity', 'subtitleBackgroundOpacityValue', 'fontSizeValue', 'externalList',
    'syncBox', 'syncTrack', 'offsetSeconds', 'timeScalePercent', 'activate', 'restartSearch', 'subtitleFile',
    'deepseekKey', 'deepseekModel', 'saveDeepseekKey', 'clearDeepseekKey', 'aiKeyState',
    'youtubeSubtitles', 'youtubeSubtitleStatus', 'createYoutubeSubtitles',
    'youtubeProgressBox', 'youtubeProgress', 'youtubeProgressValue', 'youtubeProgressDetail', 'youtubeLanguage',
    'playerTab', 'appearanceTab', 'settingsTab', 'playerPanel', 'appearancePanel', 'settingsPanel',
    'subtitlePreview', 'inlineTranslations', 'saveStatus', 'retrySave', 'retryYoutubeSubtitles', 'retrySettings', 'pageScope',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements.controls.hidden = true;
  const shiftButtons = [-5, -1, -0.1, 0.1, 1, 5].map((shift) => {
    const button = new FakeElement('button');
    button.dataset.shift = String(shift);
    return button;
  });
  return {
    elements,
    defaultView: new FakeElement(),
    getElementById(id) { return elements[id]; },
    createElement(tag) { return new FakeElement(tag); },
    querySelectorAll(selector) { return selector === '[data-shift]' ? shiftButtons : []; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
let popupInstance = 0;
async function bootPopup(overrides = {}, tab = { id: 77, url: 'https://video.example/episode-1' }) {
  const document = makeDocument();
  const messages = [];
  const handlers = {
    'dualCaptions.state.get': () => ({ state: {} }),
    'dualCaptions.player.get': () => ({ players: [] }),
    'dualCaptions.ai.get': () => ({ hasApiKey: false, model: 'deepseek-v4-flash' }),
    'dualCaptions.state.patch': () => ({ state: {} }),
    ...overrides,
  };
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: () => Promise.resolve(tab).then((value) => [value]) },
    runtime: { async sendMessage(message) {
      messages.push(structuredClone(message));
      if (!handlers[message.type]) throw new Error(`Unexpected message: ${message.type}`);
      return { ok: true, data: await handlers[message.type](message) };
    } },
    permissions: { request: async () => true },
  };
  await import(`../popup.js?regression=${++popupInstance}`);
  await tick();
  return { elements: document.elements, document, messages, handlers };
}

test('inline translations toggle hydrates, previews and saves immediately', async () => {
  const { elements, messages } = await bootPopup({
    'dualCaptions.state.get': () => ({ state: { settings: { inlineTranslations: true } } }),
  });
  assert.equal(elements.inlineTranslations.checked, true);
  assert.ok(elements.subtitlePreview.children.length > 0);
  elements.inlineTranslations.checked = false;
  elements.inlineTranslations.listeners.get('change')();
  assert.deepEqual(messages.filter((message) => message.type === 'dualCaptions.state.patch').at(-1).patch, { inlineTranslations: false });
  assert.equal(elements.subtitlePreview.textContent, 'One line at a time.');
});

test('manual generation forwards the selected speech language and imports its label', async () => {
  for (const language of ['en', 'zh', '']) {
    const expected = language || 'zh';
    const { elements, messages } = await bootPopup({
      'dualCaptions.state.get': () => ({ state: { settings: { youtubeLanguage: language } } }),
      'dualCaptions.localSubtitle.status': () => ({ status: 'missing' }),
      'dualCaptions.localSubtitle.existing': () => ({ status: 'missing' }),
      'dualCaptions.localSubtitle.generate': () => ({ status: 'ready', source: 'generated', language: expected,
        srt: '1\n00:00:00,000 --> 00:00:01,000\nHello, 你好\n' }),
      'dualCaptions.track.upsertLocal': (m) => ({ state: { settings: { youtubeLanguage: language }, externalTracks: [m.track] } }),
    }, { id: 77, url: 'https://www.youtube.com/watch?v=0Zaxca2sUGs' });
    await tick();
    assert.match(elements.youtubeSubtitleStatus.textContent, /Выберите язык речи/);
    elements.createYoutubeSubtitles.listeners.get('click')();
    await tick();
    await tick();
    assert.equal(messages.find((m) => m.type === 'dualCaptions.localSubtitle.generate').language, expected);
    const track = messages.find((m) => m.type === 'dualCaptions.track.upsertLocal').track;
    assert.equal(track.language, expected);
    assert.match(track.name, expected === 'en' ? /^Английские/ : /^Китайские с пиньинем/);
  }
});

test('YouTube language choice persists and is forwarded when loading captions', async () => {
  const { elements, messages } = await bootPopup({
    'dualCaptions.state.get': () => ({ state: { settings: { youtubeLanguage: 'zh' } } }),
    'dualCaptions.localSubtitle.status': () => ({ status: 'missing' }),
    'dualCaptions.localSubtitle.existing': () => ({ status: 'missing', language_required: true }),
  }, { id: 77, url: 'https://www.youtube.com/watch?v=0Zaxca2sUGs' });
  await tick();
  assert.equal(elements.youtubeLanguage.value, 'zh');
  assert.equal(messages.find((m) => m.type === 'dualCaptions.localSubtitle.existing').language, 'zh');
  elements.youtubeLanguage.value = 'en';
  elements.youtubeLanguage.listeners.get('change')();
  await tick();
  await tick();
  assert.ok(messages.some((m) => m.type === 'dualCaptions.state.patch' && m.patch.youtubeLanguage === 'en'));
  assert.equal(messages.filter((m) => m.type === 'dualCaptions.localSubtitle.existing').at(-1).language, 'en');
});

test('choosing a YouTube language selects its track instead of reloading generated Chinese captions', async () => {
  const { elements, messages } = await bootPopup({
    'dualCaptions.state.get': () => ({ state: { settings: { secondTrackId: 'external:generated-old' } } }),
    'dualCaptions.localSubtitle.status': () => ({ status: 'missing' }),
    'dualCaptions.localSubtitle.existing': (m) => m.language === 'en'
      ? { status: 'ready', source: 'youtube', language: 'en', srt: '1\n00:00:00,000 --> 00:00:01,000\nHello\n' }
      : { status: 'missing' },
    'dualCaptions.track.upsertLocal': (m) => ({ state: { settings: { secondTrackId: 'external:generated-old' }, externalTracks: [m.track] } }),
  }, { id: 77, url: 'https://www.youtube.com/watch?v=1evO3Nekrr8' });
  await tick();
  messages.length = 0;
  elements.youtubeLanguage.value = 'en';
  elements.youtubeLanguage.listeners.get('change')();
  await tick();
  await tick();
  assert.equal(messages.some((m) => m.type === 'dualCaptions.localSubtitle.status'), false);
  assert.ok(messages.some((m) => m.type === 'dualCaptions.state.patch'
    && m.patch.secondTrackId === 'external:youtube-1evO3Nekrr8-youtube'));
  assert.equal(messages.find((m) => m.type === 'dualCaptions.track.upsertLocal').track.language, 'en');
});

test('state and AI hydrate while the cached player request is still pending', async () => {
  const cache = deferred();
  const { elements, messages } = await bootPopup({
    'dualCaptions.player.get': () => cache.promise,
    'dualCaptions.state.get': () => ({ state: { settings: { fontSize: 34 } } }),
    'dualCaptions.ai.get': () => ({ hasApiKey: true, model: 'deepseek-v4-pro' }),
  });
  assert.equal(elements.fontSize.value, 34);
  assert.equal(elements.deepseekModel.value, 'deepseek-v4-pro');
  assert.equal(elements.controls.hidden, false);
  assert.equal(messages.find((message) => message.type === 'dualCaptions.player.get').cachedOnly, true);
  cache.resolve({ players: [] });
  await tick();
});

test('production popup startup performs read-only hydration and never overwrites settings', async () => {
  const document = makeDocument();
  const messages = [];
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 77, url: 'https://video.example/episode-1', title: 'Example S01E01' }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') {
          return {
            ok: true,
            data: {
              state: {
                schemaVersion: 1,
                settings: {
                  firstTrackId: 'track-not-ready', secondTrackId: '', firstBottom: 23,
                  secondBottom: 7, fontSize: 29, selectedPlayerKey: 'saved-player',
                },
                externalTracks: [],
              },
            },
          };
        }
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [] } };
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false } };
        throw new Error(`Unexpected startup write: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?startup-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(messages.map((message) => message.type).sort(), [
    'dualCaptions.ai.get',
    'dualCaptions.player.get',
    'dualCaptions.state.get',
  ]);
  assert.equal(messages.find((message) => message.type === 'dualCaptions.state.get').pageKey, 'https://video.example/episode-1');
  assert.equal(document.elements.controls.hidden, false);
  assert.equal(document.elements.fontSize.value, 29);
  assert.equal(messages.find((message) => message.type === 'dualCaptions.player.get').cachedOnly, true);
  assert.equal(document.elements.status.textContent, 'Нажмите «Подключить к плееру» на странице с видео.');
});

test('rapid appearance input is sent before popup teardown and survives late hydration', async () => {
  const stored = deferred();
  const writes = deferred();
  const { elements, messages } = await bootPopup({
    'dualCaptions.state.get': () => stored.promise,
    'dualCaptions.state.patch': () => writes.promise,
  });
  for (const value of [25, 31, 38]) {
    elements.fontSize.value = value;
    elements.fontSize.listeners.get('input')();
  }
  assert.deepEqual(messages.filter((message) => message.type === 'dualCaptions.state.patch').map((message) => message.patch), [
    { fontSize: 25 }, { fontSize: 31 }, { fontSize: 38 },
  ]);
  stored.resolve({ state: { settings: { fontSize: 19, subtitleColor: '#123456' } } });
  await tick();
  assert.equal(elements.fontSize.value, 38);
  assert.equal(elements.subtitleColor.value, '#123456');
  writes.resolve({ state: { settings: { fontSize: 25 } } });
  await tick();
  assert.equal(elements.fontSize.value, 38);
});

test('navigation opens appearance without a player and previews each style immediately', async () => {
  const { elements } = await bootPopup();
  elements.appearanceTab.listeners.get('click')();
  assert.equal(elements.appearancePanel.hidden, false);
  assert.equal(elements.playerPanel.hidden, true);
  assert.equal(elements.settingsPanel.hidden, true);
  assert.equal(elements.appearanceTab.attributes['aria-selected'], 'true');
  elements.fontSize.value = 36;
  elements.fontSize.listeners.get('input')();
  elements.subtitleColor.value = '#abcdef';
  elements.subtitleColor.listeners.get('input')();
  elements.subtitleBackground.checked = true;
  elements.subtitleBackground.listeners.get('change')();
  elements.subtitleBackgroundColor.value = '#123456';
  elements.subtitleBackgroundColor.listeners.get('input')();
  elements.subtitleBackgroundOpacity.value = 50;
  elements.subtitleBackgroundOpacity.listeners.get('input')();
  assert.equal(elements.subtitlePreview.style.fontSize, '36px');
  assert.equal(elements.subtitlePreview.style.color, '#abcdef');
  assert.equal(elements.subtitlePreview.style.backgroundColor, 'rgba(18, 52, 86, 0.5)');
  elements.settingsTab.listeners.get('click')();
  assert.equal(elements.appearancePanel.hidden, true);
  assert.equal(elements.settingsPanel.hidden, false);
  await tick();
});

test('failed saves remain visible across other successes and retry the latest value', async () => {
  let failFont = true;
  const { elements, messages } = await bootPopup({
    'dualCaptions.state.patch': (message) => {
      if (failFont && 'fontSize' in message.patch) throw new Error('storage full');
      return { state: {} };
    },
  });
  elements.fontSize.value = 37;
  elements.fontSize.listeners.get('input')();
  assert.match(elements.saveStatus.textContent, /Сохраня/);
  await tick();
  elements.subtitleColor.value = '#abcabc';
  elements.subtitleColor.listeners.get('input')();
  await tick();
  assert.equal(elements.retrySave.hidden, false);
  assert.match(elements.saveStatus.textContent, /storage full/);
  failFont = false;
  elements.retrySave.listeners.get('click')();
  await tick();
  assert.deepEqual(messages.filter((message) => message.patch?.fontSize).map((message) => message.patch.fontSize), [37, 37]);
  assert.equal(elements.retrySave.hidden, true);
  assert.match(elements.saveStatus.textContent, /Сохранено/);
});

test('AI hydrates before tab lookup while page edits wait for an exact persistence scope', async () => {
  const tab = deferred();
  const { elements, messages } = await bootPopup({
    'dualCaptions.ai.get': () => ({ hasApiKey: true, model: 'deepseek-v4-pro' }),
  }, tab.promise);
  assert.equal(elements.deepseekModel.value, 'deepseek-v4-pro');
  assert.equal(elements.fontSize.disabled, true);
  elements.fontSize.value = 40;
  elements.fontSize.listeners.get('input')();
  assert.equal(messages.some((message) => message.type === 'dualCaptions.state.patch'), false);
  tab.resolve({ id: 5, url: 'https://video.example/exact-page' });
  await tick();
  assert.equal(elements.fontSize.disabled, false);
});

test('failed settings hydration remains visible and can be retried without resetting edits', async () => {
  let fail = true;
  const { elements, messages } = await bootPopup({
    'dualCaptions.state.get': () => {
      if (fail) throw new Error('storage unavailable');
      return { state: { settings: { fontSize: 18, subtitleColor: '#112233' } } };
    },
    'dualCaptions.ai.get': () => {
      if (fail) throw new Error('AI config unavailable');
      return { hasApiKey: true, model: 'deepseek-v4-pro' };
    },
  });
  assert.equal(elements.retrySettings.hidden, false);
  assert.match(elements.aiKeyState.textContent, /AI config unavailable/);
  elements.fontSize.value = 35;
  elements.fontSize.listeners.get('input')();
  fail = false;
  elements.retrySettings.listeners.get('click')();
  await tick();
  assert.equal(elements.fontSize.value, 35);
  assert.equal(elements.subtitleColor.value, '#112233');
  assert.equal(elements.deepseekModel.value, 'deepseek-v4-pro');
  assert.equal(elements.retrySettings.hidden, true);
  assert.equal(messages.filter((message) => message.type === 'dualCaptions.state.patch').length, 1);
});

test('restricted tabs keep appearance and AI editable without requesting player access', async () => {
  const { elements, messages } = await bootPopup({}, { id: 3, url: 'chrome://extensions/' });
  assert.equal(elements.activate.disabled, true);
  assert.equal(messages.some((message) => message.type === 'dualCaptions.player.get'), false);
  elements.fontSize.value = 32;
  elements.fontSize.listeners.get('input')();
  assert.equal(messages.at(-1).pageKey, 'chrome://extensions/');
  assert.equal(elements.deepseekModel.disabled, false);
  assert.match(elements.status.textContent, /служебн/);
  await tick();
});

test('restart search repeats player discovery and restores the selected player', async () => {
  const document = makeDocument();
  const messages = [];
  const player = { frameId: 12, key: 'player-12', title: 'Reloaded player', tracks: [] };
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 77, url: 'https://video.example/episode-1' }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') return { ok: true, data: { state: {} } };
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [player] } };
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false } };
        if (message.type === 'dualCaptions.player.discover') return { ok: true, data: { players: [player] } };
        if (message.type === 'dualCaptions.player.select') return { ok: true, data: { state: {} } };
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?restart-search-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  messages.length = 0;

  assert.equal(document.elements.restartSearch.hidden, false);
  document.elements.restartSearch.listeners.get('click')();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(messages.map((message) => message.type), [
    'dualCaptions.player.discover',
    'dualCaptions.player.select',
  ]);
  assert.equal(document.elements.status.textContent, 'Поиск субтитров перезапущен. Найдено плееров: 1.');
});

test('rapid timing adjustments are handed off immediately and keep their final optimistic value', async () => {
  const track = { id: 'manual', name: 'Manual', cues: [{ start: 0, end: 1, text: 'hello' }], offsetSeconds: 0, timeScale: 1 };
  const saving = deferred();
  const { elements, document, messages } = await bootPopup({
    'dualCaptions.state.get': () => ({ state: { externalTracks: [track] } }),
    'dualCaptions.track.timing': () => saving.promise,
  });
  const button = document.querySelectorAll('[data-shift]').find((item) => item.dataset.shift === '1');
  button.listeners.get('click')();
  button.listeners.get('click')();
  elements.timeScalePercent.value = 101;
  elements.timeScalePercent.listeners.get('change')();
  assert.deepEqual(messages.filter((message) => message.type === 'dualCaptions.track.timing').map((message) => [message.offsetSeconds, message.timeScale]), [[1, 1], [2, 1], [2, 1.01]]);
  saving.resolve({ state: { externalTracks: [track] } });
  await tick();
  assert.equal(elements.offsetSeconds.value, 2);
  assert.equal(elements.timeScalePercent.value, 101);
});

test('manual SRT import cannot reset an appearance edit made while storage was pending', async () => {
  const stored = deferred();
  const { elements, messages } = await bootPopup({ 'dualCaptions.track.add': () => stored.promise });
  elements.subtitleFile.listeners.get('change')({ target: { files: [{ name: 'manual.srt', size: 50, arrayBuffer: async () => new TextEncoder().encode('1\n00:00:00,000 --> 00:00:01,000\nhello\n').buffer }] } });
  await tick();
  elements.fontSize.value = 42;
  elements.fontSize.listeners.get('input')();
  const track = messages.find((message) => message.type === 'dualCaptions.track.add').track;
  stored.resolve({ state: { settings: {}, externalTracks: [track] } });
  await tick();
  assert.equal(elements.fontSize.value, 42);
  assert.equal(elements.externalList.children.length, 1);
});

test('deleting an SRT clears its selection without resetting a newer appearance edit', async () => {
  const removed = deferred();
  const track = { id: 'manual', cues: [{ start: 0, end: 1, text: 'hello' }] };
  const { elements } = await bootPopup({
    'dualCaptions.state.get': () => ({ state: { externalTracks: [track] } }),
    'dualCaptions.track.remove': () => removed.promise,
  });
  elements.originalTrack.value = 'external:manual';
  elements.originalTrack.listeners.get('change')();
  elements.externalList.children[0].children[2].listeners.get('click')();
  elements.fontSize.value = 44;
  elements.fontSize.listeners.get('input')();
  removed.resolve({ state: { settings: { fontSize: 22 }, externalTracks: [] } });
  await tick();
  assert.equal(elements.fontSize.value, 44);
  assert.equal(elements.originalTrack.value, '');
});

test('validation errors are visible while the settings panel is open', async () => {
  const { elements } = await bootPopup();
  elements.settingsTab.listeners.get('click')();
  elements.saveDeepseekKey.listeners.get('click')();
  await tick();
  assert.match(elements.saveStatus.textContent, /Вставьте API-ключ/);
  assert.equal(elements.saveStatus.classList.values.has('error'), true);
});

test('late player selection cannot reset appearance edited while connecting', async () => {
  const selecting = deferred();
  const player = { frameId: 12, key: 'saved', tracks: [] };
  const { elements } = await bootPopup({
    'dualCaptions.player.discover': () => ({ players: [player] }),
    'dualCaptions.player.select': () => selecting.promise,
  });
  elements.activate.listeners.get('click')();
  await tick();
  elements.fontSize.value = 41;
  elements.fontSize.listeners.get('input')();
  selecting.resolve({ state: { settings: { fontSize: 22 } } });
  await tick();
  assert.equal(elements.fontSize.value, 41);
});

test('late AI hydration and key replies preserve edited model and newly typed key', async () => {
  const loading = deferred();
  const saving = deferred();
  const { elements } = await bootPopup({
    'dualCaptions.ai.get': () => loading.promise,
    'dualCaptions.ai.patch': (message) => 'apiKey' in message ? saving.promise : { hasApiKey: false, model: message.model },
  });
  elements.deepseekModel.value = 'deepseek-v4-pro';
  elements.deepseekModel.listeners.get('change')();
  elements.deepseekKey.value = 'test-key-one';
  elements.saveDeepseekKey.listeners.get('click')();
  elements.deepseekKey.value = 'test-key-two';
  loading.resolve({ hasApiKey: false, model: 'deepseek-v4-flash' });
  await tick();
  assert.equal(elements.deepseekModel.value, 'deepseek-v4-pro');
  saving.resolve({ hasApiKey: true, model: 'deepseek-v4-flash' });
  await tick();
  assert.equal(elements.deepseekKey.value, 'test-key-two');
  assert.equal(elements.deepseekModel.value, 'deepseek-v4-pro');
});

test('saving a key immediately after choosing Pro keeps the chosen model', async () => {
  const document = makeDocument();
  const messages = [];
  let releaseModelPatch;
  const modelPatch = new Promise((resolve) => { releaseModelPatch = resolve; });
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 77, url: 'https://video.example/episode-1' }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') return { ok: true, data: { state: {} } };
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [] } };
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false, model: 'deepseek-v4-flash' } };
        if (message.type === 'dualCaptions.ai.patch' && !('apiKey' in message)) {
          await modelPatch;
          return { ok: true, data: { hasApiKey: false, model: 'deepseek-v4-pro' } };
        }
        if (message.type === 'dualCaptions.ai.patch') return { ok: true, data: { hasApiKey: true, model: message.model } };
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?ai-model-race-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.elements.deepseekModel.value = 'deepseek-v4-pro';
  document.elements.deepseekModel.listeners.get('change')();
  document.elements.deepseekKey.value = 'secret-key';
  document.elements.saveDeepseekKey.listeners.get('click')();

  const keyPatch = messages.find((message) => message.type === 'dualCaptions.ai.patch' && 'apiKey' in message);
  assert.equal(keyPatch.model, 'deepseek-v4-pro');
  releaseModelPatch();
});

test('running YouTube downloads poll their own endpoint without blocking appearance', async () => {
  let downloads = 0;
  const { elements, messages, document } = await bootPopup({
    'dualCaptions.localSubtitle.status': () => ({ status: 'missing' }),
    'dualCaptions.localSubtitle.existing': () => ++downloads === 1
      ? { status: 'running', source: 'youtube', stage: 'downloading' }
      : { status: 'ready', source: 'youtube', srt: '1\n00:00:00,000 --> 00:00:01,000\n你好\n' },
    'dualCaptions.track.upsertLocal': (message) => ({ state: { settings: { fontSize: 22 }, externalTracks: [message.track] } }),
  }, { id: 88, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' });
  assert.doesNotMatch(elements.youtubeSubtitleStatus.textContent, /субтитров нет/i);
  elements.appearanceTab.listeners.get('click')();
  elements.fontSize.value = 40;
  elements.fontSize.listeners.get('input')();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(downloads, 2);
  assert.equal(messages.filter((message) => message.type === 'dualCaptions.localSubtitle.status').length, 1);
  assert.equal(elements.fontSize.value, 40);
  assert.match(elements.youtubeSubtitleStatus.textContent, /сохранены/i);
  assert.equal(elements.appearancePanel.hidden, false);
  document.defaultView.listeners.get('pagehide')();
});

test('interrupted generation is an error and server retry resumes status without starting a job', async () => {
  let available = false;
  const { elements, messages } = await bootPopup({
    'dualCaptions.localSubtitle.status': () => available ? { status: 'missing' } : { status: 'error', error: 'Generation interrupted by server restart; retry.' },
    'dualCaptions.localSubtitle.existing': () => ({ status: 'missing' }),
  }, { id: 88, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' });
  assert.match(elements.youtubeSubtitleStatus.textContent, /interrupted/);
  assert.equal(elements.retryYoutubeSubtitles.hidden, false);
  assert.equal(elements.createYoutubeSubtitles.disabled, false);
  available = true;
  elements.retryYoutubeSubtitles.listeners.get('click')();
  await tick();
  assert.equal(elements.youtubeSubtitleStatus.classList.values.has('error'), false);
  assert.equal(elements.retryYoutubeSubtitles.hidden, true);
  assert.equal(messages.filter((message) => message.type === 'dualCaptions.localSubtitle.status').length, 2);
  assert.equal(messages.some((message) => message.type === 'dualCaptions.localSubtitle.generate'), false);
});

test('a lost generation response requires status recovery instead of enabling duplicate creation', async () => {
  const { elements } = await bootPopup({
    'dualCaptions.localSubtitle.status': () => ({ status: 'missing' }),
    'dualCaptions.localSubtitle.existing': () => ({ status: 'missing' }),
    'dualCaptions.localSubtitle.generate': () => { throw new Error('timeout'); },
  }, { id: 88, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' });
  elements.createYoutubeSubtitles.listeners.get('click')();
  await tick();
  assert.equal(elements.createYoutubeSubtitles.disabled, true);
  assert.equal(elements.retryYoutubeSubtitles.hidden, false);
  assert.match(elements.youtubeSubtitleStatus.textContent, /timeout/);
});

test('late local import preserves a newer manual selection and appearance', async () => {
  const storing = deferred();
  const { elements, messages } = await bootPopup({
    'dualCaptions.localSubtitle.status': () => ({ status: 'missing' }),
    'dualCaptions.localSubtitle.existing': () => ({ status: 'ready', source: 'youtube', srt: '1\n00:00:00,000 --> 00:00:01,000\n你好\n' }),
    'dualCaptions.track.upsertLocal': () => storing.promise,
  }, { id: 88, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' });
  elements.originalTrack.value = 'native:manual';
  elements.originalTrack.listeners.get('change')();
  elements.fontSize.value = 39;
  elements.fontSize.listeners.get('input')();
  const track = messages.find((message) => message.track)?.track;
  storing.resolve({ state: { settings: {}, externalTracks: [track] } });
  await tick();
  assert.deepEqual(messages.filter((message) => message.patch?.secondTrackId).map((message) => message.patch.secondTrackId), ['native:manual']);
  assert.equal(elements.originalTrack.value, 'native:manual');
  assert.equal(elements.fontSize.value, 39);
  assert.match(elements.youtubeSubtitleStatus.textContent, /сохранены/);
  assert.doesNotMatch(elements.youtubeSubtitleStatus.textContent, /подключены/);
});

test('popup teardown does not schedule selection from an unfinished local import', async () => {
  const stored = deferred();
  const { document, messages } = await bootPopup({
    'dualCaptions.localSubtitle.status': () => ({ status: 'missing' }),
    'dualCaptions.localSubtitle.existing': () => ({ status: 'ready', source: 'youtube', srt: '1\n00:00:00,000 --> 00:00:01,000\n你好\n' }),
    'dualCaptions.track.upsertLocal': () => stored.promise,
  }, { id: 88, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' });
  document.defaultView.listeners.get('pagehide')();
  const track = messages.find((message) => message.track).track;
  stored.resolve({ state: { externalTracks: [track] } });
  await tick();
  assert.equal(messages.some((message) => message.type === 'dualCaptions.state.patch'), false);
});

test('explicit generation replaces an earlier manual selection in storage and the dropdown', async () => {
  const { elements } = await bootPopup({
    'dualCaptions.localSubtitle.status': () => ({ status: 'missing' }),
    'dualCaptions.localSubtitle.existing': () => ({ status: 'missing' }),
    'dualCaptions.localSubtitle.generate': () => ({ status: 'ready', source: 'generated', srt: '1\n00:00:00,000 --> 00:00:01,000\n你好\n' }),
    'dualCaptions.track.upsertLocal': (message) => ({ state: { externalTracks: [message.track] } }),
    'dualCaptions.state.patch': (message) => ({ state: { settings: message.patch } }),
  }, { id: 88, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' });
  elements.originalTrack.value = 'native:old';
  elements.originalTrack.listeners.get('change')();
  elements.createYoutubeSubtitles.listeners.get('click')();
  await tick();
  assert.equal(elements.originalTrack.value, 'external:youtube-rwnyaH6cTDE-generated');
});

test('generated readiness never claims a missing YouTube track was saved', async () => {
  const track = { id: 'youtube-rwnyaH6cTDE-generated', cues: [{ start: 0, end: 1, text: '你好' }] };
  const { elements } = await bootPopup({
    'dualCaptions.localSubtitle.status': () => ({ status: 'ready', source: 'generated', srt: '1\n00:00:00,000 --> 00:00:01,000\n你好\n' }),
    'dualCaptions.localSubtitle.existing': () => ({ status: 'missing' }),
    'dualCaptions.track.upsertLocal': () => ({ state: { externalTracks: [track] } }),
  }, { id: 88, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' });
  assert.match(elements.youtubeSubtitleStatus.textContent, /Созданные субтитры/);
  assert.doesNotMatch(elements.youtubeSubtitleStatus.textContent, /также сохранена/);
});

test('YouTube startup downloads ready Chinese subtitles without starting recognition', async () => {
  const document = makeDocument();
  const messages = [];
  const player = {
    frameId: 0,
    key: 'youtube-player',
    title: 'YouTube',
    tracks: [],
  };
  const localTrack = {
    id: 'youtube-rwnyaH6cTDE-youtube',
    name: 'Китайские с пиньинем — YouTube',
    language: 'zh',
    sourceType: 'local-server',
    cues: [{ start: 0, end: 1, text: '你好' }],
    offsetSeconds: 0,
    timeScale: 1,
  };
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 88, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') return { ok: true, data: { state: {} } };
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [player] } };
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false } };
        if (message.type === 'dualCaptions.localSubtitle.status') return { ok: true, data: { status: 'missing' } };
        if (message.type === 'dualCaptions.localSubtitle.existing') {
          return {
            ok: true,
            data: {
              status: 'ready',
              source: 'youtube',
              srt: '1\n00:00:00,000 --> 00:00:01,000\n你好\n',
            },
          };
        }
        if (message.type === 'dualCaptions.track.upsertLocal') {
          assert.deepEqual(message.track, localTrack);
          return { ok: true, data: { state: { settings: {}, externalTracks: [localTrack] } } };
        }
        if (message.type === 'dualCaptions.state.patch') {
          assert.deepEqual(message.patch, { secondTrackId: 'external:youtube-rwnyaH6cTDE-youtube' });
          return {
            ok: true,
            data: {
              state: {
                settings: { secondTrackId: message.patch.secondTrackId },
                externalTracks: [localTrack],
              },
            },
          };
        }
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?youtube-existing-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(document.elements.youtubeSubtitles.hidden, false);
  assert.match(document.elements.youtubeSubtitleStatus.textContent, /подключены/i);
  assert.equal(messages.some((message) => message.type === 'dualCaptions.localSubtitle.generate'), false);
  assert.deepEqual(messages.filter((message) => message.type.startsWith('dualCaptions.localSubtitle')).map((message) => message.type), [
    'dualCaptions.localSubtitle.status',
    'dualCaptions.localSubtitle.existing',
  ]);
});

test('YouTube recognition starts only after the create button is clicked', async () => {
  const document = makeDocument();
  const messages = [];
  const track = {
    id: 'youtube-rwnyaH6cTDE-generated',
    name: 'Китайские с пиньинем — распознаны локально',
    language: 'zh',
    sourceType: 'local-server',
    cues: [{ start: 0, end: 1, text: '自己' }],
    offsetSeconds: 0,
    timeScale: 1,
  };
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 89, url: 'https://youtu.be/rwnyaH6cTDE' }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') {
          return {
            ok: true,
            data: { state: { settings: { secondTrackId: 'external:youtube-rwnyaH6cTDE-youtube' } } },
          };
        }
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [] } };
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false } };
        if (message.type === 'dualCaptions.localSubtitle.status') return { ok: true, data: { status: 'missing' } };
        if (message.type === 'dualCaptions.localSubtitle.existing') return { ok: true, data: { status: 'missing' } };
        if (message.type === 'dualCaptions.localSubtitle.generate') {
          return {
            ok: true,
            data: {
              status: 'ready', source: 'generated',
              srt: '1\n00:00:00,000 --> 00:00:01,000\n自己\n',
            },
          };
        }
        if (message.type === 'dualCaptions.track.upsertLocal') {
          assert.deepEqual(message.track, track);
          return {
            ok: true,
            data: {
              state: {
                settings: { secondTrackId: 'external:youtube-rwnyaH6cTDE-youtube' },
                externalTracks: [track],
              },
            },
          };
        }
        if (message.type === 'dualCaptions.state.patch') {
          return {
            ok: true,
            data: {
              state: {
                settings: { secondTrackId: message.patch.secondTrackId },
                externalTracks: [track],
              },
            },
          };
        }
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?youtube-generate-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.some((message) => message.type === 'dualCaptions.localSubtitle.generate'), false);

  document.elements.createYoutubeSubtitles.listeners.get('click')();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(messages.filter((message) => message.type === 'dualCaptions.localSubtitle.generate').length, 1);
  assert.equal(
    messages.find((message) => message.type === 'dualCaptions.state.patch')?.patch.secondTrackId,
    'external:youtube-rwnyaH6cTDE-generated',
  );
  assert.match(document.elements.youtubeSubtitleStatus.textContent, /сохранены/i);
  assert.equal(document.elements.createYoutubeSubtitles.textContent, 'Создать заново');
});
