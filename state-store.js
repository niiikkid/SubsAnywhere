import {
  addExternalTrack,
  builtInTrackFallbackPatch,
  cacheBuiltInTrack,
  cloneRootState,
  cloneState,
  migrateStoredRoot,
  pageStateFromRoot,
  patchSettings,
  removeExternalTrack,
  setPageStateInRoot,
  updateExternalTrackOffset,
  updateExternalTrackTiming,
} from './state-core.js';

export const STATE_KEY = 'dualCaptionsState';
const LEGACY_KEYS = ['dualCaptionsSettings', 'dualCaptionsExternalTracks'];

export class StateStore {
  #storage;
  #root;
  #loading;
  #queue = Promise.resolve();

  constructor(storage) {
    this.#storage = storage;
  }

  async get(pageKey) {
    await this.#ensureLoaded();
    return cloneState(pageStateFromRoot(this.#root, pageKey));
  }

  async getRootForTests() {
    await this.#ensureLoaded();
    return cloneRootState(this.#root);
  }

  async #ensureLoaded() {
    if (this.#root) return;
    if (!this.#loading) {
      this.#loading = this.#load().finally(() => { this.#loading = null; });
    }
    await this.#loading;
  }

  async #load() {
    const keys = [STATE_KEY, ...LEGACY_KEYS];
    const stored = await this.#storage.get(keys);
    const next = migrateStoredRoot(stored);
    const hasAnyStoredState = keys.some((key) => Object.hasOwn(stored, key));
    const alreadyScoped = Boolean(stored[STATE_KEY]?.pages);
    if (hasAnyStoredState && !alreadyScoped) await this.#storage.set({ [STATE_KEY]: next });
    this.#root = next;
  }

  patchSettings(pageKey, patch) {
    return this.#mutatePage(pageKey, (state) => patchSettings(state, patch));
  }

  patchSettingsWithPlayerFallbacks(pageKey, patch, players = []) {
    return this.#mutatePage(pageKey, (state) => {
      const next = patchSettings(state, patch);
      const selectedPlayer = players.find((player) => player?.key === next.settings.selectedPlayerKey);
      const replaceLegacyFallback = [
        ['selectedPlayerKey', state.settings.selectedPlayerKey],
        ['secondTrackId', state.settings.secondTrackId],
      ].some(([key, previous]) => Object.hasOwn(patch, key) && patch[key] !== previous);
      const fallbackPatch = builtInTrackFallbackPatch(
        next.settings,
        selectedPlayer?.tracks ?? [],
        { replaceLegacyFallback },
      );
      return Object.keys(fallbackPatch).length ? patchSettings(next, fallbackPatch) : next;
    });
  }

  addExternalTrack(pageKey, track) {
    return this.#mutatePage(pageKey, (state) => addExternalTrack(state, track));
  }

  cacheBuiltInTrack(pageKey, track, sourceKey) {
    return this.#mutatePage(pageKey, (state) => cacheBuiltInTrack(state, track, sourceKey));
  }

  removeExternalTrack(pageKey, id) {
    return this.#mutatePage(pageKey, (state) => removeExternalTrack(state, id));
  }

  updateExternalTrackOffset(pageKey, id, offsetSeconds) {
    return this.#mutatePage(pageKey, (state) => updateExternalTrackOffset(state, id, offsetSeconds));
  }

  updateExternalTrackTiming(pageKey, id, timing) {
    return this.#mutatePage(pageKey, (state) => updateExternalTrackTiming(state, id, timing));
  }


  reconcileBuiltInTrackFallbacks(pageKey, playerKey, playerTracks) {
    return this.#mutatePage(pageKey, (state) => {
      if (state.settings.selectedPlayerKey !== playerKey) return null;
      const fallbackPatch = builtInTrackFallbackPatch(state.settings, playerTracks);
      return Object.keys(fallbackPatch).length ? patchSettings(state, fallbackPatch) : null;
    });
  }

  #mutatePage(pageKey, updater) {
    const operation = this.#queue.then(async () => {
      await this.#ensureLoaded();
      const current = pageStateFromRoot(this.#root, pageKey);
      const next = updater(current);
      if (next === null) return cloneState(current);
      const nextRoot = setPageStateInRoot(this.#root, pageKey, next);
      await this.#storage.set({ [STATE_KEY]: nextRoot });
      this.#root = nextRoot;
      return cloneState(next);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
}
