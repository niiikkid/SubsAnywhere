import { MESSAGE } from './protocol.js';
import { normalizeState } from './state-core.js';

export function decodeSubtitleBuffer(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1251').decode(buffer);
  }
}

export function choosePlayer(players = [], selectedPlayerKey = '', currentFrameId) {
  return players.find((player) => player.frameId === currentFrameId)
    ?? players.find((player) => player.key === selectedPlayerKey)
    ?? players[0]
    ?? null;
}

export function createSerialTaskQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const operation = tail.then(task);
    tail = operation.catch(() => undefined);
    return operation;
  };
}

export function createDebouncedPatchCommit(commit, delayMs = 120, onError = () => {}) {
  let pending = {};
  let timer;
  let tail = Promise.resolve();

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!Object.keys(pending).length) return tail;
    const patch = pending;
    pending = {};
    const operation = tail.then(() => commit(patch));
    tail = operation.catch(() => undefined);
    return operation;
  };

  return {
    schedule(patch) {
      Object.assign(pending, patch);
      clearTimeout(timer);
      timer = setTimeout(() => { flush().catch(onError); }, delayMs);
    },
    flush,
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending = {};
    },
  };
}

export async function loadPopupSnapshot(request, tabId, pageKey) {
  const [stateData, playerData, aiData] = await Promise.all([
    request(MESSAGE.STATE_GET, { tabId, pageKey }),
    request(MESSAGE.PLAYER_GET, { tabId, pageKey }),
    request(MESSAGE.AI_CONFIG_GET),
  ]);
  return {
    state: normalizeState(stateData.state),
    players: Array.isArray(playerData.players) ? playerData.players : [],
    hasApiKey: Boolean(aiData.hasApiKey),
  };
}

export function formatFindSummary(summary = {}) {
  const describe = (role, missing) => {
    if (!role?.found) return missing;
    return `${role.kind === 'builtin' ? 'встроенные' : 'SubDL'} — ${role.name}`;
  };
  const lines = [
    `Оригинал: ${describe(summary.original, 'не найден')}.`,
    `Русские: ${describe(summary.russian, 'не найдены')}.`,
  ];
  if (Array.isArray(summary.sync) && summary.sync.length) {
    const synced = summary.sync.map((item) => {
      const scale = Math.round(Number(item.timeScale || 1) * 100_000) / 1000;
      const offset = Number(item.offsetSeconds || 0);
      return `${item.language}: ${offset >= 0 ? '+' : ''}${offset} с, ${scale}%`;
    });
    lines.push(`Синхронизация: ${synced.join('; ')}.`);
  }
  if (Array.isArray(summary.notes) && summary.notes.length) lines.push(summary.notes.join(' '));
  return lines.join(' ');
}
