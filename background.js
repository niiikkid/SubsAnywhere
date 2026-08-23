import { BackgroundController } from './background-controller.js';
import { StateStore } from './state-store.js';

const store = new StateStore(chrome.storage.local);
const controller = new BackgroundController(chrome, store);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  controller.handle(message, sender).then(reply);
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => controller.removeTab(tabId));
