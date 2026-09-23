import { AIClient, AiCredentialStore } from './ai-client.js';
import { BackgroundController } from './background-controller.js';
import { LocalSubtitleClient } from './local-subtitles-client.js';
import { VocabularyClient } from './vocabulary-client.js';
import { StateStore } from './state-store.js';
import { MESSAGE, failure, ok } from './protocol.js';

const storage = chrome.storage.local;
const store = new StateStore(storage);
const credentialStore = new AiCredentialStore(storage);
const aiClient = new AIClient(globalThis.fetch.bind(globalThis), credentialStore);
const localSubtitles = new LocalSubtitleClient(globalThis.fetch.bind(globalThis));
const vocabulary = new VocabularyClient(globalThis.fetch.bind(globalThis));
const controller = new BackgroundController(chrome, store, { credentialStore, aiClient, localSubtitles, vocabulary });
const PANEL_STORAGE_KEY = 'dualCaptionsPanel';

function normalizePanelState(value = {}) {
  const rect = value?.rect && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(Number(value.rect[key])))
    ? Object.fromEntries(['left', 'top', 'width', 'height'].map((key) => [key, Number(value.rect[key])]))
    : null;
  return {
    open: value?.open !== false,
    rect,
    dockedHeight: Math.min(1600, Math.max(240, Number(value?.dockedHeight) || 760)),
    layoutVersion: Math.max(0, Math.trunc(Number(value?.layoutVersion) || 0)),
  };
}

async function handlePanelState(message, sender) {
  if (message?.type === MESSAGE.PANEL_CONTEXT_GET) {
    if (!Number.isInteger(sender?.tab?.id) || typeof sender.tab.url !== 'string') {
      return failure(new Error('Не удалось определить страницу панели'));
    }
    return ok({ tabId: sender.tab.id, url: sender.tab.url });
  }
  if (![MESSAGE.PANEL_STATE_GET, MESSAGE.PANEL_STATE_PATCH].includes(message?.type)) return null;
  const stored = await storage.get(PANEL_STORAGE_KEY);
  const current = normalizePanelState(stored[PANEL_STORAGE_KEY]);
  if (message.type === MESSAGE.PANEL_STATE_GET) return ok(current);
  const patch = message.patch && typeof message.patch === 'object' ? message.patch : {};
  const next = normalizePanelState({
    ...current,
    ...(typeof patch.open === 'boolean' ? { open: patch.open } : {}),
    ...(patch.rect ? { rect: patch.rect } : {}),
    ...(Number.isFinite(Number(patch.dockedHeight)) ? { dockedHeight: Number(patch.dockedHeight) } : {}),
    ...(Number.isInteger(Number(patch.layoutVersion)) ? { layoutVersion: Number(patch.layoutVersion) } : {}),
  });
  await storage.set({ [PANEL_STORAGE_KEY]: next });
  return ok(next);
}

const protectedMessages = new Set([
  MESSAGE.AI_CONFIG_GET, MESSAGE.AI_CONFIG_PATCH, MESSAGE.AI_MODELS_GET, MESSAGE.CAPTION_TRANSLATE,
  MESSAGE.WORD_EXPLAIN, MESSAGE.SENTENCE_EXPLAIN,
]);
const storageProtection = (async () => {
  try {
    if (typeof storage.setAccessLevel !== 'function') return false;
    await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    return true;
  } catch {
    return false;
  }
})();

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const respond = async () => {
    const panelResult = await handlePanelState(message, sender);
    if (panelResult) return panelResult;
    if (protectedMessages.has(message?.type) && !await storageProtection) {
      return failure(new Error('Не удалось защитить хранилище API-ключа. Обновите Chrome и перезагрузите расширение.'));
    }
    return controller.handle(message, sender);
  };
  // A popup or frame may close before its response arrives.
  respond().catch(failure).then(reply).catch(() => undefined);
  return true;
});

chrome.action?.onClicked?.addListener(async (tab) => {
  if (!Number.isInteger(tab?.id) || !/^https?:\/\//i.test(tab.url || '')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MESSAGE.PANEL_TOGGLE });
    return;
  } catch {
    // A page opened before the extension reload has no static panel host yet.
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['panel-layout.js', 'panel-host.js'],
    });
    await chrome.tabs.sendMessage(tab.id, { type: MESSAGE.PANEL_SHOW });
  } catch {
    // Browser and store pages do not allow extension injection.
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) controller.handleTabNavigation(tabId, changeInfo.url).catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => controller.removeTab(tabId));

// Persisted registrations outlive this worker and must follow revoked permissions.
controller.initialize().catch(() => undefined);
chrome.permissions.onRemoved?.addListener(() => controller.initialize().catch(() => undefined));
