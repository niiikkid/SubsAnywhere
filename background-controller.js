import { canonicalPageKey } from './page-context.js';
import { MESSAGE, failure, ok } from './protocol.js';

const CONTENT_SCRIPT_ID = 'dual-captions-player-discovery-v1';
const CONTENT_MESSAGES = new Set([
  MESSAGE.PLAYER_REPORT, MESSAGE.CONTENT_POSITION_PATCH, MESSAGE.TRACK_CACHE_BUILTIN, MESSAGE.CAPTION_TRANSLATE,
  MESSAGE.WORDS_LIST, MESSAGE.WORDS_SAVE, MESSAGE.WORD_EXPLAIN, MESSAGE.WORD_TRANSLATE,
  MESSAGE.SENTENCES_LIST, MESSAGE.SENTENCES_SAVE, MESSAGE.SENTENCE_EXPLAIN,
]);
const SERIALIZED_MESSAGES = new Set([
  MESSAGE.PLAYER_REPORT, MESSAGE.PLAYER_SELECT, MESSAGE.STATE_PATCH, MESSAGE.CONTENT_POSITION_PATCH,
  MESSAGE.TRACK_ADD, MESSAGE.TRACK_UPSERT_LOCAL, MESSAGE.TRACK_CACHE_BUILTIN,
  MESSAGE.TRACK_REMOVE, MESSAGE.TRACK_OFFSET, MESSAGE.TRACK_TIMING,
]);

function validateContentSize(message) {
  let remaining = message.type === MESSAGE.TRACK_CACHE_BUILTIN ? 6 * 1024 * 1024 : 64 * 1024;
  let entries = message.type === MESSAGE.TRACK_CACHE_BUILTIN ? 40_000 : 2_000;
  const visit = (value, depth) => {
    if (--entries < 0 || depth > 8) throw new Error('Сообщение плеера слишком большое');
    if (typeof value === 'string') remaining -= value.length;
    else if (value && typeof value === 'object') {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        remaining -= key.length;
        visit(value[key], depth + 1);
      }
    }
    if (remaining < 0) throw new Error('Сообщение плеера слишком большое');
  };
  visit(message, 0);
}

function boundedString(value, limit, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit) throw new Error('Некорректные данные плеера');
  return value;
}

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

  waitForPlayers(tabId, timeoutMs = 5000, quietMs = 300) {
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
  #aiClient;
  #localSubtitles;
  #vocabulary;
  #discoveryTimeoutMs;
  #discoveryQuietMs;
  #contentRegistration;
  #tabPageKeys = new Map();
  #tabOperations = new Map();
  #playerRecoveries = new Map();

  constructor(chromeApi, store, options = {}) {
    this.#chrome = chromeApi;
    this.#store = store;
    this.#registry = options.registry ?? new PlayerRegistry();
    this.#credentialStore = options.credentialStore;
    this.#aiClient = options.aiClient ?? options.deepSeek;
    this.#localSubtitles = options.localSubtitles;
    this.#vocabulary = options.vocabulary;
    this.#discoveryTimeoutMs = options.discoveryTimeoutMs ?? 5000;
    this.#discoveryQuietMs = options.discoveryQuietMs ?? 300;
  }

  players(tabId) {
    return this.#registry.list(tabId);
  }

  initialize() {
    return this.#ensureContentRegistration(true);
  }

  removeTab(tabId) {
    this.#registry.removeTab(tabId);
    this.#tabPageKeys.delete(tabId);
  }

  async handleTabNavigation(tabId, url) {
    if (!Number.isInteger(tabId) || !url) return;
    await this.#enqueue(tabId, () => this.#adoptPage(tabId, canonicalPageKey(url)));
  }

  async handle(message, sender = {}) {
    try {
      const fromContent = this.#authorize(message, sender);
      // Extension pages may themselves occupy tabs; that is not a content sender.
      if (!fromContent) sender = { id: sender.id, url: sender.url };
      // Reports must be able to enter the tab queue while recovery awaits their acknowledgement.
      const fromWordsPanel = fromContent && this.#isWordsPanelSender(sender);
      if ([MESSAGE.WORD_EXPLAIN, MESSAGE.WORD_TRANSLATE, MESSAGE.SENTENCE_EXPLAIN].includes(message.type) && !fromWordsPanel) {
        throw new Error('ИИ-действие доступно только из панели обучения');
      }
      if (fromContent && !fromWordsPanel && message.type !== MESSAGE.PLAYER_REPORT) await this.#recoverSelectedSender(message, sender);
      const operation = () => this.#dispatch(message, sender);
      return await (SERIALIZED_MESSAGES.has(message.type)
        ? this.#enqueue(sender.tab?.id ?? message.tabId, operation) : operation());
    } catch (error) {
      return failure(error);
    }
  }

  #enqueue(tabId, operation) {
    const pending = (this.#tabOperations.get(tabId) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => undefined).finally(() => {
      if (this.#tabOperations.get(tabId) === settled) this.#tabOperations.delete(tabId);
    });
    this.#tabOperations.set(tabId, settled);
    return pending;
  }

  async #dispatch(message, sender) {
      switch (message?.type) {
        case MESSAGE.PLAYER_REPORT:
          if (!sender.tab?.id && sender.tab?.id !== 0) throw new Error('Player report has no tab');
          return ok(await this.#reportPlayer(sender.tab.id, sender.frameId ?? 0, message.player, message, sender));
        case MESSAGE.PLAYER_GET:
          return ok({ players: await this.#getPlayers(message.tabId, this.#pageKey(message, sender), message.cachedOnly === true) });
        case MESSAGE.PLAYER_DISCOVER:
          return ok({ players: await this.#discover(message.tabId, this.#pageKey(message, sender)) });
        case MESSAGE.STATE_GET:
          return ok({ state: await this.#store.get(this.#pageKey(message, sender)) });
        case MESSAGE.PLAYER_SELECT:
          return ok(await this.#selectPlayer(message, this.#pageKey(message, sender)));
        case MESSAGE.STATE_PATCH:
          return ok(await this.#updateSettings(message, this.#pageKey(message, sender)));
        case MESSAGE.CONTENT_POSITION_PATCH:
          return ok(await this.#updateCaptionPosition(message, sender));
        case MESSAGE.TRACK_ADD:
          return ok(await this.#mutateTracks(message.tabId, this.#pageKey(message, sender), () => (
            this.#store.addExternalTrack(this.#pageKey(message, sender), message.track)
          )));
        case MESSAGE.TRACK_UPSERT_LOCAL:
          return ok(await this.#mutateTracks(message.tabId, this.#pageKey(message, sender), () => (
            this.#store.upsertManagedExternalTrack(this.#pageKey(message, sender), message.track)
          )));
        case MESSAGE.TRACK_CACHE_BUILTIN:
          return ok(await this.#cacheBuiltInTrack(message, sender));
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
          if (!this.#credentialStore) throw new Error('Настройки ИИ пока недоступны');
          return ok(await this.#credentialStore.publicInfo());
        case MESSAGE.AI_CONFIG_PATCH:
          if (!this.#credentialStore) throw new Error('Настройки ИИ пока недоступны');
          return ok(await this.#credentialStore.patch(message));
        case MESSAGE.AI_MODELS_GET:
          if (!this.#aiClient) throw new Error('ИИ пока недоступен');
          return ok({ provider: message.provider, models: await this.#aiClient.listModels(message.provider) });
        case MESSAGE.CAPTION_TRANSLATE:
          await this.#enqueue(sender.tab.id, () => this.#selectedSender(message, sender));
          return ok(await this.#translateCaption(message));
        case MESSAGE.WORDS_LIST:
        case MESSAGE.WORDS_SAVE:
          await this.#enqueue(sender.tab.id, () => this.#selectedSender(message, sender));
          if (!this.#vocabulary) throw new Error('Словарь недоступен. Запустите сервер в Docker');
          return ok(message.type === MESSAGE.WORDS_SAVE
            ? await this.#vocabulary.save(message.word) : await this.#vocabulary.list());
        case MESSAGE.WORD_EXPLAIN: {
          if (!this.#isWordsPanelSender(sender)) throw new Error('Объяснение доступно только из панели слов');
          if (!this.#vocabulary || !this.#aiClient) throw new Error('Объяснение пока недоступно');
          if (!Number.isSafeInteger(message.id) || message.id < 1) throw new Error('Некорректный идентификатор слова');
          const { words } = await this.#vocabulary.list();
          const word = words.find((item) => item.id === message.id);
          if (!word) throw new Error('Слово не найдено');
          if (word.explanation) return ok({ word });
          return ok(await this.#vocabulary.saveExplanation(word.id, await this.#aiClient.explainWord(word)));
        }
        case MESSAGE.WORD_TRANSLATE: {
          if (!this.#isWordsPanelSender(sender)) throw new Error('Перевод доступен только из панели слов');
          if (!this.#vocabulary || !this.#aiClient) throw new Error('Перевод пока недоступен');
          if (!Number.isSafeInteger(message.id) || message.id < 1) throw new Error('Некорректный идентификатор слова');
          const { words } = await this.#vocabulary.list();
          const word = words.find((item) => item.id === message.id);
          if (!word || word.language !== 'zh') throw new Error('Китайское слово не найдено');
          return ok(await this.#vocabulary.saveAiTranslations(
            word.id, await this.#aiClient.translateSavedChineseWord(word),
          ));
        }
        case MESSAGE.SENTENCES_LIST:
        case MESSAGE.SENTENCES_SAVE:
          await this.#enqueue(sender.tab.id, () => this.#selectedSender(message, sender));
          if (!this.#vocabulary) throw new Error('Список предложений недоступен. Запустите сервер в Docker');
          return ok(message.type === MESSAGE.SENTENCES_SAVE
            ? await this.#vocabulary.saveSentence(message.sentence) : await this.#vocabulary.listSentences());
        case MESSAGE.SENTENCE_EXPLAIN: {
          if (!this.#isWordsPanelSender(sender)) throw new Error('Разбор доступен только из панели обучения');
          if (!this.#vocabulary || !this.#aiClient) throw new Error('Разбор пока недоступен');
          if (!Number.isSafeInteger(message.id) || message.id < 1) throw new Error('Некорректный идентификатор предложения');
          const { sentences } = await this.#vocabulary.listSentences();
          const sentence = sentences.find((item) => item.id === message.id);
          if (!sentence) throw new Error('Предложение не найдено');
          if (sentence.explanation) return ok({ sentence });
          return ok(await this.#vocabulary.saveSentenceExplanation(
            sentence.id, await this.#aiClient.explainSentence(sentence),
          ));
        }
        case MESSAGE.LOCAL_SUBTITLE_EXISTING:
          if (!this.#localSubtitles) throw new Error('Локальный сервер субтитров недоступен');
          return ok(await this.#localSubtitles.existing(message.videoId, message.language));
        case MESSAGE.LOCAL_SUBTITLE_GENERATE:
          if (!this.#localSubtitles) throw new Error('Локальный сервер субтитров недоступен');
          return ok(await this.#localSubtitles.generate(message.videoId, message.language));
        case MESSAGE.LOCAL_SUBTITLE_STATUS:
          if (!this.#localSubtitles) throw new Error('Локальный сервер субтитров недоступен');
          return ok(await this.#localSubtitles.status(message.videoId));
        default:
          throw new Error(`Unknown message: ${message?.type ?? 'empty'}`);
      }
  }

  #authorize(message, sender) {
    if (!this.#chrome.runtime?.id || sender?.id !== this.#chrome.runtime.id) {
      throw new Error('Недоверенный отправитель');
    }
    if (sender.url === this.#chrome.runtime.getURL('popup.html')) {
      if (CONTENT_MESSAGES.has(message?.type)) throw new Error('Сообщение доступно только плееру');
      return false;
    }
    if (sender.tab) {
      if (!Number.isInteger(sender.tab.id) || sender.tab.id < 0
        || !Number.isInteger(sender.frameId) || sender.frameId < 0
        || (sender.documentLifecycle && sender.documentLifecycle !== 'active')
        || !CONTENT_MESSAGES.has(message?.type)
        || Object.hasOwn(message, 'tabId') || Object.hasOwn(message, 'pageKey')) {
        throw new Error('Сообщение недоступно плееру');
      }
      validateContentSize(message);
      return true;
    }
    throw new Error('Сообщение доступно только окну расширения');
  }

  #isWordsPanelSender(sender) {
    try {
      const url = new URL(sender?.url);
      return url.origin === 'http://127.0.0.1:43817' && url.pathname === '/words' && !url.search && !url.hash;
    } catch {
      return false;
    }
  }

  #pageKey(message, sender) {
    const tabId = message?.tabId ?? sender?.tab?.id;
    const raw = message?.pageKey || sender?.tab?.url || this.#tabPageKeys.get(tabId) || `https://local.invalid/tab/${tabId ?? 'unknown'}`;
    return canonicalPageKey(raw);
  }

  async #contentPageKey(message, sender) {
    const currentTab = this.#chrome.tabs.get ? await this.#chrome.tabs.get(sender.tab.id) : sender.tab;
    if (currentTab.url && sender.tab.url && canonicalPageKey(currentTab.url) !== canonicalPageKey(sender.tab.url)) {
      throw new Error('Страница плеера изменилась');
    }
    return currentTab.url ? canonicalPageKey(currentTab.url) : this.#pageKey(message, sender);
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
    await this.#enqueue(tabId, () => this.#adoptPage(tabId, pageKey));
    await this.#ensureContentRegistration();
    const previousPlayers = this.players(tabId);
    this.#registry.clear(tabId);
    await this.#chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content-runtime.js', 'content.js'],
    });
    await this.#registry.waitForPlayers(tabId, this.#discoveryTimeoutMs, this.#discoveryQuietMs);
    return this.#enqueue(tabId, async () => {
      if (this.#tabPageKeys.get(tabId) !== pageKey) return this.players(tabId);
      const state = await this.#store.get(pageKey);
      const replacement = !this.#selectedPlayer(tabId, state)
        && this.players(tabId).find((player) => player.key === state.settings.selectedPlayerKey);
      if (replacement) {
        // A frame ID may change on recreation, but only fall back after discovery settles.
        const previous = previousPlayers.find((player) => player.frameId === state.settings.selectedPlayerFrameId);
        const next = await this.#store.patchSettingsWithPlayerFallbacks(pageKey,
          { selectedPlayerFrameId: replacement.frameId }, [replacement]);
        if (previous) {
          try {
            await this.#chrome.tabs.sendMessage(tabId, { type: MESSAGE.CONTENT_RESET }, {
              frameId: previous.frameId, ...(previous.documentId ? { documentId: previous.documentId } : {}),
            });
          } catch { /* The replaced document may already be gone. */ }
        }
        await this.#send(tabId, replacement.frameId, {
          type: MESSAGE.CONTENT_FULL_STATE, settings: next.settings, externalTracks: next.externalTracks,
        });
      }
      return this.players(tabId);
    });
  }

  async #ensureContentRegistration(onlyExisting = false) {
    const scripting = this.#chrome.scripting;
    if (!scripting.getRegisteredContentScripts || !scripting.registerContentScripts) return;
    const operation = (this.#contentRegistration ?? Promise.resolve()).catch(() => undefined).then(async () => {
        const existing = await scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
        if (onlyExisting && !existing.length) return;
        const permissions = await this.#chrome.permissions.getAll();
        const required = new Set(this.#chrome.runtime.getManifest().host_permissions ?? []);
        const matches = [...new Set((permissions.origins ?? []).filter((origin) => !required.has(origin))
          .flatMap((origin) => origin === '<all_urls>' ? ['http://*/*', 'https://*/*'] : [origin])
          .filter((origin) => /^(https?|\*):\/\//.test(origin)))].sort();
        if (!matches.length) {
          if (existing.length) await scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
          return;
        }
        const desired = {
          id: CONTENT_SCRIPT_ID,
          matches,
          js: ['content-runtime.js', 'content.js'],
          allFrames: true,
          matchOriginAsFallback: true,
          persistAcrossSessions: true,
          runAt: 'document_idle',
        };
        if (!existing.length) await scripting.registerContentScripts([desired]);
        else if (Object.entries(desired).some(([key, value]) => JSON.stringify(existing[0][key]) !== JSON.stringify(value))) {
          await scripting.updateContentScripts([desired]);
        }
    });
    this.#contentRegistration = operation;
    await operation;
  }

  async #getPlayers(tabId, pageKey, cachedOnly = false) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab id');
    if (cachedOnly) return this.#tabPageKeys.get(tabId) === pageKey ? this.players(tabId) : [];
    await this.#enqueue(tabId, () => this.#adoptPage(tabId, pageKey));
    const cached = this.players(tabId);
    try {
      return await this.#discover(tabId, pageKey);
    } catch {
      return cached;
    }
  }

  async #reportPlayer(tabId, frameId, playerData, message, sender) {
    if (!playerData || typeof playerData !== 'object' || Array.isArray(playerData)
      || !Number.isInteger(playerData.videoIndex) || playerData.videoIndex < 0 || playerData.videoIndex > 10_000
      || !Array.isArray(playerData.tracks) || playerData.tracks.length > 128
      || !sender.url) throw new Error('Некорректный отчёт плеера');
    const report = {
      frameUrl: boundedString(sender.url, 8192),
      title: boundedString(playerData.title, 512),
      sourceName: boundedString(playerData.sourceName, 240),
      duration: Number.isFinite(playerData.duration) && playerData.duration >= 0 ? playerData.duration : null,
      videoIndex: playerData.videoIndex,
      tracks: playerData.tracks.map((track) => ({
        id: boundedString(track?.id, 4096),
        legacyId: boundedString(track?.legacyId, 64),
        fallbackId: boundedString(track?.fallbackId, 64),
        label: boundedString(track?.label, 512),
        language: boundedString(track?.language, 64),
      })),
      documentId: sender.documentId,
    };
    const pageKey = await this.#contentPageKey(message, sender);
    await this.#adoptPage(tabId, pageKey);
    const previousPlayer = this.players(tabId).find((item) => item.frameId === frameId);
    const player = this.#registry.report(tabId, frameId, {
      ...report,
      tabTitle: String(sender.tab?.title || '').slice(0, 512),
    });
    let state = await this.#store.reconcileBuiltInTrackFallbacks(pageKey, player.key, player.tracks);
    state = await this.#store.adoptSelectedPlayerReplacement(pageKey, {
      previousPlayerKey: previousPlayer?.key,
      frameId,
      player,
    });
    const selected = this.#selectedPlayer(tabId, state)?.frameId === frameId;
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
    const previous = await this.#store.get(pageKey);
    const state = await this.#store.patchSettingsWithPlayerFallbacks(
      pageKey,
      { selectedPlayerKey: player.key, selectedPlayerFrameId: player.frameId },
      [player],
    );
    const previousFrame = previous.settings.selectedPlayerFrameId >= 0
      ? previous.settings.selectedPlayerFrameId
      : this.players(message.tabId).find((item) => item.key === previous.settings.selectedPlayerKey)?.frameId;
    if (Number.isInteger(previousFrame) && previousFrame !== player.frameId) {
      await this.#send(message.tabId, previousFrame, { type: MESSAGE.CONTENT_RESET });
    }
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

  async #updateCaptionPosition(message, sender) {
    const tabId = sender?.tab?.id;
    const frameId = sender?.frameId ?? 0;
    const { player, pageKey } = await this.#selectedSender(message, sender);
    const state = await this.#store.patchSettingsWithPlayerFallbacks(
      pageKey,
      { secondLeft: message.secondLeft, secondBottom: message.secondBottom },
      [player],
    );
    const delivered = await this.#send(tabId, frameId, {
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

  async #cacheBuiltInTrack(message, sender) {
    const tabId = sender.tab.id;
    const { state, pageKey } = await this.#selectedSender(message, sender);
    const expectedSource = `${state.settings.selectedPlayerKey}\u0000${state.settings.secondTrackId}`;
    if (!state.settings.secondTrackId || state.settings.secondTrackId.startsWith('external:') || message.sourceKey !== expectedSource) {
      throw new Error('Built-in subtitle cache is stale');
    }
    return this.#mutateTracks(tabId, pageKey, () => (
      this.#store.cacheBuiltInTrack(pageKey, message.track, message.sourceKey)
    ));
  }


  async #recoverSelectedSender(message, sender) {
    const tabId = sender.tab.id;
    const pageKey = await this.#contentPageKey(message, sender);
    const knownPage = this.#tabPageKeys.get(tabId);
    if (knownPage && knownPage !== pageKey) throw new Error('Страница плеера изменилась');
    if (this.players(tabId).some((player) => player.frameId === sender.frameId)) return;
    const state = await this.#store.get(pageKey);
    if (!state.settings.selectedPlayerKey || !sender.documentId
      || (state.settings.selectedPlayerFrameId >= 0 && state.settings.selectedPlayerFrameId !== sender.frameId)) {
      throw new Error('Сообщение от невыбранного или устаревшего плеера');
    }
    const key = `${tabId}:${sender.frameId}`;
    let recovery = this.#playerRecoveries.get(key);
    if (!recovery) {
      let timer;
      recovery = Promise.race([
        // Target the current frame, NOT the document claimed by the original action.
        Promise.resolve().then(() => this.#chrome.tabs.sendMessage(tabId,
          { type: MESSAGE.PLAYER_DISCOVER }, { frameId: sender.frameId })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Плеер не ответил. Повторите действие')), this.#discoveryTimeoutMs);
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (this.#playerRecoveries.get(key) === recovery) this.#playerRecoveries.delete(key);
      });
      this.#playerRecoveries.set(key, recovery);
    }
    await recovery;
    const player = this.players(tabId).find((item) => item.frameId === sender.frameId);
    if (!player || player.key !== state.settings.selectedPlayerKey
      || player.documentId !== sender.documentId || player.frameUrl !== sender.url) {
      throw new Error('Сообщение от невыбранного или устаревшего плеера');
    }
  }

  async #selectedSender(message, sender) {
    const tabId = sender.tab.id;
    const pageKey = await this.#contentPageKey(message, sender);
    if (this.#tabPageKeys.get(tabId) !== pageKey) throw new Error('Страница плеера изменилась');
    const state = await this.#store.get(pageKey);
    const player = this.#selectedPlayer(tabId, state);
    if (!player || player.frameId !== sender.frameId
      || (player.documentId ? player.documentId !== sender.documentId : player.frameUrl !== sender.url)) {
      throw new Error('Сообщение от невыбранного или устаревшего плеера');
    }
    return { state, player, pageKey };
  }

  async #translateCaption(message) {
    if (!this.#aiClient) throw new Error('Перевод через ИИ пока недоступен');
    const text = boundedString(message.text, 500).trim();
    const displayText = boundedString(message.displayText, 500).trim();
    if (!text) return { items: [] };
    if (message?.language === 'zh') {
      const translation = await this.#aiClient.translateChineseCaption(text, displayText);
      const pinyin = boundedString(translation.pinyin, 500).trim() || displayText;
      if (!pinyin) throw new Error('ИИ не вернул пиньинь китайской строки');
      return {
        items: [{
          start: 0,
          end: pinyin.length,
          text: pinyin,
          dictionary: translation.dictionary,
          context: translation.context,
          glossary: translation.glossary,
          isSentenceTranslation: true,
        }],
      };
    }
    const translation = await this.#aiClient.translateCaption(text);
    return {
      items: [{
        start: 0,
        end: displayText.length || text.length,
        text: displayText || text,
        dictionary: translation.translation,
        context: translation.translation,
        glossary: translation.glossary,
        isSentenceTranslation: true,
      }],
    };
  }

  #selectedPlayer(tabId, state) {
    const matches = this.players(tabId).filter((item) => item.key === state.settings.selectedPlayerKey);
    return state.settings.selectedPlayerFrameId >= 0
      ? matches.find((item) => item.frameId === state.settings.selectedPlayerFrameId)
      : matches[0];
  }

  async #sendToSelected(tabId, state, payload) {
    const player = this.#selectedPlayer(tabId, state);
    return player ? this.#send(tabId, player.frameId, payload) : false;
  }

  async #request(tabId, frameId, payload) {
    const documentId = this.players(tabId).find((player) => player.frameId === frameId)?.documentId;
    return this.#chrome.tabs.sendMessage(tabId, payload, { frameId, ...(documentId ? { documentId } : {}) });
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
