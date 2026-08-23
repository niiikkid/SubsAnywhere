import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundController, PlayerRegistry, stablePlayerKey } from '../background-controller.js';
import { MESSAGE } from '../protocol.js';
import { normalizeState, patchSettings as patchState } from '../state-core.js';

class FakeStore {
  constructor() {
    this.state = normalizeState({});
  }
  async get() { return structuredClone(this.state); }
  async patchSettings(patch) { this.state = patchState(this.state, patch); return this.get(); }
  async addExternalTrack(track) { this.state.externalTracks.push(structuredClone(track)); return this.get(); }
  async removeExternalTrack(id) { this.state.externalTracks = this.state.externalTracks.filter((track) => track.id !== id); return this.get(); }
  async updateExternalTrackOffset(id, value) {
    this.state.externalTracks = this.state.externalTracks.map((track) => track.id === id ? { ...track, offsetSeconds: value } : track);
    return this.get();
  }
}

function makeChrome() {
  const sent = [];
  return {
    sent,
    scripting: { executeScript: async () => [] },
    tabs: {
      sendMessage: async (tabId, message, options) => { sent.push({ tabId, message, options }); },
    },
  };
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
      firstTrackId: 'track-0',
      secondTrackId: 'external:mine',
      firstBottom: 21,
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
