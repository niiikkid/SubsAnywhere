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
    'controls', 'status', 'player', 'originalTrack', 'originalBottom',
    'fontSize', 'originalBottomValue', 'fontSizeValue', 'externalList',
    'syncBox', 'syncTrack', 'offsetSeconds', 'timeScalePercent', 'activate', 'restartSearch', 'subtitleFile',
    'deepseekKey', 'deepseekModel', 'saveDeepseekKey', 'clearDeepseekKey', 'aiKeyState',
    'youtubeSubtitles', 'youtubeSubtitleStatus', 'createYoutubeSubtitles',
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
    tabs: { query: async () => [{ id: 77, url: 'https://video.example/episode-1', title: 'Example S01E01' }] },
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
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false } };
        throw new Error(`Unexpected startup write: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?startup-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(messages.map((message) => message.type).sort(), [
    'dualCaptions.ai.get',
    'dualCaptions.player.get',
    'dualCaptions.state.get',
  ]);
  assert.equal(messages.find((message) => message.type === 'dualCaptions.state.get').pageKey, 'https://video.example/episode-1');
  assert.equal(document.elements.controls.hidden, true);
  assert.equal(document.elements.status.textContent, 'Нажмите «Подключить к плееру» на странице с видео.');
});

test('restart search repeats player discovery and restores the selected player', async () => {
  const document = makeDocument();
  const messages = [];
  const player = { frameId: 12, key: 'player-12', title: 'Reloaded player', tracks: [] };
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 77, url: 'https://video.example/episode-1' }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') return { ok: true, data: { state: {} } };
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [player] } };
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false } };
        if (message.type === 'dualCaptions.player.discover') return { ok: true, data: { players: [player] } };
        if (message.type === 'dualCaptions.player.select') return { ok: true, data: { state: {} } };
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?restart-search-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  messages.length = 0;

  assert.equal(document.elements.restartSearch.hidden, false);
  document.elements.restartSearch.listeners.get('click')();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(messages.map((message) => message.type), [
    'dualCaptions.player.discover',
    'dualCaptions.player.select',
  ]);
  assert.equal(document.elements.status.textContent, 'Поиск субтитров перезапущен. Найдено плееров: 1.');
});

test('saving a key immediately after choosing Pro keeps the chosen model', async () => {
  const document = makeDocument();
  const messages = [];
  let releaseModelPatch;
  const modelPatch = new Promise((resolve) => { releaseModelPatch = resolve; });
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 77, url: 'https://video.example/episode-1' }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') return { ok: true, data: { state: {} } };
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [] } };
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false, model: 'deepseek-v4-flash' } };
        if (message.type === 'dualCaptions.ai.patch' && !('apiKey' in message)) {
          await modelPatch;
          return { ok: true, data: { hasApiKey: false, model: 'deepseek-v4-pro' } };
        }
        if (message.type === 'dualCaptions.ai.patch') return { ok: true, data: { hasApiKey: true, model: message.model } };
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?ai-model-race-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.elements.deepseekModel.value = 'deepseek-v4-pro';
  document.elements.deepseekModel.listeners.get('change')();
  document.elements.deepseekKey.value = 'secret-key';
  document.elements.saveDeepseekKey.listeners.get('click')();

  const keyPatch = messages.find((message) => message.type === 'dualCaptions.ai.patch' && 'apiKey' in message);
  assert.equal(keyPatch.model, 'deepseek-v4-pro');
  releaseModelPatch();
});

test('YouTube startup downloads ready Chinese subtitles without starting recognition', async () => {
  const document = makeDocument();
  const messages = [];
  const player = {
    frameId: 0,
    key: 'youtube-player',
    title: 'YouTube',
    tracks: [],
  };
  const localTrack = {
    id: 'youtube-rwnyaH6cTDE-youtube',
    name: 'YouTube rwnyaH6cTDE youtube Chinese',
    language: 'zh',
    sourceType: 'local-server',
    cues: [{ start: 0, end: 1, text: '你好' }],
    offsetSeconds: 0,
    timeScale: 1,
  };
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 88, url: 'https://www.youtube.com/watch?v=rwnyaH6cTDE' }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') return { ok: true, data: { state: {} } };
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [player] } };
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false } };
        if (message.type === 'dualCaptions.localSubtitle.status') return { ok: true, data: { status: 'missing' } };
        if (message.type === 'dualCaptions.localSubtitle.existing') {
          return {
            ok: true,
            data: {
              status: 'ready',
              source: 'youtube',
              srt: '1\n00:00:00,000 --> 00:00:01,000\n你好\n',
            },
          };
        }
        if (message.type === 'dualCaptions.track.upsertLocal') {
          assert.deepEqual(message.track, localTrack);
          return { ok: true, data: { state: { settings: {}, externalTracks: [localTrack] } } };
        }
        if (message.type === 'dualCaptions.state.patch') {
          assert.deepEqual(message.patch, { secondTrackId: 'external:youtube-rwnyaH6cTDE-youtube' });
          return {
            ok: true,
            data: {
              state: {
                settings: { secondTrackId: message.patch.secondTrackId },
                externalTracks: [localTrack],
              },
            },
          };
        }
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?youtube-existing-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(document.elements.youtubeSubtitles.hidden, false);
  assert.match(document.elements.youtubeSubtitleStatus.textContent, /подключены/i);
  assert.equal(messages.some((message) => message.type === 'dualCaptions.localSubtitle.generate'), false);
  assert.deepEqual(messages.filter((message) => message.type.startsWith('dualCaptions.localSubtitle')).map((message) => message.type), [
    'dualCaptions.localSubtitle.status',
    'dualCaptions.localSubtitle.existing',
  ]);
});

test('YouTube recognition starts only after the create button is clicked', async () => {
  const document = makeDocument();
  const messages = [];
  const track = {
    id: 'youtube-rwnyaH6cTDE-generated',
    name: 'YouTube rwnyaH6cTDE generated Chinese',
    language: 'zh',
    sourceType: 'local-server',
    cues: [{ start: 0, end: 1, text: '自己' }],
    offsetSeconds: 0,
    timeScale: 1,
  };
  globalThis.document = document;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 89, url: 'https://youtu.be/rwnyaH6cTDE' }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'dualCaptions.state.get') {
          return {
            ok: true,
            data: { state: { settings: { secondTrackId: 'external:youtube-rwnyaH6cTDE-youtube' } } },
          };
        }
        if (message.type === 'dualCaptions.player.get') return { ok: true, data: { players: [] } };
        if (message.type === 'dualCaptions.ai.get') return { ok: true, data: { hasApiKey: false } };
        if (message.type === 'dualCaptions.localSubtitle.status') return { ok: true, data: { status: 'missing' } };
        if (message.type === 'dualCaptions.localSubtitle.existing') return { ok: true, data: { status: 'missing' } };
        if (message.type === 'dualCaptions.localSubtitle.generate') {
          return {
            ok: true,
            data: {
              status: 'ready', source: 'generated',
              srt: '1\n00:00:00,000 --> 00:00:01,000\n自己\n',
            },
          };
        }
        if (message.type === 'dualCaptions.track.upsertLocal') {
          assert.deepEqual(message.track, track);
          return {
            ok: true,
            data: {
              state: {
                settings: { secondTrackId: 'external:youtube-rwnyaH6cTDE-youtube' },
                externalTracks: [track],
              },
            },
          };
        }
        if (message.type === 'dualCaptions.state.patch') {
          return {
            ok: true,
            data: {
              state: {
                settings: { secondTrackId: message.patch.secondTrackId },
                externalTracks: [track],
              },
            },
          };
        }
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
    permissions: { request: async () => true },
  };

  await import(`../popup.js?youtube-generate-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.some((message) => message.type === 'dualCaptions.localSubtitle.generate'), false);

  document.elements.createYoutubeSubtitles.listeners.get('click')();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(messages.filter((message) => message.type === 'dualCaptions.localSubtitle.generate').length, 1);
  assert.equal(
    messages.find((message) => message.type === 'dualCaptions.state.patch')?.patch.secondTrackId,
    'external:youtube-rwnyaH6cTDE-generated',
  );
  assert.match(document.elements.youtubeSubtitleStatus.textContent, /подключены/i);
  assert.equal(document.elements.createYoutubeSubtitles.textContent, 'Создать заново');
});
