import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BackgroundController as RuntimeBackgroundController, PlayerRegistry, stablePlayerKey } from '../background-controller.js';
import { MESSAGE, failure } from '../protocol.js';
import { StateStore } from '../state-store.js';
import { builtInTrackFallbackPatch, normalizeState, patchSettings as patchState } from '../state-core.js';

const EXTENSION_ID = 'fixture-extension';
const POPUP = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup.html` };

// Supply the sender metadata Chrome populates, not content-controlled fields.
class BackgroundController extends RuntimeBackgroundController {
  handle(message, sender = {}) {
    return super.handle(message, Object.keys(sender).length ? {
      id: EXTENSION_ID,
      frameId: 0,
      url: message?.player?.frameUrl || 'https://player.example/embed',
      ...sender,
    } : POPUP);
  }
}

class FakeStore {
  constructor() {
    this.state = normalizeState({});
  }
  async get(_pageKey) { return structuredClone(this.state); }
  async patchSettings(_pageKey, patch) { this.state = patchState(this.state, patch); return this.get(); }
  async patchSettingsWithPlayerFallbacks(_pageKey, patch, players = []) {
    const previous = this.state.settings;
    this.state = patchState(this.state, patch);
    const player = players.find((item) => item.key === this.state.settings.selectedPlayerKey);
    const replaceLegacyFallback = [
      ['selectedPlayerKey', previous.selectedPlayerKey],
      ['secondTrackId', previous.secondTrackId],
    ].some(([key, value]) => Object.hasOwn(patch, key) && patch[key] !== value);
    this.state = patchState(this.state, builtInTrackFallbackPatch(
      this.state.settings,
      player?.tracks ?? [],
      { replaceLegacyFallback },
    ));
    return this.get();
  }
  async reconcileBuiltInTrackFallbacks(pageKey, playerKey, playerTracks) {
    return this.patchSettingsWithPlayerFallbacks(pageKey, {}, [{ key: playerKey, tracks: playerTracks }]);
  }
  async adoptSelectedPlayerReplacement(pageKey, { previousPlayerKey, frameId, player }) {
    if (this.state.settings.selectedPlayerKey === player.key) return this.get();
    const selectedSameFrame = this.state.settings.selectedPlayerFrameId === frameId;
    const selectedPrevious = this.state.settings.selectedPlayerFrameId < 0 && previousPlayerKey
      && this.state.settings.selectedPlayerKey === previousPlayerKey;
    if (!selectedSameFrame && !selectedPrevious) return this.get();
    return this.patchSettingsWithPlayerFallbacks(pageKey, {
      selectedPlayerKey: player.key,
      selectedPlayerFrameId: frameId,
    }, [player]);
  }
  async addExternalTrack(_pageKey, track) { this.state.externalTracks.push(structuredClone(track)); return this.get(); }
  async upsertManagedExternalTrack(_pageKey, track) {
    const index = this.state.externalTracks.findIndex((item) => item.id === track.id);
    if (index < 0) this.state.externalTracks.push(structuredClone(track));
    else this.state.externalTracks[index] = structuredClone(track);
    return this.get();
  }
  async removeExternalTrack(_pageKey, id) { this.state.externalTracks = this.state.externalTracks.filter((track) => track.id !== id); return this.get(); }
  async updateExternalTrackOffset(_pageKey, id, value) {
    this.state.externalTracks = this.state.externalTracks.map((track) => track.id === id ? { ...track, offsetSeconds: value } : track);
    return this.get();
  }
  async updateExternalTrackTiming(_pageKey, id, timing) {
    this.state.externalTracks = this.state.externalTracks.map((track) => track.id === id ? { ...track, ...timing } : track);
    return this.get();
  }

}

function makeChrome() {
  const sent = [];
  const api = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
      getManifest: () => ({ host_permissions: ['https://api.deepseek.com/*', 'http://127.0.0.1:43817/*'] }),
    },
    permissions: { getAll: async () => ({ origins: ['<all_urls>'] }) },
    sent,
    onSend: null,
    scripting: { executeScript: async () => [] },
    tabs: {
      sendMessage: async (tabId, message, options) => {
        sent.push({ tabId, message, options });
        return api.onSend ? api.onSend(tabId, message, options) : undefined;
      },
    },
  };
  return api;
}

test('content cannot invoke popup-only credential, state, discovery or local-job commands', async () => {
  const store = new FakeStore();
  let accesses = 0;
  const credentialStore = {
    async publicInfo() { accesses += 1; return { hasApiKey: true }; },
    async patch() { accesses += 1; return {}; },
  };
  const controller = new BackgroundController(makeChrome(), store, { credentialStore });
  const before = structuredClone(store.state);
  for (const type of [MESSAGE.AI_CONFIG_GET, MESSAGE.AI_CONFIG_PATCH, MESSAGE.AI_MODELS_GET, MESSAGE.STATE_GET, MESSAGE.STATE_PATCH,
    MESSAGE.PLAYER_GET, MESSAGE.PLAYER_DISCOVER, MESSAGE.LOCAL_SUBTITLE_GENERATE, MESSAGE.TRACK_REMOVE]) {
    const response = await controller.handle({ type, tabId: 77, pageKey: 'https://private.example/', patch: { fontSize: 48 }, apiKey: 'not-a-real-key' }, { tab: { id: 3 }, frameId: 8 });
    assert.equal(response.ok, false, type);
  }
  assert.equal(accesses, 0);
  assert.deepEqual(store.state, before);
  assert.equal((await controller.handle({ type: MESSAGE.AI_CONFIG_GET })).ok, true);
  assert.equal(accesses, 1);
});

test('popup loads the selected provider model catalog through the background client', async () => {
  const calls = [];
  const controller = new BackgroundController(makeChrome(), new FakeStore(), {
    deepSeek: {
      async listModels(provider) {
        calls.push(provider);
        return ['gpt-5', 'gpt-5-mini'];
      },
    },
  });

  const response = await controller.handle({ type: MESSAGE.AI_MODELS_GET, provider: 'openai' });

  assert.deepEqual(calls, ['openai']);
  assert.deepEqual(response, {
    ok: true,
    data: { provider: 'openai', models: ['gpt-5', 'gpt-5-mini'] },
  });
});

test('sentence grammar is generated only from the trusted panel and saved after canonical lookup', async () => {
  const sentence = {
    id: 7, language: 'zh', text: '我已经吃过饭了。', pinyin: 'wǒ yǐjīng chī guò fàn le.',
    translation: 'Я уже поел.', explanation: '', learned: false, created_at: '2026-01-01T00:00:00Z',
  };
  const calls = [];
  const controller = new RuntimeBackgroundController(makeChrome(), new FakeStore(), {
    vocabulary: {
      async listSentences() { calls.push('list'); return { sentences: [sentence] }; },
      async saveSentenceExplanation(id, explanation) {
        calls.push(['save', id, explanation]);
        return { sentence: { ...sentence, explanation } };
      },
    },
    aiClient: {
      async explainSentence(value) { calls.push(['ai', value.id]); return 'Короткий разбор грамматики.'; },
    },
  });
  const panel = {
    id: EXTENSION_ID, frameId: 0, url: 'http://127.0.0.1:43817/words',
    tab: { id: 91, url: 'http://127.0.0.1:43817/words' },
  };
  const response = await controller.handle({ type: MESSAGE.SENTENCE_EXPLAIN, id: 7 }, panel);
  assert.equal(response.ok, true);
  assert.equal(response.data.sentence.explanation, 'Короткий разбор грамматики.');
  assert.deepEqual(calls, ['list', ['ai', 7], ['save', 7, 'Короткий разбор грамматики.']]);
  assert.equal((await controller.handle({ type: MESSAGE.SENTENCE_EXPLAIN, id: 7 }, {
    ...panel, url: 'https://evil.example/', tab: { id: 91, url: 'https://evil.example/' },
  })).ok, false);
});

test('AI translation variants for a Chinese word are generated from canonical storage only and saved separately', async () => {
  const word = {
    id: 5, language: 'zh', text: '行', pinyin: 'xíng', translation: 'старый перевод',
    ai_translations: [], explanation: '', learned: false, created_at: '2026-01-01T00:00:00Z',
  };
  const translations = [{ translation: 'годится; можно', usage: 'когда что-то допустимо или подходит' }];
  const calls = [];
  const controller = new RuntimeBackgroundController(makeChrome(), new FakeStore(), {
    vocabulary: {
      async list() { calls.push('list'); return { words: [word] }; },
      async saveAiTranslations(id, value) { calls.push(['save', id, value]); return { word: { ...word, ai_translations: value } }; },
    },
    aiClient: { async translateSavedChineseWord(value) { calls.push(['ai', value.id]); return translations; } },
  });
  const panel = {
    id: EXTENSION_ID, frameId: 0, url: 'http://127.0.0.1:43817/words',
    tab: { id: 91, url: 'http://127.0.0.1:43817/words' },
  };

  const response = await controller.handle({ type: MESSAGE.WORD_TRANSLATE, id: 5 }, panel);
  assert.deepEqual(response, { ok: true, data: { word: { ...word, ai_translations: translations } } });
  assert.deepEqual(calls, ['list', ['ai', 5], ['save', 5, translations]]);
  assert.equal((await controller.handle({ type: MESSAGE.WORD_TRANSLATE, id: 5 }, {
    ...panel, url: 'https://evil.example/', tab: { id: 91, url: 'https://evil.example/' },
  })).ok, false);
});

test('the own popup page remains trusted when Chrome hosts it in an extension tab', async () => {
  const store = new FakeStore();
  const controller = new RuntimeBackgroundController(makeChrome(), store);
  const sender = { ...POPUP, tab: { id: 100, url: POPUP.url }, frameId: 0 };
  const result = await controller.handle({ type: MESSAGE.STATE_PATCH, tabId: 3,
    pageKey: 'https://video.example/', patch: { fontSize: 31 } }, sender);
  assert.equal(result.ok, true);
  assert.equal(store.state.settings.fontSize, 31);
  const embedded = await controller.handle({ type: MESSAGE.STATE_GET, tabId: 3,
    pageKey: 'https://video.example/' }, {
    ...POPUP, url: `${POPUP.url}?embedded=1`,
    tab: { id: 3, url: 'https://video.example/' }, frameId: 0,
  });
  assert.equal(embedded.ok, true);
});

test('speech settings are shared by the popup and trusted learning panel', async () => {
  const calls = [];
  const speech = {
    async getSettings() { calls.push('get'); return { rate: 0.8 }; },
    async patchSettings(settings) { calls.push(['patch', settings]); return { rate: settings.rate }; },
    async speak(value) { calls.push(['speak', value]); return { language: value.language, rate: 0.55 }; },
  };
  const controller = new RuntimeBackgroundController(makeChrome(), new FakeStore(), { speech });
  const panel = {
    id: EXTENSION_ID, frameId: 0, url: 'http://127.0.0.1:43817/words',
    tab: { id: 91, url: 'http://127.0.0.1:43817/words' },
  };

  assert.deepEqual(await controller.handle({ type: MESSAGE.SPEECH_SETTINGS_GET }, POPUP), {
    ok: true, data: { settings: { rate: 0.8 } },
  });
  assert.deepEqual(await controller.handle({ type: MESSAGE.SPEECH_SETTINGS_PATCH, rate: 0.55 }, panel), {
    ok: true, data: { settings: { rate: 0.55 } },
  });
  assert.deepEqual(await controller.handle({ type: MESSAGE.SPEECH_SPEAK, text: '你好', language: 'zh' }, panel), {
    ok: true, data: { language: 'zh', rate: 0.55 },
  });
  assert.deepEqual(calls, ['get', ['patch', { rate: 0.55 }], ['speak', { text: '你好', language: 'zh' }]]);
  assert.equal((await controller.handle({ type: MESSAGE.SPEECH_SETTINGS_GET }, {
    id: EXTENSION_ID, frameId: 0, url: 'https://video.example/', tab: { id: 3, url: 'https://video.example/' },
  })).ok, false);
});

test('unknown extension and missing sender identities cannot read state', async () => {
  const controller = new RuntimeBackgroundController(makeChrome(), new FakeStore());
  for (const sender of [{}, { ...POPUP, id: 'other-extension' }, { id: EXTENSION_ID, url: 'https://untrusted.example/' }]) {
    assert.equal((await controller.handle({ type: MESSAGE.STATE_GET }, sender)).ok, false);
  }
});

async function backgroundHarness(setAccessLevel) {
  const source = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
  const chrome = makeChrome();
  const handlers = [];
  const event = { addListener() {} };
  chrome.storage = { local: { setAccessLevel } };
  chrome.runtime.onMessage = { addListener(handler) { handlers.push(handler); } };
  chrome.tabs.onUpdated = event;
  chrome.tabs.onRemoved = event;
  const handled = [];
  const sandbox = {
    chrome, MESSAGE, failure, console, fetch() { throw new Error('No network in bootstrap tests'); },
    StateStore: class {}, AiCredentialStore: class {}, AIClient: class {}, LocalSubtitleClient: class {}, VocabularyClient: class {},
    SpeechService: class {},
    BackgroundController: class {
      async handle(message) { handled.push(message); return { ok: true }; }
      async initialize() {}
    },
  };
  vm.runInNewContext(source.replace(/^import .*;$/gm, ''), sandbox);
  return { handled, request: (type) => new Promise((resolve) => handlers[0]({ type }, POPUP, resolve)) };
}

test('background waits for trusted-only storage access before handling AI credentials', async () => {
  let release;
  const harness = await backgroundHarness((options) => {
    assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS');
    return new Promise((resolve) => { release = resolve; });
  });
  const pending = harness.request(MESSAGE.AI_CONFIG_PATCH);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  assert.equal(harness.handled.length, 0);
  release();
  assert.equal((await pending).ok, true);
  assert.equal(harness.handled.length, 1);
});

test('storage access protection failures fail closed for AI without crashing the worker', async () => {
  for (const setter of [undefined, () => { throw new Error('Unsupported'); }, () => Promise.reject(new Error('Denied'))]) {
    const harness = await backgroundHarness(setter);
    for (const type of [MESSAGE.AI_CONFIG_GET, MESSAGE.AI_CONFIG_PATCH, MESSAGE.AI_MODELS_GET, MESSAGE.CAPTION_TRANSLATE]) {
      assert.equal((await harness.request(type)).ok, false);
    }
    assert.equal(harness.handled.length, 0);
    assert.equal((await harness.request(MESSAGE.PLAYER_GET)).ok, true);
  }
});

test('stablePlayerKey ignores temporary query tokens but distinguishes video index', () => {
  assert.equal(
    stablePlayerKey('https://player.example/embed/episode?token=one', 0),
    stablePlayerKey('https://player.example/embed/episode?token=two', 0),
  );
  assert.notEqual(
    stablePlayerKey('https://player.example/embed/episode?token=one', 0),
    stablePlayerKey('https://player.example/embed/episode?token=one', 1),
  );
  assert.notEqual(
    stablePlayerKey('https://player.example/embed?id=episode-7&token=one', 0),
    stablePlayerKey('https://player.example/embed?id=episode-8&token=two', 0),
  );
});

test('PlayerRegistry wait resolves from a fresh report after an empty service-worker cache', async () => {
  const registry = new PlayerRegistry();
  const waiting = registry.waitForPlayers(7, 100);
  registry.report(7, 12, { title: 'Player', frameUrl: 'https://player.example/embed', videoIndex: 0, tracks: [] });

  const players = await waiting;
  assert.equal(players.length, 1);
  assert.equal(players[0].frameId, 12);
});

test('PlayerRegistry discovery collects late reports from multiple iframe players', async () => {
  const registry = new PlayerRegistry();
  const waiting = registry.waitForPlayers(7, 100, 20);
  registry.report(7, 12, { title: 'First', frameUrl: 'https://one.example/embed', videoIndex: 0, tracks: [] });
  setTimeout(() => {
    registry.report(7, 18, { title: 'Second', frameUrl: 'https://two.example/embed', videoIndex: 0, tracks: [] });
  }, 10);

  const found = await waiting;

  assert.deepEqual(found.map((player) => player.title), ['First', 'Second']);
});

test('default discovery waits for a player created after a slow iframe startup', async () => {
  const registry = new PlayerRegistry();
  const waiting = registry.waitForPlayers(7);
  setTimeout(() => {
    registry.report(7, 12, { title: 'Delayed', frameUrl: 'https://slow.example/embed', videoIndex: 0, tracks: [] });
  }, 1600);

  const players = await waiting;

  assert.equal(players[0]?.title, 'Delayed');
});

test('discover re-injects both runtime and bootstrap and returns the reported player', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const controller = new BackgroundController(chrome, store, { discoveryTimeoutMs: 100 });
  chrome.scripting.executeScript = async (details) => {
    assert.deepEqual(details.files, ['content-runtime.js', 'content.js']);
    await controller.handle({
      type: MESSAGE.PLAYER_REPORT,
      player: { title: 'Recovered', frameUrl: 'https://player.example/embed', videoIndex: 0, tracks: [] },
    }, { tab: { id: 4 }, frameId: 9, url: 'https://player.example/embed' });
    return [];
  };

  const result = await controller.handle({ type: MESSAGE.PLAYER_DISCOVER, tabId: 4 }, {});

  assert.equal(result.ok, true);
  assert.equal(result.data.players[0].title, 'Recovered');
});

test('player report trusts Chrome sender URL after an iframe redirect', async () => {
  const chrome = makeChrome();
  const controller = new BackgroundController(chrome, new FakeStore());
  const result = await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: {
      title: 'Redirected player',
      frameUrl: 'https://redirector.example/loading',
      videoIndex: 0,
      tracks: [],
    },
  }, {
    tab: { id: 4, url: 'https://site.example/movie' },
    frameId: 9,
    url: 'https://player.example/embed/movie',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.player.frameUrl, 'https://player.example/embed/movie');
});

test('a selected player report restores persisted state after service-worker restart', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const frameUrl = 'https://player.example/embed?id=episode-7&token=fresh';
  store.state = normalizeState({
    settings: {
      secondTrackId: 'external:mine',
      secondBottom: 8,
      fontSize: 27,
      selectedPlayerKey: stablePlayerKey(frameUrl, 0),
    },
    externalTracks: [{
      id: 'mine',
      name: 'Mine',
      cues: [{ start: 0, end: 1, text: 'Hi' }],
      offsetSeconds: 1,
    }],
  });
  const controller = new BackgroundController(chrome, store);

  const result = await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: { title: 'Recovered', frameUrl, videoIndex: 0, tracks: [] },
  }, { tab: { id: 4 }, frameId: 9, url: frameUrl });

  assert.equal(result.ok, true);
  assert.equal(chrome.sent.length, 1);
  assert.equal(chrome.sent[0].message.type, MESSAGE.CONTENT_FULL_STATE);
  assert.equal(chrome.sent[0].message.settings.fontSize, 27);
  assert.equal(chrome.sent[0].message.externalTracks[0].id, 'mine');
});

test('a selected iframe slot stays connected when the site switches player providers', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const controller = new BackgroundController(chrome, store);
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: {
      title: 'Standard player',
      frameUrl: 'https://api.ortified.ws/embed/movie/331',
      videoIndex: 0,
      tracks: [{ id: 'standard-en', fallbackId: 'caption-1', label: 'Eng. full' }],
    },
  }, { tab: { id: 4, url: 'https://kinogomy.net/films/170.html' }, frameId: 9 });
  const [standardPlayer] = controller.players(4);
  await controller.handle({
    type: MESSAGE.PLAYER_SELECT,
    tabId: 4,
    frameId: 9,
    playerKey: standardPlayer.key,
    pageKey: 'https://kinogomy.net/films/170.html',
  }, {});
  await controller.handle({
    type: MESSAGE.STATE_PATCH,
    tabId: 4,
    pageKey: 'https://kinogomy.net/films/170.html',
    patch: { secondTrackId: 'standard-en' },
  }, {});
  chrome.sent.length = 0;

  const restartedController = new BackgroundController(chrome, store, {
    discoveryTimeoutMs: 100,
    discoveryQuietMs: 5,
  });
  chrome.scripting.executeScript = async () => {
    await restartedController.handle({
      type: MESSAGE.PLAYER_REPORT,
      player: {
        title: '4K player',
        frameUrl: 'https://synthezoid-as.stloadi.live/',
        videoIndex: 0,
        tracks: [{ id: 'four-k-en', fallbackId: 'caption-1', label: 'English' }],
      },
    }, { tab: { id: 4, url: 'https://kinogomy.net/films/170.html' }, frameId: 9 });
    return [];
  };
  const result = await restartedController.handle({
    type: MESSAGE.PLAYER_DISCOVER,
    tabId: 4,
    pageKey: 'https://kinogomy.net/films/170.html',
  }, {});

  assert.equal(result.ok, true);
  assert.equal(store.state.settings.selectedPlayerKey, result.data.players[0].key);
  assert.equal(store.state.settings.selectedPlayerFrameId, 9);
  assert.equal(store.state.settings.secondTrackFallbackId, 'caption-1');
  assert.equal(chrome.sent.length, 1);
  assert.equal(chrome.sent[0].message.type, MESSAGE.CONTENT_FULL_STATE);
});

test('a selected player report persists the built-in recovery position before an audio switch', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const frameUrl = 'https://player.example/embed?id=episode-7';
  store.state = normalizeState({
    settings: {
      secondTrackId: 'builtin-en',
      selectedPlayerKey: stablePlayerKey(frameUrl, 0),
    },
  });
  const controller = new BackgroundController(chrome, store);

  const result = await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: {
      title: 'Player',
      frameUrl,
      videoIndex: 0,
      tracks: [{ id: 'builtin-en', legacyId: 'track-0', fallbackId: 'caption-0', label: 'English' }],
    },
  }, { tab: { id: 4 }, frameId: 9, url: frameUrl });

  assert.equal(result.ok, true);
  assert.equal(store.state.settings.secondTrackFallbackId, 'caption-0');
  assert.equal(chrome.sent[0].message.settings.secondTrackFallbackId, 'caption-0');
});

test('player get rebuilds an empty cache so popup reopen recovers automatically', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const controller = new BackgroundController(chrome, store, {
    discoveryTimeoutMs: 100,
    discoveryQuietMs: 5,
  });
  chrome.scripting.executeScript = async () => {
    await controller.handle({
      type: MESSAGE.PLAYER_REPORT,
      player: { title: 'Rehydrated', frameUrl: 'https://player.example/embed', videoIndex: 0, tracks: [] },
    }, { tab: { id: 6 }, frameId: 11 });
    return [];
  };

  const result = await controller.handle({ type: MESSAGE.PLAYER_GET, tabId: 6 }, {});

  assert.equal(result.ok, true);
  assert.equal(result.data.players[0].title, 'Rehydrated');
});

test('cached-only player get returns immediately without injection or registration', async () => {
  const chrome = makeChrome();
  let discoveryCalls = 0;
  chrome.scripting.executeScript = async () => { discoveryCalls += 1; };
  chrome.scripting.getRegisteredContentScripts = async () => { discoveryCalls += 1; return []; };
  const controller = new BackgroundController(chrome, new FakeStore());
  const empty = await controller.handle({ type: MESSAGE.PLAYER_GET, tabId: 3, cachedOnly: true });
  assert.deepEqual(empty, { ok: true, data: { players: [] } });
  await selectTranslationPlayer(controller);
  const cached = await controller.handle({ type: MESSAGE.PLAYER_GET, tabId: 3, cachedOnly: true });
  assert.equal(cached.data.players.length, 1);
  assert.equal(discoveryCalls, 0);
});

test('player get refresh removes stale iframe entries before popup hydration', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const controller = new BackgroundController(chrome, store, {
    discoveryTimeoutMs: 100,
    discoveryQuietMs: 5,
  });
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: { title: 'Removed frame', frameUrl: 'https://old.example/embed', videoIndex: 0, tracks: [] },
  }, { tab: { id: 6 }, frameId: 20 });
  chrome.scripting.executeScript = async () => {
    await controller.handle({
      type: MESSAGE.PLAYER_REPORT,
      player: { title: 'Current frame', frameUrl: 'https://current.example/embed', videoIndex: 0, tracks: [] },
    }, { tab: { id: 6 }, frameId: 11 });
    return [];
  };

  const result = await controller.handle({ type: MESSAGE.PLAYER_GET, tabId: 6 }, {});

  assert.deepEqual(result.data.players.map((player) => player.title), ['Current frame']);
});

test('explicit discovery registers idempotent all-frame scripts for later iframe navigation', async () => {
  const chrome = makeChrome();
  const registrations = [];
  chrome.scripting.getRegisteredContentScripts = async () => registrations;
  chrome.scripting.registerContentScripts = async (scripts) => registrations.push(...scripts);
  const controller = new BackgroundController(chrome, new FakeStore(), {
    discoveryTimeoutMs: 1,
    discoveryQuietMs: 1,
  });

  await controller.handle({ type: MESSAGE.PLAYER_DISCOVER, tabId: 2 }, {});
  await controller.handle({ type: MESSAGE.PLAYER_DISCOVER, tabId: 2 }, {});

  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].js, ['content-runtime.js', 'content.js']);
  assert.equal(registrations[0].allFrames, true);
  assert.equal(registrations[0].persistAcrossSessions, true);
});

test('stale wildcard discovery registration is narrowed and removed after optional permission revocation', async () => {
  const chrome = makeChrome();
  const id = 'dual-captions-player-discovery-v1';
  let scripts = [{ id, matches: ['http://*/*', 'https://*/*'], js: ['old-content.js'] }];
  let origins = ['https://video.example/*', 'https://api.deepseek.com/*', 'http://127.0.0.1:43817/*'];
  chrome.permissions.getAll = async () => ({ origins });
  chrome.scripting.getRegisteredContentScripts = async () => structuredClone(scripts);
  chrome.scripting.registerContentScripts = async (values) => { scripts.push(...values); };
  chrome.scripting.updateContentScripts = async (values) => { scripts = values; };
  chrome.scripting.unregisterContentScripts = async () => { scripts = []; };
  const controller = new BackgroundController(chrome, new FakeStore(), { discoveryTimeoutMs: 1 });

  await controller.handle({ type: MESSAGE.PLAYER_DISCOVER, tabId: 3 });
  assert.deepEqual(scripts[0].matches, ['https://video.example/*']);
  assert.deepEqual(scripts[0].js, ['content-runtime.js', 'content.js']);

  origins = ['https://api.deepseek.com/*', 'http://127.0.0.1:43817/*'];
  await controller.handle({ type: MESSAGE.PLAYER_DISCOVER, tabId: 3 });
  assert.deepEqual(scripts, []);
});

test('selecting a second player resets the previously active frame before activation', async () => {
  const chrome = makeChrome();
  const controller = new BackgroundController(chrome, new FakeStore());
  await selectTranslationPlayer(controller);
  await controller.handle({ type: MESSAGE.PLAYER_REPORT, player: {
    title: 'Second', frameUrl: 'https://second.example/embed', videoIndex: 0, tracks: [],
  } }, { tab: { id: 3 }, frameId: 8 });
  const second = controller.players(3).find((player) => player.frameId === 8);
  chrome.sent.length = 0;

  const response = await controller.handle({ type: MESSAGE.PLAYER_SELECT, tabId: 3, frameId: 8, playerKey: second.key });

  assert.equal(response.ok, true);
  assert.deepEqual(chrome.sent.map(({ message, options }) => [message.type, options.frameId]), [
    [MESSAGE.CONTENT_RESET, 0], [MESSAGE.CONTENT_FULL_STATE, 8],
  ]);
});

test('a delayed player report cannot reactivate an old frame after a newer selection', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const controller = new BackgroundController(chrome, store);
  const sender = await selectTranslationPlayer(controller);
  const [first] = controller.players(3);
  await controller.handle({ type: MESSAGE.PLAYER_REPORT, player: {
    title: 'Second', frameUrl: 'https://second.example/embed', videoIndex: 0, tracks: [],
  } }, { tab: { id: 3 }, frameId: 8 });
  const second = controller.players(3).find((player) => player.frameId === 8);
  const adopt = store.adoptSelectedPlayerReplacement.bind(store);
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  store.adoptSelectedPlayerReplacement = async (...args) => {
    const snapshot = await adopt(...args);
    started();
    await new Promise((resolve) => { release = resolve; });
    return snapshot;
  };
  chrome.sent.length = 0;
  const report = controller.handle({ type: MESSAGE.PLAYER_REPORT, player: first }, sender);
  await waiting;
  const selection = controller.handle({ type: MESSAGE.PLAYER_SELECT, tabId: 3, frameId: 8, playerKey: second.key });
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  release();
  await Promise.all([report, selection]);

  assert.equal(store.state.settings.selectedPlayerKey, second.key);
  assert.equal(chrome.sent.filter(({ options }) => options.frameId === 0).at(-1).message.type, MESSAGE.CONTENT_RESET);
  assert.equal(chrome.sent.at(-1).options.frameId, 8);
});

test('settings patch sends only lightweight settings to the selected player frame', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const controller = new BackgroundController(chrome, store);
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: { title: 'Player', frameUrl: 'https://player.example/embed', videoIndex: 0, tracks: [] },
  }, { tab: { id: 3 }, frameId: 8, url: 'https://player.example/embed' });
  const [player] = controller.players(3);
  await controller.handle({ type: MESSAGE.PLAYER_SELECT, tabId: 3, frameId: 8, playerKey: player.key }, {});
  chrome.sent.length = 0;

  const result = await controller.handle({ type: MESSAGE.STATE_PATCH, tabId: 3, patch: { fontSize: 31 } }, {});

  assert.equal(result.ok, true);
  assert.equal(chrome.sent.length, 1);
  assert.equal(chrome.sent[0].message.type, MESSAGE.CONTENT_SETTINGS);
  assert.equal(chrome.sent[0].message.settings.fontSize, 31);
  assert.equal('externalTracks' in chrome.sent[0].message, false);
});

test('the selected player persists a dragged subtitle position on both axes', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const controller = new BackgroundController(chrome, store);
  const sender = { tab: { id: 3, url: 'https://video.example/episode' }, frameId: 8 };
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: { title: 'Player', frameUrl: 'https://player.example/embed', videoIndex: 0, tracks: [] },
  }, sender);
  const [player] = controller.players(3);
  await controller.handle({
    type: MESSAGE.PLAYER_SELECT,
    tabId: 3,
    pageKey: 'https://video.example/episode',
    frameId: 8,
    playerKey: player.key,
  }, {});
  chrome.sent.length = 0;

  const result = await controller.handle({
    type: MESSAGE.CONTENT_POSITION_PATCH,
    secondLeft: 64,
    secondBottom: 27,
  }, sender);

  assert.equal(result.ok, true);
  assert.equal(store.state.settings.secondLeft, 64);
  assert.equal(store.state.settings.secondBottom, 27);
  assert.deepEqual(chrome.sent[0].message.settings.secondLeft, 64);
  assert.deepEqual(chrome.sent[0].message.settings.secondBottom, 27);
});

async function selectTranslationPlayer(controller) {
  const sender = { tab: { id: 3 }, frameId: 0, url: 'https://player.example/embed', documentId: 'current-document' };
  await controller.handle({ type: MESSAGE.PLAYER_REPORT, player: {
    title: 'Player', frameUrl: sender.url, videoIndex: 0, tracks: [],
  } }, sender);
  const [player] = controller.players(3);
  await controller.handle({ type: MESSAGE.PLAYER_SELECT, tabId: 3, frameId: 0, playerKey: player.key });
  return sender;
}

test('only the selected current frame document can spend a translation request', async () => {
  let calls = 0;
  const controller = new BackgroundController(makeChrome(), new FakeStore(), {
    deepSeek: { async translateCaption() { calls += 1; return []; } },
  });
  const sender = await selectTranslationPlayer(controller);
  const message = { type: MESSAGE.CAPTION_TRANSLATE, text: 'Hello' };
  for (const untrusted of [{ ...sender, frameId: 4 }, { ...sender, tab: { id: 9 } },
    { ...sender, documentId: 'old-document' }, { ...sender, documentLifecycle: 'prerender' }]) {
    assert.equal((await controller.handle(message, untrusted)).ok, false);
  }
  assert.equal(calls, 0);
  assert.equal((await controller.handle(message, sender)).ok, true);
  assert.equal(calls, 1);
});

test('player reports reject invalid sender identity and excessive track metadata before registration', async () => {
  const controller = new BackgroundController(makeChrome(), new FakeStore());
  const player = { title: 'Player', frameUrl: 'https://player.example/embed', videoIndex: 0, tracks: [] };
  for (const [data, sender] of [
    [{ ...player, tracks: Array.from({ length: 129 }, () => ({ id: 'en' })) }, {}],
    [{ ...player, title: 'x'.repeat(100_000) }, {}],
    [player, { frameId: -1 }],
    [player, { documentLifecycle: 'cached' }],
  ]) {
    const response = await controller.handle({ type: MESSAGE.PLAYER_REPORT, player: data }, { tab: { id: 3 }, frameId: 0, ...sender });
    assert.equal(response.ok, false);
    assert.deepEqual(controller.players(3), []);
  }
});

test('oversized translation messages are rejected rather than silently truncated or forwarded', async () => {
  let calls = 0;
  const controller = new BackgroundController(makeChrome(), new FakeStore(), {
    deepSeek: { async translateCaption() { calls += 1; return []; } },
  });
  const sender = await selectTranslationPlayer(controller);
  for (const extra of [{ text: 'x'.repeat(501) }, { text: 'Hi', displayText: 'x'.repeat(501) },
    { text: 'Hi', ignored: 'x'.repeat(100_000) }]) {
    assert.equal((await controller.handle({ type: MESSAGE.CAPTION_TRANSLATE, ...extra }, sender)).ok, false);
  }
  assert.equal(calls, 0);
});

test('caption translation sends only the current short caption to DeepSeek', async () => {
  const calls = [];
  const deepSeek = {
    async translateCaption(text) {
      calls.push({ text });
      return {
        translation: 'Подожди меня.',
        glossary: [{ text: 'Wait for', translation: 'подожди' }],
      };
    },
  };
  const controller = new BackgroundController(makeChrome(), new FakeStore(), { deepSeek });

  const result = await controller.handle({
    type: 'dualCaptions.caption.translate',
    text: 'Wait for me.',
    aiOptions: { model: 'deepseek-v4-flash', reasoningEffort: 'low' },
  }, await selectTranslationPlayer(controller));

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items, [{
    start: 0,
    end: 12,
    text: 'Wait for me.',
    dictionary: 'Подожди меня.',
    context: 'Подожди меня.',
    glossary: [{ text: 'Wait for', translation: 'подожди' }],
    isSentenceTranslation: true,
  }]);
  assert.deepEqual(calls, [{
    text: 'Wait for me.',
  }]);
});

test('Chinese pinyin click translates its linked characters in one request', async () => {
  const calls = [];
  const deepSeek = {
    async translateChineseCaption(text, pinyin) {
      calls.push({ text, pinyin });
      return {
        dictionary: 'Привет, мир',
        context: 'Привет, мир',
        glossary: [{ pinyin: 'nǐ hǎo', translation: 'здравствуйте' }],
      };
    },
  };
  const controller = new BackgroundController(makeChrome(), new FakeStore(), { deepSeek });

  const result = await controller.handle({
    type: MESSAGE.CAPTION_TRANSLATE,
    language: 'zh',
    text: '你好，世界',
    displayText: 'nǐ hǎo, shì jiè',
  }, await selectTranslationPlayer(controller));

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ text: '你好，世界', pinyin: 'nǐ hǎo, shì jiè' }]);
  assert.deepEqual(result.data.items, [{
    start: 0,
    end: 15,
    text: 'nǐ hǎo, shì jiè',
    dictionary: 'Привет, мир',
    context: 'Привет, мир',
    glossary: [{ pinyin: 'nǐ hǎo', translation: 'здравствуйте' }],
    isSentenceTranslation: true,
  }]);
});

test('Chinese Han captions receive generated pinyin with their translation in one request', async () => {
  const calls = [];
  const deepSeek = {
    async translateChineseCaption(text, pinyin) {
      calls.push({ text, pinyin });
      return {
        pinyin: 'nǐ hǎo, shì jiè',
        dictionary: 'Привет, мир',
        context: 'Привет, мир',
        glossary: [{ text: '你好', pinyin: 'nǐ hǎo', translation: 'здравствуйте', pinyinStart: 0, pinyinEnd: 6 }],
      };
    },
  };
  const controller = new BackgroundController(makeChrome(), new FakeStore(), { deepSeek });

  const result = await controller.handle({
    type: MESSAGE.CAPTION_TRANSLATE,
    language: 'zh',
    text: '你好，世界',
    displayText: '',
  }, await selectTranslationPlayer(controller));

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ text: '你好，世界', pinyin: '' }]);
  assert.deepEqual(result.data.items, [{
    start: 0,
    end: 15,
    text: 'nǐ hǎo, shì jiè',
    dictionary: 'Привет, мир',
    context: 'Привет, мир',
    glossary: [{ text: '你好', pinyin: 'nǐ hǎo', translation: 'здравствуйте', pinyinStart: 0, pinyinEnd: 6 }],
    isSentenceTranslation: true,
  }]);
});

test('selecting a built-in track persists its recovery position immediately', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const controller = new BackgroundController(chrome, store);
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: {
      title: 'Player',
      frameUrl: 'https://player.example/embed',
      videoIndex: 0,
      tracks: [{ id: 'builtin-en', legacyId: 'track-0', fallbackId: 'caption-0', label: 'English' }],
    },
  }, { tab: { id: 3 }, frameId: 8, url: 'https://player.example/embed' });
  const [player] = controller.players(3);
  await controller.handle({ type: MESSAGE.PLAYER_SELECT, tabId: 3, frameId: 8, playerKey: player.key }, {});
  chrome.sent.length = 0;

  const result = await controller.handle({
    type: MESSAGE.STATE_PATCH,
    tabId: 3,
    patch: { secondTrackId: 'builtin-en' },
  }, {});

  assert.equal(result.ok, true);
  assert.equal(store.state.settings.secondTrackFallbackId, 'caption-0');
  assert.equal(chrome.sent[0].message.settings.secondTrackFallbackId, 'caption-0');
});

test('selecting a player backfills recovery positions for existing built-in selections', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  store.state = normalizeState({ settings: { secondTrackId: 'builtin-en' } });
  const controller = new BackgroundController(chrome, store);
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: {
      title: 'Player',
      frameUrl: 'https://player.example/embed',
      videoIndex: 0,
      tracks: [{ id: 'builtin-en', fallbackId: 'caption-0', label: 'English' }],
    },
  }, { tab: { id: 3 }, frameId: 8, url: 'https://player.example/embed' });
  const [player] = controller.players(3);
  chrome.sent.length = 0;

  const result = await controller.handle({
    type: MESSAGE.PLAYER_SELECT,
    tabId: 3,
    frameId: 8,
    playerKey: player.key,
  }, {});

  assert.equal(result.ok, true);
  assert.equal(store.state.settings.secondTrackFallbackId, 'caption-0');
  assert.equal(chrome.sent[0].message.settings.secondTrackFallbackId, 'caption-0');
});

test('explicit player selection replaces a legacy fallback inherited from another player', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  store.state = normalizeState({
    settings: {
      secondTrackId: 'track-1',
      secondTrackFallbackId: 'caption-0',
    },
  });
  const controller = new BackgroundController(chrome, store);
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: {
      title: 'Second player',
      frameUrl: 'https://player.example/second',
      videoIndex: 0,
      tracks: [
        { id: 'builtin-a', legacyId: 'track-0', fallbackId: 'caption-0' },
        { id: 'builtin-b', legacyId: 'track-1', fallbackId: 'caption-1' },
      ],
    },
  }, { tab: { id: 3 }, frameId: 9, url: 'https://player.example/second' });
  const [player] = controller.players(3);

  const result = await controller.handle({
    type: MESSAGE.PLAYER_SELECT,
    tabId: 3,
    frameId: 9,
    playerKey: player.key,
  }, {});

  assert.equal(result.ok, true);
  assert.equal(store.state.settings.secondTrackFallbackId, 'caption-1');
});

test('reselecting the same player preserves a legacy fallback after context recreation', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const frameUrl = 'https://player.example/embed';
  const playerKey = stablePlayerKey(frameUrl, 0);
  store.state = normalizeState({
    settings: {
      selectedPlayerKey: playerKey,
      secondTrackId: 'track-1',
      secondTrackFallbackId: 'caption-0',
    },
  });
  const controller = new BackgroundController(chrome, store);
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: {
      title: 'Recreated player',
      frameUrl,
      videoIndex: 0,
      tracks: [
        { id: 'new-a', legacyId: 'track-0', fallbackId: 'caption-0' },
        { id: 'new-b', legacyId: 'track-1', fallbackId: 'caption-1' },
      ],
    },
  }, { tab: { id: 3 }, frameId: 9, url: frameUrl });

  const result = await controller.handle({
    type: MESSAGE.PLAYER_SELECT,
    tabId: 3,
    frameId: 9,
    playerKey,
  }, {});

  assert.equal(result.ok, true);
  assert.equal(store.state.settings.secondTrackFallbackId, 'caption-0');
});

test('late reports from the previous top page cannot readopt its state after navigation', async () => {
  const chrome = makeChrome();
  let currentUrl = 'https://site.example/episode-1';
  chrome.tabs.get = async () => ({ id: 3, url: currentUrl });
  const controller = new BackgroundController(chrome, new FakeStore());
  const sender = { tab: { id: 3, url: currentUrl }, frameId: 8, documentId: 'old-document' };
  const message = { type: MESSAGE.PLAYER_REPORT, player: {
    title: 'Old', frameUrl: 'https://player.example/embed', videoIndex: 0, tracks: [],
  } };
  await controller.handle(message, sender);
  currentUrl = 'https://site.example/episode-2';
  await controller.handleTabNavigation(3, currentUrl);
  chrome.sent.length = 0;

  assert.equal((await controller.handle(message, sender)).ok, false);
  assert.deepEqual(controller.players(3), []);
  assert.deepEqual(chrome.sent, []);
});

test('two identical iframe URLs do not activate or receive settings in the unselected frame', async () => {
  const chrome = makeChrome();
  const controller = new BackgroundController(chrome, new FakeStore());
  const sender = await selectTranslationPlayer(controller);
  const [player] = controller.players(3);
  await controller.handle({ type: MESSAGE.PLAYER_REPORT, player }, { ...sender, frameId: 8, documentId: 'second-document' });
  await controller.handle({ type: MESSAGE.PLAYER_SELECT, tabId: 3, frameId: 8, playerKey: player.key });
  chrome.sent.length = 0;
  await controller.handle({ type: MESSAGE.PLAYER_REPORT, player }, sender);
  await controller.handle({ type: MESSAGE.STATE_PATCH, tabId: 3, patch: { fontSize: 31 } });
  assert.deepEqual(chrome.sent.map(({ message, options }) => [message.type, options.frameId]), [[MESSAGE.CONTENT_SETTINGS, 8]]);
});

async function persistedSelectedPlayer() {
  const storage = {
    data: {},
    async get() { return structuredClone(this.data); },
    async set(values) { Object.assign(this.data, structuredClone(values)); },
  };
  const chrome = makeChrome();
  const pageKey = 'https://site.example/episode-1';
  const sender = { id: EXTENSION_ID, tab: { id: 3, url: pageKey }, frameId: 8,
    url: 'https://player.example/embed', documentId: 'selected-document', documentLifecycle: 'active' };
  chrome.tabs.get = async () => ({ ...sender.tab });
  const registry = new PlayerRegistry();
  const controller = new RuntimeBackgroundController(chrome, new StateStore(storage), { registry });
  const report = { type: MESSAGE.PLAYER_REPORT, player: { title: 'Selected', frameUrl: sender.url,
    videoIndex: 0, tracks: [{ id: 'track-0', fallbackId: 'caption-0', language: 'en' }] } };
  assert.equal((await controller.handle(report, sender)).ok, true);
  const [player] = controller.players(sender.tab.id);
  assert.equal((await controller.handle({ type: MESSAGE.PLAYER_SELECT, tabId: sender.tab.id,
    pageKey, frameId: sender.frameId, playerKey: player.key }, POPUP)).ok, true);
  assert.equal((await controller.handle({ type: MESSAGE.STATE_PATCH, tabId: sender.tab.id,
    pageKey, patch: { secondTrackId: 'track-0', fontSize: 31 } }, POPUP)).ok, true);
  const persisted = await new StateStore(storage).get(pageKey);
  assert.equal(persisted.settings.selectedPlayerFrameId, sender.frameId);
  assert.equal(persisted.settings.selectedPlayerKey, player.key);
  chrome.sent.length = 0;
  return { chrome, storage, registry, controller, pageKey, sender, player, report };
}

test('rediscovery never activates an identical-URL frame before the persisted frame reports', async () => {
  for (const reset of ['worker-restart', 'registry-clear', 'explicit-discovery']) {
    for (const order of [[0, 8], [8, 0]]) {
      const fixture = await persistedSelectedPlayer();
      const { chrome, storage, pageKey, sender, report } = fixture;
      const controller = reset === 'worker-restart'
        ? new RuntimeBackgroundController(chrome, new StateStore(storage)) : fixture.controller;
      if (reset === 'registry-clear') fixture.registry.clear(sender.tab.id);
      const reportPlayers = async () => {
        for (const frameId of order) {
          const response = await controller.handle(report, { ...sender, frameId,
            documentId: frameId === sender.frameId ? sender.documentId : 'unselected-document' });
          assert.equal(response.ok, true);
          assert.equal(response.data.restored, frameId === sender.frameId, `${reset}: frame ${frameId}`);
          await controller.handle({ type: MESSAGE.STATE_PATCH, tabId: sender.tab.id,
            pageKey, patch: { fontSize: 32 } }, POPUP);
        }
      };
      if (reset === 'explicit-discovery') {
        chrome.scripting.executeScript = reportPlayers;
        assert.equal((await controller.handle({ type: MESSAGE.PLAYER_DISCOVER, tabId: sender.tab.id, pageKey }, POPUP)).ok, true);
      } else await reportPlayers();
      assert.ok(chrome.sent.length > 0);
      assert.ok(chrome.sent.every(({ options }) => options.frameId === sender.frameId), reset);
      assert.equal((await new StateStore(storage).get(pageKey)).settings.selectedPlayerFrameId, sender.frameId);
    }
  }
});

test('completed discovery restores a same-URL replacement only after the stored frame is absent', async () => {
  for (const restart of [false, true]) {
    const fixture = await persistedSelectedPlayer();
    const { chrome, storage, pageKey, sender, report } = fixture;
    const controller = restart
      ? new RuntimeBackgroundController(chrome, new StateStore(storage), { discoveryQuietMs: 1, discoveryTimeoutMs: 50 })
      : fixture.controller;
    const replacement = { ...sender, frameId: 12, documentId: 'replacement-document' };
    chrome.scripting.executeScript = async () => {
      const response = await controller.handle(report, replacement);
      assert.equal(response.ok, true);
      assert.equal(response.data.restored, false, 'Do not activate before discovery settles');
      assert.equal((await new StateStore(storage).get(pageKey)).settings.selectedPlayerFrameId, sender.frameId);
    };
    const response = await controller.handle({ type: MESSAGE.PLAYER_DISCOVER, tabId: sender.tab.id, pageKey }, POPUP);
    assert.equal(response.ok, true);
    assert.equal((await new StateStore(storage).get(pageKey)).settings.selectedPlayerFrameId, replacement.frameId);
    assert.equal(chrome.sent.at(-1).message.type, MESSAGE.CONTENT_FULL_STATE);
    assert.deepEqual(chrome.sent.at(-1).options, { frameId: replacement.frameId, documentId: replacement.documentId });
    if (!restart) {
      assert.equal(chrome.sent[0].message.type, MESSAGE.CONTENT_RESET);
      assert.deepEqual(chrome.sent[0].options, { frameId: sender.frameId, documentId: sender.documentId });
    }
  }
});

test('the first selected action after a worker restart re-registers before authorization', async () => {
  for (const type of [MESSAGE.CAPTION_TRANSLATE, MESSAGE.CONTENT_POSITION_PATCH, MESSAGE.TRACK_CACHE_BUILTIN,
    MESSAGE.WORDS_LIST, MESSAGE.WORDS_SAVE, MESSAGE.SENTENCES_LIST, MESSAGE.SENTENCES_SAVE]) {
    const { chrome, storage, pageKey, sender, player, report } = await persistedSelectedPlayer();
    let translations = 0;
    const controller = new RuntimeBackgroundController(chrome, new StateStore(storage), {
      discoveryTimeoutMs: 50,
      deepSeek: { async translateCaption() { translations += 1; return []; } },
      vocabulary: {
        async list() { return { words: [] }; }, async save(word) { return { word }; },
        async listSentences() { return { sentences: [] }; }, async saveSentence(sentence) { return { sentence }; },
      },
    });
    let handshakes = 0;
    chrome.onSend = async (tabId, message, options) => {
      if (message.type !== MESSAGE.PLAYER_DISCOVER) return { ok: true };
      handshakes += 1;
      assert.equal(tabId, sender.tab.id);
      assert.deepEqual(options, { frameId: sender.frameId });
      return controller.handle(report, sender);
    };
    const action = { type, text: 'After restart', secondLeft: 72, secondBottom: 27,
      word: { language: 'zh', text: '你好', pinyin: 'nǐ hǎo', translation: 'привет' },
      sentence: { language: 'zh', text: '你好，世界！', pinyin: 'nǐ hǎo, shì jiè!', translation: 'Привет, мир!' },
      sourceKey: `${player.key}\u0000track-0`,
      track: { id: 'builtin-cache-snapshot', sourceType: 'builtin-cache', name: 'English',
        cues: [{ start: 1, end: 2, text: 'Saved caption' }] } };
    // No PLAYER_REPORT, popup request or navigation primes this new controller.
    const response = await controller.handle(action, sender);
    assert.equal(response.ok, true, `${type}: ${response.error}`);
    assert.equal(handshakes, 1);
    assert.equal(controller.players(sender.tab.id)[0].documentId, sender.documentId);
    const state = await new StateStore(storage).get(pageKey);
    assert.equal(state.settings.selectedPlayerFrameId, sender.frameId);
    assert.equal(state.settings.selectedPlayerKey, player.key);
    assert.equal(state.settings.fontSize, 31);
    assert.equal(translations, type === MESSAGE.CAPTION_TRANSLATE ? 1 : 0);
    if (type === MESSAGE.WORDS_SAVE) assert.deepEqual(response.data.word, action.word);
    if (type === MESSAGE.SENTENCES_SAVE) assert.deepEqual(response.data.sentence, action.sentence);
    if (type === MESSAGE.CONTENT_POSITION_PATCH) {
      assert.equal(state.settings.secondLeft, 72);
      assert.equal(state.settings.secondBottom, 27);
    }
    if (type === MESSAGE.TRACK_CACHE_BUILTIN) {
      assert.equal(state.settings.secondTrackCacheSource, action.sourceKey);
      assert.equal(state.externalTracks[0].cues[0].text, 'Saved caption');
    }
  }
});

test('cold-worker recovery still rejects an unselected or stale action without spending or saving', async () => {
  for (const scenario of ['wrong-frame', 'wrong-document', 'wrong-url', 'missing-document', 'inactive-document',
    'wrong-page', 'different-current-player', 'ack-without-report']) {
    const { chrome, storage, pageKey, sender, report } = await persistedSelectedPlayer();
    let translations = 0;
    const controller = new RuntimeBackgroundController(chrome, new StateStore(storage), {
      discoveryTimeoutMs: 50, deepSeek: { async translateCaption() { translations += 1; return []; } },
    });
    let actionSender = { ...sender };
    if (scenario === 'wrong-frame') actionSender.frameId = 0;
    if (scenario === 'wrong-document') actionSender.documentId = 'old-document';
    if (scenario === 'wrong-url') actionSender.url = 'https://other.example/embed';
    if (scenario === 'missing-document') delete actionSender.documentId;
    if (scenario === 'inactive-document') actionSender.documentLifecycle = 'cached';
    if (scenario === 'wrong-page') actionSender.tab = { ...sender.tab, url: 'https://site.example/episode-0' };
    chrome.onSend = async (_tabId, message) => {
      if (message.type !== MESSAGE.PLAYER_DISCOVER || scenario === 'ack-without-report') return { ok: true };
      const currentSender = scenario === 'different-current-player'
        ? { ...sender, url: 'https://other.example/embed' } : sender;
      return controller.handle({ ...report, player: { ...report.player, frameUrl: currentSender.url } }, currentSender);
    };
    const response = await controller.handle({ type: MESSAGE.CAPTION_TRANSLATE, text: 'Do not spend' }, actionSender);
    assert.equal(response.ok, false, scenario);
    assert.equal(translations, 0, scenario);
    assert.equal((await new StateStore(storage).get(pageKey)).settings.secondLeft, 50, scenario);
  }
});

test('cold-worker recovery coalesces concurrent actions and times out without blocking a later retry', async (t) => {
  const { chrome, storage, sender, report } = await persistedSelectedPlayer();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let translations = 0;
  const controller = new RuntimeBackgroundController(chrome, new StateStore(storage), {
    discoveryTimeoutMs: 50, deepSeek: { async translateCaption() { translations += 1; return []; } },
  });
  let handshakes = 0;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  chrome.onSend = async (_tabId, message) => {
    if (message.type !== MESSAGE.PLAYER_DISCOVER) return { ok: true };
    handshakes += 1;
    started();
    return new Promise(() => {});
  };
  const requests = [
    controller.handle({ type: MESSAGE.CAPTION_TRANSLATE, text: 'Hello' }, sender),
    controller.handle({ type: MESSAGE.CONTENT_POSITION_PATCH, secondLeft: 72 }, sender),
  ];
  await waiting;
  t.mock.timers.tick(50);
  for (const response of await Promise.all(requests)) {
    assert.equal(response.ok, false);
    assert.match(response.error, /Плеер не ответил/);
  }
  assert.equal(handshakes, 1);
  assert.equal(translations, 0);
  chrome.onSend = (_tabId, message) => message.type === MESSAGE.PLAYER_DISCOVER
    ? controller.handle(report, sender) : { ok: true };
  assert.equal((await controller.handle({ type: MESSAGE.CAPTION_TRANSLATE, text: 'Retry' }, sender)).ok, true);
  assert.equal(translations, 1);
});

test('navigation during recovery cannot authorize an action from the previous page', async () => {
  const { chrome, storage, pageKey, sender, report } = await persistedSelectedPlayer();
  const controller = new RuntimeBackgroundController(chrome, new StateStore(storage));
  chrome.onSend = async (_tabId, message) => {
    if (message.type !== MESSAGE.PLAYER_DISCOVER) return { ok: true };
    const response = await controller.handle(report, sender);
    chrome.tabs.get = async () => ({ ...sender.tab, url: 'https://site.example/episode-2' });
    await controller.handleTabNavigation(sender.tab.id, 'https://site.example/episode-2');
    return response;
  };
  assert.equal((await controller.handle({ type: MESSAGE.CONTENT_POSITION_PATCH, secondLeft: 72 }, sender)).ok, false);
  assert.equal((await new StateStore(storage).get(pageKey)).settings.secondLeft, 50);
});

test('state delivery targets the registered document rather than a reused frame slot', async () => {
  const chrome = makeChrome();
  const controller = new BackgroundController(chrome, new FakeStore());
  await selectTranslationPlayer(controller);
  assert.deepEqual(chrome.sent.at(-1).options, { frameId: 0, documentId: 'current-document' });
});

test('top-page navigation resets the old frame before a new page can reuse its subtitles', async () => {
  const chrome = makeChrome();
  const controller = new BackgroundController(chrome, new FakeStore());
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: { title: 'Old', frameUrl: 'https://player.example/embed', videoIndex: 0, tracks: [] },
  }, { tab: { id: 9, url: 'https://site.example/episode-1' }, frameId: 4 });
  chrome.sent.length = 0;

  await controller.handleTabNavigation(9, 'https://site.example/episode-2');

  assert.equal(chrome.sent.length, 1);
  assert.equal(chrome.sent[0].message.type, MESSAGE.CONTENT_RESET);
  assert.deepEqual(controller.players(9), []);
});

test('background forwards explicit YouTube subtitle actions to the local client', async () => {
  const calls = [];
  const localSubtitles = {
    async existing(videoId) { calls.push(['existing', videoId]); return { status: 'ready' }; },
    async generate(videoId, language) { calls.push(['generate', videoId, language]); return { status: 'running' }; },
    async status(videoId) { calls.push(['status', videoId]); return { status: 'missing' }; },
  };
  const controller = new BackgroundController(makeChrome(), new FakeStore(), { localSubtitles });

  const existing = await controller.handle({ type: MESSAGE.LOCAL_SUBTITLE_EXISTING, videoId: 'rwnyaH6cTDE' });
  const generated = await controller.handle({ type: MESSAGE.LOCAL_SUBTITLE_GENERATE, videoId: 'rwnyaH6cTDE', language: 'en' });
  const status = await controller.handle({ type: MESSAGE.LOCAL_SUBTITLE_STATUS, videoId: 'rwnyaH6cTDE' });

  assert.equal(existing.ok, true);
  assert.equal(generated.data.status, 'running');
  assert.equal(status.data.status, 'missing');
  assert.deepEqual(calls, [
    ['existing', 'rwnyaH6cTDE'],
    ['generate', 'rwnyaH6cTDE', 'en'],
    ['status', 'rwnyaH6cTDE'],
  ]);
});

test('background stores a local-server subtitle and delivers it to the selected player', async () => {
  const chrome = makeChrome();
  const store = new FakeStore();
  const controller = new BackgroundController(chrome, store);
  await controller.handle({
    type: MESSAGE.PLAYER_REPORT,
    player: { title: 'YouTube', frameUrl: 'https://www.youtube.com/watch?v=rwnyaH6cTDE', videoIndex: 0, tracks: [] },
  }, { tab: { id: 5, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' }, frameId: 0 });
  const [player] = controller.players(5);
  await controller.handle({ type: MESSAGE.PLAYER_SELECT, tabId: 5, frameId: 0, playerKey: player.key }, {});
  chrome.sent.length = 0;

  const result = await controller.handle({
    type: MESSAGE.TRACK_UPSERT_LOCAL,
    tabId: 5,
    pageKey: 'https://www.youtube.com/watch?v=rwnyaH6cTDE',
    track: {
      id: 'youtube-rwnyaH6cTDE-youtube',
      name: 'YouTube rwnyaH6cTDE youtube Chinese',
      sourceType: 'local-server',
      cues: [{ start: 0, end: 1, text: '你好' }],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.state.externalTracks[0].id, 'youtube-rwnyaH6cTDE-youtube');
  assert.equal(chrome.sent[0].message.type, MESSAGE.CONTENT_TRACKS);
});
