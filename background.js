import { AiCredentialStore, DeepSeekClient } from './ai-client.js';
import { BackgroundController } from './background-controller.js';
import { StateStore } from './state-store.js';
import { SubtitleFinder } from './subtitle-finder.js';

const storage = chrome.storage.local;
const store = new StateStore(storage);
const credentialStore = new AiCredentialStore(storage);
const deepSeek = new DeepSeekClient(globalThis.fetch.bind(globalThis), credentialStore);
const subtitleFinder = new SubtitleFinder(globalThis.fetch.bind(globalThis), deepSeek);
const controller = new BackgroundController(chrome, store, { credentialStore, subtitleFinder });

storage.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  controller.handle(message, sender).then(reply);
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) controller.handleTabNavigation(tabId, changeInfo.url).catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => controller.removeTab(tabId));
