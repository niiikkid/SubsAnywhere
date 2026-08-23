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
  }
  setAttribute() {}
  append(...children) {
    for (const child of children) {
      child.isConnected = true;
      this.children.push(child);
    }
  }
  remove() { this.isConnected = false; }
}

class FakeChromeEvent {
  constructor() { this.listeners = new Set(); }
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
}

function fakeVideo(width = 800, height = 450) {
  const video = new FakeTarget();
  const track = Object.assign(new FakeTarget(), {
    kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled', activeCues: [{ text: 'Built in' }],
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
    querySelectorAll(selector) { return selector === 'video' ? this.videos : []; },
  });
  document.documentElement.isConnected = true;
  const reports = [];
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
    setTimeout,
    clearTimeout,
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
  return { context, runtimeSource, contentSource, document, reports, onMessage, observers };
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

test('production content message renders built-in and imported tracks safely', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: {
      firstTrackId: 'track-0', secondTrackId: 'external:mine',
      firstBottom: 20, secondBottom: 8, fontSize: 24, selectedPlayerKey: '',
    },
    externalTracks: [{ id: 'mine', name: 'Mine', offsetSeconds: 0, cues: [{ start: 1, end: 2, text: '<b>Imported</b>' }] }],
  }, {}, () => {});

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.ok(overlay);
  assert.equal(overlay.children[0].textContent, 'Built in');
  assert.equal(overlay.children[1].textContent, 'Imported');
  assert.equal(overlay.children[0].style.bottom, '20%');
  assert.equal(overlay.children[1].style.bottom, '8%');
});

test('production overlay text changes do not trigger a discovery-report loop', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { firstTrackId: 'track-0', secondTrackId: '', firstBottom: 20, secondBottom: 8, fontSize: 24 },
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
