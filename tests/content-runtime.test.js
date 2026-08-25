import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function loadRuntime() {
  const source = await fs.readFile(new URL('../content-runtime.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, setTimeout, clearTimeout, URL });
  vm.runInContext(source, context);
  return context.DualCaptionsContentRuntime;
}

class FakeTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    const values = this.listeners.get(type) ?? new Set();
    values.add(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

function fakeVideo(width, height) {
  const video = new FakeTarget();
  video.readyState = 1;
  video.clientWidth = width;
  video.currentTime = 0;
  video.getBoundingClientRect = () => ({ width, height, left: 0, top: 0 });
  video.textTracks = Object.assign(new FakeTarget(), {
    length: 1,
    0: Object.assign(new FakeTarget(), { kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled', activeCues: [] }),
    [Symbol.iterator]: function* iterator() { yield this[0]; },
  });
  return video;
}

test('chooseVideo returns the largest visible candidate and its stable document index', async () => {
  const runtime = await loadRuntime();
  const small = fakeVideo(200, 100);
  const large = fakeVideo(800, 450);

  const result = runtime.chooseVideo([small, large]);

  assert.equal(result.video, large);
  assert.equal(result.index, 1);
});

test('chooseVideo keeps an initially hidden video eligible for readiness events', async () => {
  const runtime = await loadRuntime();
  const hidden = fakeVideo(0, 0);
  hidden.readyState = 0;

  const result = runtime.chooseVideo([hidden]);

  assert.equal(result.video, hidden);
  assert.equal(result.index, 0);
});

test('bindVideoEvents cleanup removes video, track-list, and cue listeners', async () => {
  const runtime = await loadRuntime();
  const video = fakeVideo(800, 450);
  const cleanup = runtime.bindVideoEvents(video, { render() {}, report() {} });

  assert.ok(video.listenerCount() > 0);
  assert.ok(video.textTracks.listenerCount() > 0);
  assert.ok(video.textTracks[0].listenerCount() > 0);

  cleanup();

  assert.equal(video.listenerCount(), 0);
  assert.equal(video.textTracks.listenerCount(), 0);
  assert.equal(video.textTracks[0].listenerCount(), 0);
});

test('bindVideoEvents attaches and later removes cue listener for a dynamically added track', async () => {
  const runtime = await loadRuntime();
  const video = fakeVideo(800, 450);
  const cleanup = runtime.bindVideoEvents(video, { render() {}, report() {} });
  const added = Object.assign(new FakeTarget(), { kind: 'subtitles', activeCues: [] });

  video.textTracks.dispatch('addtrack', { track: added });
  assert.ok(added.listenerCount() > 0);

  cleanup();
  assert.equal(added.listenerCount(), 0);
});

test('bindVideoEvents detaches a removed text track immediately', async () => {
  const runtime = await loadRuntime();
  const video = fakeVideo(800, 450);
  let reports = 0;
  const cleanup = runtime.bindVideoEvents(video, { render() {}, report() { reports += 1; } });
  const added = Object.assign(new FakeTarget(), { kind: 'subtitles', activeCues: [] });
  video.textTracks.dispatch('addtrack', { track: added });

  video.textTracks.dispatch('removetrack', { track: added });

  assert.equal(added.listenerCount(), 0);
  assert.equal(reports, 2);
  cleanup();
});

test('video manager cleans old bindings when a dynamic player replaces the video', async () => {
  const runtime = await loadRuntime();
  const first = fakeVideo(800, 450);
  const second = fakeVideo(900, 500);
  const reports = [];
  const manager = runtime.createVideoManager({
    report(video, index) { reports.push({ video, index }); },
    render() {},
  });

  manager.discover([first]);
  assert.ok(first.listenerCount() > 0);
  manager.discover([second]);

  assert.equal(first.listenerCount(), 0);
  assert.ok(second.listenerCount() > 0);
  assert.equal(reports.at(-1).video, second);
  manager.destroy();
  assert.equal(second.listenerCount(), 0);
});

test('video manager unbinds a removed video when no replacement exists', async () => {
  const runtime = await loadRuntime();
  const video = fakeVideo(800, 450);
  let renders = 0;
  const manager = runtime.createVideoManager({ report() {}, render() { renders += 1; } });
  manager.discover([video]);

  manager.discover([]);

  assert.equal(video.listenerCount(), 0);
  assert.equal(video.textTracks.listenerCount(), 0);
  assert.equal(video.textTracks[0].listenerCount(), 0);
  assert.equal(manager.current().video, null);
  assert.equal(renders, 2);
});

test('video manager re-reports the same video without duplicating listeners', async () => {
  const runtime = await loadRuntime();
  const video = fakeVideo(800, 450);
  let reports = 0;
  const manager = runtime.createVideoManager({ report() { reports += 1; }, render() {} });

  manager.discover([video]);
  const listenerCount = video.listenerCount();
  manager.discover([video]);

  assert.equal(reports, 2);
  assert.equal(video.listenerCount(), listenerCount);
});

test('installController reuses the existing controller and triggers rediscovery', async () => {
  const runtime = await loadRuntime();
  const root = {};
  let creations = 0;
  let discoveries = 0;
  const factory = () => {
    creations += 1;
    return { discover() { discoveries += 1; } };
  };

  runtime.installController(root, 'controller', factory);
  runtime.installController(root, 'controller', factory);

  assert.equal(creations, 1);
  assert.equal(discoveries, 2);
});

test('runtime sanitizes subtitle markup before it reaches textContent', async () => {
  const runtime = await loadRuntime();
  assert.equal(runtime.cleanSubtitleText('<i>Hello</i><br>world'), 'Hello\nworld');
});

test('runtime external cue lookup keeps positive offset semantics', async () => {
  const runtime = await loadRuntime();
  const cues = [{ start: 10, end: 12, text: '<b>Later</b>' }];
  assert.equal(runtime.cueTextAt(cues, 11, 2), '');
  assert.equal(runtime.cueTextAt(cues, 12.5, 2), 'Later');
});

test('runtime applies AI speed correction without rewriting cue times', async () => {
  const runtime = await loadRuntime();
  const cues = [{ start: 10, end: 12, text: 'Scaled' }];

  assert.equal(runtime.cueTextAt(cues, 20.5, 0, 2), 'Scaled');
  assert.equal(runtime.cueTextAt(cues, 12, 0, 2), '');
});

test('runtime samples a native TextTrack without returning the whole file', async () => {
  const runtime = await loadRuntime();
  const cues = Array.from({ length: 100 }, (_, index) => ({ startTime: index, endTime: index + 0.5, text: `Line ${index}` }));
  const samples = runtime.sampleTextTrack({ cues }, 12);

  assert.equal(samples.length, 12);
  assert.ok(samples[0].start > 0);
  assert.ok(samples.at(-1).start < 100);
});

test('runtime indexed cue lookup preserves overlapping subtitles', async () => {
  const runtime = await loadRuntime();
  const cues = [
    { start: 1, end: 10, text: 'Long cue' },
    { start: 2, end: 3, text: 'Short cue' },
  ];

  assert.equal(runtime.cueTextAt(cues, 2.5), 'Long cue\nShort cue');
  assert.equal(runtime.cueTextAt(cues, 8), 'Long cue');
});

test('runtime reuses an indexed cue lookup instead of rescanning a large SRT', async () => {
  const runtime = await loadRuntime();
  let reads = 0;
  const cues = Array.from({ length: 5_000 }, (_, index) => ({
    get start() { reads += 1; return index * 2; },
    get end() { reads += 1; return index * 2 + 1; },
    get text() { reads += 1; return `Cue ${index}`; },
  }));
  assert.equal(runtime.cueTextAt(cues, 8_000.5), 'Cue 4000');
  reads = 0;

  assert.equal(runtime.cueTextAt(cues, 8_002.5), 'Cue 4001');
  assert.ok(reads < 50, `expected indexed lookup, observed ${reads} cue property reads`);
});

test('runtime built-in track ids survive TextTrackList reordering', async () => {
  const runtime = await loadRuntime();
  const english = { id: 'english-main', kind: 'subtitles', label: 'English', language: 'en' };
  const russian = { id: 'russian-main', kind: 'subtitles', label: 'Русский', language: 'ru' };

  const before = runtime.trackChoices([english, russian]);
  const after = runtime.trackChoices([russian, english]);

  assert.equal(before.find((track) => track.label === 'English').id, after.find((track) => track.label === 'English').id);
  assert.equal(before.find((track) => track.label === 'Русский').id, after.find((track) => track.label === 'Русский').id);
});

test('runtime resolves both stable and legacy built-in track selections', async () => {
  const runtime = await loadRuntime();
  const english = { id: 'english-main', kind: 'subtitles', label: 'English', language: 'en' };
  const russian = { id: 'russian-main', kind: 'subtitles', label: 'Русский', language: 'ru' };
  const tracks = [english, russian];
  const stableId = runtime.trackChoices(tracks)[1].id;

  assert.equal(runtime.findBuiltInTrack(tracks, stableId), russian);
  assert.equal(runtime.findBuiltInTrack(tracks, 'track-1'), russian);
});

test('runtime keeps a selected built-in track when an audio switch replaces all track metadata', async () => {
  const runtime = await loadRuntime();
  const resolver = runtime.createBuiltInTrackResolver();
  const original = { id: 'old-id', kind: 'subtitles', label: 'English', language: 'en' };
  const selectedId = runtime.trackChoices([original])[0].id;

  assert.equal(resolver.find([original], selectedId), original);

  const recreated = { id: 'new-id', kind: 'subtitles', label: 'English CC', language: 'en-US' };
  assert.equal(resolver.find([recreated], selectedId), recreated);
});

test('runtime normalizes settings at the content-script boundary', async () => {
  const runtime = await loadRuntime();

  assert.deepEqual(
    { ...runtime.normalizeSettings({ firstTrackId: 'saved', firstBottom: 200, fontSize: '31', selectedPlayerKey: 'player' }) },
    {
      firstTrackId: 'saved',
      secondTrackId: '',
      firstBottom: 95,
      secondBottom: 5,
      fontSize: 31,
      selectedPlayerKey: 'player',
    },
  );
});

test('runtime ignores overlay text mutations but notices video insertion and removal', async () => {
  const runtime = await loadRuntime();
  const overlayText = {};
  const overlay = { contains(node) { return node === overlayText; } };
  const wrapper = { matches() { return false; }, querySelector(selector) { return selector === 'video' ? {} : null; } };
  const video = { matches(selector) { return selector === 'video'; }, querySelector() { return null; } };

  assert.equal(runtime.mutationsAffectVideo([{ target: overlayText, addedNodes: [overlayText], removedNodes: [] }], overlay), false);
  assert.equal(runtime.mutationsAffectVideo([{ target: {}, addedNodes: [wrapper], removedNodes: [] }], overlay), true);
  assert.equal(runtime.mutationsAffectVideo([{ target: {}, addedNodes: [], removedNodes: [video] }], overlay), true);
});
