import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STATE,
  SCHEMA_VERSION,
  addExternalTrack,
  builtInTrackFallbackPatch,
  buildTrackOptions,
  cacheBuiltInTrack,
  migrateStoredRoot,
  migrateStoredState,
  normalizeState,
  pageStateFromRoot,
  patchSettings,
  removeExternalTrack,
  setPageStateInRoot,
  updateExternalTrackOffset,
} from '../state-core.js';

test('migrateStoredState keeps the original selection and drops the removed first track', () => {
  const legacyTrack = { id: 'abc', name: 'English', cues: [{ start: 1, end: 2, text: 'Hi' }], offsetSeconds: 1.5 };
  const state = migrateStoredState({
    dualCaptionsSettings: {
      firstTrackId: 'track-1',
      secondTrackId: 'external:abc',
      firstBottom: 22,
      secondBottom: 8,
      fontSize: 26,
    },
    dualCaptionsExternalTracks: [legacyTrack],
  });

  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.equal(state.settings.firstTrackId, undefined);
  assert.equal(state.settings.secondTrackId, 'external:abc');
  assert.deepEqual(state.externalTracks, [{ ...legacyTrack, language: '', timeScale: 1 }]);
});

test('migrateStoredState promotes a lone legacy first track to the original selection', () => {
  const state = migrateStoredState({
    dualCaptionsSettings: {
      firstTrackId: 'external:legacy-original',
      firstTrackFallbackId: 'caption-2',
      firstBottom: 22,
    },
  });

  assert.equal(state.settings.secondTrackId, 'external:legacy-original');
  assert.equal(state.settings.secondTrackFallbackId, 'caption-2');
  assert.equal(state.settings.secondBottom, 22);
});

test('normalizeState preserves a temporarily unavailable selected track id', () => {
  const state = normalizeState({
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_STATE.settings, secondTrackId: 'track-not-loaded-yet' },
    externalTracks: [],
  });

  assert.equal(state.settings.secondTrackId, 'track-not-loaded-yet');
});

test('built-in selections persist a recovery position before the player context is replaced', () => {
  const patch = builtInTrackFallbackPatch(
    { secondTrackId: 'builtin-en' },
    [
      { id: 'builtin-ru', fallbackId: 'caption-0' },
      { id: 'builtin-en', fallbackId: 'caption-1' },
    ],
  );

  assert.deepEqual(patch, { secondTrackFallbackId: 'caption-1' });
});

test('a legacy track index cannot overwrite an existing recovery position after recreation', () => {
  const patch = builtInTrackFallbackPatch(
    {
      secondTrackId: 'track-1',
      secondTrackFallbackId: 'caption-0',
    },
    [
      { id: 'new-a', legacyId: 'track-0', fallbackId: 'caption-0' },
      { id: 'new-b', legacyId: 'track-1', fallbackId: 'caption-1' },
    ],
  );

  assert.deepEqual(patch, {});
});

test('patchSettings ignores undefined UI values instead of clearing stored state', () => {
  const state = normalizeState({
    ...DEFAULT_STATE,
    settings: { ...DEFAULT_STATE.settings, secondTrackId: 'track-1', fontSize: 24 },
  });

  const next = patchSettings(state, { secondTrackId: undefined, fontSize: 30, unknown: 'ignored' });

  assert.equal(next.settings.secondTrackId, 'track-1');
  assert.equal(next.settings.fontSize, 30);
  assert.equal(next.settings.unknown, undefined);
});

test('patchSettings preserves unknown stored fields for forward-compatible updates', () => {
  const state = normalizeState({
    ...DEFAULT_STATE,
    futureTopLevel: { enabled: true },
    settings: { ...DEFAULT_STATE.settings, futurePreference: 'keep-me' },
  });

  const next = patchSettings(state, { fontSize: 30 });

  assert.deepEqual(next.futureTopLevel, { enabled: true });
  assert.equal(next.settings.futurePreference, 'keep-me');
});

test('migrateStoredState refuses a newer schema instead of destroying it', () => {
  assert.throws(
    () => migrateStoredState({
      dualCaptionsState: {
        schemaVersion: SCHEMA_VERSION + 1,
        settings: DEFAULT_STATE.settings,
        externalTracks: [],
      },
    }),
    /newer version/i,
  );
});

test('removeExternalTrack clears only selections that explicitly reference the removed file', () => {
  const state = normalizeState({
    ...DEFAULT_STATE,
    settings: { ...DEFAULT_STATE.settings, secondTrackId: 'external:gone' },
    externalTracks: [
      { id: 'gone', name: 'Gone', cues: [{ start: 0, end: 1, text: 'A' }], offsetSeconds: 0 },
      { id: 'keep', name: 'Keep', cues: [{ start: 0, end: 1, text: 'B' }], offsetSeconds: 0 },
    ],
  });

  const next = removeExternalTrack(state, 'gone');

  assert.equal(next.settings.secondTrackId, '');
  assert.deepEqual(next.externalTracks.map((track) => track.id), ['keep']);
});

test('cacheBuiltInTrack stores a built-in fallback without replacing the native selection', () => {
  const cached = cacheBuiltInTrack(normalizeState({ settings: { secondTrackId: 'track-0' } }), {
    id: 'builtin-cache-main',
    sourceType: 'builtin-cache',
    name: 'Сохранённые встроенные субтитры',
    cues: [{ start: 1, end: 2, text: 'Saved line' }],
    offsetSeconds: 0,
    timeScale: 1,
  }, 'player-1\u0000track-0');

  assert.equal(cached.settings.secondTrackId, 'track-0');
  assert.equal(cached.settings.secondTrackCacheId, 'builtin-cache-main');
  assert.equal(cached.settings.secondTrackCacheSource, 'player-1\u0000track-0');
  assert.equal(cached.externalTracks[0].cues[0].text, 'Saved line');
});

test('cacheBuiltInTrack rejects an oversized native subtitle snapshot', () => {
  assert.throws(
    () => cacheBuiltInTrack(normalizeState({}), {
      id: 'builtin-cache-oversized',
      sourceType: 'builtin-cache',
      name: 'Сохранённые встроенные субтитры',
      cues: [{ start: 1, end: 2, text: 'x'.repeat(1_201) }],
      offsetSeconds: 0,
      timeScale: 1,
    }),
    /too large/i,
  );
});

test('buildTrackOptions keeps a missing selection visible without treating it as available', () => {
  const options = buildTrackOptions(
    [{ id: 'track-0', label: 'English', language: 'en' }],
    [],
    'track-2',
  );

  assert.deepEqual(options, [
    { id: '', label: 'Не показывать', group: '' },
    { id: 'track-0', label: 'English (en)', group: 'Встроенные в плеер' },
    { id: 'track-2', label: 'Ранее выбранные субтитры (сейчас недоступны)', group: 'Недоступно сейчас', unavailable: true },
  ]);
});

test('buildTrackOptions recognizes a legacy index alias without clearing the selection', () => {
  const options = buildTrackOptions(
    [{ id: 'builtin:id%3Aenglish:0', legacyId: 'track-1', label: 'English', language: 'en' }],
    [],
    'track-1',
  );

  assert.deepEqual(options, [
    { id: '', label: 'Не показывать', group: '' },
    { id: 'track-1', label: 'English (en)', group: 'Встроенные в плеер' },
  ]);
});

test('buildTrackOptions displays the persisted fallback instead of a conflicting legacy alias', () => {
  const options = buildTrackOptions(
    [
      { id: 'new-a', legacyId: 'track-0', fallbackId: 'caption-0', label: 'Changed A', language: 'xx' },
      { id: 'new-b', legacyId: 'track-1', fallbackId: 'caption-1', label: 'Changed B', language: 'yy' },
    ],
    [],
    'track-1',
    'caption-0',
  );

  assert.equal(options.find((option) => option.label.startsWith('Changed A')).id, 'track-1');
  assert.equal(options.find((option) => option.label.startsWith('Changed B')).id, 'new-b');
  assert.equal(options.some((option) => option.unavailable), false);
});

test('addExternalTrack rejects duplicate ids instead of replacing user data', () => {
  const existing = { id: 'same', name: 'Original', cues: [{ start: 0, end: 1, text: 'A' }], offsetSeconds: 0 };
  const state = normalizeState({ ...DEFAULT_STATE, externalTracks: [existing] });
  assert.throws(
    () => addExternalTrack(state, { ...existing, name: 'Replacement' }),
    /already exists/i,
  );
  assert.equal(state.externalTracks[0].name, 'Original');
});

test('updateExternalTrackOffset clamps offset and leaves other files untouched', () => {
  const state = normalizeState({
    ...DEFAULT_STATE,
    externalTracks: [
      { id: 'one', name: 'One', cues: [{ start: 0, end: 1, text: 'A' }], offsetSeconds: 0 },
      { id: 'two', name: 'Two', cues: [{ start: 0, end: 1, text: 'B' }], offsetSeconds: 2 },
    ],
  });

  const next = updateExternalTrackOffset(state, 'one', 9999);
  assert.equal(next.externalTracks[0].offsetSeconds, 3600);
  assert.equal(next.externalTracks[1].offsetSeconds, 2);
});

test('scoped root keeps two page states independent', () => {
  let root = migrateStoredRoot({});
  root = setPageStateInRoot(root, 'https://example.test/one', patchSettings(normalizeState({}), { secondTrackId: 'one' }));
  root = setPageStateInRoot(root, 'https://example.test/two', patchSettings(normalizeState({}), { secondTrackId: 'two' }));

  assert.equal(pageStateFromRoot(root, 'https://example.test/one').settings.secondTrackId, 'one');
  assert.equal(pageStateFromRoot(root, 'https://example.test/two').settings.secondTrackId, 'two');
  assert.equal(pageStateFromRoot(root, 'https://example.test/new').settings.secondTrackId, '');
});

test('legacy global state is retained as an orphan but not assigned to arbitrary pages', () => {
  const root = migrateStoredRoot({
    dualCaptionsState: {
      schemaVersion: 1,
      settings: { secondTrackId: 'wrong-episode' },
      externalTracks: [],
    },
  });

  assert.equal(root.legacyState.settings.secondTrackId, 'wrong-episode');
  assert.equal(pageStateFromRoot(root, 'https://example.test/fresh').settings.secondTrackId, '');
});
