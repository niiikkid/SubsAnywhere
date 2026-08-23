import {
  addExternalTrack,
  cloneState,
  migrateStoredState,
  patchSettings,
  removeExternalTrack,
  updateExternalTrackOffset,
} from './state-core.js';

export const STATE_KEY = 'dualCaptionsState';
const LEGACY_KEYS = ['dualCaptionsSettings', 'dualCaptionsExternalTracks'];

export class StateStore {
  #storage;
  #state;
  #loading;
  #queue = Promise.resolve();

  constructor(storage) {
    this.#storage = storage;
  }

  async get() {
    if (this.#state) return cloneState(this.#state);
    if (!this.#loading) {
      this.#loading = this.#load().finally(() => { this.#loading = null; });
    }
    await this.#loading;
    return cloneState(this.#state);
  }

  async #load() {
    const keys = [STATE_KEY, ...LEGACY_KEYS];
    const stored = await this.#storage.get(keys);
    const next = migrateStoredState(stored);
    const hasLegacyState = LEGACY_KEYS.some((key) => Object.hasOwn(stored, key));
    if (!stored[STATE_KEY] && hasLegacyState) {
      await this.#storage.set({ [STATE_KEY]: next });
    }
    this.#state = next;
  }

  patchSettings(patch) {
    return this.#mutate((state) => patchSettings(state, patch));
  }

  addExternalTrack(track) {
    return this.#mutate((state) => addExternalTrack(state, track));
  }

  removeExternalTrack(id) {
    return this.#mutate((state) => removeExternalTrack(state, id));
  }

  updateExternalTrackOffset(id, offsetSeconds) {
    return this.#mutate((state) => updateExternalTrackOffset(state, id, offsetSeconds));
  }

  #mutate(updater) {
    const operation = this.#queue.then(async () => {
      const current = await this.get();
      const next = updater(current);
      await this.#storage.set({ [STATE_KEY]: next });
      this.#state = next;
      return cloneState(next);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
}
