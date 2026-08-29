import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

class FakeElement extends FakeTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.isConnected = false;
    this.textContent = '';
    this.id = '';
    this.className = '';
    this.parentElement = null;
  }
  setAttribute() {}
  append(...children) {
    for (const child of children) {
      if (child.parentElement) {
        child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
      }
      child.isConnected = true;
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) {
      child.parentElement = null;
      child.isConnected = false;
    }
    this.children = [];
    this.append(...children);
  }
  getBoundingClientRect() { return { left: 10, top: 20, width: 800, height: 450 }; }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
    }
    this.parentElement = null;
    this.isConnected = false;
  }
}

class FakeChromeEvent {
  constructor() { this.listeners = new Set(); }
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
}

function fakeVideo(width = 800, height = 450) {
  const video = new FakeTarget();
  const track = Object.assign(new FakeTarget(), {
    kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled',
    activeCues: [{ text: 'Built in' }],
    cues: [
      { startTime: 1, endTime: 2, text: 'Built in' },
      { startTime: 3, endTime: 4, text: 'Another line' },
      { startTime: 5, endTime: 6, text: 'Third line' },
    ],
  });
  video.readyState = 1;
  video.clientWidth = width;
  video.currentTime = 1.5;
  video.matches = (selector) => selector === 'video';
  video.getBoundingClientRect = () => ({ width, height, left: 10, top: 20 });
  video.textTracks = Object.assign(new FakeTarget(), {
    0: track,
    length: 1,
    [Symbol.iterator]: function* iterator() { yield this[0]; },
  });
  return video;
}

async function makeHarness() {
  const runtimeSource = await fs.readFile(new URL('../content-runtime.js', import.meta.url), 'utf8');
  const contentSource = await fs.readFile(new URL('../content.js', import.meta.url), 'utf8');
  const document = Object.assign(new FakeTarget(), {
    title: 'Fixture player',
    videos: [fakeVideo()],
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => Object.assign(new FakeElement('#text'), { textContent: text }),
    querySelectorAll(selector) { return selector === 'video' ? this.videos : []; },
  });
  document.documentElement.isConnected = true;
  const reports = [];
  const scheduled = [];
  const onMessage = new FakeChromeEvent();
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const sandbox = new FakeTarget();
  Object.assign(sandbox, {
    console,
    setTimeout(callback) { scheduled.push(callback); return scheduled.length; },
    clearTimeout,
    crypto: { randomUUID: () => 'fixture-cache-uuid' },
    TextEncoder,
    URL,
    document,
    location: { href: 'https://player.example/embed?token=temporary' },
    MutationObserver: FakeMutationObserver,
    chrome: {
      runtime: {
        onMessage,
        sendMessage(message) { reports.push(structuredClone(message)); return Promise.resolve({ ok: true }); },
      },
    },
  });
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  return { context, runtimeSource, contentSource, document, reports, onMessage, observers, scheduled };
}

test('production bootstrap re-reports after reinjection without duplicate controller listeners', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const firstListenerCount = harness.document.videos[0].listenerCount();

  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);

  assert.equal(harness.reports.filter((message) => message.type === 'dualCaptions.player.report').length, 2);
  assert.equal(harness.onMessage.listeners.size, 1);
  assert.equal(harness.document.videos[0].listenerCount(), firstListenerCount);
});

test('production content message renders only the selected original track safely', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: {
      secondTrackId: 'external:mine', secondBottom: 8, fontSize: 24, selectedPlayerKey: '',
    },
    externalTracks: [{ id: 'mine', name: 'Mine', offsetSeconds: 0, cues: [{ start: 1, end: 2, text: '<b>Imported</b>' }] }],
  }, {}, () => {});

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.ok(overlay);
  assert.equal(overlay.children.length, 1);
  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'Imported');
  assert.equal(overlay.children[0].style.bottom, '8%');
});

test('production turns prepared English phrases into toggled translation tooltips', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = (message) => {
    if (message.type === 'dualCaptions.caption.translate') {
      return Promise.resolve({ ok: true, data: {
        items: [{ start: 0, end: 5, text: 'Built', dictionary: 'строить', context: 'встроенный' }],
      } });
    }
    harness.reports.push(structuredClone(message));
    return Promise.resolve({ ok: true });
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const phrase = overlay.children[0].children[0];
  assert.equal(phrase.textContent, 'Built');
  phrase.dispatch('click', { stopPropagation() {} });
  assert.equal(
    overlay.children.at(-1).children[1].children.map((child) => child.textContent).join(' '),
    'Обычно строить',
  );

  phrase.dispatch('click', { stopPropagation() {} });
  assert.equal(overlay.children.length, 1);
});

test('production makes the original caption clickable while its translation is loading', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = (message) => {
    if (message.type === 'dualCaptions.caption.translate') return new Promise(() => {});
    harness.reports.push(structuredClone(message));
    return Promise.resolve({ ok: true });
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const token = overlay.children[0].children[0];
  assert.equal(token.textContent, 'Built');
  token.dispatch('click', { stopPropagation() {} });
  assert.equal(
    overlay.children.at(-1).children[1].children.map((child) => child.textContent).join(' '),
    'Обычно Перевод готовится…',
  );
});

test('production keeps original caption tokens clickable when AI returns no phrases', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = (message) => {
    if (message.type === 'dualCaptions.caption.translate') return Promise.resolve({ ok: true, data: { items: [] } });
    harness.reports.push(structuredClone(message));
    return Promise.resolve({ ok: true });
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const token = overlay.children[0].children[0];
  assert.equal(token.textContent, 'Built');
  assert.equal(token.listeners.get('click')?.size, 1);
});

test('production always prepares the selected original second track for translation', async () => {
  const harness = await makeHarness();
  Object.assign(harness.document.videos[0].textTracks[0], {
    label: 'Русский', language: 'ru', activeCues: [{ text: 'A name appears' }],
  });
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();

  assert.equal(harness.reports.some((message) => message.type === 'dualCaptions.caption.translate'), true);
});

test('production saves selected built-in subtitle cues before an audio switch can remove them', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();

  const snapshot = harness.reports.find((message) => message.type === 'dualCaptions.track.cacheBuiltin');
  assert.ok(snapshot);
  assert.equal(snapshot.track.cues[0].text, 'Built in');
  assert.equal(snapshot.track.cues[1].start, 3);
});

test('production uses the saved fallback only after the native track disappears', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  const settings = {
    secondTrackId: 'track-0', secondBottom: 8, fontSize: 24,
    secondTrackCacheId: 'builtin-cache-fixture-cache-uuid',
    secondTrackCacheSource: '\u0000track-0',
  };
  const cached = [{ id: 'builtin-cache-fixture-cache-uuid', sourceType: 'builtin-cache', name: 'Saved', offsetSeconds: 0, timeScale: 1, cues: [{ start: 1, end: 2, text: 'Saved fallback' }] }];

  listener({ type: 'dualCaptions.content.fullState', settings, externalTracks: cached }, {}, () => {});
  let overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'Built in');

  harness.document.videos[0].textTracks[0] = undefined;
  harness.document.videos[0].textTracks.length = 0;
  harness.document.videos[0].textTracks[Symbol.iterator] = function* noTracks() {};
  listener({ type: 'dualCaptions.content.tracks', settings, externalTracks: cached }, {}, () => {});
  overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'Saved fallback');
});

test('production prepares the next three original captions before they appear', async () => {
  const harness = await makeHarness();
  harness.document.videos[0].textTracks[0].activeCues = [{ text: 'Current line' }];
  harness.document.videos[0].textTracks[0].cues = [
    { startTime: 1, endTime: 2, text: 'Current line' },
    { startTime: 5, endTime: 6, text: 'First next' },
    { startTime: 10, endTime: 11, text: 'Second next' },
    { startTime: 15, endTime: 16, text: 'Third next' },
  ];
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    harness.scheduled.shift()?.();
  }

  assert.deepEqual(
    harness.reports.filter((message) => message.type === 'dualCaptions.caption.translate').map((message) => message.text),
    ['Current line', 'First next', 'Second next', 'Third next'],
  );
});

test('production recognizes English metadata used by Russian players', async () => {
  const harness = await makeHarness();
  Object.assign(harness.document.videos[0].textTracks[0], {
    label: 'Английский', language: 'eng', activeCues: [{ text: 'A name appears' }],
  });
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();

  assert.equal(harness.reports.some((message) => message.type === 'dualCaptions.caption.translate'), true);
});

test('production keeps a selected built-in track when the player recreates it during an audio switch', async () => {
  const harness = await makeHarness();
  const video = harness.document.videos[0];
  const originalTrack = video.textTracks[0];
  originalTrack.id = 'subtitle-before-audio-switch';
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  const selectedId = harness.context.DualCaptionsContentRuntime.trackChoices(video.textTracks)[0].id;
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: selectedId, secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');

  const recreatedTrack = Object.assign(new FakeTarget(), {
    id: 'subtitle-after-audio-switch',
    kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled', activeCues: [{ text: 'After switch' }],
  });
  video.textTracks[0] = recreatedTrack;
  video.textTracks.dispatch('removetrack', { track: originalTrack });
  video.textTracks.dispatch('addtrack', { track: recreatedTrack });

  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'After switch');
  assert.equal(originalTrack.mode, 'disabled');
});

test('production restores a built-in track after an audio switch recreates the player context', async () => {
  const harness = await makeHarness();
  const originalTrack = harness.document.videos[0].textTracks[0];
  originalTrack.id = 'subtitle-before-context-reload';
  vm.runInContext(harness.runtimeSource, harness.context);
  const selected = harness.context.DualCaptionsContentRuntime.trackChoices([originalTrack])[0];
  const recreatedVideo = fakeVideo();
  Object.assign(recreatedVideo.textTracks[0], {
    id: 'subtitle-after-context-reload',
    label: 'Original CC',
    language: 'en-US',
    activeCues: [{ text: 'After context reload' }],
  });
  harness.document.videos = [recreatedVideo];
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: {
      secondTrackId: selected.id,
      secondTrackFallbackId: selected.fallbackId,
      secondBottom: 8,
      fontSize: 24,
    },
    externalTracks: [],
  }, {}, () => {});

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'After context reload');
});

test('production late built-in track report keeps the bound video reference', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const reportsBefore = harness.reports.length;

  harness.document.videos[0].dispatch('loadedmetadata');

  assert.equal(harness.reports.length, reportsBefore + 1);
  assert.equal(harness.reports.at(-1).player.tracks[0].label, 'English');
});

test('production overlay moves inside a fullscreen player container and returns afterwards', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const fullscreenPlayer = new FakeElement('div');
  fullscreenPlayer.contains = (node) => node === harness.document.videos[0];

  harness.document.fullscreenElement = fullscreenPlayer;
  harness.document.dispatch('fullscreenchange');
  assert.equal(overlay.parentElement, fullscreenPlayer);

  harness.document.fullscreenElement = null;
  harness.document.dispatch('fullscreenchange');
  assert.equal(overlay.parentElement, harness.document.documentElement);
});

test('production overlay text changes do not trigger a discovery-report loop', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const reportCount = harness.reports.length;

  harness.observers[0].callback([{
    target: overlay,
    addedNodes: [overlay.children[0]],
    removedNodes: [],
  }]);

  assert.equal(harness.reports.length, reportCount);
});

test('production mutation discovery detaches listeners from a replaced video', async () => {
  const harness = await makeHarness();
  const first = harness.document.videos[0];
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const second = fakeVideo(900, 500);
  harness.document.videos = [second];

  harness.observers[0].callback([{
    target: harness.document.documentElement,
    addedNodes: [second],
    removedNodes: [first],
  }]);

  assert.equal(first.listenerCount(), 0);
  assert.ok(second.listenerCount() > 0);
});


test('production reset clears page subtitles and restores native track mode', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  const video = harness.document.videos[0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.equal(video.textTracks[0].mode, 'hidden');

  listener({ type: 'dualCaptions.content.reset' }, {}, () => {});

  assert.equal(video.textTracks[0].mode, 'disabled');
  assert.equal(overlay.style.display, 'none');
  assert.equal(overlay.children[0].textContent, '');
});
