import { canonicalPageKey } from './page-context.js';
import { MESSAGE, failure, ok } from './protocol.js';

const CONTENT_SCRIPT_ID = 'dual-captions-player-discovery-v1';

export function stablePlayerKey(frameUrl, videoIndex = 0) {
  try {
    const url = new URL(frameUrl);
    const transientParameters = new Set([
      '_', 'auth', 'authorization', 'exp', 'expires', 'key', 'sig', 'signature',
      't', 'timestamp', 'token',
    ]);
    const stableParameters = [...url.searchParams.entries()]
      .filter(([name]) => !transientParameters.has(name.toLowerCase()))
      .sort(([leftName, leftValue], [rightName, rightValue]) => (
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
      ));
    const query = new URLSearchParams(stableParameters).toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}#video-${Number(videoIndex) || 0}`;
  } catch {
    return `${String(frameUrl || 'unknown')}#video-${Number(videoIndex) || 0}`;
  }
}

export class PlayerRegistry {
  #tabs = new Map();
  #waiters = new Map();

  clear(tabId) {
    this.#tabs.delete(tabId);
  }

  report(tabId, frameId, player) {
    const frames = this.#tabs.get(tabId) ?? new Map();
    const descriptor = {
      ...player,
      frameId,
      key: stablePlayerKey(player.frameUrl, player.videoIndex),
    };
    frames.set(frameId, descriptor);
    this.#tabs.set(tabId, frames);
    for (const notify of this.#waiters.get(tabId) ?? []) notify();
    return descriptor;
  }

  list(tabId) {
    return [...(this.#tabs.get(tabId)?.values() ?? [])].sort((a, b) => a.frameId - b.frameId);
  }

  removeTab(tabId) {
    this.#tabs.delete(tabId);
    this.#waiters.delete(tabId);
  }

  waitForPlayers(tabId, timeoutMs = 1500, quietMs = 75) {
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(tabId) ?? new Set();
      let settled = false;
      let quietTimer;
      let timeoutTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(quietTimer);
        clearTimeout(timeoutTimer);
        waiters.delete(notify);
        if (!waiters.size) this.#waiters.delete(tabId);
        resolve(this.list(tabId));
      };
      const notify = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };
      waiters.add(notify);
      this.#waiters.set(tabId, waiters);
      timeoutTimer = setTimeout(finish, timeoutMs);
      if (this.list(tabId).length) notify();
    });
  }
}

export class BackgroundController {
  #chrome;
  #store;
  #registry;
  #credentialStore;
  #deepSeek;
  #discoveryTimeoutMs;
  #discoveryQuietMs;
  #contentRegistration;
  #tabPageKeys = new Map();

  constructor(chromeApi, store, options = {}) {
    this.#chrome = chromeApi;
    this.#store = store;
    this.#registry = options.registry ?? new PlayerRegistry();
    this.#credentialStore = options.credentialStore;
    this.#deepSeek = options.deepSeek;
    this.#discoveryTimeoutMs = options.discoveryTimeoutMs ?? 1500;
    this.#discoveryQuietMs = options.discoveryQuietMs ?? 75;
  }

  players(tabId) {
    return this.#registry.list(tabId);
  }

  removeTab(tabId) {
    this.#registry.removeTab(tabId);
    this.#tabPageKeys.delete(tabId);
  }

  async handleTabNavigation(tabId, url) {
    if (!Number.isInteger(tabId) || !url) return;
    await this.#adoptPage(tabId, canonicalPageKey(url));
  }

  async handle(message, sender = {}) {
    try {
      switch (message?.type) {
        case MESSAGE.PLAYER_REPORT:
          if (!sender.tab?.id && sender.tab?.id !== 0) throw new Error('Player report has no tab');
          return ok(await this.#reportPlayer(sender.tab.id, sender.frameId ?? 0, message.player, message, sender));
        case MESSAGE.PLAYER_GET:
          return ok({ players: await this.#getPlayers(message.tabId, this.#pageKey(message, sender)) });
        case MESSAGE.PLAYER_DISCOVER:
          return ok({ players: await this.#discover(message.tabId, this.#pageKey(message, sender)) });
        case MESSAGE.STATE_GET:
          return ok({ state: await this.#store.get(this.#pageKey(message, sender)) });
        case MESSAGE.PLAYER_SELECT:
          return ok(await this.#selectPlayer(message, this.#pageKey(message, sender)));
        case MESSAGE.STATE_PATCH:
          return ok(await this.#updateSettings(message, this.#pageKey(message, sender)));
        case MESSAGE.TRACK_ADD:
          return ok(await this.#mutateTracks(message.tabId, this.#pageKey(message, sender), () => (
            this.#store.addExternalTrack(this.#pageKey(message, sender), message.track)
          )));
        case MESSAGE.TRACK_REMOVE:
          return ok(await this.#mutateTracks(message.tabId, this.#pageKey(message, sender), () => (
            this.#store.removeExternalTrack(this.#pageKey(message, sender), message.id)
          )));
        case MESSAGE.TRACK_OFFSET:
          return ok(await this.#mutateTracks(message.tabId, this.#pageKey(message, sender), () => (
            this.#store.updateExternalTrackOffset(this.#pageKey(message, sender), message.id, message.offsetSeconds)
          )));
        case MESSAGE.TRACK_TIMING:
          return ok(await this.#mutateTracks(message.tabId, this.#pageKey(message, sender), () => (
            this.#store.updateExternalTrackTiming(this.#pageKey(message, sender), message.id, {
              offsetSeconds: message.offsetSeconds,
              timeScale: message.timeScale,
            })
          )));

        case MESSAGE.AI_CONFIG_GET:
          if (!this.#credentialStore) throw new Error('DeepSeek пока недоступен');
          return ok(await this.#credentialStore.publicInfo());
        case MESSAGE.AI_CONFIG_PATCH:
          if (!this.#credentialStore) throw new Error('DeepSeek пока недоступен');
          return ok(await this.#credentialStore.patch(message));
        case MESSAGE.CAPTION_TRANSLATE:
          return ok(await this.#translateCaption(message));
        default:
          throw new Error(`Unknown message: ${message?.type ?? 'empty'}`);
      }
    } catch (error) {
      return failure(error);
    }
  }

  #pageKey(message, sender) {
    const tabId = message?.tabId ?? sender?.tab?.id;
    const raw = message?.pageKey || sender?.tab?.url || this.#tabPageKeys.get(tabId) || `https://local.invalid/tab/${tabId ?? 'unknown'}`;
    return canonicalPageKey(raw);
  }

  async #adoptPage(tabId, pageKey) {
    if (!Number.isInteger(tabId)) throw new Error('Invalid tab id');
    const previous = this.#tabPageKeys.get(tabId);
    if (previous && previous !== pageKey) {
      const oldPlayers = this.players(tabId);
      await Promise.all(oldPlayers.map((player) => this.#send(tabId, player.frameId, { type: MESSAGE.CONTENT_RESET })));
      this.#registry.clear(tabId);
    }
    this.#tabPageKeys.set(tabId, pageKey);
  }

  async #discover(tabId, pageKey) {
    if (!Number.isInteger(tabId)) throw new Error('Invalid tab id');
    await this.#adoptPage(tabId, pageKey);
    await this.#ensureContentRegistration();
    this.#registry.clear(tabId);
    await this.#chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content-runtime.js', 'content.js'],
    });
    return this.#registry.waitForPlayers(tabId, this.#discoveryTimeoutMs, this.#discoveryQuietMs);
  }

  async #ensureContentRegistration() {
    const scripting = this.#chrome.scripting;
    if (!scripting.getRegisteredContentScripts || !scripting.registerContentScripts) return;
    if (!this.#contentRegistration) {
      this.#contentRegistration = (async () => {
        const existing = await scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
        if (existing.length) return;
        await scripting.registerContentScripts([{
          id: CONTENT_SCRIPT_ID,
          matches: ['http://*/*', 'https://*/*'],
          js: ['content-runtime.js', 'content.js'],
          allFrames: true,
          matchOriginAsFallback: true,
          persistAcrossSessions: true,
          runAt: 'document_idle',
        }]);
      })().catch((error) => {
        this.#contentRegistration = null;
        throw error;
      });
    }
    await this.#contentRegistration;
  }

  async #getPlayers(tabId, pageKey) {
    await this.#adoptPage(tabId, pageKey);
    const cached = this.players(tabId);
    try {
      return await this.#discover(tabId, pageKey);
    } catch {
      return cached;
    }
  }

  async #reportPlayer(tabId, frameId, playerData, message, sender) {
    const pageKey = this.#pageKey(message, sender);
    await this.#adoptPage(tabId, pageKey);
    const player = this.#registry.report(tabId, frameId, {
      ...playerData,
      tabTitle: sender.tab?.title || playerData?.tabTitle || '',
    });
    const state = await this.#store.reconcileBuiltInTrackFallbacks(pageKey, player.key, player.tracks);
    const selected = player.key === state.settings.selectedPlayerKey;
    const restored = selected
      ? await this.#send(tabId, frameId, {
        type: MESSAGE.CONTENT_FULL_STATE,
        settings: state.settings,
        externalTracks: state.externalTracks,
      })
      : false;
    return { player, restored };
  }

  async #selectPlayer(message, pageKey) {
    await this.#adoptPage(message.tabId, pageKey);
    const player = this.players(message.tabId).find((item) => item.frameId === message.frameId && item.key === message.playerKey);
    if (!player) throw new Error('Выбранный плеер больше недоступен');
    const state = await this.#store.patchSettingsWithPlayerFallbacks(
      pageKey,
      { selectedPlayerKey: player.key },
      [player],
    );
    const delivered = await this.#send(message.tabId, player.frameId, {
      type: MESSAGE.CONTENT_FULL_STATE,
      settings: state.settings,
      externalTracks: state.externalTracks,
    });
    return { state, delivered };
  }

  async #updateSettings(message, pageKey) {
    await this.#adoptPage(message.tabId, pageKey);
    const state = await this.#store.patchSettingsWithPlayerFallbacks(
      pageKey,
      message.patch ?? {},
      this.players(message.tabId),
    );
    const delivered = await this.#sendToSelected(message.tabId, state, {
      type: MESSAGE.CONTENT_SETTINGS,
      settings: state.settings,
    });
    return { state, delivered };
  }

  async #mutateTracks(tabId, pageKey, mutation) {
    await this.#adoptPage(tabId, pageKey);
    const state = await mutation();
    const delivered = await this.#sendToSelected(tabId, state, {
      type: MESSAGE.CONTENT_TRACKS,
      settings: state.settings,
      externalTracks: state.externalTracks,
    });
    return { state, delivered };
  }


  async #translateCaption(message) {
    if (!this.#deepSeek) throw new Error('DeepSeek пока недоступен');
    const text = typeof message?.text === 'string' ? message.text.trim().slice(0, 500) : '';
    if (!text) return { items: [] };
    return {
      items: await this.#deepSeek.translateCaption(text, message.aiOptions),
    };
  }

  async #sendToSelected(tabId, state, payload) {
    const player = this.players(tabId).find((item) => item.key === state.settings.selectedPlayerKey);
    return player ? this.#send(tabId, player.frameId, payload) : false;
  }

  async #request(tabId, frameId, payload) {
    return this.#chrome.tabs.sendMessage(tabId, payload, { frameId });
  }

  async #send(tabId, frameId, payload) {
    try {
      await this.#request(tabId, frameId, payload);
      return true;
    } catch {
      return false;
    }
  }
}
