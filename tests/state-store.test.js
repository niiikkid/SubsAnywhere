import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore, STATE_KEY } from '../state-store.js';

const PAGE_A = 'https://video.example/show/episode-1';
const PAGE_B = 'https://video.example/show/episode-2';

class MemoryStorage {
  constructor(initial = {}, delays = []) {
    this.data = structuredClone(initial);
    this.delays = [...delays];
    this.writes = [];
  }

  async get(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter((name) => name in this.data).map((name) => [name, structuredClone(this.data[name])]));
  }

  async set(values) {
    const delay = this.delays.shift() ?? 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
    Object.assign(this.data, structuredClone(values));
    this.writes.push(structuredClone(values));
  }
}

test('StateStore preserves legacy data for recovery but never leaks it into a new page', async () => {
  const storage = new MemoryStorage({
    dualCaptionsSettings: { firstTrackId: 'track-1', fontSize: 28 },
    dualCaptionsExternalTracks: [{ id: 'old', name: 'Old', cues: [{ start: 0, end: 1, text: 'Old' }] }],
  });
  const store = new StateStore(storage);

  const state = await store.get(PAGE_A);
  const root = await store.getRootForTests();

  assert.equal(state.settings.firstTrackId, '');
  assert.equal(state.externalTracks.length, 0);
  assert.equal(root.legacyState.settings.firstTrackId, 'track-1');
  assert.equal(root.legacyState.externalTracks[0].id, 'old');
  assert.equal(storage.writes.length, 1);
});

test('StateStore serializes concurrent settings patches so the last page value wins', async () => {
  const storage = new MemoryStorage({}, [30, 0, 0]);
  const store = new StateStore(storage);
  await store.get(PAGE_A);

  const first = store.patchSettings(PAGE_A, { fontSize: 24 });
  const second = store.patchSettings(PAGE_A, { fontSize: 36 });
  await Promise.all([first, second]);

  const state = await store.get(PAGE_A);
  assert.equal(state.settings.fontSize, 36);
  assert.equal(storage.data[STATE_KEY].pages[PAGE_A].settings.fontSize, 36);
});

test('StateStore isolates selections, files, offsets, and styles by exact page', async () => {
  const storage = new MemoryStorage({});
  const store = new StateStore(storage);
  const track = { id: 'one', name: 'Episode one', cues: [{ start: 0, end: 1, text: 'Hi' }] };

  await store.addExternalTrack(PAGE_A, track);
  await store.patchSettings(PAGE_A, { firstTrackId: 'external:one', firstBottom: 31 });
  const first = await store.get(PAGE_A);
  const second = await store.get(PAGE_B);

  assert.equal(first.settings.firstTrackId, 'external:one');
  assert.equal(first.settings.firstBottom, 31);
  assert.equal(first.externalTracks.length, 1);
  assert.equal(second.settings.firstTrackId, '');
  assert.equal(second.settings.firstBottom, 14);
  assert.equal(second.externalTracks.length, 0);
});

test('StateStore keeps the last value after a rapid burst of slider updates', async () => {
  const storage = new MemoryStorage({});
  const store = new StateStore(storage);
  await store.get(PAGE_A);

  await Promise.all(Array.from({ length: 100 }, (_, index) => store.patchSettings(PAGE_A, { firstBottom: index })));

  const state = await store.get(PAGE_A);
  assert.equal(state.settings.firstBottom, 95);
  assert.equal(storage.data[STATE_KEY].pages[PAGE_A].settings.firstBottom, 95);
});

test('StateStore reading empty storage returns defaults without writing them', async () => {
  const storage = new MemoryStorage({});
  const store = new StateStore(storage);

  await store.get(PAGE_A);
  await store.get(PAGE_A);
  await store.get(PAGE_B);

  assert.equal(storage.writes.length, 0);
});

test('StateStore owns external-track timing mutations and persists each atomic result', async () => {
  const storage = new MemoryStorage({});
  const store = new StateStore(storage);
  const track = { id: 'mine', name: 'Mine', cues: [{ start: 0, end: 1, text: 'Hi' }], offsetSeconds: 0 };

  await store.addExternalTrack(PAGE_A, track);
  await store.updateExternalTrackTiming(PAGE_A, 'mine', { offsetSeconds: 1.5, timeScale: 1.001 });
  const timed = await store.get(PAGE_A);
  const state = await store.removeExternalTrack(PAGE_A, 'mine');

  assert.equal(timed.externalTracks[0].offsetSeconds, 1.5);
  assert.equal(timed.externalTracks[0].timeScale, 1.001);
  assert.deepEqual(state.externalTracks, []);
  assert.deepEqual(storage.data[STATE_KEY].pages[PAGE_A].externalTracks, []);
});

test('StateStore queue recovers after a failed write', async () => {
  class FailOnceStorage extends MemoryStorage {
    failed = false;
    async set(values) {
      if (!this.failed) {
        this.failed = true;
        throw new Error('disk unavailable');
      }
      return super.set(values);
    }
  }
  const storage = new FailOnceStorage({});
  const store = new StateStore(storage);
  await store.get(PAGE_A);

  await assert.rejects(store.patchSettings(PAGE_A, { fontSize: 24 }), /disk unavailable/);
  const state = await store.patchSettings(PAGE_A, { fontSize: 32 });

  assert.equal(state.settings.fontSize, 32);
  assert.equal(storage.data[STATE_KEY].pages[PAGE_A].settings.fontSize, 32);
});

test('StateStore retries initialization after the first migration write fails', async () => {
  class FailInitialWriteStorage extends MemoryStorage {
    attempts = 0;
    async set(values) {
      this.attempts += 1;
      if (this.attempts === 1) throw new Error('temporary storage failure');
      return super.set(values);
    }
  }
  const storage = new FailInitialWriteStorage({ dualCaptionsSettings: { fontSize: 31 } });
  const store = new StateStore(storage);

  await assert.rejects(store.get(PAGE_A), /temporary storage failure/);
  const state = await store.get(PAGE_A);
  const root = await store.getRootForTests();

  assert.equal(state.settings.fontSize, 22);
  assert.equal(root.legacyState.settings.fontSize, 31);
  assert.equal(storage.attempts, 2);
});
