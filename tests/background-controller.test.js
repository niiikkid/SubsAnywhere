import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundController, PlayerRegistry, stablePlayerKey } from '../background-controller.js';
import { MESSAGE } from '../protocol.js';
import { builtInTrackFallbackPatch, normalizeState, patchSettings as patchState } from '../state-core.js';

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
    if (
      this.state.settings.selectedPlayerKey !== previousPlayerKey
      && this.state.settings.selectedPlayerFrameId !== frameId
    ) return this.get();
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

test('caption translation sends only the current short caption to DeepSeek', async () => {
  const calls = [];
  const deepSeek = {
    async translateCaption(text) {
      calls.push({ text });
      return [{ start: 0, end: 4, text: 'Wait', dictionary: 'ждать', context: 'подожди' }];
    },
  };
  const controller = new BackgroundController(makeChrome(), new FakeStore(), { deepSeek });

  const result = await controller.handle({
    type: 'dualCaptions.caption.translate',
    text: 'Wait for me.',
    aiOptions: { model: 'deepseek-v4-flash', reasoningEffort: 'low' },
  }, { tab: { id: 3 } });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items, [{ start: 0, end: 4, text: 'Wait', dictionary: 'ждать', context: 'подожди' }]);
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
  }, { tab: { id: 3 } });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ text: '你好，世界', pinyin: 'nǐ hǎo, shì jiè' }]);
  assert.deepEqual(result.data.items, [{
    start: 0,
    end: 15,
    text: 'nǐ hǎo, shì jiè',
    dictionary: 'Привет, мир',
    context: 'Привет, мир',
    glossary: [{ pinyin: 'nǐ hǎo', translation: 'здравствуйте' }],
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
    async generate(videoId) { calls.push(['generate', videoId]); return { status: 'running' }; },
    async status(videoId) { calls.push(['status', videoId]); return { status: 'missing' }; },
  };
  const controller = new BackgroundController(makeChrome(), new FakeStore(), { localSubtitles });

  const existing = await controller.handle({ type: MESSAGE.LOCAL_SUBTITLE_EXISTING, videoId: 'rwnyaH6cTDE' });
  const generated = await controller.handle({ type: MESSAGE.LOCAL_SUBTITLE_GENERATE, videoId: 'rwnyaH6cTDE' });
  const status = await controller.handle({ type: MESSAGE.LOCAL_SUBTITLE_STATUS, videoId: 'rwnyaH6cTDE' });

  assert.equal(existing.ok, true);
  assert.equal(generated.data.status, 'running');
  assert.equal(status.data.status, 'missing');
  assert.deepEqual(calls, [
    ['existing', 'rwnyaH6cTDE'],
    ['generate', 'rwnyaH6cTDE'],
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
