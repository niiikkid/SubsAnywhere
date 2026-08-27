export const SCHEMA_VERSION = 4;

export const DEFAULT_STATE = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  settings: Object.freeze({
    secondTrackId: '',
    secondTrackFallbackId: '',
    secondTrackCacheId: '',
    secondTrackCacheSource: '',
    secondBottom: 5,
    fontSize: 22,
    selectedPlayerKey: '',
  }),
  externalTracks: Object.freeze([]),
});

export const DEFAULT_ROOT_STATE = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  pages: Object.freeze({}),
});

const SETTING_KEYS = new Set([
  'secondTrackId',
  'secondTrackFallbackId',
  'secondTrackCacheId',
  'secondTrackCacheSource',
  'secondBottom',
  'fontSize',
  'selectedPlayerKey',
]);
const MAX_BUILT_IN_CACHE_CUES = 5_000;
const MAX_BUILT_IN_CUE_CHARS = 1_200;
const MAX_BUILT_IN_CACHE_BYTES = 5 * 1024 * 1024;

export function isBuiltInCacheTrack(track) {
  return track?.sourceType === 'builtin-cache';
}

const clone = (value) => structuredClone(value);

function bounded(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
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
  const {
    firstTrackId,
    firstTrackFallbackId,
    firstBottom,
    mediaTitle: _mediaTitle,
    mediaSeason: _mediaSeason,
    mediaEpisode: _mediaEpisode,
    aiModel: _aiModel,
    reasoningEffort: _reasoningEffort,
    ...retainedSettings
  } = settings;
  const tracks = Array.isArray(source.externalTracks)
    ? source.externalTracks.map(normalizeTrack).filter(Boolean)
    : [];
  const hasOriginalSelection = typeof settings.secondTrackId === 'string' && settings.secondTrackId;
  const usingLegacyFirst = !hasOriginalSelection && typeof firstTrackId === 'string' && firstTrackId;
  const selectedTrackId = hasOriginalSelection
    ? settings.secondTrackId
    : (usingLegacyFirst ? firstTrackId : DEFAULT_STATE.settings.secondTrackId);
  const selectedFallbackId = hasOriginalSelection
    ? settings.secondTrackFallbackId
    : (usingLegacyFirst && typeof firstTrackFallbackId === 'string' ? firstTrackFallbackId : DEFAULT_STATE.settings.secondTrackFallbackId);
  const selectedBottom = hasOriginalSelection || !usingLegacyFirst
    ? settings.secondBottom
    : firstBottom;

  return {
    ...source,
    schemaVersion: SCHEMA_VERSION,
    settings: {
      ...retainedSettings,
      secondTrackId: selectedTrackId,
      secondTrackFallbackId: selectedFallbackId,
      secondTrackCacheId: typeof settings.secondTrackCacheId === 'string' ? settings.secondTrackCacheId : '',
      secondTrackCacheSource: typeof settings.secondTrackCacheSource === 'string' ? settings.secondTrackCacheSource : '',
      secondBottom: bounded(selectedBottom, 0, 95, DEFAULT_STATE.settings.secondBottom),
      fontSize: bounded(settings.fontSize, 12, 48, DEFAULT_STATE.settings.fontSize),
      selectedPlayerKey: typeof settings.selectedPlayerKey === 'string' ? settings.selectedPlayerKey : DEFAULT_STATE.settings.selectedPlayerKey,
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

export function builtInTrackFallbackPatch(settings = {}, playerTracks = [], options = {}) {
  const patch = {};
  const tracks = Array.isArray(playerTracks) ? playerTracks : [];
  for (const [trackKey, fallbackKey] of [['secondTrackId', 'secondTrackFallbackId']]) {
    const selectedId = typeof settings[trackKey] === 'string' ? settings[trackKey] : '';
    if (!selectedId || selectedId.startsWith('external:')) {
      if (settings[fallbackKey]) patch[fallbackKey] = '';
      continue;
    }
    const stableTrack = tracks.find((track) => track?.id === selectedId);
    const hasPersistedFallback = /^caption-\d+$/.test(String(settings[fallbackKey] ?? ''));
    if (
      !stableTrack
      && /^track-\d+$/.test(selectedId)
      && hasPersistedFallback
      && !options.replaceLegacyFallback
    ) continue;
    const selectedTrack = stableTrack ?? tracks.find((track) => track?.legacyId === selectedId);
    const fallbackId = typeof selectedTrack?.fallbackId === 'string' ? selectedTrack.fallbackId : '';
    if (fallbackId && fallbackId !== settings[fallbackKey]) patch[fallbackKey] = fallbackId;
  }
  return patch;
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

export function cacheBuiltInTrack(state, track, sourceKey) {
  const current = normalizeState(state);
  if (!track || typeof track.id !== 'string' || !track.id.startsWith('builtin-cache-') || track.sourceType !== 'builtin-cache' || !Array.isArray(track.cues)) {
    throw new Error('Built-in subtitle cache is invalid');
  }
  if (track.cues.length > MAX_BUILT_IN_CACHE_CUES) {
    throw new Error('Built-in subtitle cache is too large');
  }
  const safeCues = [];
  const encoder = new TextEncoder();
  let serializedBytes = 2;
  for (const cue of track.cues) {
    const start = Number(cue?.start);
    const end = Number(cue?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || typeof cue?.text !== 'string' || !cue.text) continue;
    if (cue.text.length > MAX_BUILT_IN_CUE_CHARS) throw new Error('Built-in subtitle cache is too large');
    const safeCue = { start, end, text: cue.text };
    serializedBytes += encoder.encode(JSON.stringify(safeCue)).byteLength + (safeCues.length ? 1 : 0);
    if (serializedBytes > MAX_BUILT_IN_CACHE_BYTES) throw new Error('Built-in subtitle cache is too large');
    safeCues.push(safeCue);
  }
  const normalized = normalizeTrack({ ...track, cues: safeCues });
  if (!normalized?.cues.length) {
    throw new Error('Built-in subtitle cache is too large');
  }
  if (typeof sourceKey !== 'string' || !sourceKey || sourceKey.length > 4096) {
    throw new Error('Built-in subtitle cache source is invalid');
  }
  return normalizeState({
    ...current,
    settings: {
      ...current.settings,
      secondTrackCacheId: normalized.id,
      secondTrackCacheSource: sourceKey,
    },
    externalTracks: [
      ...current.externalTracks.filter((existing) => !isBuiltInCacheTrack(existing)),
      normalized,
    ],
  });
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
      secondTrackId: current.settings.secondTrackId === externalId ? '' : current.settings.secondTrackId,
    },
    externalTracks: current.externalTracks.filter((track) => track.id !== id),
  });
}

export function buildTrackOptions(
  playerTracks = [],
  externalTracks = [],
  selectedId = '',
  selectedFallbackId = '',
) {
  const options = [{ id: '', label: 'Не показывать', group: '' }];
  const hasStableMatch = playerTracks.some((track) => track?.id === selectedId);
  const useFallback = !hasStableMatch
    && !selectedId.startsWith('external:')
    && /^caption-\d+$/.test(selectedFallbackId);
  for (const track of playerTracks) {
    const selected = track.id === selectedId
      || (useFallback && track.fallbackId === selectedFallbackId)
      || (!hasStableMatch && !useFallback && track.legacyId === selectedId);
    options.push({
      id: selected ? selectedId : track.id,
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
