import { AIClient, AiCredentialStore } from './ai-client.js';
import { BackgroundController } from './background-controller.js';
import { LocalSubtitleClient } from './local-subtitles-client.js';
import { VocabularyClient } from './vocabulary-client.js';
import { StateStore } from './state-store.js';
import { MESSAGE, failure } from './protocol.js';

const storage = chrome.storage.local;
const store = new StateStore(storage);
const credentialStore = new AiCredentialStore(storage);
const aiClient = new AIClient(globalThis.fetch.bind(globalThis), credentialStore);
const localSubtitles = new LocalSubtitleClient(globalThis.fetch.bind(globalThis));
const vocabulary = new VocabularyClient(globalThis.fetch.bind(globalThis));
const controller = new BackgroundController(chrome, store, { credentialStore, aiClient, localSubtitles, vocabulary });

const protectedMessages = new Set([
  MESSAGE.AI_CONFIG_GET, MESSAGE.AI_CONFIG_PATCH, MESSAGE.AI_MODELS_GET, MESSAGE.CAPTION_TRANSLATE, MESSAGE.WORD_EXPLAIN,
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
    if (protectedMessages.has(message?.type) && !await storageProtection) {
      return failure(new Error('Не удалось защитить хранилище API-ключа. Обновите Chrome и перезагрузите расширение.'));
    }
    return controller.handle(message, sender);
  };
  // A popup or frame may close before its response arrives.
  respond().catch(failure).then(reply).catch(() => undefined);
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) controller.handleTabNavigation(tabId, changeInfo.url).catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => controller.removeTab(tabId));

// Persisted registrations outlive this worker and must follow revoked permissions.
controller.initialize().catch(() => undefined);
chrome.permissions.onRemoved?.addListener(() => controller.initialize().catch(() => undefined));
