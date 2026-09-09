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
let syncTrackId = '';
let hasApiKey = false;
let aiModel = 'deepseek-v4-flash';
let aiModelRevision = 0;
let aiKeyRevision = 0;
let youtubeId = '';
let youtubePollTimer;
let youtubeEpoch = 0;
let popupClosed = false;
let selectGeneratedWhenReady = false;
let selectionRevision = 0;
let generatedSelectionRevision = 0;


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
  for (const id of ['fontSize', 'subtitleColor', 'subtitleBackground', 'originalTrack', 'subtitleFile']) $(id).disabled = !pageKey;
  drawTrackSelect($('originalTrack'), settings.secondTrackId, settings.secondTrackFallbackId);
  $('fontSize').value = settings.fontSize;
  $('subtitleColor').value = settings.subtitleColor;
  $('subtitleBackground').checked = settings.subtitleBackground;
  $('subtitleBackgroundColor').value = settings.subtitleBackgroundColor;
  $('subtitleBackgroundOpacity').value = settings.subtitleBackgroundOpacity;
  $('subtitleBackgroundOpacityValue').value = `${settings.subtitleBackgroundOpacity}%`;
  $('subtitleBackgroundColor').disabled = !pageKey || !settings.subtitleBackground;
  $('subtitleBackgroundOpacity').disabled = !pageKey || !settings.subtitleBackground;
  $('fontSizeValue').value = `${settings.fontSize}px`;
  $('aiKeyState').textContent = hydrationErrors.has('ai')
    ? `Не удалось загрузить DeepSeek: ${hydrationErrors.get('ai').message}`
    : !aiLoaded ? 'Загружаю настройки DeepSeek…' : hasApiKey
    ? 'Ключ сохранён. Перевод по клику включён.'
    : 'Ключ не сохранён. Перевод по клику недоступен.';
  $('deepseekModel').value = aiModel;
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

async function installLocalSubtitle(payload, selectTrack = false) {
  if (popupClosed) return false;
  const epoch = youtubeEpoch;
  if (payload?.status !== 'ready' || typeof payload.srt !== 'string') return false;
  if (payload.srt.length > 5 * 1024 * 1024) throw new Error('Локальный файл субтитров слишком большой');
  const cues = parseSrt(payload.srt);
  if (!cues.length) throw new Error('Локальный сервер вернул пустые субтитры');
  const source = payload.source === 'generated' ? 'generated' : 'youtube';
  const track = localSubtitleTrack(youtubeId, source, cues);
  const revision = selectionRevision;
  const shouldSelect = (selectTrack && generatedSelectionRevision === selectionRevision)
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

async function pollExistingSubtitle(epoch, generatedReady = false) {
  if (popupClosed || epoch !== youtubeEpoch) return;
  const result = await request(MESSAGE.LOCAL_SUBTITLE_EXISTING, { videoId: youtubeId });
  if (popupClosed || epoch !== youtubeEpoch) return;
  if (result.status === 'running') {
    setYoutubeStatus('Скачиваю готовую дорожку YouTube… Можно продолжать настройку внешнего вида.');
    youtubePollTimer = setTimeout(() => pollExistingSubtitle(epoch, generatedReady).catch((error) => youtubeFailure(error, true, epoch)), 1500);
    return;
  }
  if (result.status === 'error') throw new Error(result.error || 'Не удалось скачать дорожку YouTube');
  const existingReady = await installLocalSubtitle(result);
  if (popupClosed || epoch !== youtubeEpoch) return;
  if (generatedReady) {
    setYoutubeStatus(existingReady
      ? 'Созданные субтитры готовы. Готовая дорожка YouTube также сохранена.'
      : 'Созданные субтитры готовы. Готовой дорожки YouTube нет.');
  } else if (existingReady) {
    setYoutubeStatus(players.length
      ? 'Готовые китайские субтитры YouTube скачаны и подключены.'
      : 'Готовые китайские субтитры YouTube сохранены. Подключите плеер для просмотра.');
  } else {
    setYoutubeStatus('Готовых китайских субтитров нет. Можно создать свои.');
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
    if (generated.status === 'error') return youtubeFailure(new Error(generated.error || 'Создание субтитров прервано'), true, epoch);
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
      await pollExistingSubtitle(epoch, generatedReady);
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
    const result = await request(MESSAGE.LOCAL_SUBTITLE_GENERATE, { videoId: youtubeId });
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

async function saveDeepseekKey(clear = false) {
  const inputValue = $('deepseekKey').value;
  const apiKey = $('deepseekKey').value.trim();
  if (!clear && !apiKey) throw new Error('Вставьте API-ключ DeepSeek');
  aiKeyRevision += 1;
  await saveRequest('ai:key', MESSAGE.AI_CONFIG_PATCH, { apiKey, model: aiModel, clearApiKey: clear }, (data) => {
    hasApiKey = Boolean(data.hasApiKey);
    aiLoaded = true;
    hydrationErrors.delete('ai');
    if ($('deepseekKey').value === inputValue) $('deepseekKey').value = '';
    drawSettings();
  });
}

async function saveDeepseekModel() {
  aiModelRevision += 1;
  aiModel = $('deepseekModel').value === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
  await saveRequest('ai:model', MESSAGE.AI_CONFIG_PATCH, { model: aiModel });
}

async function loadAiSettings() {
  const revision = ++aiLoadRevision;
  const keyRevision = aiKeyRevision;
  const modelRevision = aiModelRevision;
  try {
    const data = await request(MESSAGE.AI_CONFIG_GET);
    if (revision !== aiLoadRevision) return data;
    if (keyRevision === aiKeyRevision) hasApiKey = Boolean(data.hasApiKey);
    if (modelRevision === aiModelRevision) aiModel = data.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
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
      if (!connectable) setStatus('На служебных страницах подключение недоступно. Внешний вид и DeepSeek можно настроить без плеера.');
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) throw new Error('Не удалось определить активную вкладку.');
  tabId = tab.id;
  connectable = /^https?:\/\//i.test(tab.url || '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i.test(tab.url || '');
  $('activate').disabled = !connectable;
  youtubeId = youtubeVideoId(tab.url || '');
  $('youtubeSubtitles').hidden = !youtubeId;
  pageKey = canonicalPageKey(tab.url || `https://local.invalid/tab/${tab.id}`);
  drawSettings();
  await hydratePage(aiPromise);
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
$('saveDeepseekKey').addEventListener('click', () => saveDeepseekKey(false).catch((error) => setStatus(error.message, true)));
$('clearDeepseekKey').addEventListener('click', () => saveDeepseekKey(true).catch((error) => setStatus(error.message, true)));
$('deepseekModel').addEventListener('change', () => saveDeepseekModel().catch((error) => setStatus(error.message, true)));
$('subtitleFile').addEventListener('change', (event) => importFile(event.target.files?.[0]).catch((error) => setStatus(error.message, true)));
$('createYoutubeSubtitles').addEventListener('click', () => createYoutubeSubtitles());
$('retryYoutubeSubtitles').addEventListener('click', () => loadYoutubeSubtitles());
$('player').addEventListener('change', () => {
  const player = players.find((item) => item.frameId === Number($('player').value));
  selectPlayer(player).catch((error) => setStatus(error.message, true));
});
$('originalTrack').addEventListener('change', () => persistSetting('secondTrackId', $('originalTrack').value));
$('fontSize').addEventListener('input', () => previewSetting('fontSize', Number($('fontSize').value)));
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
