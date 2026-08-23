import test from 'node:test';
import assert from 'node:assert/strict';

class FakeClassList {
  values = new Set();
  toggle(name, force) { if (force) this.values.add(name); else this.values.delete(name); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
}

function makeDocument() {
  const ids = [
    'controls', 'status', 'player', 'firstTrack', 'secondTrack', 'firstBottom', 'secondBottom',
    'fontSize', 'firstBottomValue', 'secondBottomValue', 'fontSizeValue', 'externalList',
    'syncBox', 'syncTrack', 'offsetSeconds', 'activate', 'subtitleFile',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements.controls.hidden = true;
  const shiftButtons = [-5, -1, -0.1, 0.1, 1, 5].map((shift) => {
    const button = new FakeElement('button');
    button.dataset.shift = String(shift);
    return button;
  });
  return {
    elements,
    getElementById(id) { return elements[id]; },
    createElement(tag) { return new FakeElement(tag); },
    querySelectorAll(selector) { return selector === '[data-shift]' ? shiftButtons : []; },
  };
}

test('production popup startup performs read-only hydration and never overwrites settings', async () => {
  const document = makeDocument();
  const messages = [];
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 77 }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') {
          return {
            ok: true,
            data: {
              state: {
                schemaVersion: 1,
                settings: {
                  firstTrackId: 'track-not-ready', secondTrackId: '', firstBottom: 23,
                  secondBottom: 7, fontSize: 29, selectedPlayerKey: 'saved-player',
                },
                externalTracks: [],
              },
            },
          };
        }
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [] } };
        throw new Error(`Unexpected startup write: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?startup-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(messages.map((message) => message.type).sort(), [
    'dualCaptions.player.get',
    'dualCaptions.state.get',
  ]);
  assert.equal(document.elements.controls.hidden, true);
  assert.equal(document.elements.status.textContent, 'Нажмите «Подключить к плееру» на странице с видео.');
});
