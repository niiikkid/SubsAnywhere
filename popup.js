import { parseSrt } from './caption-core.js';
import { formatGenerationProgress, localSubtitleTrack, youtubeVideoId } from './local-subtitles-client.js';
import { canonicalPageKey } from './page-context.js';
import {
  choosePlayer,
  decodeSubtitleBuffer,
  loadPopupSnapshot,
} from './popup-model.js';
import { MESSAGE } from './protocol.js';
import { buildTrackOptions, normalizeState, patchSettings, updateExternalTrackTiming } from './state-core.js';

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
let speechRate = 0.8;
let speechVoiceName = '';
let speechVoices = [];
let speechRevision = 0;
let youtubeLoaded = false;
let selectedFrameId;
let syncTrackId = '';
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
let selectGeneratedWhenReady = false;
let selectionRevision = 0;
let generatedSelectionRevision = 0;

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
    dock.textContent = event.data.layout === 'docked' ? '↗' : '↙';
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
      : entries.length ? 'Сохранено на этом устройстве' : 'Изменения сохраняются автоматически';
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
  status.classList.toggle('error', error);
  if (error) {
    $('saveStatus').textContent = text;
    $('saveStatus').classList.toggle('error', true);
  }
}

const sections = ['player', 'appearance', 'settings'];
function showSection(name) {
  for (const section of sections) {
    const active = name === section;
    $(`${section}Panel`).hidden = !active;
    $(`${section}Tab`).setAttribute('aria-selected', active);
    $(`${section}Tab`).tabIndex = active ? 0 : -1;
  }
}

function drawPreview() {
  const settings = state.settings;
  const preview = $('subtitlePreview');
  preview.style.fontSize = `${settings.fontSize}px`;
  preview.style.color = settings.subtitleColor;
  preview.replaceChildren();
  if (settings.inlineTranslations) {
    preview.textContent = '';
    for (const [source, translation] of [['One line', 'одна строка'], ['at a time.', 'за раз, по очереди']]) {
      const cell = document.createElement('span');
      cell.style.cssText = 'display:inline-flex;flex-direction:column;align-items:center;vertical-align:bottom;width:max-content;max-width:calc(100% - .18em);box-sizing:border-box;margin:.12em .09em;padding:.12em .22em;border:1px solid #ffffff20;border-radius:6px;';
      const meaning = document.createElement('span');
      meaning.style.cssText = 'width:100%;max-width:18em;font-size:.58em;font-weight:400;line-height:1.3;opacity:.8;margin-bottom:.2em;white-space:normal;overflow-wrap:anywhere;';
      meaning.textContent = translation;
      const original = document.createElement('span');
      original.style.cssText = 'max-width:100%;overflow-wrap:anywhere;';
      original.textContent = source;
      cell.append(meaning, original);
      preview.append(cell);
    }
  } else preview.textContent = 'One line at a time.';
  const rgb = [1, 3, 5].map((index) => parseInt(settings.subtitleBackgroundColor.slice(index, index + 2), 16));
  preview.style.backgroundColor = settings.subtitleBackground
    ? `rgba(${rgb.join(', ')}, ${settings.subtitleBackgroundOpacity / 100})` : 'transparent';
}

function setYoutubeStatus(text, error = false) {
  const element = $('youtubeSubtitleStatus');
  element.textContent = text;
  element.classList.toggle('error', error);
}

function youtubeFailure(error, canGenerate = false, epoch = youtubeEpoch) {
  if (popupClosed || epoch !== youtubeEpoch) return;
  clearTimeout(youtubePollTimer);
  $('createYoutubeSubtitles').disabled = !canGenerate;
  $('retryYoutubeSubtitles').hidden = false;
  drawYoutubeProgress({ status: 'error' });
  setYoutubeStatus(`${error.message} Проверьте локальный сервер и повторите проверку. Сохранённые дорожки не удалены.`, true);
}

function drawYoutubeProgress(payload) {
  const progress = formatGenerationProgress(payload);
  $('youtubeProgressBox').hidden = !progress.visible;
  $('youtubeProgress').value = progress.value;
  $('youtubeProgressValue').value = `${progress.value}%`;
  $('youtubeProgressDetail').textContent = progress.detail;
  if (progress.visible) setYoutubeStatus(progress.label);
}

function currentPlayer() {
  return choosePlayer(players, state.settings.selectedPlayerKey, selectedFrameId);
}

function selectedExternalTrack() {
  return state.externalTracks.find((track) => track.id === syncTrackId) ?? state.externalTracks[0] ?? null;
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
  const selected = currentPlayer();
  selectedFrameId = selected?.frameId;
  select.replaceChildren();
  players.forEach((player, index) => option(select, player.frameId, `Плеер ${index + 1}: ${player.title || 'video'}`));
  if (selected) select.value = String(selected.frameId);
}

function drawTrackSelect(select, selectedId, selectedFallbackId) {
  const options = buildTrackOptions(
    currentPlayer()?.tracks ?? [],
    state.externalTracks,
    selectedId,
    selectedFallbackId,
  );
  const groups = new Map();
  select.replaceChildren();
  for (const item of options) {
    let parent = select;
    if (item.group) {
      if (!groups.has(item.group)) {
        const group = document.createElement('optgroup');
        group.label = item.group;
        groups.set(item.group, group);
        select.append(group);
      }
      parent = groups.get(item.group);
    }
    const element = option(parent, item.id, item.label);
    if (item.unavailable) element.dataset.unavailable = 'true';
  }
  select.value = selectedId;
}

function drawExternalList() {
  const list = $('externalList');
  list.replaceChildren();
  for (const track of state.externalTracks) {
    const row = document.createElement('div');
    row.className = 'external-item';
    const text = document.createElement('div');
    text.className = 'external-name';
    text.title = track.name;
    text.textContent = track.name;
    const meta = document.createElement('span');
    meta.className = 'external-meta';
    meta.textContent = `${track.cues.length} строк`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete';
    remove.textContent = 'Удалить';
    remove.addEventListener('click', () => deleteTrack(track.id).catch((error) => setStatus(error.message, true)));
    row.append(text, meta, remove);
    list.append(row);
  }
}

function drawSync() {
  const box = $('syncBox');
  box.hidden = state.externalTracks.length === 0;
  if (!state.externalTracks.length) {
    syncTrackId = '';
    return;
  }
  const select = $('syncTrack');
  if (!state.externalTracks.some((track) => track.id === syncTrackId)) syncTrackId = state.externalTracks[0].id;
  select.replaceChildren();
  for (const track of state.externalTracks) option(select, track.id, track.name);
  select.value = syncTrackId;
  $('offsetSeconds').value = selectedExternalTrack()?.offsetSeconds ?? 0;
  $('timeScalePercent').value = Math.round((selectedExternalTrack()?.timeScale ?? 1) * 100_000) / 1000;
}

function drawSettings() {
  const settings = state.settings;
  $('speechVoice').replaceChildren();
  option($('speechVoice'), '', 'Автоматически — Google');
  for (const voice of speechVoices) option($('speechVoice'), voice.voiceName, voice.voiceName);
  $('speechVoice').value = speechVoices.some((voice) => voice.voiceName === speechVoiceName) ? speechVoiceName : '';
  $('speechRate').value = String(speechRate);
  $('youtubeLanguage').value = settings.youtubeLanguage;
  $('youtubeLanguage').disabled = !pageKey;
  for (const id of ['fontSize', 'inlineTranslations', 'subtitleColor', 'subtitleBackground', 'originalTrack', 'subtitleFile']) $(id).disabled = !pageKey;
  drawTrackSelect($('originalTrack'), settings.secondTrackId, settings.secondTrackFallbackId);
  $('fontSize').value = settings.fontSize;
  $('inlineTranslations').checked = settings.inlineTranslations;
  $('subtitleColor').value = settings.subtitleColor;
  $('subtitleBackground').checked = settings.subtitleBackground;
  $('subtitleBackgroundColor').value = settings.subtitleBackgroundColor;
  $('subtitleBackgroundOpacity').value = settings.subtitleBackgroundOpacity;
  $('subtitleBackgroundOpacityValue').value = `${settings.subtitleBackgroundOpacity}%`;
  $('subtitleBackgroundColor').disabled = !pageKey || !settings.subtitleBackground;
  $('subtitleBackgroundOpacity').disabled = !pageKey || !settings.subtitleBackground;
  $('fontSizeValue').value = `${settings.fontSize}px`;
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
}

function render() {
  controls.hidden = false;
  $('restartSearch').hidden = players.length === 0;
  drawPlayers();
  $('player').disabled = players.length === 0;
  drawSettings();
  drawExternalList();
  drawSync();
}

async function selectPlayer(player) {
  if (!player) return;
  selectedFrameId = player.frameId;
  const data = await request(MESSAGE.PLAYER_SELECT, {
    tabId,
    pageKey,
    frameId: player.frameId,
    playerKey: player.key,
  });
  adoptState(data.state);
  render();
}

function updateLocalSetting(key, value) {
  if (key === 'secondTrackId') selectionRevision += 1;
  state = patchSettings(state, { [key]: value });
  editedSettings[key] = state.settings[key];
  drawPreview();
  if (key === 'fontSize') $('fontSizeValue').value = `${state.settings.fontSize}px`;
  if (key === 'subtitleBackgroundOpacity') $('subtitleBackgroundOpacityValue').value = `${state.settings.subtitleBackgroundOpacity}%`;
  return state.settings[key];
}

function persistSetting(key, value) {
  if (!pageKey) return Promise.resolve();
  const normalized = updateLocalSetting(key, value);
  return saveRequest(`setting:${key}`, MESSAGE.STATE_PATCH, { tabId, pageKey, patch: { [key]: normalized } })
    .catch((error) => setStatus(`Не удалось сохранить настройку: ${error.message}`, true));
}

function previewSetting(key, value) {
  return persistSetting(key, value);
}

async function importFile(file) {
  if (!file || !pageKey) return;
  if (file.size > 5 * 1024 * 1024) throw new Error('Файл слишком большой. Максимум — 5 МБ.');
  const text = decodeSubtitleBuffer(await file.arrayBuffer());
  const cues = parseSrt(text);
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
  adoptState(data.state);
  syncTrackId = track.id;
  render();
  if (!state.settings.secondTrackId) await persistSetting('secondTrackId', `external:${track.id}`);
  render();
  setStatus(`Добавлен файл «${track.name}»: ${cues.length} строк.`);
  $('subtitleFile').value = '';
}

async function installLocalSubtitle(payload, selectTrack = false, selectionAtStart = generatedSelectionRevision) {
  if (popupClosed) return false;
  const epoch = youtubeEpoch;
  if (payload?.status !== 'ready' || typeof payload.srt !== 'string') return false;
  if (payload.srt.length > 5 * 1024 * 1024) throw new Error('Локальный файл субтитров слишком большой');
  const cues = parseSrt(payload.srt);
  if (!cues.length) throw new Error('Локальный сервер вернул пустые субтитры');
  const source = payload.source === 'generated' ? 'generated' : 'youtube';
  const track = localSubtitleTrack(youtubeId, source, cues, payload.language);
  const revision = selectionRevision;
  const shouldSelect = (selectTrack && selectionAtStart === selectionRevision)
    || (!state.settings.secondTrackId && !Object.hasOwn(editedSettings, 'secondTrackId'));
  const stored = await request(MESSAGE.TRACK_UPSERT_LOCAL, { tabId, pageKey, track });
  if (popupClosed || epoch !== youtubeEpoch) return false;
  adoptState(stored.state);
  syncTrackId = track.id;
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

async function pollGeneratedSubtitle(epoch = youtubeEpoch) {
  if (!youtubeId || popupClosed || epoch !== youtubeEpoch) return;
  clearTimeout(youtubePollTimer);
  try {
    const result = await request(MESSAGE.LOCAL_SUBTITLE_STATUS, { videoId: youtubeId });
    if (popupClosed || epoch !== youtubeEpoch) return;
    if (result.status === 'ready') {
      drawYoutubeProgress(result);
      await installLocalSubtitle(result, selectGeneratedWhenReady);
      if (popupClosed || epoch !== youtubeEpoch) return;
      selectGeneratedWhenReady = false;
      setYoutubeStatus('Созданные субтитры готовы.');
      $('createYoutubeSubtitles').disabled = false;
      $('createYoutubeSubtitles').textContent = 'Создать заново';
      return;
    }
    if (result.status === 'error') return youtubeFailure(new Error(result.error || 'Не удалось создать субтитры'), true, epoch);
    if (result.status === 'running') {
      drawYoutubeProgress(result);
      $('createYoutubeSubtitles').disabled = true;
      youtubePollTimer = setTimeout(() => pollGeneratedSubtitle(epoch), 1500);
      return;
    }
    $('createYoutubeSubtitles').disabled = false;
    drawYoutubeProgress(result);
    setYoutubeStatus('Задание не найдено на сервере. Можно запустить создание снова.');
  } catch (error) {
    youtubeFailure(error, false, epoch);
  }
}

async function pollExistingSubtitle(epoch, generatedReady = false, selectionAtStart = null, generatedError = null) {
  if (popupClosed || epoch !== youtubeEpoch) return;
  const result = await request(MESSAGE.LOCAL_SUBTITLE_EXISTING, { videoId: youtubeId, language: state.settings.youtubeLanguage });
  if (popupClosed || epoch !== youtubeEpoch) return;
  if (result.status === 'running') {
    setYoutubeStatus('Скачиваю готовую дорожку YouTube… Можно продолжать настройку внешнего вида.');
    youtubePollTimer = setTimeout(() => pollExistingSubtitle(epoch, generatedReady, selectionAtStart, generatedError).catch((error) => youtubeFailure(error, true, epoch)), 1500);
    return;
  }
  if (result.status === 'error') throw new Error(result.error || 'Не удалось скачать дорожку YouTube');
  if (result.language_required) {
    if (generatedError) return youtubeFailure(generatedError, true, epoch);
    setYoutubeStatus('YouTube не указал язык оригинала. Выберите английский или китайский выше.');
    return;
  }
  const existingReady = await installLocalSubtitle(result, selectionAtStart !== null, selectionAtStart);
  if (popupClosed || epoch !== youtubeEpoch) return;
  if (generatedReady) {
    setYoutubeStatus(existingReady
      ? 'Созданные субтитры готовы. Готовая дорожка YouTube также сохранена.'
      : 'Созданные субтитры готовы. Готовой дорожки YouTube нет.');
  } else if (existingReady) {
    setYoutubeStatus(players.length
      ? 'Субтитры на языке оригинала скачаны и подключены.'
      : 'Субтитры на языке оригинала сохранены. Подключите плеер для просмотра.');
  } else if (generatedError) {
    youtubeFailure(generatedError, true, epoch);
  } else {
    setYoutubeStatus('Не найдена подходящая английская или китайская дорожка оригинала. Выберите язык речи и создайте субтитры локально; в режиме «Авто» создание использует китайский.');
  }
}

async function loadYoutubeSubtitles() {
  if (!youtubeId || popupClosed) return;
  clearTimeout(youtubePollTimer);
  const epoch = ++youtubeEpoch;
  $('createYoutubeSubtitles').disabled = true;
  $('retryYoutubeSubtitles').hidden = true;
  $('youtubeSubtitles').hidden = false;
  setYoutubeStatus('Проверяю локальный сервер…');
  let generationSettled = false;
  try {
    const generated = await request(MESSAGE.LOCAL_SUBTITLE_STATUS, { videoId: youtubeId });
    if (popupClosed || epoch !== youtubeEpoch) return;
    generationSettled = generated.status !== 'running';
    const generatedError = generated.status === 'error'
      ? new Error(generated.error || 'Создание субтитров прервано') : null;
    let generatedReady = false;
    let generatedRunning = false;
    if (generated.status === 'ready') {
      drawYoutubeProgress(generated);
      await installLocalSubtitle(generated);
      if (popupClosed || epoch !== youtubeEpoch) return;
      $('createYoutubeSubtitles').textContent = 'Создать заново';
      generatedReady = true;
    }
    if (generated.status === 'running') {
      drawYoutubeProgress(generated);
      $('createYoutubeSubtitles').disabled = true;
      generatedRunning = true;
      youtubePollTimer = setTimeout(() => pollGeneratedSubtitle(epoch), 1500);
    }
    if (!generatedRunning) {
      $('createYoutubeSubtitles').disabled = false;
      await pollExistingSubtitle(epoch, generatedReady, null, generatedError);
    }
  } catch (error) {
    youtubeFailure(error, generationSettled, epoch);
  }
}

async function createYoutubeSubtitles() {
  if (!youtubeId || popupClosed || $('createYoutubeSubtitles').disabled) return;
  clearTimeout(youtubePollTimer);
  const epoch = ++youtubeEpoch;
  const button = $('createYoutubeSubtitles');
  button.disabled = true;
  $('retryYoutubeSubtitles').hidden = true;
  selectGeneratedWhenReady = true;
  generatedSelectionRevision = selectionRevision;
  drawYoutubeProgress({ status: 'running', stage: 'preparing', progress: 0 });
  try {
    const result = await request(MESSAGE.LOCAL_SUBTITLE_GENERATE, { videoId: youtubeId, language: state.settings.youtubeLanguage || 'zh' });
    if (popupClosed || epoch !== youtubeEpoch) return;
    if (result.status === 'ready') {
      drawYoutubeProgress(result);
      await installLocalSubtitle(result, true);
      if (popupClosed || epoch !== youtubeEpoch) return;
      selectGeneratedWhenReady = false;
      setYoutubeStatus('Созданные субтитры сохранены. Выберите дорожку и подключите плеер для просмотра.');
      button.disabled = false;
      button.textContent = 'Создать заново';
      return;
    }
    if (result.status === 'error') return youtubeFailure(new Error(result.error || 'Не удалось запустить создание'), true, epoch);
    if (result.status !== 'running') throw new Error('Сервер не подтвердил запуск задания');
    drawYoutubeProgress(result);
    youtubePollTimer = setTimeout(() => pollGeneratedSubtitle(epoch), 1500);
  } catch (error) {
    youtubeFailure(error, false, epoch);
  }
}

async function deleteTrack(id) {
  const data = await request(MESSAGE.TRACK_REMOVE, { tabId, pageKey, id });
  if (state.settings.secondTrackId === `external:${id}`) updateLocalSetting('secondTrackId', '');
  editedTiming.delete(id);
  adoptState(data.state);
  if (syncTrackId === id) syncTrackId = '';
  render();
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
  if (!connectable) return;
  $('activate').disabled = true;
  $('restartSearch').disabled = true;
  setStatus(restart ? 'Перезапускаю поиск субтитров…' : 'Подключаюсь к странице и плееру…');
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) throw new Error('Без доступа к iframe расширение не сможет увидеть плеер.');
    const data = await request(MESSAGE.PLAYER_DISCOVER, { tabId, pageKey });
    players = data.players ?? [];
    if (!players.length) {
      render();
      throw new Error('Плеер не найден. Запустите видео и попробуйте ещё раз.');
    }
    render();
    await selectPlayer(currentPlayer());
    setStatus(restart
      ? `Поиск субтитров перезапущен. Найдено плееров: ${players.length}.`
      : `Подключено. Найдено плееров: ${players.length}.`);
  } finally {
    $('activate').disabled = false;
    $('restartSearch').disabled = false;
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

async function loadSpeechSettings() {
  const revision = speechRevision;
  try {
    const data = await request(MESSAGE.SPEECH_SETTINGS_GET);
    if (revision === speechRevision && Number.isFinite(Number(data.settings?.rate))) {
      speechRate = Number(data.settings.rate);
      speechVoiceName = typeof data.settings?.voiceName === 'string' ? data.settings.voiceName : '';
      speechVoices = Array.isArray(data.voices) ? data.voices : [];
      drawSettings();
    }
    hydrationErrors.delete('speech');
    drawSaveFeedback();
    return data;
  } catch (error) {
    if (revision === speechRevision) hydrationErrors.set('speech', error);
    drawSaveFeedback();
    return {};
  }
}

function saveSpeechSettings() {
  const requested = Number($('speechRate').value);
  const voiceName = $('speechVoice').value;
  speechRevision += 1;
  speechRate = requested;
  speechVoiceName = voiceName;
  return saveRequest('speech:settings', MESSAGE.SPEECH_SETTINGS_PATCH, { rate: requested, voiceName }, (data) => {
    if (Number.isFinite(Number(data.settings?.rate))) speechRate = Number(data.settings.rate);
    if (typeof data.settings?.voiceName === 'string') speechVoiceName = data.settings.voiceName;
    if (Array.isArray(data.voices)) speechVoices = data.voices;
    hydrationErrors.delete('speech');
    drawSettings();
  }).catch((error) => setStatus(`Не удалось сохранить произношение: ${error.message}`, true));
}

async function previewSpeech() {
  const button = $('speechPreview');
  button.disabled = true;
  try {
    await request(MESSAGE.SPEECH_SPEAK, { text: '你好，很高兴认识你。', language: 'zh' });
  } catch (error) {
    setStatus(`Не удалось проверить голос: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

async function hydratePage(aiPromise) {
  if (!pageKey) return;
  const revision = ++hydrationRevision;
  return loadPopupSnapshot(request, tabId, pageKey, {
    aiPromise,
    connectable,
    onState(snapshot) {
      if (revision !== hydrationRevision) return;
      hydrationErrors.delete('onState');
      adoptState(snapshot.state);
      render();
      drawSaveFeedback();
      controls.dataset.hydrated = 'true';
      if (!youtubeLoaded) {
        youtubeLoaded = true;
        void loadYoutubeSubtitles();
      }
    },
    onPlayers(snapshot) {
      if (revision !== hydrationRevision) return;
      hydrationErrors.delete('onPlayers');
      players = snapshot.players;
      render();
      if (!connectable) setStatus('На служебных страницах подключение недоступно. Внешний вид и перевод можно настроить без плеера.');
      else if (!players.length) setStatus('Нажмите «Подключить к плееру» на странице с видео.');
      else setStatus(`Найдено в памяти: ${players.length}. Если плеер сменился, повторите поиск.`);
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
  const speechPromise = loadSpeechSettings();
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
  $('activate').disabled = !connectable;
  youtubeId = youtubeVideoId(tab.url || '');
  $('youtubeSubtitles').hidden = !youtubeId;
  pageKey = canonicalPageKey(tab.url || `https://local.invalid/tab/${tab.id}`);
  drawSettings();
  await Promise.all([hydratePage(aiPromise), speechPromise]);
}

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
showSection('player');
setupEmbeddedPanel();
document.defaultView?.addEventListener('pagehide', () => {
  popupClosed = true;
  youtubeEpoch += 1;
  clearTimeout(youtubePollTimer);
});
$('retrySave').addEventListener('click', () => {
  for (const entry of [...saves.values()]) if (entry.error) void entry.retry().catch(() => {});
});
$('retrySettings').addEventListener('click', () => { void Promise.all([hydratePage(loadAiSettings()), loadSpeechSettings()]); });
$('activate').addEventListener('click', () => activate().catch((error) => setStatus(error.message, true)));
$('restartSearch').addEventListener('click', () => activate(true).catch((error) => setStatus(error.message, true)));
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
$('speechVoice').addEventListener('change', () => { void saveSpeechSettings(); });
$('speechRate').addEventListener('change', () => { void saveSpeechSettings(); });
$('speechPreview').addEventListener('click', () => { void previewSpeech(); });
$('subtitleFile').addEventListener('change', (event) => importFile(event.target.files?.[0]).catch((error) => setStatus(error.message, true)));
$('createYoutubeSubtitles').addEventListener('click', () => createYoutubeSubtitles());
$('retryYoutubeSubtitles').addEventListener('click', () => loadYoutubeSubtitles());
$('youtubeLanguage').addEventListener('change', () => {
  youtubeEpoch += 1;
  clearTimeout(youtubePollTimer);
  const epoch = youtubeEpoch;
  const selectionAtStart = selectionRevision;
  void persistSetting('youtubeLanguage', $('youtubeLanguage').value).then(() => {
    if (!popupClosed && epoch === youtubeEpoch) {
      setYoutubeStatus('Ищу дорожку выбранного языка…');
      return pollExistingSubtitle(epoch, false, selectionAtStart);
    }
  }).catch((error) => setYoutubeStatus(error.message, true));
});
$('player').addEventListener('change', () => {
  const player = players.find((item) => item.frameId === Number($('player').value));
  selectPlayer(player).catch((error) => setStatus(error.message, true));
});
$('originalTrack').addEventListener('change', () => persistSetting('secondTrackId', $('originalTrack').value));
$('fontSize').addEventListener('input', () => previewSetting('fontSize', Number($('fontSize').value)));
$('inlineTranslations').addEventListener('change', () => persistSetting('inlineTranslations', $('inlineTranslations').checked));
$('subtitleColor').addEventListener('input', () => previewSetting('subtitleColor', $('subtitleColor').value));

$('subtitleBackground').addEventListener('change', () => {
  persistSetting('subtitleBackground', $('subtitleBackground').checked);
  drawSettings();
});
$('subtitleBackgroundColor').addEventListener('input', () => previewSetting('subtitleBackgroundColor', $('subtitleBackgroundColor').value));

$('subtitleBackgroundOpacity').addEventListener('input', () => previewSetting('subtitleBackgroundOpacity', Number($('subtitleBackgroundOpacity').value)));

$('syncTrack').addEventListener('change', () => {
  syncTrackId = $('syncTrack').value;
  $('offsetSeconds').value = selectedExternalTrack()?.offsetSeconds ?? 0;
  $('timeScalePercent').value = Math.round((selectedExternalTrack()?.timeScale ?? 1) * 100_000) / 1000;
});
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
