import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore, STATE_KEY } from '../state-store.js';

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

test('StateStore migrates legacy storage once into the versioned root key', async () => {
  const storage = new MemoryStorage({
    dualCaptionsSettings: { firstTrackId: 'track-1', fontSize: 28 },
    dualCaptionsExternalTracks: [],
  });
  const store = new StateStore(storage);

  const state = await store.get();

  assert.equal(state.settings.firstTrackId, 'track-1');
  assert.equal(state.settings.fontSize, 28);
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(storage.data[STATE_KEY], state);
});

test('StateStore serializes concurrent settings patches so the last user value wins', async () => {
  const storage = new MemoryStorage({}, [30, 0, 0]);
  const store = new StateStore(storage);
  await store.get();

  const first = store.patchSettings({ fontSize: 24 });
  const second = store.patchSettings({ fontSize: 36 });
  await Promise.all([first, second]);

  const state = await store.get();
  assert.equal(state.settings.fontSize, 36);
  assert.equal(storage.data[STATE_KEY].settings.fontSize, 36);
});

test('StateStore keeps the last value after a rapid burst of slider updates', async () => {
  const storage = new MemoryStorage({});
  const store = new StateStore(storage);
  await store.get();

  await Promise.all(Array.from({ length: 100 }, (_, index) => store.patchSettings({ firstBottom: index })));

  const state = await store.get();
  assert.equal(state.settings.firstBottom, 95);
  assert.equal(storage.data[STATE_KEY].settings.firstBottom, 95);
});

test('StateStore reading empty storage returns defaults without writing them', async () => {
  const storage = new MemoryStorage({});
  const store = new StateStore(storage);

  await store.get();
  await store.get();
  await store.get();

  assert.equal(storage.writes.length, 0);
});

test('StateStore owns external-track mutations and persists each atomic result', async () => {
  const storage = new MemoryStorage({});
  const store = new StateStore(storage);
  const track = { id: 'mine', name: 'Mine', cues: [{ start: 0, end: 1, text: 'Hi' }], offsetSeconds: 0 };

  await store.addExternalTrack(track);
  await store.updateExternalTrackOffset('mine', 1.5);
  const state = await store.removeExternalTrack('mine');

  assert.deepEqual(state.externalTracks, []);
  assert.deepEqual(storage.data[STATE_KEY].externalTracks, []);
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
  await store.get();

  await assert.rejects(store.patchSettings({ fontSize: 24 }), /disk unavailable/);
  const state = await store.patchSettings({ fontSize: 32 });

  assert.equal(state.settings.fontSize, 32);
  assert.equal(storage.data[STATE_KEY].settings.fontSize, 32);
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
  const storage = new FailInitialWriteStorage({
    dualCaptionsSettings: { fontSize: 31 },
  });
  const store = new StateStore(storage);

  await assert.rejects(store.get(), /temporary storage failure/);
  const state = await store.get();

  assert.deepEqual(storage.data[STATE_KEY], state);
  assert.equal(storage.attempts, 2);
});
