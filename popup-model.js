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
    aiModel: aiData.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
  };
}
