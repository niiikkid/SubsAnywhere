import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('YouTube navigation reloads the panel context once, even while hidden', async () => {
  const source = await fs.readFile(new URL('../panel-host.js', import.meta.url), 'utf8');
  const documentListeners = new Map();
  const windowListeners = new Map();
  const reloads = [];
  const frame = { set src(value) { reloads.push(value); } };
  const shadow = { querySelector: (selector) => selector === 'iframe' ? frame : {}, querySelectorAll: () => [] };
  const host = { dataset: {}, attachShadow: () => shadow };
  const location = { href: 'https://www.youtube.com/watch?v=abcdefghijk', hostname: 'www.youtube.com', pathname: '/watch' };
  let poll;
  const context = vm.createContext({
    location,
    document: {
      addEventListener: (type, listener) => documentListeners.set(type, listener),
      getElementById: () => null,
      createElement: () => host,
      documentElement: { append() {} },
    },
    chrome: { runtime: {
      getURL: (path) => `chrome-extension://fixture/${path}`,
      onMessage: { addListener() {} },
      sendMessage: async () => ({ ok: true, data: { open: false, layoutVersion: 2 } }),
    } },
    SubsAnywherePanelLayout: {},
    setInterval: (callback) => { poll = callback; },
  });
  context.window = { addEventListener: (type, listener) => windowListeners.set(type, listener) };
  vm.runInContext(source, context);
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  assert.equal(host.hidden, true);
  location.href = 'https://www.youtube.com/watch?v=repevhXG7W0';
  documentListeners.get('yt-navigate-finish')();
  assert.deepEqual(reloads, ['chrome-extension://fixture/popup.html?embedded=1']);
  poll();
  documentListeners.get('yt-navigate-finish')();
  assert.equal(reloads.length, 1);
  location.href = 'https://www.youtube.com/watch?v=abcdefghijk';
  windowListeners.get('popstate')();
  assert.equal(reloads.length, 2);
});
