import { parseSrt } from './caption-core.js';
import { isLocalSubtitleTrack, localSubtitleTrack, subtitleTrackMatchesVideo, youtubeVideoId } from './local-subtitles-client.js';
import { canonicalPageKey } from './page-context.js';
import {
  choosePlayer,
  decodeSubtitleBuffer,
  loadPopupSnapshot,
} from './popup-model.js';
import { MESSAGE } from './protocol.js';
import { buildTrackOptions, isBuiltInCacheTrack, normalizeState, patchSettings, updateExternalTrackTiming } from './state-core.js';

const $ = (id) => document.getElementById(id);
const embeddedPanel = new URLSearchParams(globalThis.location?.search || '').get('embedded') === '1'
  && globalThis.window?.parent && window.parent !== window;
if (embeddedPanel) document.documentElement.classList.add('embedded');
const controls = $('controls');
const status = $('status');
let tabId;
let connectable = false;
let pageKey = '';
let players = [];
let state = normalizeState({});
// Responses may predate input. Keep this popup's explicit edits authoritative.
const editedSettings = {};
const editedTiming = new Map();
const saves = new Map();
const hydrationErrors = new Map();
let hydrationRevision = 0;
let aiLoadRevision = 0;
let aiLoaded = false;

let youtubeLoaded = false;
let selectedFrameId;
let videoOptionsOpen = false;
let subtitleOptionsOpen = false;
let timingOpen = false;
let connectionBusy = false;
let playerDeliveryFailed = false;
let pageHydrated = false;
let discoveryRevision = 0;

let downloadingLanguage = '';
const subtitleResults = new Map();
let aiConfig = {
  activeProvider: 'deepseek',
  providers: {
    deepseek: { hasApiKey: false, model: '' },
    openai: { hasApiKey: false, model: '' },
  },
};
let aiProvider = 'deepseek';
let aiCatalog = [];
let aiCatalogProvider = '';
let aiCatalogRevision = 0;
let aiModelRevision = 0;
let aiKeyRevision = 0;
let youtubeId = '';
let youtubePollTimer;
let youtubeEpoch = 0;
let popupClosed = false;
let selectionRevision = 0;

function postPanelMessage(type, payload = {}) {
  if (!embeddedPanel) return;
  window.parent.postMessage({ source: 'subs-anywhere-frame', type, ...payload }, '*');
}

function setupEmbeddedPanel() {
  if (!embeddedPanel) return;
  const windowControls = document.querySelector('.panel-window-controls');
  const header = document.querySelector('.app-header');
  const dock = $('panelDock');
  windowControls.hidden = false;
  $('panelClose').addEventListener('click', () => postPanelMessage('close'));
  dock.addEventListener('click', () => postPanelMessage('dock-toggle'));
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.source !== 'subs-anywhere-host'
      || event.data?.type !== 'panel-state') return;
    dock.hidden = !event.data.dockable;
    dock.setAttribute('aria-pressed', String(event.data.layout === 'docked'));
    dock.title = event.data.layout === 'docked' ? 'Открепить окно' : 'Встроить справа';
    dock.setAttribute('aria-label', dock.title);
  });
  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || event.target.closest('button, a, input, select')) return;
    event.preventDefault();
    header.classList.add('dragging');
    header.setPointerCapture?.(event.pointerId);
    postPanelMessage('drag-start', { screenX: event.screenX, screenY: event.screenY });
  });
  header.addEventListener('pointermove', (event) => {
    if (!header.hasPointerCapture?.(event.pointerId)) return;
    postPanelMessage('drag-move', { screenX: event.screenX, screenY: event.screenY });
  });
  const finishDrag = (event) => {
    if (!header.hasPointerCapture?.(event.pointerId)) return;
    header.releasePointerCapture?.(event.pointerId);
    header.classList.remove('dragging');
    postPanelMessage('drag-end');
  };
  header.addEventListener('pointerup', finishDrag);
  header.addEventListener('pointercancel', finishDrag);
  postPanelMessage('ready');
}


function adoptState(value) {
  state = patchSettings(normalizeState(value), editedSettings);
  const rejectedIds = new Set(state.externalTracks.filter((track) => isLocalSubtitleTrack(track)
    && !subtitleTrackMatchesVideo(track, youtubeId)).map((track) => `external:${track.id}`));
  state.externalTracks = state.externalTracks.filter((track) => !rejectedIds.has(`external:${track.id}`));
  if (rejectedIds.has(state.settings.secondTrackId)) state.settings.secondTrackId = '';
  for (const [id, timing] of editedTiming) state = updateExternalTrackTiming(state, id, timing);
}

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'Расширение не ответило');
  return response.data;
}

function drawSaveFeedback() {
  const entries = [...saves.values()];
  const failed = entries.find((entry) => entry.error);
  const hydrationError = [...hydrationErrors.values()][0];
  $('retrySave').hidden = !failed;
  $('retrySettings').hidden = !hydrationError;
  $('saveStatus').classList.toggle('error', Boolean(failed || hydrationError));
  $('saveStatus').textContent = failed
    ? `Не удалось подтвердить сохранение: ${failed.error.message}`
    : hydrationError ? `Не удалось загрузить настройки: ${hydrationError.message}`
    : entries.some((entry) => entry.pending) ? 'Сохраняю изменения…'
      : entries.length ? 'Сохранено на этом устройстве' : '';
}

function saveRequest(key, type, payload, apply = () => {}) {
  const entry = { pending: true, retry: () => saveRequest(key, type, payload, apply) };
  saves.set(key, entry);
  drawSaveFeedback();
  // Hand off now, not through a popup timer/queue: the worker owns serialization.
  return request(type, payload).then((data) => {
    if (saves.get(key) === entry) {
      entry.pending = false;
      apply(data);
      drawSaveFeedback();
    }
    return data;
  }).catch((error) => {
    if (saves.get(key) === entry) {
      entry.pending = false;
      entry.error = error;
      drawSaveFeedback();
    }
    throw error;
  });
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.hidden = !text;
  status.classList.toggle('error', error);
  if (error) {
    $('saveStatus').textContent = text;
    $('saveStatus').classList.toggle('error', true);
  }
}

function setupTabs(sections) {
  const showSection = (name) => {
    for (const section of sections) {
      const active = name === section;
      $(`${section}Panel`).hidden = !active;
      $(`${section}Tab`).setAttribute('aria-selected', active);
      $(`${section}Tab`).tabIndex = active ? 0 : -1;
    }
  };
  for (const [index, section] of sections.entries()) {
    const tab = $(`${section}Tab`);
    tab.addEventListener('click', () => showSection(section));
    tab.addEventListener('keydown', (event) => {
      const target = { ArrowRight: (index + 1) % sections.length, ArrowLeft: (index + sections.length - 1) % sections.length, Home: 0, End: sections.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      showSection(sections[target]);
      $(`${sections[target]}Tab`).focus();
    });
  }
  showSection(sections[0]);
}

function drawPreview() {
  const settings = state.settings;
  const preview = $('subtitlePreview');
  const chinese = settings.youtubeLanguage === 'zh' || /^zh/i.test(selectedExternalTrack()?.language || '');
  preview.style.fontSize = `${settings.fontSize}px`;
  preview.style.color = settings.subtitleColor;
  preview.replaceChildren();
  const sentence = document.createElement('span');
  sentence.textContent = chinese ? 'Привет, мир!' : 'По одной строке за раз.';
  sentence.style.cssText = `display:block;font-size:${settings.translationFontSize}px;font-weight:400;line-height:1.3;margin-bottom:.18em;opacity:.88;`;
  preview.append(sentence);
  if (settings.inlineTranslations) {
    const examples = chinese ? [['nǐ hǎo,', 'привет'], ['shì jiè!', 'мир']] : [['One line', 'одна строка'], ['at a time.', 'за раз, по очереди']];
    for (const [source, translation] of examples) {
      const cell = document.createElement('span');
      cell.style.cssText = 'display:inline-flex;flex-direction:column;align-items:center;vertical-align:bottom;width:max-content;max-width:calc(100% - .18em);box-sizing:border-box;margin:.12em .09em;padding:.12em .22em;border:1px solid #ffffff20;border-radius:6px;';
      const meaning = document.createElement('span');
      meaning.style.cssText = `width:100%;max-width:18em;font-size:${settings.inlineTranslationFontSize}px;font-weight:400;line-height:1.3;opacity:.8;margin-bottom:.2em;white-space:normal;overflow-wrap:anywhere;`;
      meaning.textContent = translation;
      const original = document.createElement('span');
      original.style.cssText = 'max-width:100%;overflow-wrap:anywhere;';
      original.textContent = source;
      cell.append(meaning, original);
      preview.append(cell);
    }
  }
  if (!settings.inlineTranslations || settings.showOriginalWithInline) {
    const original = document.createElement('span');
    original.className = 'dual-captions-sentence-original';
    original.style.cssText = 'display:block;margin-top:.18em;';
    original.textContent = chinese
      ? (settings.inlineTranslations ? '你好，世界！' : 'nǐ hǎo, shì jiè!')
      : 'One line at a time.';
    preview.append(original);
  }
  const rgb = [1, 3, 5].map((index) => parseInt(settings.subtitleBackgroundColor.slice(index, index + 2), 16));
  preview.style.backgroundColor = settings.subtitleBackground
    ? `rgba(${rgb.join(', ')}, ${settings.subtitleBackgroundOpacity / 100})` : 'transparent';
}

function setYoutubeStatus(text, error = false, phase = 'ready') {
  const element = $('youtubeSubtitleStatus');
  element.textContent = text;
  element.classList.toggle('error', error);

  drawWorkspace();
}

function youtubeFailure(error, epoch = youtubeEpoch) {
  if (popupClosed || epoch !== youtubeEpoch) return;
  clearTimeout(youtubePollTimer);
  if (downloadingLanguage) subtitleResults.set(downloadingLanguage,
    /не найден|субтитров.*нет/i.test(error.message) ? 'Нет субтитров' : 'Повторить');
  downloadingLanguage = '';
  setYoutubeStatus(error.message, true);
}

function savedLanguageTrack(language) {
  const matching = state.externalTracks.filter((track) => !isBuiltInCacheTrack(track)
    && subtitleTrackMatchesVideo(track, youtubeId) && track.language === language && track.cues?.length);
  return matching.find((track) => track.id === `youtube-${youtubeId}-youtube-${language}`)
    ?? matching.find((track) => track.id === `youtube-${youtubeId}-youtube`)
    ?? null;
}

function drawLanguageTracks() {
  for (const [language, prefix] of [['en', 'english'], ['zh', 'chinese']]) {
    const track = savedLanguageTrack(language);
    const selected = Boolean(track && state.settings.secondTrackId === `external:${track.id}`);
    const button = $(`${prefix}Subtitles`);
    button.disabled = !pageHydrated || !pageKey || Boolean(downloadingLanguage);
    button.setAttribute('aria-pressed', String(selected));
    $(`${prefix}SubtitleState`).textContent = downloadingLanguage === language ? 'Скачиваю…'
      : selected ? (track.sourceType === 'youtube-page' ? 'Со страницы · Показываются' : 'Показываются') : track ? 'Сохранены · Показать'
        : subtitleResults.get(language) || 'Скачать и показать';
  }
}

function currentPlayer() {
  return choosePlayer(players, state.settings.selectedPlayerKey, selectedFrameId);
}

function selectedExternalTrack() {
  return state.externalTracks.find((track) => `external:${track.id}` === state.settings.secondTrackId) ?? null;
}

function connectedPlayer() {
  if (playerDeliveryFailed) return null;
  return players.find((player) => player.key === state.settings.selectedPlayerKey
    && (state.settings.selectedPlayerFrameId < 0 || player.frameId === state.settings.selectedPlayerFrameId)) ?? null;
}

function subtitleOrigin(track) {
  if (isBuiltInCacheTrack(track)) return 'Сохранены с сайта';
  if (track?.sourceType === 'youtube-page') return 'Со страницы YouTube';
  if (track?.sourceType === 'local-server') return /-generated(?:-|$)/.test(track.id) ? 'Созданы из речи' : 'YouTube · Video Download API';
  return track ? 'Из файла SRT' : 'С сайта';
}

function trackChoices() {
  return buildTrackOptions(
    (connectedPlayer() ?? (players.length === 1 ? currentPlayer() : null))?.tracks ?? [],
    state.externalTracks.filter((track) => !isBuiltInCacheTrack(track)),
    state.settings.secondTrackId,
    state.settings.secondTrackFallbackId,
  );
}

function drawWorkspace() {
  const player = connectedPlayer();
  const selectedId = state.settings.secondTrackId;
  const external = selectedExternalTrack();
  const selected = trackChoices().find((item) => item.id === selectedId);
  const cached = !external && selected?.unavailable && state.settings.secondTrackCacheSource
    === `${state.settings.selectedPlayerKey}\u0000${selectedId}`
    ? state.externalTracks.find((track) => track.id === state.settings.secondTrackCacheId && isBuiltInCacheTrack(track)) : null;
  const available = selectedId && ((selected && !selected.unavailable) || cached);
  const title = external?.name ?? cached?.name ?? (selectedId ? selected?.label : 'Субтитры не выбраны');
  $('videoConnection').textContent = connectionBusy ? 'Подключение…' : player ? 'Видео подключено' : 'Видео не подключено';
  $('videoTitle').textContent = player?.title || player?.sourceName || '';
  $('videoTitle').hidden = !player;
  $('activate').hidden = Boolean(player) && !connectionBusy;
  $('activate').disabled = !connectable || !pageHydrated || connectionBusy;
  $('changeVideo').hidden = !players.length;
  $('changeVideo').setAttribute('aria-expanded', videoOptionsOpen);
  $('videoOptions').hidden = !videoOptionsOpen;
  $('playerChoice').hidden = !players.length;
  $('player').disabled = !players.length || connectionBusy;
  $('restartSearch').disabled = !connectable || !pageHydrated || connectionBusy;
  $('captionTitle').textContent = title || 'Ранее выбранные субтитры';
  $('captionSource').textContent = selectedId && available ? subtitleOrigin(external ?? cached) : '';
  $('captionSource').hidden = !$('captionSource').textContent;
  $('captionState').textContent = selectedId
    ? !available ? 'Выбранная дорожка сейчас недоступна. Выбор сохранён.'
      : player ? 'Готовы к показу на видео.' : 'Субтитры сохранены. Подключите видео для просмотра.'
    : Object.hasOwn(editedSettings, 'secondTrackId') ? 'Субтитры выключены.'
      : player && !player.tracks.length && !youtubeId ? 'У видео нет доступных субтитров. Добавьте файл SRT.'
        : 'Выберите дорожку или добавьте файл SRT.';
  $('changeSubtitles').disabled = !pageKey;
  $('changeSubtitles').textContent = subtitleOptionsOpen ? 'Закрыть выбор' : 'Другие субтитры';
  $('changeSubtitles').setAttribute('aria-expanded', subtitleOptionsOpen);
  $('subtitleOptions').hidden = !subtitleOptionsOpen;
  $('showTiming').hidden = !external;
  $('showTiming').textContent = timingOpen ? 'Закрыть сдвиг' : 'Сдвиг';
  $('showTiming').setAttribute('aria-expanded', Boolean(external && timingOpen));
  $('youtubeActions').hidden = !youtubeId;
  $('youtubeSubtitles').hidden = !youtubeId || !$('youtubeSubtitleStatus').textContent;
  $('otherSubtitleActions').hidden = Boolean(youtubeId);
  $('subtitleOptions').hidden = Boolean(youtubeId) || !subtitleOptionsOpen;
  $('captionTitle').hidden = Boolean(youtubeId);
  $('captionSource').hidden = Boolean(youtubeId) || !$('captionSource').textContent;
  $('captionState').hidden = Boolean(youtubeId);
  $('hideSubtitles').hidden = !selectedId;
  drawLanguageTracks();
}

function option(parent, value, label) {
  const element = document.createElement('option');
  element.value = String(value);
  element.textContent = label;
  parent.append(element);
  return element;
}

function providerLabel(provider = aiProvider) {
  return provider === 'openai' ? 'OpenAI' : 'DeepSeek';
}

function normalizeAiConfig(value = {}) {
  const activeProvider = value.activeProvider === 'openai' ? 'openai' : 'deepseek';
  return {
    activeProvider,
    providers: Object.fromEntries(['deepseek', 'openai'].map((provider) => [provider, {
      hasApiKey: Boolean(value.providers?.[provider]?.hasApiKey),
      model: typeof value.providers?.[provider]?.model === 'string' ? value.providers[provider].model : '',
    }])),
  };
}

function adoptAiConfig(value) {
  aiConfig = normalizeAiConfig(value);
}

function resetAiCatalog() {
  aiCatalog = [];
  aiCatalogProvider = '';
}

function drawPlayers() {
  const select = $('player');
  const selected = connectedPlayer() ?? currentPlayer();
  selectedFrameId = selected?.frameId;
  select.replaceChildren();
  option(select, '', 'Выберите видео');
  players.forEach((player, index) => option(select, player.frameId, player.title || player.sourceName || `Видео ${index + 1}`));
  select.value = connectedPlayer() ? String(selected.frameId) : '';
}

function drawTrackSelect(select, selectedId) {
  const options = trackChoices();
  const groups = new Map();
  select.replaceChildren();
  for (const item of options) {
    let parent = select;
    const external = state.externalTracks.find((track) => `external:${track.id}` === item.id);
    const groupName = item.unavailable ? item.group : item.group ? subtitleOrigin(external) : '';
    if (groupName) {
      if (!groups.has(groupName)) {
        const group = document.createElement('optgroup');
        group.label = groupName;
        groups.set(groupName, group);
        select.append(group);
      }
      parent = groups.get(groupName);
    }
    const element = option(parent, item.id, item.label);
    if (item.unavailable) element.dataset.unavailable = 'true';
  }
  select.value = selectedId;
}


function drawSync() {
  const box = $('syncBox');
  const track = selectedExternalTrack();
  box.hidden = !track || !timingOpen;
  $('syncTrackName').textContent = track?.name ?? '';
  $('offsetSeconds').value = track?.offsetSeconds ?? 0;
  $('timeScalePercent').value = Math.round((track?.timeScale ?? 1) * 100_000) / 1000;
}

function drawSettings() {
  const settings = state.settings;
  for (const id of ['fontSize', 'translationFontSize', 'inlineTranslationFontSize', 'inlineTranslations', 'showOriginalWithInline', 'subtitleColor', 'subtitleBackground', 'originalTrack', 'subtitleFile']) $(id).disabled = !pageKey;
  drawTrackSelect($('originalTrack'), settings.secondTrackId);
  for (const key of ['fontSize', 'translationFontSize', 'inlineTranslationFontSize']) {
    $(key).value = settings[key];
    $(`${key}Value`).value = `${settings[key]}px`;
  }
  $('inlineTranslations').checked = settings.inlineTranslations;
  $('showOriginalWithInline').checked = settings.showOriginalWithInline;
  $('showOriginalWithInline').disabled = !pageKey || !settings.inlineTranslations;
  $('subtitleColor').value = settings.subtitleColor;
  $('subtitleBackground').checked = settings.subtitleBackground;
  $('subtitleBackgroundColor').value = settings.subtitleBackgroundColor;
  $('subtitleBackgroundOpacity').value = settings.subtitleBackgroundOpacity;
  $('subtitleBackgroundOpacityValue').value = `${settings.subtitleBackgroundOpacity}%`;
  $('subtitleBackgroundColor').disabled = !pageKey || !settings.subtitleBackground;
  $('subtitleBackgroundOpacity').disabled = !pageKey || !settings.subtitleBackground;

  const providerInfo = aiConfig.providers[aiProvider];
  const catalogReady = aiCatalogProvider === aiProvider && aiCatalog.length > 0;
  const selectedModel = catalogReady && aiCatalog.includes($('aiModel').value)
    ? $('aiModel').value : providerInfo.model;
  $('aiProvider').value = aiProvider;
  $('aiKeyLabel').textContent = `API-ключ ${providerLabel()}`;
  $('loadAiModels').textContent = providerInfo.hasApiKey && !$('aiKey').value.trim()
    ? 'Загрузить доступные модели' : 'Сохранить ключ и загрузить модели';
  $('aiModel').replaceChildren();
  if (catalogReady) {
    for (const model of aiCatalog) option($('aiModel'), model, model);
    $('aiModel').value = aiCatalog.includes(selectedModel) ? selectedModel : aiCatalog[0];
  }
  $('aiModel').disabled = !catalogReady;
  $('saveAiSettings').disabled = !catalogReady || !$('aiModel').value;
  $('aiModelHint').textContent = catalogReady
    ? 'Модели загружены. Выберите одну и сохраните настройки.'
    : providerInfo.hasApiKey ? 'Загрузите доступные модели.' : 'Сначала сохраните ключ.';
  $('aiKeyState').textContent = hydrationErrors.has('ai')
    ? `Не удалось загрузить настройки ИИ: ${hydrationErrors.get('ai').message}`
    : !aiLoaded ? 'Загружаю настройки перевода…'
      : aiConfig.activeProvider === aiProvider && providerInfo.hasApiKey && providerInfo.model
        ? `${providerLabel()} используется для перевода: ${providerInfo.model}.`
        : providerInfo.hasApiKey
          ? `Ключ ${providerLabel()} сохранён. Загрузите модели и выберите одну.`
          : `Ключ ${providerLabel()} не сохранён.`;
  drawPreview();
  drawWorkspace();
}

function render() {
  controls.hidden = false;
  drawPlayers();
  drawSettings();

  drawSync();
}

async function selectPlayer(player) {
  if (!player) return;
  const revision = selectionRevision;
  selectedFrameId = player.frameId;
  const data = await request(MESSAGE.PLAYER_SELECT, {
    tabId,
    pageKey,
    frameId: player.frameId,
    playerKey: player.key,
  });
  adoptState(data.state);
  playerDeliveryFailed = data.delivered === false;
  videoOptionsOpen = false;
  render();
  if (playerDeliveryFailed) throw new Error('Видео не ответило. Нажмите «Найти видео» ещё раз.');
  if (!youtubeId && !state.settings.secondTrackId && revision === selectionRevision
    && !Object.hasOwn(editedSettings, 'secondTrackId') && player.tracks?.length === 1) {
    await persistSetting('secondTrackId', player.tracks[0].id);
  }
  if (!state.settings.secondTrackId) subtitleOptionsOpen = true;
  if (playerDeliveryFailed) return;
  setStatus('');
  render();
}

function updateLocalSetting(key, value) {
  if (key === 'secondTrackId') selectionRevision += 1;
  state = patchSettings(state, { [key]: value });
  editedSettings[key] = state.settings[key];
  drawPreview();
  if (['fontSize', 'translationFontSize', 'inlineTranslationFontSize'].includes(key)) $(`${key}Value`).value = `${state.settings[key]}px`;
  if (key === 'subtitleBackgroundOpacity') $('subtitleBackgroundOpacityValue').value = `${state.settings.subtitleBackgroundOpacity}%`;
  return state.settings[key];
}

function persistSetting(key, value) {
  if (!pageKey) return Promise.resolve();
  const normalized = updateLocalSetting(key, value);
  if (key === 'secondTrackId') { drawWorkspace(); drawSync(); }
  return saveRequest(`setting:${key}`, MESSAGE.STATE_PATCH, { tabId, pageKey, patch: { [key]: normalized } }, (data) => {
    if (key === 'secondTrackId' && data.delivered === false && connectedPlayer()) {
      playerDeliveryFailed = true;
      setStatus('Не удалось передать субтитры на видео. Подключитесь снова; выбор сохранён.', true);
      drawWorkspace();
    }
  })
    .catch((error) => setStatus(`Не удалось сохранить настройку: ${error.message}`, true));
}

function previewSetting(key, value) {
  return persistSetting(key, value);
}

async function importFile(file) {
  if (!file || !pageKey) return;
  const revision = selectionRevision;
  if (file.size > 5 * 1024 * 1024) throw new Error('Файл слишком большой. Максимум — 5 МБ.');
  const text = decodeSubtitleBuffer(await file.arrayBuffer());
  const cues = parseSrt(text);
  if (popupClosed) return;
  if (!cues.length) throw new Error('Не удалось найти строки SRT. Проверьте формат файла.');
  const track = {
    id: crypto.randomUUID(),
    name: file.name.replace(/\.srt$/i, '') || 'Оригинальные субтитры',
    language: '',
    cues,
    offsetSeconds: 0,
    timeScale: 1,
  };
  const data = await request(MESSAGE.TRACK_ADD, { tabId, pageKey, track });
  if (popupClosed) return;
  adoptState(data.state);
  render();
  if (revision === selectionRevision) await persistSetting('secondTrackId', `external:${track.id}`);
  render();
  setStatus(`Добавлен файл «${track.name}»: ${cues.length} строк.`);
  $('subtitleFile').value = '';
}

async function installLocalSubtitle(payload, selectTrack = false, selectionAtStart = selectionRevision) {
  if (popupClosed) return false;
  const epoch = youtubeEpoch;
  if (payload?.status !== 'ready' || typeof payload.srt !== 'string') return false;
  if (payload.videoId !== youtubeId) throw new Error('Субтитры относятся к другому видео');
  if (payload.srt.length > 5 * 1024 * 1024) throw new Error('Локальный файл субтитров слишком большой');
  const cues = parseSrt(payload.srt);
  if (!cues.length) throw new Error('Локальный сервер вернул пустые субтитры');
  const source = payload.source === 'youtube-page' ? 'page' : payload.source === 'generated' ? 'generated' : 'youtube';
  const track = localSubtitleTrack(payload.videoId, source, cues, payload.language);
  const revision = selectionRevision;
  const shouldSelect = (selectTrack && selectionAtStart === selectionRevision)
    || (!state.settings.secondTrackId && !Object.hasOwn(editedSettings, 'secondTrackId'));
  const stored = await request(MESSAGE.TRACK_UPSERT_LOCAL, { tabId, pageKey, track });
  if (popupClosed || epoch !== youtubeEpoch) return false;
  adoptState(stored.state);
  if (shouldSelect && revision === selectionRevision) {
    updateLocalSetting('secondTrackId', `external:${track.id}`);
    const selected = await request(MESSAGE.STATE_PATCH, {
      tabId,
      pageKey,
      patch: { secondTrackId: `external:${track.id}` },
    });
    if (popupClosed || epoch !== youtubeEpoch) return false;
    adoptState(selected.state);
  }
  render();
  return true;
}

async function pollExistingSubtitle(epoch, language, selectionAtStart) {
  if (popupClosed || epoch !== youtubeEpoch) return;
  const videoId = youtubeId;
  const result = await request(MESSAGE.LOCAL_SUBTITLE_EXISTING, { tabId, pageKey, videoId, language });
  if (popupClosed || epoch !== youtubeEpoch) return;
  if (videoId !== youtubeId || (result.videoId && result.videoId !== videoId)) {
    throw new Error('Субтитры относятся к другому видео');
  }
  if (result.status === 'running') {
    setYoutubeStatus('Скачиваю субтитры…', false, 'loading');
    youtubePollTimer = setTimeout(() => pollExistingSubtitle(epoch, language, selectionAtStart)
      .catch((error) => youtubeFailure(error, epoch)), 1500);
    return;
  }
  if (result.status === 'error') throw new Error(result.error || 'Не удалось скачать дорожку YouTube');
  const existingReady = await installLocalSubtitle({ ...result, videoId }, true, selectionAtStart);
  if (popupClosed || epoch !== youtubeEpoch) return;
  downloadingLanguage = '';
  if (existingReady) setYoutubeStatus(result.source === 'youtube-page' ? 'Субтитры получены со страницы YouTube.' : '');
  else {
    subtitleResults.set(language, 'Нет субтитров');
    setYoutubeStatus(result.error || 'Субтитров на этом языке нет.', true);
  }
}

async function loadYoutubeSubtitles() {
  if (!youtubeId || popupClosed) return;
  setYoutubeStatus('');
}

async function showLanguageSubtitles(language) {
  if (!youtubeId || popupClosed || downloadingLanguage || !pageHydrated) return;
  clearTimeout(youtubePollTimer);
  const epoch = ++youtubeEpoch;
  const revision = ++selectionRevision;
  downloadingLanguage = language;
  setYoutubeStatus('');
  try {
    if (!connectedPlayer()) await activate();
    if (popupClosed || epoch !== youtubeEpoch) return;
    if (!connectedPlayer()) {
      downloadingLanguage = '';
      drawWorkspace();
      return;
    }
    await persistSetting('youtubeLanguage', language);
    if (popupClosed || epoch !== youtubeEpoch) return;
    const saved = savedLanguageTrack(language);
    if (saved) {
      downloadingLanguage = '';
      await persistSetting('secondTrackId', `external:${saved.id}`);
      render();
      return;
    }
    await pollExistingSubtitle(epoch, language, revision);
  } catch (error) {
    youtubeFailure(error, epoch);
  }
}


async function setTiming(trackId, { offsetSeconds, timeScale }) {
  state = updateExternalTrackTiming(state, trackId, { offsetSeconds, timeScale });
  const track = state.externalTracks.find((item) => item.id === trackId);
  if (!track) return;
  const timing = { offsetSeconds: track.offsetSeconds, timeScale: track.timeScale };
  editedTiming.set(trackId, timing);
  drawSync();
  await saveRequest(`timing:${trackId}`, MESSAGE.TRACK_TIMING, {
    tabId,
    pageKey,
    id: track.id,
    ...timing,
  });
}

async function activate(restart = false) {
  if (!connectable || !pageHydrated || connectionBusy) return;
  discoveryRevision += 1;
  connectionBusy = true;
  drawWorkspace();
  setStatus(restart ? 'Ищу видео и доступные субтитры…' : 'Подключаю видео…');
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) throw new Error('Доступ не разрешён. Для подключения видео разрешите доступ к странице.');
    const data = await request(MESSAGE.PLAYER_DISCOVER, { tabId, pageKey });
    players = data.players ?? [];
    if (!players.length) {
      render();
      throw new Error('Видео не найдено. Запустите его на странице и попробуйте ещё раз.');
    }
    render();
    const saved = players.find((player) => player.key === state.settings.selectedPlayerKey
      && player.frameId === state.settings.selectedPlayerFrameId)
      ?? players.find((player) => player.key === state.settings.selectedPlayerKey);
    const player = saved ?? (!state.settings.selectedPlayerKey && players.length === 1 ? players[0] : null);
    if (player) await selectPlayer(player);
    else {
      videoOptionsOpen = true;
      setStatus(state.settings.selectedPlayerKey
        ? 'Ранее выбранное видео пока не найдено. Подождите или выберите другое.'
        : 'На странице несколько видео. Выберите нужное.');
    }
  } finally {
    connectionBusy = false;
    render();
  }
}

async function loadAiModels() {
  const provider = aiProvider;
  const revision = ++aiCatalogRevision;
  const inputValue = $('aiKey').value;
  const apiKey = inputValue.trim();
  if (!apiKey && !aiConfig.providers[provider].hasApiKey) throw new Error(`Вставьте API-ключ ${providerLabel(provider)}`);
  aiKeyRevision += 1;
  if (apiKey) {
    await saveRequest(`ai:key:${provider}`, MESSAGE.AI_CONFIG_PATCH, { provider, apiKey }, (data) => {
      adoptAiConfig(data);
      aiLoaded = true;
      hydrationErrors.delete('ai');
      if ($('aiKey').value === inputValue) $('aiKey').value = '';
    });
  }
  if (revision !== aiCatalogRevision || provider !== aiProvider) return;
  const data = await request(MESSAGE.AI_MODELS_GET, { provider });
  if (revision !== aiCatalogRevision || provider !== aiProvider || popupClosed) return;
  aiCatalog = Array.isArray(data.models) ? data.models : [];
  aiCatalogProvider = provider;
  if (!aiCatalog.length) throw new Error(`Нет доступных текстовых моделей ${providerLabel(provider)}`);
  drawSettings();
}

async function clearAiKey() {
  const provider = aiProvider;
  aiCatalogRevision += 1;
  aiKeyRevision += 1;
  await saveRequest(`ai:key:${provider}`, MESSAGE.AI_CONFIG_PATCH, { provider, clearApiKey: true }, (data) => {
    adoptAiConfig(data);
    resetAiCatalog();
    $('aiKey').value = '';
    drawSettings();
  });
}

async function saveAiSettings() {
  const provider = aiProvider;
  const model = $('aiModel').value;
  if (aiCatalogProvider !== provider || !aiCatalog.includes(model)) throw new Error('Сначала загрузите и выберите модель');
  aiModelRevision += 1;
  await saveRequest(`ai:settings:${provider}`, MESSAGE.AI_CONFIG_PATCH, { provider, model, activate: true }, (data) => {
    adoptAiConfig(data);
    drawSettings();
  });
}

async function loadAiSettings() {
  const revision = ++aiLoadRevision;
  const keyRevision = aiKeyRevision;
  const modelRevision = aiModelRevision;
  try {
    const data = await request(MESSAGE.AI_CONFIG_GET);
    if (revision !== aiLoadRevision) return data;
    if (keyRevision === aiKeyRevision && modelRevision === aiModelRevision) {
      adoptAiConfig(data);
      aiProvider = aiConfig.activeProvider;
    }
    aiLoaded = true;
    hydrationErrors.delete('ai');
    drawSettings();
    drawSaveFeedback();
    return data;
  } catch (error) {
    if (revision !== aiLoadRevision) return {};
    hydrationErrors.set('ai', error);
    drawSettings();
    drawSaveFeedback();
    return {};
  }
}



async function hydratePage(aiPromise) {
  if (!pageKey) return;
  const revision = ++hydrationRevision;
  const discoveryAtStart = discoveryRevision;
  return loadPopupSnapshot(request, tabId, pageKey, {
    aiPromise,
    connectable,
    onState(snapshot) {
      if (revision !== hydrationRevision) return;
      hydrationErrors.delete('onState');
      adoptState(snapshot.state);
      pageHydrated = true;
      if (connectedPlayer() && !connectionBusy) setStatus('');
      render();
      drawSaveFeedback();
      controls.dataset.hydrated = 'true';
      if (!youtubeLoaded) {
        youtubeLoaded = true;
        void loadYoutubeSubtitles();
      }
    },
    onPlayers(snapshot) {
      if (revision !== hydrationRevision || discoveryAtStart !== discoveryRevision) return;
      hydrationErrors.delete('onPlayers');
      players = snapshot.players;
      render();
      if (!connectable) setStatus('На служебных страницах подключение недоступно. Внешний вид и перевод можно настроить без плеера.');
      else setStatus('');
    },
    onError(name, error) {
      if (revision !== hydrationRevision) return;
      hydrationErrors.set(name, error);
      drawSaveFeedback();
    },
  });
}

async function init() {
  $('activate').disabled = true;
  render();
  drawSaveFeedback();
  const aiPromise = loadAiSettings();

  let tab;
  if (embeddedPanel) {
    const context = await request(MESSAGE.PANEL_CONTEXT_GET);
    tab = { id: context.tabId, url: context.url };
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!Number.isInteger(tab?.id)) throw new Error('Не удалось определить активную вкладку.');
  tabId = tab.id;
  connectable = /^https?:\/\//i.test(tab.url || '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i.test(tab.url || '');
  youtubeId = youtubeVideoId(tab.url || '');
  pageKey = canonicalPageKey(tab.url || `https://local.invalid/tab/${tab.id}`);
  drawSettings();
  await hydratePage(aiPromise);
}

setupTabs(['player', 'appearance', 'settings']);

setupEmbeddedPanel();
document.defaultView?.addEventListener('pagehide', () => {
  popupClosed = true;
  youtubeEpoch += 1;
  clearTimeout(youtubePollTimer);
});
$('retrySave').addEventListener('click', () => {
  for (const entry of [...saves.values()]) if (entry.error) void entry.retry().catch(() => {});
});
$('retrySettings').addEventListener('click', () => { void hydratePage(loadAiSettings()); });
$('activate').addEventListener('click', () => activate().catch((error) => setStatus(error.message, true)));
$('restartSearch').addEventListener('click', () => activate(true).catch((error) => setStatus(error.message, true)));
$('changeVideo').addEventListener('click', () => { videoOptionsOpen = !videoOptionsOpen; drawWorkspace(); });
$('changeSubtitles').addEventListener('click', () => { subtitleOptionsOpen = !subtitleOptionsOpen; drawWorkspace(); });
$('showTiming').addEventListener('click', () => { timingOpen = !timingOpen; drawWorkspace(); drawSync(); });
$('hideSubtitles').addEventListener('click', () => { void persistSetting('secondTrackId', ''); });
$('aiProvider').addEventListener('change', () => {
  aiProvider = $('aiProvider').value === 'openai' ? 'openai' : 'deepseek';
  aiCatalogRevision += 1;
  aiModelRevision += 1;
  resetAiCatalog();
  $('aiKey').value = '';
  drawSettings();
});
$('aiKey').addEventListener('input', () => drawSettings());
$('aiModel').addEventListener('change', () => drawSettings());
$('loadAiModels').addEventListener('click', () => loadAiModels().catch((error) => setStatus(error.message, true)));
$('clearAiKey').addEventListener('click', () => clearAiKey().catch((error) => setStatus(error.message, true)));
$('saveAiSettings').addEventListener('click', () => saveAiSettings().catch((error) => setStatus(error.message, true)));

$('subtitleFile').addEventListener('change', (event) => importFile(event.target.files?.[0]).catch((error) => setStatus(error.message, true)));
$('englishSubtitles').addEventListener('click', () => { void showLanguageSubtitles('en'); });
$('chineseSubtitles').addEventListener('click', () => { void showLanguageSubtitles('zh'); });
$('player').addEventListener('change', () => {
  if (!$('player').value || connectionBusy) return;
  discoveryRevision += 1;
  const player = players.find((item) => item.frameId === Number($('player').value));
  connectionBusy = true;
  drawWorkspace();
  void selectPlayer(player).catch((error) => setStatus(error.message, true)).finally(() => {
    connectionBusy = false;
    render();
  });
});
$('originalTrack').addEventListener('change', () => persistSetting('secondTrackId', $('originalTrack').value));
for (const key of ['fontSize', 'translationFontSize', 'inlineTranslationFontSize']) {
  $(key).addEventListener('input', () => previewSetting(key, Number($(key).value)));
}
$('inlineTranslations').addEventListener('change', () => {
  persistSetting('inlineTranslations', $('inlineTranslations').checked);
  drawSettings();
});
$('showOriginalWithInline').addEventListener('change', () => persistSetting('showOriginalWithInline', $('showOriginalWithInline').checked));
$('subtitleColor').addEventListener('input', () => previewSetting('subtitleColor', $('subtitleColor').value));

$('subtitleBackground').addEventListener('change', () => {
  persistSetting('subtitleBackground', $('subtitleBackground').checked);
  drawSettings();
});
$('subtitleBackgroundColor').addEventListener('input', () => previewSetting('subtitleBackgroundColor', $('subtitleBackgroundColor').value));

$('subtitleBackgroundOpacity').addEventListener('input', () => previewSetting('subtitleBackgroundOpacity', Number($('subtitleBackgroundOpacity').value)));


$('offsetSeconds').addEventListener('change', () => {
  const trackId = selectedExternalTrack()?.id;
  const value = Number($('offsetSeconds').value);
  if (!trackId) return;
  setTiming(trackId, { offsetSeconds: value }).catch((error) => setStatus(error.message, true));
});
$('timeScalePercent').addEventListener('change', () => {
  const trackId = selectedExternalTrack()?.id;
  const value = Number($('timeScalePercent').value) / 100;
  if (!trackId) return;
  setTiming(trackId, { timeScale: value }).catch((error) => setStatus(error.message, true));
});
for (const button of document.querySelectorAll('[data-shift]')) {
  button.addEventListener('click', () => {
    const trackId = selectedExternalTrack()?.id;
    const shift = Number(button.dataset.shift);
    if (!trackId) return;
    const track = state.externalTracks.find((item) => item.id === trackId);
    if (track) setTiming(trackId, { offsetSeconds: track.offsetSeconds + shift }).catch((error) => setStatus(error.message, true));
  });
}

init().catch((error) => setStatus(error.message, true));
