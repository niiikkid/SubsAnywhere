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
  async addExternalTrack(_pageKey, track) { this.state.externalTracks.push(structuredClone(track)); return this.get(); }
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

test('caption translation sends only the current short caption to DeepSeek', async () => {
  const calls = [];
  const deepSeek = {
    async translateCaption(text, options) {
      calls.push({ text, options });
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
    options: { model: 'deepseek-v4-flash', reasoningEffort: 'low' },
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
