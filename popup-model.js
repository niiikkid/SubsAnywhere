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

export async function loadPopupSnapshot(request, tabId, pageKey, observers = {}) {
  const snapshot = {
    state: normalizeState({}),
    players: [],
    ai: {
      activeProvider: 'deepseek',
      providers: {
        deepseek: { hasApiKey: false, model: '' },
        openai: { hasApiKey: false, model: '' },
      },
    },
  };
  const read = async (name, operation, apply) => {
    try {
      apply(await operation);
      observers[name]?.(snapshot);
    } catch (error) {
      if (!observers.onError) throw error;
      observers.onError(name, error);
    }
  };
  await Promise.all([
    read('onState', request(MESSAGE.STATE_GET, { tabId, pageKey }), (data) => { snapshot.state = normalizeState(data.state); }),
    read('onPlayers', observers.connectable === false ? Promise.resolve({ players: [] }) : request(MESSAGE.PLAYER_GET, { tabId, pageKey, cachedOnly: true }), (data) => { snapshot.players = Array.isArray(data.players) ? data.players : []; }),
    read('onAi', observers.aiPromise ?? request(MESSAGE.AI_CONFIG_GET), (data) => {
      snapshot.ai = data;
    }),
  ]);
  return snapshot;
}
