import test from 'node:test';
import assert from 'node:assert/strict';
import { TranslationPreparation } from '../translation-preparation.js';

class MemoryStorage {
  data = {};
  async get(keys) {
    return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(this.data[key])]));
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
}
const configuration = async () => ({ provider: 'deepseek', model: 'deepseek-chat', hasApiKey: true });
const pageKey = 'https://www.youtube.com/watch?v=GgXaTa4k_QU';
const track = { id: 'fixture', cues: [
  { start: 1, end: 4, text: 'First line' },
  { start: 3, end: 6, text: 'Second line' },
] };
const translated = (descriptor) => ({ items: [{ text: descriptor.displayText, dictionary: 'Перевод', isSentenceTranslation: true }] });
async function settled(service, source = track) {
  for (let index = 0; index < 200; index += 1) {
    const status = await service.status(pageKey, source);
    if (status.status !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('preparation did not settle');
}

test('whole-track preparation saves every displayed overlap and restores without any AI requests', async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const service = new TranslationPreparation(storage, { configuration, translate: async (descriptor) => {
    calls.push(descriptor.sourceText);
    return translated(descriptor);
  } });
  assert.equal((await service.status(pageKey, track)).status, 'idle');
  assert.equal(calls.length, 0, 'opening progress must never start paid work');
  await service.start(pageKey, track);
  const ready = await settled(service);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.completed, ready.total);
  assert.deepEqual(new Set(calls), new Set(['First line', 'First line\nSecond line', 'Second line']));
  const restored = new TranslationPreparation(storage, { configuration, translate: () => assert.fail('cached playback must not translate') });
  const payload = await restored.payload(pageKey, track);
  assert.equal(payload.status, 'ready');
  assert.equal(payload.entries.length, 3);
  assert.ok(payload.entries.every((entry) => entry.items[0].dictionary === 'Перевод'));
  await restored.start(pageKey, track);
  assert.equal((await restored.status(pageKey, track)).status, 'ready');
  assert.equal((await restored.status('https://www.youtube.com/watch?v=XuoqKYxDHVc', track)).status, 'idle');
  assert.equal((await restored.status(pageKey, { ...track, cues: [{ start: 1, end: 3, text: 'Changed source' }] })).status, 'idle');
});

test('failed preparation keeps completed results and resumes only missing captions after an explicit action', async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const source = { id: 'plain', cues: [
    { start: 1, end: 2, text: 'One' }, { start: 3, end: 4, text: 'Two' }, { start: 5, end: 6, text: 'Three' },
  ] };
  let fail = true;
  const service = new TranslationPreparation(storage, { configuration, translate: async (descriptor) => {
    calls.push(descriptor.sourceText);
    if (fail && descriptor.sourceText === 'Two') throw new Error('Провайдер недоступен');
    return translated(descriptor);
  } });
  await service.start(pageKey, source);
  const error = await settled(service, source);
  assert.equal(error.status, 'error');
  assert.ok(error.completed > 0 && error.completed < error.total);
  const previousOne = calls.filter((value) => value === 'One').length;
  await service.status(pageKey, source);
  fail = false;
  await service.start(pageKey, source);
  assert.equal((await settled(service, source)).status, 'ready');
  assert.equal(calls.filter((value) => value === 'One').length, previousOne);
});

test('pause prevents further admissions and a restarted worker preserves progress without automatic paid retries', async () => {
  const storage = new MemoryStorage();
  const pending = [];
  const source = { id: 'pause', cues: Array.from({ length: 6 }, (_, i) => ({ start: i * 3, end: i * 3 + 2, text: `Line ${i}` })) };
  const service = new TranslationPreparation(storage, { configuration, translate: (descriptor) => new Promise((resolve) => pending.push(() => resolve(translated(descriptor)))) });
  await service.start(pageKey, source);
  for (let index = 0; index < 20 && !pending.length; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(pending.length > 0 && pending.length <= 2);
  await service.pause(pageKey, source);
  const admitted = pending.length;
  for (const resolve of pending) resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pending.length, admitted);
  assert.equal((await service.status(pageKey, source)).status, 'paused');
  const restored = new TranslationPreparation(storage, { configuration, translate: () => assert.fail('restart must not silently spend') });
  assert.equal((await restored.status(pageKey, source)).completed, admitted);
});
