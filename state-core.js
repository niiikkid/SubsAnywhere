export const SCHEMA_VERSION = 1;

export const DEFAULT_STATE = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  settings: Object.freeze({
    firstTrackId: '',
    secondTrackId: '',
    firstBottom: 14,
    secondBottom: 5,
    fontSize: 22,
    selectedPlayerKey: '',
  }),
  externalTracks: Object.freeze([]),
});

const SETTING_KEYS = new Set([
  'firstTrackId',
  'secondTrackId',
  'firstBottom',
  'secondBottom',
  'fontSize',
  'selectedPlayerKey',
]);

const clone = (value) => structuredClone(value);

function bounded(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalizeTrack(track) {
  if (!track || typeof track.id !== 'string' || !track.id || !Array.isArray(track.cues)) return null;
  return {
    id: track.id,
    name: typeof track.name === 'string' && track.name.trim() ? track.name.trim() : 'Мои субтитры',
    cues: track.cues
      .filter((cue) => Number.isFinite(Number(cue?.start)) && Number.isFinite(Number(cue?.end)) && Number(cue.end) > Number(cue.start) && typeof cue.text === 'string' && cue.text)
      .map((cue) => ({ start: Number(cue.start), end: Number(cue.end), text: cue.text })),
    offsetSeconds: bounded(track.offsetSeconds, -3600, 3600, 0),
  };
}

export function normalizeState(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const settings = source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
    ? source.settings
    : {};
  const tracks = Array.isArray(source.externalTracks)
    ? source.externalTracks.map(normalizeTrack).filter(Boolean)
    : [];

  return {
    ...source,
    schemaVersion: SCHEMA_VERSION,
    settings: {
      ...settings,
      firstTrackId: typeof settings.firstTrackId === 'string' ? settings.firstTrackId : DEFAULT_STATE.settings.firstTrackId,
      secondTrackId: typeof settings.secondTrackId === 'string' ? settings.secondTrackId : DEFAULT_STATE.settings.secondTrackId,
      firstBottom: bounded(settings.firstBottom, 0, 95, DEFAULT_STATE.settings.firstBottom),
      secondBottom: bounded(settings.secondBottom, 0, 95, DEFAULT_STATE.settings.secondBottom),
      fontSize: bounded(settings.fontSize, 12, 48, DEFAULT_STATE.settings.fontSize),
      selectedPlayerKey: typeof settings.selectedPlayerKey === 'string' ? settings.selectedPlayerKey : DEFAULT_STATE.settings.selectedPlayerKey,
    },
    externalTracks: tracks,
  };
}

export function migrateStoredState(stored = {}) {
  if (stored.dualCaptionsState) {
    if (Number(stored.dualCaptionsState.schemaVersion) > SCHEMA_VERSION) {
      throw new Error('Stored state was created by a newer version of the extension');
    }
    return normalizeState(stored.dualCaptionsState);
  }
  return normalizeState({
    schemaVersion: SCHEMA_VERSION,
    settings: stored.dualCaptionsSettings ?? DEFAULT_STATE.settings,
    externalTracks: stored.dualCaptionsExternalTracks ?? [],
  });
}

export function patchSettings(state, patch = {}) {
  const current = normalizeState(state);
  const nextSettings = { ...current.settings };
  for (const [key, value] of Object.entries(patch)) {
    if (SETTING_KEYS.has(key) && value !== undefined) nextSettings[key] = value;
  }
  return normalizeState({ ...current, settings: nextSettings });
}

export function addExternalTrack(state, track) {
  const current = normalizeState(state);
  if (current.externalTracks.some((existing) => existing.id === track?.id)) {
    throw new Error(`External track already exists: ${track.id}`);
  }
  const normalized = normalizeTrack(track);
  if (!normalized || !normalized.cues.length) throw new Error('External track is invalid');
  return normalizeState({ ...current, externalTracks: [...current.externalTracks, normalized] });
}

export function updateExternalTrackOffset(state, id, offsetSeconds) {
  const current = normalizeState(state);
  return normalizeState({
    ...current,
    externalTracks: current.externalTracks.map((track) => (
      track.id === id ? { ...track, offsetSeconds: bounded(offsetSeconds, -3600, 3600, track.offsetSeconds) } : track
    )),
  });
}

export function removeExternalTrack(state, id) {
  const current = normalizeState(state);
  const externalId = `external:${id}`;
  return normalizeState({
    ...current,
    settings: {
      ...current.settings,
      firstTrackId: current.settings.firstTrackId === externalId ? '' : current.settings.firstTrackId,
      secondTrackId: current.settings.secondTrackId === externalId ? '' : current.settings.secondTrackId,
    },
    externalTracks: current.externalTracks.filter((track) => track.id !== id),
  });
}

export function buildTrackOptions(playerTracks = [], externalTracks = [], selectedId = '') {
  const options = [{ id: '', label: 'Не показывать', group: '' }];
  for (const track of playerTracks) {
    options.push({
      id: track.id === selectedId || track.legacyId === selectedId ? selectedId : track.id,
      label: `${track.label}${track.language ? ` (${track.language})` : ''}`,
      group: 'Встроенные в плеер',
    });
  }
  for (const track of externalTracks) {
    options.push({ id: `external:${track.id}`, label: track.name, group: 'Добавленные SRT-файлы' });
  }
  if (selectedId && !options.some((option) => option.id === selectedId)) {
    options.push({
      id: selectedId,
      label: 'Ранее выбранные субтитры (сейчас недоступны)',
      group: 'Недоступно сейчас',
      unavailable: true,
    });
  }
  return options;
}

export function cloneState(state) {
  return clone(normalizeState(state));
}
