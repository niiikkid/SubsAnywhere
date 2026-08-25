import {
  addExternalTrack,
  applySubtitleSearchResult,
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

  addExternalTrack(pageKey, track) {
    return this.#mutatePage(pageKey, (state) => addExternalTrack(state, track));
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

  applySubtitleSearchResult(pageKey, result) {
    return this.#mutatePage(pageKey, (state) => applySubtitleSearchResult(state, result));
  }

  #mutatePage(pageKey, updater) {
    const operation = this.#queue.then(async () => {
      await this.#ensureLoaded();
      const current = pageStateFromRoot(this.#root, pageKey);
      const next = updater(current);
      const nextRoot = setPageStateInRoot(this.#root, pageKey, next);
      await this.#storage.set({ [STATE_KEY]: nextRoot });
      this.#root = nextRoot;
      return cloneState(next);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
}
