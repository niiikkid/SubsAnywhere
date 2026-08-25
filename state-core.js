import { DEEPSEEK_MODELS, REASONING_EFFORTS } from './ai-client.js';

export const SCHEMA_VERSION = 2;

export const DEFAULT_STATE = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  settings: Object.freeze({
    firstTrackId: '',
    secondTrackId: '',
    firstBottom: 14,
    secondBottom: 5,
    fontSize: 22,
    selectedPlayerKey: '',
    mediaTitle: '',
    mediaSeason: null,
    mediaEpisode: null,
    aiModel: DEEPSEEK_MODELS[0],
    reasoningEffort: REASONING_EFFORTS[0],
  }),
  externalTracks: Object.freeze([]),
});

export const DEFAULT_ROOT_STATE = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  pages: Object.freeze({}),
});

const SETTING_KEYS = new Set([
  'firstTrackId',
  'secondTrackId',
  'firstBottom',
  'secondBottom',
  'fontSize',
  'selectedPlayerKey',
  'mediaTitle',
  'mediaSeason',
  'mediaEpisode',
  'aiModel',
  'reasoningEffort',
]);

const clone = (value) => structuredClone(value);

function bounded(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function nullableInteger(value, minimum, maximum) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizeTrack(track) {
  if (!track || typeof track.id !== 'string' || !track.id || !Array.isArray(track.cues)) return null;
  return {
    ...track,
    id: track.id,
    name: typeof track.name === 'string' && track.name.trim() ? track.name.trim() : 'Мои субтитры',
    language: typeof track.language === 'string' ? track.language.trim().toLowerCase().slice(0, 12) : '',
    cues: track.cues
      .filter((cue) => Number.isFinite(Number(cue?.start)) && Number.isFinite(Number(cue?.end)) && Number(cue.end) > Number(cue.start) && typeof cue.text === 'string' && cue.text)
      .map((cue) => ({ start: Number(cue.start), end: Number(cue.end), text: cue.text })),
    offsetSeconds: bounded(track.offsetSeconds, -3600, 3600, 0),
    timeScale: bounded(track.timeScale, 0.9, 1.1, 1),
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
      mediaTitle: typeof settings.mediaTitle === 'string' ? settings.mediaTitle.trim().slice(0, 300) : DEFAULT_STATE.settings.mediaTitle,
      mediaSeason: nullableInteger(settings.mediaSeason, 0, 100),
      mediaEpisode: nullableInteger(settings.mediaEpisode, 0, 1000),
      aiModel: DEEPSEEK_MODELS.includes(settings.aiModel) ? settings.aiModel : DEFAULT_STATE.settings.aiModel,
      reasoningEffort: REASONING_EFFORTS.includes(settings.reasoningEffort) ? settings.reasoningEffort : DEFAULT_STATE.settings.reasoningEffort,
    },
    externalTracks: tracks,
  };
}

export function migrateStoredState(stored = {}) {
  if (stored.dualCaptionsState && !stored.dualCaptionsState.pages) {
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

export function normalizeRootState(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (Number(source.schemaVersion) > SCHEMA_VERSION) {
    throw new Error('Stored state was created by a newer version of the extension');
  }
  const rawPages = source.pages && typeof source.pages === 'object' && !Array.isArray(source.pages)
    ? source.pages
    : {};
  const pages = {};
  for (const [key, pageState] of Object.entries(rawPages)) {
    if (typeof key === 'string' && key && key.length <= 4096) pages[key] = normalizeState(pageState);
  }
  return {
    ...source,
    schemaVersion: SCHEMA_VERSION,
    pages,
    ...(source.legacyState ? { legacyState: normalizeState(source.legacyState) } : {}),
  };
}

export function migrateStoredRoot(stored = {}) {
  const existing = stored.dualCaptionsState;
  if (existing?.pages) return normalizeRootState(existing);
  const hasLegacy = Boolean(existing)
    || Object.hasOwn(stored, 'dualCaptionsSettings')
    || Object.hasOwn(stored, 'dualCaptionsExternalTracks');
  const root = normalizeRootState({ schemaVersion: SCHEMA_VERSION, pages: {} });
  if (hasLegacy) root.legacyState = migrateStoredState(stored);
  return root;
}

export function pageStateFromRoot(root, pageKey) {
  const current = normalizeRootState(root);
  return clone(current.pages[String(pageKey)] ?? normalizeState({}));
}

export function setPageStateInRoot(root, pageKey, pageState) {
  const key = String(pageKey || '');
  if (!key || key.length > 4096) throw new Error('Invalid page key');
  const current = normalizeRootState(root);
  return normalizeRootState({
    ...current,
    pages: { ...current.pages, [key]: normalizeState(pageState) },
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

export function applySubtitleSearchResult(state, result = {}) {
  let current = normalizeState(state);
  for (const rawTrack of Array.isArray(result.tracks) ? result.tracks : []) {
    const track = normalizeTrack(rawTrack);
    if (!track || !track.cues.length) continue;
    const index = current.externalTracks.findIndex((existing) => existing.id === track.id);
    if (index < 0) {
      current = normalizeState({ ...current, externalTracks: [...current.externalTracks, track] });
      continue;
    }
    if (current.externalTracks[index]?.source?.provider === 'subdl-web') {
      const externalTracks = [...current.externalTracks];
      externalTracks[index] = track;
      current = normalizeState({ ...current, externalTracks });
    }
  }
  return patchSettings(current, result.settingsPatch ?? {});
}

export function updateExternalTrackTiming(state, id, timing = {}) {
  const current = normalizeState(state);
  return normalizeState({
    ...current,
    externalTracks: current.externalTracks.map((track) => (
      track.id === id
        ? {
          ...track,
          offsetSeconds: bounded(timing.offsetSeconds, -3600, 3600, track.offsetSeconds),
          timeScale: bounded(timing.timeScale, 0.9, 1.1, track.timeScale),
        }
        : track
    )),
  });
}

export function updateExternalTrackOffset(state, id, offsetSeconds) {
  return updateExternalTrackTiming(state, id, { offsetSeconds });
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

export function cloneRootState(root) {
  return clone(normalizeRootState(root));
}
