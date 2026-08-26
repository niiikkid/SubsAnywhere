import { parseSrt } from './caption-core.js';
import { canonicalPageKey, inferMediaDescriptor } from './page-context.js';
import {
  choosePlayer,
  createDebouncedPatchCommit,
  createSerialTaskQueue,
  decodeSubtitleBuffer,
  formatFindSummary,
  loadPopupSnapshot,
} from './popup-model.js';
import { MESSAGE } from './protocol.js';
import { buildTrackOptions, normalizeState, patchSettings } from './state-core.js';

const $ = (id) => document.getElementById(id);
const controls = $('controls');
const status = $('status');
let tabId;
let pageKey = '';
let activeTab = null;
let players = [];
let state = normalizeState({});
let selectedFrameId;
let syncTrackId = '';
let hasApiKey = false;
let mediaDraftInitialized = false;
const enqueueOffsetTask = createSerialTaskQueue();
const settingsCommit = createDebouncedPatchCommit(
  (patch) => request(MESSAGE.STATE_PATCH, { tabId, pageKey, patch }),
  120,
  (error) => setStatus(`Не удалось сохранить настройку: ${error.message}`, true),
);

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'Расширение не ответило');
  return response.data;
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
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
    const details = [track.language || '', `${track.cues.length} строк`];
    if (track.sync?.method) details.push('AI ✓');
    meta.textContent = details.filter(Boolean).join(' · ');
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
  const validSelection = state.externalTracks.some((track) => track.id === syncTrackId);
  if (!validSelection) syncTrackId = state.externalTracks[0].id;
  select.replaceChildren();
  for (const track of state.externalTracks) option(select, track.id, track.name);
  select.value = syncTrackId;
  $('offsetSeconds').value = selectedExternalTrack()?.offsetSeconds ?? 0;
  $('timeScalePercent').value = Math.round((selectedExternalTrack()?.timeScale ?? 1) * 100_000) / 1000;
}

function drawMediaDraft() {
  if (mediaDraftInitialized) return;
  const player = currentPlayer();
  const inferred = inferMediaDescriptor({
    title: activeTab?.title || player?.tabTitle || '',
    url: activeTab?.url || pageKey,
    playerTitle: player?.title || '',
    sourceName: player?.sourceName || '',
  });
  $('mediaTitle').value = state.settings.mediaTitle || inferred.title;
  $('mediaSeason').value = state.settings.mediaSeason ?? inferred.season ?? '';
  $('mediaEpisode').value = state.settings.mediaEpisode ?? inferred.episode ?? '';
  mediaDraftInitialized = true;
}

function drawSettings() {
  const settings = state.settings;
  drawTrackSelect($('firstTrack'), settings.firstTrackId, settings.firstTrackFallbackId);
  drawTrackSelect($('secondTrack'), settings.secondTrackId, settings.secondTrackFallbackId);
  $('firstBottom').value = settings.firstBottom;
  $('secondBottom').value = settings.secondBottom;
  $('fontSize').value = settings.fontSize;
  $('firstBottomValue').value = `${settings.firstBottom}%`;
  $('secondBottomValue').value = `${settings.secondBottom}%`;
  $('fontSizeValue').value = `${settings.fontSize}px`;
  $('aiModel').value = settings.aiModel;
  $('reasoningEffort').value = settings.reasoningEffort;
  $('aiKeyState').textContent = hasApiKey
    ? 'Ключ сохранён внутри расширения.'
    : 'Ключ не сохранён. Поиск работает, но AI-синхронизация будет ручной.';
  drawMediaDraft();
}

function render() {
  controls.hidden = players.length === 0;
  drawPlayers();
  if (!players.length) return;
  drawSettings();
  drawExternalList();
  drawSync();
}

async function selectPlayer(player) {
  if (!player) return;
  await settingsCommit.flush();
  selectedFrameId = player.frameId;
  const data = await request(MESSAGE.PLAYER_SELECT, {
    tabId,
    pageKey,
    frameId: player.frameId,
    playerKey: player.key,
  });
  state = normalizeState(data.state);
  mediaDraftInitialized = false;
  render();
}

function updateLocalSetting(key, value) {
  state = patchSettings(state, { [key]: value });
  if (key === 'firstBottom') $('firstBottomValue').value = `${state.settings.firstBottom}%`;
  if (key === 'secondBottom') $('secondBottomValue').value = `${state.settings.secondBottom}%`;
  if (key === 'fontSize') $('fontSizeValue').value = `${state.settings.fontSize}px`;
  return state.settings[key];
}

function persistSetting(key, value) {
  const normalized = updateLocalSetting(key, value);
  return request(MESSAGE.STATE_PATCH, { tabId, pageKey, patch: { [key]: normalized } })
    .catch((error) => setStatus(`Не удалось сохранить настройку: ${error.message}`, true));
}

function previewSetting(key, value) {
  const normalized = updateLocalSetting(key, value);
  settingsCommit.schedule({ [key]: normalized });
}

async function readSubtitleFile(file) {
  return decodeSubtitleBuffer(await file.arrayBuffer());
}

async function importFile(file) {
  if (!file) return;
  await settingsCommit.flush();
  if (file.size > 5 * 1024 * 1024) throw new Error('Файл слишком большой. Максимум — 5 МБ.');
  const cues = parseSrt(await readSubtitleFile(file));
  if (!cues.length) throw new Error('Не удалось найти строки SRT. Проверьте формат файла.');
  const track = {
    id: crypto.randomUUID(),
    name: file.name.replace(/\.srt$/i, '') || 'Мои субтитры',
    language: '',
    cues,
    offsetSeconds: 0,
    timeScale: 1,
  };
  const data = await request(MESSAGE.TRACK_ADD, { tabId, pageKey, track });
  state = normalizeState(data.state);
  syncTrackId = track.id;
  render();
  const externalId = `external:${track.id}`;
  if (!state.settings.secondTrackId) await persistSetting('secondTrackId', externalId);
  else if (!state.settings.firstTrackId) await persistSetting('firstTrackId', externalId);
  render();
  setStatus(`Добавлен файл «${track.name}»: ${cues.length} строк.`);
  $('subtitleFile').value = '';
}

async function deleteTrack(id) {
  await settingsCommit.flush();
  const data = await request(MESSAGE.TRACK_REMOVE, { tabId, pageKey, id });
  state = normalizeState(data.state);
  if (syncTrackId === id) syncTrackId = '';
  render();
}

async function setTiming(trackId, { offsetSeconds, timeScale }) {
  await settingsCommit.flush();
  const track = state.externalTracks.find((item) => item.id === trackId);
  if (!track) return;
  const data = await request(MESSAGE.TRACK_TIMING, {
    tabId,
    pageKey,
    id: track.id,
    offsetSeconds: offsetSeconds ?? track.offsetSeconds,
    timeScale: timeScale ?? track.timeScale,
  });
  state = normalizeState(data.state);
  render();
}

async function activate() {
  $('activate').disabled = true;
  setStatus('Подключаюсь к странице и плееру…');
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) throw new Error('Без доступа к iframe расширение не сможет увидеть плеер.');
    const data = await request(MESSAGE.PLAYER_DISCOVER, { tabId, pageKey });
    players = data.players ?? [];
    if (!players.length) {
      render();
      throw new Error('Плеер не найден. Запустите видео и попробуйте ещё раз.');
    }
    mediaDraftInitialized = false;
    render();
    await selectPlayer(currentPlayer());
    setStatus(`Подключено. Найдено плееров: ${players.length}.`);
  } finally {
    $('activate').disabled = false;
  }
}

async function saveDeepseekKey(clear = false) {
  const apiKey = $('deepseekKey').value.trim();
  if (!clear && !apiKey) throw new Error('Вставьте API-ключ DeepSeek');
  const data = await request(MESSAGE.AI_CONFIG_PATCH, { apiKey, clearApiKey: clear });
  hasApiKey = Boolean(data.hasApiKey);
  $('deepseekKey').value = '';
  drawSettings();
  setStatus(clear ? 'API-ключ DeepSeek удалён.' : 'API-ключ DeepSeek сохранён.');
}

function numberOrNull(input) {
  return input.value === '' ? null : Number(input.value);
}

async function findSubtitles() {
  const button = $('findSubtitles');
  button.disabled = true;
  setStatus('Проверяю встроенные дорожки и ищу недостающие субтитры…');
  try {
    await settingsCommit.flush();
    if ($('deepseekKey').value.trim()) await saveDeepseekKey(false);
    const aiOptions = {
      model: $('aiModel').value,
      reasoningEffort: $('reasoningEffort').value,
    };
    const media = {
      title: $('mediaTitle').value.trim(),
      season: numberOrNull($('mediaSeason')),
      episode: numberOrNull($('mediaEpisode')),
    };
    if (!media.title) throw new Error('Введите название фильма или сериала.');
    const persisted = await request(MESSAGE.STATE_PATCH, {
      tabId,
      pageKey,
      patch: {
        mediaTitle: media.title,
        mediaSeason: media.season,
        mediaEpisode: media.episode,
        aiModel: aiOptions.model,
        reasoningEffort: aiOptions.reasoningEffort,
      },
    });
    state = normalizeState(persisted.state);
    const data = await request(MESSAGE.SUBTITLE_FIND, {
      tabId,
      pageKey,
      frameId: selectedFrameId,
      media,
      aiOptions,
    });
    state = normalizeState(data.state);
    syncTrackId = data.summary?.sync?.[0]?.language
      ? state.externalTracks.find((track) => track.language === data.summary.sync[0].language)?.id || syncTrackId
      : syncTrackId;
    $('mediaTitle').value = data.summary?.title || media.title;
    mediaDraftInitialized = true;
    render();
    setStatus(`Готово. ${formatFindSummary(data.summary)}`);
  } finally {
    button.disabled = false;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) throw new Error('Не удалось определить активную вкладку.');
  activeTab = tab;
  tabId = tab.id;
  pageKey = canonicalPageKey(tab.url || `https://local.invalid/tab/${tab.id}`);
  const snapshot = await loadPopupSnapshot(request, tabId, pageKey);
  state = snapshot.state;
  players = snapshot.players;
  hasApiKey = snapshot.hasApiKey;
  render();
  if (!players.length) setStatus('Нажмите «Подключить к плееру» на странице с видео.');
  else setStatus(`Плеер уже подключён. Найдено: ${players.length}.`);
}

$('activate').addEventListener('click', () => activate().catch((error) => setStatus(error.message, true)));
$('findSubtitles').addEventListener('click', () => findSubtitles().catch((error) => setStatus(error.message, true)));
$('saveDeepseekKey').addEventListener('click', () => saveDeepseekKey(false).catch((error) => setStatus(error.message, true)));
$('clearDeepseekKey').addEventListener('click', () => saveDeepseekKey(true).catch((error) => setStatus(error.message, true)));
$('subtitleFile').addEventListener('change', (event) => importFile(event.target.files?.[0]).catch((error) => setStatus(error.message, true)));
$('player').addEventListener('change', () => {
  const player = players.find((item) => item.frameId === Number($('player').value));
  selectPlayer(player).catch((error) => setStatus(error.message, true));
});
$('firstTrack').addEventListener('change', () => persistSetting('firstTrackId', $('firstTrack').value));
$('secondTrack').addEventListener('change', () => persistSetting('secondTrackId', $('secondTrack').value));
$('aiModel').addEventListener('change', () => persistSetting('aiModel', $('aiModel').value));
$('reasoningEffort').addEventListener('change', () => persistSetting('reasoningEffort', $('reasoningEffort').value));
$('mediaTitle').addEventListener('change', () => persistSetting('mediaTitle', $('mediaTitle').value.trim()));
$('mediaSeason').addEventListener('change', () => persistSetting('mediaSeason', numberOrNull($('mediaSeason'))));
$('mediaEpisode').addEventListener('change', () => persistSetting('mediaEpisode', numberOrNull($('mediaEpisode'))));
$('firstBottom').addEventListener('input', () => previewSetting('firstBottom', Number($('firstBottom').value)));
$('secondBottom').addEventListener('input', () => previewSetting('secondBottom', Number($('secondBottom').value)));
$('fontSize').addEventListener('input', () => previewSetting('fontSize', Number($('fontSize').value)));
for (const id of ['firstBottom', 'secondBottom', 'fontSize']) {
  $(id).addEventListener('change', () => {
    settingsCommit.flush().catch((error) => setStatus(`Не удалось сохранить настройку: ${error.message}`, true));
  });
}
$('syncTrack').addEventListener('change', () => {
  syncTrackId = $('syncTrack').value;
  $('offsetSeconds').value = selectedExternalTrack()?.offsetSeconds ?? 0;
  $('timeScalePercent').value = Math.round((selectedExternalTrack()?.timeScale ?? 1) * 100_000) / 1000;
});
$('offsetSeconds').addEventListener('change', () => {
  const trackId = selectedExternalTrack()?.id;
  const value = Number($('offsetSeconds').value);
  if (!trackId) return;
  enqueueOffsetTask(() => setTiming(trackId, { offsetSeconds: value })).catch((error) => setStatus(error.message, true));
});
$('timeScalePercent').addEventListener('change', () => {
  const trackId = selectedExternalTrack()?.id;
  const value = Number($('timeScalePercent').value) / 100;
  if (!trackId) return;
  enqueueOffsetTask(() => setTiming(trackId, { timeScale: value })).catch((error) => setStatus(error.message, true));
});
for (const button of document.querySelectorAll('[data-shift]')) {
  button.addEventListener('click', () => {
    const trackId = selectedExternalTrack()?.id;
    const shift = Number(button.dataset.shift);
    if (!trackId) return;
    enqueueOffsetTask(() => {
      const track = state.externalTracks.find((item) => item.id === trackId);
      return track ? setTiming(trackId, { offsetSeconds: track.offsetSeconds + shift }) : undefined;
    }).catch((error) => setStatus(error.message, true));
  });
}

init().catch((error) => setStatus(error.message, true));
