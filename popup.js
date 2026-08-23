import { parseSrt } from './caption-core.js';
import {
  choosePlayer,
  createDebouncedPatchCommit,
  createSerialTaskQueue,
  decodeSubtitleBuffer,
  loadPopupSnapshot,
} from './popup-model.js';
import { MESSAGE } from './protocol.js';
import { buildTrackOptions, normalizeState, patchSettings } from './state-core.js';

const $ = (id) => document.getElementById(id);
const controls = $('controls');
const status = $('status');
let tabId;
let players = [];
let state = normalizeState({});
let selectedFrameId;
let syncTrackId = '';
const enqueueOffsetTask = createSerialTaskQueue();
const settingsCommit = createDebouncedPatchCommit(
  (patch) => request(MESSAGE.STATE_PATCH, { tabId, patch }),
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

function drawTrackSelect(select, selectedId) {
  const options = buildTrackOptions(currentPlayer()?.tracks ?? [], state.externalTracks, selectedId);
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
    remove.addEventListener('click', () => deleteTrack(track.id));
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
}

function drawSettings() {
  const settings = state.settings;
  drawTrackSelect($('firstTrack'), settings.firstTrackId);
  drawTrackSelect($('secondTrack'), settings.secondTrackId);
  $('firstBottom').value = settings.firstBottom;
  $('secondBottom').value = settings.secondBottom;
  $('fontSize').value = settings.fontSize;
  $('firstBottomValue').value = `${settings.firstBottom}%`;
  $('secondBottomValue').value = `${settings.secondBottom}%`;
  $('fontSizeValue').value = `${settings.fontSize}px`;
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
    frameId: player.frameId,
    playerKey: player.key,
  });
  state = normalizeState(data.state);
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
  return request(MESSAGE.STATE_PATCH, { tabId, patch: { [key]: normalized } })
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
    cues,
    offsetSeconds: 0,
  };
  const data = await request(MESSAGE.TRACK_ADD, { tabId, track });
  state = normalizeState(data.state);
  syncTrackId = track.id;
  render();
  const externalId = `external:${track.id}`;
  if (!state.settings.secondTrackId) persistSetting('secondTrackId', externalId);
  else if (!state.settings.firstTrackId) persistSetting('firstTrackId', externalId);
  render();
  setStatus(`Добавлен файл «${track.name}»: ${cues.length} строк.`);
  $('subtitleFile').value = '';
}

async function deleteTrack(id) {
  await settingsCommit.flush();
  const data = await request(MESSAGE.TRACK_REMOVE, { tabId, id });
  state = normalizeState(data.state);
  if (syncTrackId === id) syncTrackId = '';
  render();
}

async function setOffset(trackId, value) {
  await settingsCommit.flush();
  const track = state.externalTracks.find((item) => item.id === trackId);
  if (!track) return;
  const data = await request(MESSAGE.TRACK_OFFSET, { tabId, id: track.id, offsetSeconds: value });
  state = normalizeState(data.state);
  render();
}

async function activate() {
  $('activate').disabled = true;
  setStatus('Подключаюсь к странице и плееру…');
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) throw new Error('Без доступа к iframe расширение не сможет увидеть плеер.');
    const data = await request(MESSAGE.PLAYER_DISCOVER, { tabId });
    players = data.players ?? [];
    if (!players.length) {
      render();
      throw new Error('Плеер не найден. Запустите видео и попробуйте ещё раз.');
    }
    render();
    await selectPlayer(currentPlayer());
    setStatus(`Подключено. Найдено плееров: ${players.length}.`);
  } finally {
    $('activate').disabled = false;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) throw new Error('Не удалось определить активную вкладку.');
  tabId = tab.id;
  const snapshot = await loadPopupSnapshot(request, tabId);
  state = snapshot.state;
  players = snapshot.players;
  render();
  if (!players.length) setStatus('Нажмите «Подключить к плееру» на странице с видео.');
  else setStatus(`Плеер уже подключён. Найдено: ${players.length}.`);
}

$('activate').addEventListener('click', () => activate().catch((error) => setStatus(error.message, true)));
$('subtitleFile').addEventListener('change', (event) => importFile(event.target.files?.[0]).catch((error) => setStatus(error.message, true)));
$('player').addEventListener('change', () => {
  const player = players.find((item) => item.frameId === Number($('player').value));
  selectPlayer(player).catch((error) => setStatus(error.message, true));
});
$('firstTrack').addEventListener('change', () => persistSetting('firstTrackId', $('firstTrack').value));
$('secondTrack').addEventListener('change', () => persistSetting('secondTrackId', $('secondTrack').value));
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
});
$('offsetSeconds').addEventListener('change', () => {
  const trackId = selectedExternalTrack()?.id;
  const value = Number($('offsetSeconds').value);
  if (!trackId) return;
  enqueueOffsetTask(() => setOffset(trackId, value)).catch((error) => setStatus(error.message, true));
});
for (const button of document.querySelectorAll('[data-shift]')) {
  button.addEventListener('click', () => {
    const trackId = selectedExternalTrack()?.id;
    const shift = Number(button.dataset.shift);
    if (!trackId) return;
    enqueueOffsetTask(() => {
      const track = state.externalTracks.find((item) => item.id === trackId);
      return track ? setOffset(trackId, track.offsetSeconds + shift) : undefined;
    }).catch((error) => setStatus(error.message, true));
  });
}

init().catch((error) => setStatus(error.message, true));
