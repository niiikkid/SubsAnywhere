import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

class FakeElement extends FakeTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.isConnected = false;
    this.textContent = '';
    this.id = '';
    this.className = '';
    this.parentElement = null;
  }
  setAttribute() {}
  append(...children) {
    for (const child of children) {
      if (child.parentElement) {
        child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
      }
      child.isConnected = true;
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) {
      child.parentElement = null;
      child.isConnected = false;
    }
    this.children = [];
    this.append(...children);
  }
  getBoundingClientRect() {
    const width = this.className === 'subs-anywhere-original' ? 200 : 800;
    const height = this.className === 'subs-anywhere-original' ? 60 : 450;
    return { left: 10, top: 20, right: 10 + width, bottom: 20 + height, width, height };
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
    }
    this.parentElement = null;
    this.isConnected = false;
  }
}

class FakeChromeEvent {
  constructor() { this.listeners = new Set(); }
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
}

function fakeVideo(width = 800, height = 450) {
  const video = new FakeTarget();
  const track = Object.assign(new FakeTarget(), {
    kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled',
    activeCues: [{ text: 'Built in' }],
    cues: [
      { startTime: 1, endTime: 2, text: 'Built in' },
      { startTime: 3, endTime: 4, text: 'Another line' },
      { startTime: 5, endTime: 6, text: 'Third line' },
    ],
  });
  video.readyState = 1;
  video.clientWidth = width;
  video.currentTime = 1.5;
  video.matches = (selector) => selector === 'video';
  video.getBoundingClientRect = () => ({ width, height, left: 10, top: 20 });
  video.textTracks = Object.assign(new FakeTarget(), {
    0: track,
    length: 1,
    [Symbol.iterator]: function* iterator() { yield this[0]; },
  });
  return video;
}

async function makeHarness() {
  const runtimeSource = await fs.readFile(new URL('../content-runtime.js', import.meta.url), 'utf8');
  const contentSource = await fs.readFile(new URL('../content.js', import.meta.url), 'utf8');
  const document = Object.assign(new FakeTarget(), {
    title: 'Fixture player',
    videos: [fakeVideo()],
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => Object.assign(new FakeElement('#text'), { textContent: text }),
    querySelectorAll(selector) { return selector === 'video' ? this.videos : []; },
  });
  document.documentElement.isConnected = true;
  const reports = [];
  const scheduled = [];
  const onMessage = new FakeChromeEvent();
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const sandbox = new FakeTarget();
  Object.assign(sandbox, {
    console,
    setTimeout(callback) { scheduled.push(callback); return scheduled.length; },
    clearTimeout,
    crypto: { randomUUID: () => 'fixture-cache-uuid' },
    TextEncoder,
    URL,
    document,
    location: { href: 'https://player.example/embed?token=temporary' },
    MutationObserver: FakeMutationObserver,
    chrome: {
      runtime: {
        onMessage,
        sendMessage(message) { reports.push(structuredClone(message)); return Promise.resolve({ ok: true }); },
      },
    },
  });
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  return { context, runtimeSource, contentSource, document, reports, onMessage, observers, scheduled };
}

test('inline translations toggle reuses cached glossary for English and pinyin', async () => {
  for (const chinese of [false, true]) {
    const harness = await makeHarness();
    const source = chinese ? 'nǐ hǎo, shì jiè' : 'Hello, world';
    const item = { start: 0, end: source.length, dictionary: 'Привет, мир', isSentenceTranslation: true,
      glossary: chinese ? [{ pinyin: 'nǐ hǎo', translation: 'здравствуйте, приветствую вас' }]
        : [{ text: 'Hello', translation: 'здравствуйте, приветствую вас' }] };
    let requests = 0;
    harness.context.chrome.runtime.sendMessage = async (message) => {
      if (message.type !== 'dualCaptions.caption.translate') return { ok: true };
      requests += 1;
      return { ok: true, data: { items: [item] } };
    };
    vm.runInContext(harness.runtimeSource, harness.context);
    vm.runInContext(harness.contentSource, harness.context);
    const listener = [...harness.onMessage.listeners][0];
    const settings = { secondTrackId: 'external:mine', inlineTranslations: true };
    listener({ type: 'dualCaptions.content.fullState', settings,
      externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: chinese ? `\u2063${source}\n\u2064你好，世界` : source }] }],
    }, {}, () => {});
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
    const caption = overlay.children[0];
    const target = chinese ? caption.children[0] : caption;
    const sentenceTranslation = target.children[0];
    const cells = target.children[1];
    assert.equal(sentenceTranslation.className, 'dual-captions-sentence-translation');
    assert.equal(sentenceTranslation.textContent, 'Привет, мир');
    assert.match(sentenceTranslation.style.cssText, /text-align:center/);
    assert.match(sentenceTranslation.style.cssText, /font-size:\.58em/);
    assert.equal(cells.className, 'dual-captions-inline');
    assert.equal(cells.children[0].children[0].textContent, item.glossary[0].translation);
    assert.match(cells.children[0].children[0].style.cssText, /font-size:\.4em/);
    assert.match(cells.children[0].children[0].style.cssText, /white-space:nowrap/);
    assert.match(cells.children[0].children[0].style.cssText, /text-overflow:ellipsis/);
    assert.equal(cells.children[0].children[0].title, '');
    assert.equal(cells.children[0].children[1].textContent, chinese ? 'nǐ hǎo,' : 'Hello,');

    cells.children[0].children[0].dispatch('mouseenter');
    const hoverTranslation = overlay.children.at(-1);
    assert.equal(hoverTranslation.className, 'dual-captions-meaning-preview');
    assert.equal(hoverTranslation.textContent, item.glossary[0].translation);
    cells.children[0].children[0].dispatch('mouseleave');
    assert.equal(overlay.children.includes(hoverTranslation), false);

    if (chinese) assert.equal(caption.children[1].textContent, '你好，世界');
    cells.children[0].dispatch('click', { stopPropagation() {} });
    assert.equal(overlay.children.length, 3);
    listener({ type: 'dualCaptions.content.settings', settings: { ...settings, inlineTranslations: false } }, {}, () => {});
    assert.notEqual(caption.children[0].className, 'dual-captions-inline');
    assert.equal(requests, 1);
  }
});

test('inline cell saves only its own translation, highlights repeats and refreshes learned words', async () => {
  const harness = await makeHarness();
  const source = 'nǐ hǎo, nǐ hǎo, shì jiè';
  const word = { language: 'zh', text: '你好', pinyin: 'nǐ hǎo', translation: 'здравствуйте, приветствую вас' };
  let words = [];
  let rejectSave = true;
  let translateCalls = 0;
  let saves = 0;
  let releaseList;
  let firstList = true;
  harness.context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === 'dualCaptions.words.list') {
      if (firstList) {
        firstList = false;
        return new Promise((resolve) => { releaseList = resolve; });
      }
      return { ok: true, data: { words } };
    }
    if (message.type === 'dualCaptions.words.save') {
      saves += 1;
      assert.deepEqual(JSON.parse(JSON.stringify(message.word)), word);
      if (rejectSave) return { ok: false, error: 'Запустите сервер Docker' };
      words = [{ ...word, id: 1, learned: false }];
      return { ok: true, data: { word: words[0] } };
    }
    if (message.type !== 'dualCaptions.caption.translate') return { ok: true };
    translateCalls += 1;
    return { ok: true, data: { items: [{ start: 0, end: source.length,
      dictionary: 'Полный перевод всей реплики', isSentenceTranslation: true,
      glossary: [0, source.indexOf(word.pinyin, word.pinyin.length)].map((start) => ({
        text: word.text, pinyin: word.pinyin, translation: word.translation,
        pinyinStart: start, pinyinEnd: start + word.pinyin.length,
      })) }] } };
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  const settings = { secondTrackId: 'external:mine', inlineTranslations: true };
  listener({ type: 'dualCaptions.content.fullState', settings,
    externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: `\u2063${source}\n\u2064你好，你好，世界` }] }],
  }, {}, () => {});
  const flush = async () => { for (let index = 0; index < 15; index += 1) await Promise.resolve(); };
  await flush();
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const cells = () => overlay.children[0].children[0].children[1].children;
  const click = (element) => element.dispatch('click', { stopPropagation() {} });
  const allText = (element) => [element.textContent, ...element.children.map(allText)].join(' ');
  click(cells()[0]);
  let tooltip = overlay.children.at(-1);
  assert.match(allText(tooltip), /здравствуйте, приветствую вас/);
  assert.doesNotMatch(allText(tooltip), /Полный перевод всей реплики|Слова|Фразы/);
  const save = tooltip.children.find((child) => child.className === 'dual-captions-save-word');
  click(save);
  await flush();
  assert.match(allText(tooltip), /Docker/);
  assert.equal(cells()[0].style.backgroundColor, '');
  assert.equal(save.disabled, false);
  rejectSave = false;
  click(save);
  click(save);
  await flush();
  assert.equal(saves, 2, 'Double click must not send two writes');
  assert.equal(save.textContent, '✓ Сохранено');
  releaseList({ ok: true, data: { words: [] } });
  await flush();
  for (const cell of cells().slice(0, 2)) {
    assert.equal(cell.style.backgroundColor, 'rgba(80, 170, 115, .18)');
    cell.dispatch('focus'); cell.dispatch('blur');
    assert.equal(cell.style.backgroundColor, 'rgba(80, 170, 115, .18)');
  }
  words = [{ ...word, id: 1, learned: true }];
  harness.context.dispatch('focus');
  await flush();
  for (const cell of cells().slice(0, 2)) {
    assert.equal(cell.style.backgroundColor, 'rgba(74, 176, 184, .16)');
    assert.equal(cell.style.borderColor, 'rgba(112, 202, 207, .4)');
  }
  click(cells()[2]);
  tooltip = overlay.children.at(-1);
  assert.match(allText(tooltip), /Перевод этой ячейки пока отсутствует/);
  assert.doesNotMatch(allText(tooltip), /Полный перевод всей реплики/);
  assert.equal(tooltip.children.find((child) => child.className === 'dual-captions-save-word').disabled, true);
  listener({ type: 'dualCaptions.content.settings', settings: { ...settings, inlineTranslations: false } }, {}, () => {});
  listener({ type: 'dualCaptions.content.settings', settings }, {}, () => {});
  assert.equal(cells()[0].style.backgroundColor, 'rgba(74, 176, 184, .16)');
  words = [];
  harness.context.dispatch('focus');
  await flush();
  assert.equal(cells()[0].style.backgroundColor, '');
  assert.equal(translateCalls, 1, 'Saving and refreshing must never request another AI translation');
});

test('a full Chinese sentence saves beside the Han line and marks the saved Han softly green', async () => {
  const harness = await makeHarness();
  const sentence = {
    language: 'zh', text: '我已经吃过饭了。', pinyin: 'wǒ yǐjīng chī guò fàn le.', translation: 'Я уже поел.',
  };
  let sentences = [];
  let saves = 0;
  harness.context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === 'dualCaptions.sentences.list') return { ok: true, data: { sentences } };
    if (message.type === 'dualCaptions.sentences.save') {
      saves += 1;
      assert.deepEqual(JSON.parse(JSON.stringify(message.sentence)), sentence);
      sentences = [{ ...sentence, id: 7, learned: false, explanation: '' }];
      return { ok: true, data: { sentence: sentences[0] } };
    }
    if (message.type === 'dualCaptions.words.list') return { ok: true, data: { words: [] } };
    if (message.type === 'dualCaptions.caption.translate') return { ok: true, data: { items: [{
      start: 0, end: sentence.pinyin.length, dictionary: sentence.translation, isSentenceTranslation: true, glossary: [],
    }] } };
    return { ok: true };
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  [...harness.onMessage.listeners][0]({ type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'external:mine', inlineTranslations: false },
    externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: `\u2063${sentence.pinyin}\n\u2064${sentence.text}` }] }],
  }, {}, () => {});
  for (let index = 0; index < 15; index += 1) await Promise.resolve();
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const findClass = (node, className) => node.className === className ? node
    : node.children.map((child) => findClass(child, className)).find(Boolean);
  const button = findClass(overlay, 'dual-captions-save-sentence');
  const characters = findClass(overlay, 'dual-captions-sentence-characters');
  assert.ok(button);
  assert.equal(button.textContent, 'Сохранить предложение');
  assert.equal(characters.textContent, sentence.text);
  button.dispatch('click', { stopPropagation() {} });
  button.dispatch('click', { stopPropagation() {} });
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  assert.equal(saves, 1);
  assert.equal(button.textContent, '✓ Предложение сохранено');
  assert.equal(characters.style.color, 'rgba(151, 213, 169, .88)');
});

test('a Han-only Chinese caption receives pinyin before its translation is saved for review', async () => {
  const harness = await makeHarness();
  const sentence = {
    language: 'zh', text: '你好，世界', pinyin: 'nǐ hǎo, shì jiè', translation: 'Привет, мир',
  };
  const translations = [];
  let saved;
  harness.context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === 'dualCaptions.words.list') return { ok: true, data: { words: [] } };
    if (message.type === 'dualCaptions.sentences.list') return { ok: true, data: { sentences: saved ? [{ ...saved, id: 8, learned: false, explanation: '' }] : [] } };
    if (message.type === 'dualCaptions.caption.translate') {
      translations.push({ text: message.text, displayText: message.displayText, language: message.language });
      return { ok: true, data: { items: [{
        start: 0, end: sentence.pinyin.length, text: sentence.pinyin, dictionary: sentence.translation,
        context: sentence.translation, isSentenceTranslation: true,
        glossary: [{ text: '你好', pinyin: 'nǐ hǎo', translation: 'привет', pinyinStart: 0, pinyinEnd: 6 }],
      }] } };
    }
    if (message.type === 'dualCaptions.sentences.save') {
      saved = JSON.parse(JSON.stringify(message.sentence));
      return { ok: true, data: { sentence: { ...saved, id: 8, learned: false, explanation: '' } } };
    }
    return { ok: true };
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  [...harness.onMessage.listeners][0]({ type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'external:mine', inlineTranslations: false },
    externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: sentence.text }] }],
  }, {}, () => {});
  for (let index = 0; index < 15; index += 1) await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const findClass = (node, className) => node.className === className ? node
    : node.children.map((child) => findClass(child, className)).find(Boolean);
  const button = findClass(overlay, 'dual-captions-save-sentence');
  assert.deepEqual(translations, [{ text: sentence.text, displayText: '', language: 'zh' }]);
  assert.equal(overlay.children[0].children[0].children.map((child) => child.textContent).join(''), sentence.pinyin);
  assert.equal(findClass(overlay, 'dual-captions-sentence-characters').textContent, sentence.text);
  button.dispatch('click', { stopPropagation() {} });
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  assert.deepEqual(saved, sentence);
});

test('a Chinese translation replaces broken displayed pinyin before sentence review saves it', async () => {
  const harness = await makeHarness();
  const sourcePinyin = 'ni hao shi jie';
  const sentence = {
    language: 'zh', text: '你好，世界', pinyin: 'nǐ hǎo, shì jiè', translation: 'Привет, мир',
  };
  const translations = [];
  let saved;
  harness.context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === 'dualCaptions.words.list') return { ok: true, data: { words: [] } };
    if (message.type === 'dualCaptions.sentences.list') return { ok: true, data: { sentences: [] } };
    if (message.type === 'dualCaptions.caption.translate') {
      translations.push({ text: message.text, displayText: message.displayText, language: message.language });
      return { ok: true, data: { items: [{
        start: 0, end: sentence.pinyin.length, text: sentence.pinyin, dictionary: sentence.translation,
        context: sentence.translation, isSentenceTranslation: true, glossary: [],
      }] } };
    }
    if (message.type === 'dualCaptions.sentences.save') {
      saved = JSON.parse(JSON.stringify(message.sentence));
      return { ok: true, data: { sentence: { ...saved, id: 9, learned: false, explanation: '' } } };
    }
    return { ok: true };
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  [...harness.onMessage.listeners][0]({ type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'external:mine', inlineTranslations: false },
    externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: `\u2063${sourcePinyin}\n\u2064${sentence.text}` }] }],
  }, {}, () => {});
  for (let index = 0; index < 15; index += 1) await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const findClass = (node, className) => node.className === className ? node
    : node.children.map((child) => findClass(child, className)).find(Boolean);
  assert.deepEqual(translations, [{ text: sentence.text, displayText: sourcePinyin, language: 'zh' }]);
  assert.equal(overlay.children[0].children[0].children.map((child) => child.textContent).join(''), sentence.pinyin);
  findClass(overlay, 'dual-captions-save-sentence').dispatch('click', { stopPropagation() {} });
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  assert.deepEqual(saved, sentence);
});

test('Chinese glossary without mapped Han still shows cell translation but cannot save guessed characters', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = async (message) => {
    if (message.type !== 'dualCaptions.caption.translate') return { ok: true, data: { words: [] } };
    return { ok: true, data: { items: [{ start: 0, end: 6, dictionary: 'Вся фраза',
      isSentenceTranslation: true, glossary: [{ pinyin: 'nǐ hǎo', translation: 'привет' }] }] } };
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  [...harness.onMessage.listeners][0]({ type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'external:mine', inlineTranslations: true },
    externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: '\u2063nǐ hǎo\n\u2064你好' }] }],
  }, {}, () => {});
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  overlay.children[0].children[0].children[1].children[0].dispatch('click', { stopPropagation() {} });
  const tooltip = overlay.children.at(-1);
  assert.equal(tooltip.children[1].children[1].textContent, 'привет');
  assert.equal(tooltip.children.find((child) => child.className === 'dual-captions-save-word').disabled, true);
});

test('inline pinyin cells hide grammatical meanings for untoned de, le, zhe and la', async () => {
  for (const particle of ['de', 'le', 'zhe', 'la']) {
    const harness = await makeHarness();
    harness.context.chrome.runtime.sendMessage = async (message) => ({ ok: true, data: { items: [{
      start: 0, end: message.displayText.length, dictionary: 'Учебный пример', isSentenceTranslation: true,
      glossary: [{ pinyin: particle, translation: 'грамматическая частица' }],
    }] } });
    vm.runInContext(harness.runtimeSource, harness.context);
    vm.runInContext(harness.contentSource, harness.context);
    [...harness.onMessage.listeners][0]({ type: 'dualCaptions.content.fullState',
      settings: { secondTrackId: 'external:mine', inlineTranslations: true },
      externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: `\u2063wǒ ${particle} shū\n\u2064示例` }] }],
    }, {}, () => {});
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
    const cells = overlay.children[0].children[0].children[1];
    const particleCell = cells.children.find((cell) => cell.children.at(-1)?.textContent === particle);
    assert.ok(particleCell);
    assert.equal(particleCell.children[0].textContent, '');
    assert.match(particleCell.children[0].style.cssText, /display:none/);
    assert.equal(particleCell.children.at(-1).textContent, particle);
  }
});

test('inline pinyin meanings grow only by the length-based cell allowance', async () => {
  const harness = await makeHarness();
  harness.document.createRange = () => {
    let node;
    return {
      selectNodeContents(value) { node = value; },
      getBoundingClientRect() {
        const letters = [...String(node?.textContent ?? '').normalize('NFD')]
          .filter((character) => /\p{L}/u.test(character)).length;
        return { width: letters * 10 };
      },
    };
  };
  const glossary = [
    { pinyin: 'ma', translation: 'перевод для двух букв' },
    { pinyin: 'hǎo', translation: 'перевод для трёх букв' },
    { pinyin: 'zhen', translation: 'перевод для четырёх букв' },
    { pinyin: 'pengyou', translation: 'перевод для длинного слова' },
  ];
  harness.context.chrome.runtime.sendMessage = async (message) => ({ ok: true, data: { items: [{
    start: 0, end: message.displayText.length, dictionary: 'Учебный пример', isSentenceTranslation: true, glossary,
  }] } });
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  [...harness.onMessage.listeners][0]({ type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'external:mine', inlineTranslations: true },
    externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: '\u2063ma hǎo zhen pengyou\n\u2064示例' }] }],
  }, {}, () => {});
  for (let index = 0; index < 8; index += 1) await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const cells = overlay.children[0].children[0].children[1].children;
  const limits = Object.fromEntries(cells.map((cell) => [cell.children.at(-1)?.textContent, cell.children[0]?.style.maxWidth]));
  assert.deepEqual(limits, { ma: '60px', hǎo: '60px', zhen: '52px', pengyou: '81px' });
});

test('empty cues and track switches hide the caption background in either display mode', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  const video = harness.document.videos[0];
  for (const inlineTranslations of [false, true, false]) {
    const settings = { secondTrackId: 'external:mine', subtitleBackground: true, inlineTranslations };
    video.currentTime = 1.5;
    listener({ type: 'dualCaptions.content.fullState', settings,
      externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: 'Hello' }] }],
    }, {}, () => {});
    const caption = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay').children[0];
    assert.equal(caption.style.display, 'block');
    video.currentTime = 10;
    video.dispatch('timeupdate');
    assert.equal(caption.style.display, 'none', 'A cue gap must not paint a padded black strip');
    listener({ type: 'dualCaptions.content.settings', settings: { ...settings, secondTrackId: '' } }, {}, () => {});
    assert.equal(caption.style.display, 'none');
  }
});

test('inline wrapping keeps quotation marks attached and preserves explicit source line breaks', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = async (message) => ({ ok: true, data: { items: [{
    start: 0, end: message.displayText?.length ?? 0, dictionary: 'Пример',
    glossary: [{ text: 'Hello', translation: 'привет' }, { text: 'world', translation: 'мир' }],
  }] } });
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  [...harness.onMessage.listeners][0]({ type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'external:mine', inlineTranslations: true },
    externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: 'He said "Hello",\n(«world»)!' }] }],
  }, {}, () => {});
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  const caption = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay').children[0];
  const cells = caption.children[0].children;
  assert.deepEqual(cells.map((cell) => cell.children[1]?.textContent ?? cell.textContent), ['He', 'said', '"Hello",', '\n', '(«world»)!']);
});

test('dragging a clamped caption starts from its visible position rather than its saved anchor', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  [...harness.onMessage.listeners][0]({ type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'external:mine', secondLeft: 96, secondBottom: 95 },
    externalTracks: [{ id: 'mine', cues: [{ start: 1, end: 2, text: 'Hello' }] }],
  }, {}, () => {});
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const [caption, handle] = overlay.children;
  const visible = { left: 602, top: 28, right: 802, bottom: 88, width: 200, height: 60 };
  caption.getBoundingClientRect = () => visible;
  const event = { button: 0, pointerId: 1, clientX: 795, clientY: 23, preventDefault() {}, stopPropagation() {} };
  handle.dispatch('pointerdown', event);
  handle.dispatch('pointerup', { ...event, clientX: event.clientX - 20, clientY: event.clientY + 20 });
  const saved = harness.reports.findLast((message) => message.type === 'dualCaptions.content.positionPatch');
  const root = overlay.getBoundingClientRect();
  assert.equal(saved.secondLeft, ((visible.left - root.left + visible.width / 2) / root.width) * 100 - (20 / root.width) * 100);
  assert.equal(saved.secondBottom, ((root.bottom - visible.bottom) / root.height) * 100 - (20 / root.height) * 100);
});

test('production bootstrap re-reports after reinjection without duplicate controller listeners', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const firstListenerCount = harness.document.videos[0].listenerCount();

  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);

  assert.equal(harness.reports.filter((message) => message.type === 'dualCaptions.player.report').length, 2);
  assert.equal(harness.onMessage.listeners.size, 1);
  assert.equal(harness.document.videos[0].listenerCount(), firstListenerCount);
});

test('worker recovery replies only after the current player report is acknowledged', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  let acknowledge;
  harness.context.chrome.runtime.sendMessage = (message) => {
    harness.reports.push(structuredClone(message));
    return new Promise((resolve) => { acknowledge = resolve; });
  };
  const replies = [];
  const keepChannelOpen = listener({ type: 'dualCaptions.player.discover' }, {}, (response) => replies.push(response));
  assert.equal(keepChannelOpen, true);
  assert.equal(harness.reports.at(-1).type, 'dualCaptions.player.report');
  assert.equal(harness.reports.at(-1).player.videoIndex, 0);
  assert.equal(harness.reports.at(-1).player.frameUrl, harness.context.location.href);
  assert.equal(replies.length, 0);
  acknowledge({ ok: true });
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, true);
  assert.equal(harness.onMessage.listeners.size, 1);
});

test('production content message renders only the selected original track safely', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: {
      secondTrackId: 'external:mine', secondBottom: 8, fontSize: 24, selectedPlayerKey: '',
    },
    externalTracks: [{ id: 'mine', name: 'Mine', offsetSeconds: 0, cues: [{ start: 1, end: 2, text: '<b>Imported</b>' }] }],
  }, {}, () => {});

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.ok(overlay);
  assert.equal(overlay.children.length, 2);
  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'Imported');
  assert.equal(overlay.children[0].style.bottom, '36px');
  assert.equal(overlay.children[0].style.left, '400px');
  assert.equal(overlay.children[1].textContent, '⠿');
});

test('production makes pinyin the primary clickable line and keeps its characters linked', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'external:chinese', secondBottom: 8, fontSize: 24 },
    externalTracks: [{
      id: 'chinese',
      name: 'Chinese',
      offsetSeconds: 0,
      cues: [{ start: 1, end: 2, text: '\u2063nǐ hǎo, shì jiè\n\u2064你好，世界' }],
    }],
  }, {}, () => {});
  await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const caption = overlay.children[0];
  assert.equal(caption.children[0].children.map((child) => child.textContent).join(''), 'nǐ hǎo, shì jiè');
  assert.equal(caption.children[1].textContent, '你好，世界');
  assert.match(caption.children[1].style.cssText, /opacity:\.68/);
  assert.deepEqual(
    harness.reports.filter((message) => message.type === 'dualCaptions.caption.translate').map((message) => ({
      text: message.text,
      displayText: message.displayText,
      language: message.language,
    })),
    [{ text: '你好，世界', displayText: 'nǐ hǎo, shì jiè', language: 'zh' }],
  );
});

test('production shows a pinyin-to-Russian glossary with the full Chinese sentence translation', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = (message) => {
    if (message.type === 'dualCaptions.caption.translate') {
      return Promise.resolve({ ok: true, data: {
        items: [{
          start: 0,
          end: 15,
          text: 'nǐ hǎo, shì jiè',
          dictionary: 'Привет, мир',
          context: 'Привет, мир',
          glossary: [
            { pinyin: 'nǐ hǎo', translation: 'здравствуйте' },
            { pinyin: 'shì jiè', translation: 'мир' },
            { pinyin: 'wǒ', translation: 'я' },
            { pinyin: 'men', translation: 'множественное число' },
            { pinyin: 'xué', translation: 'учиться' },
            { pinyin: 'zhōng wén', translation: 'китайский язык' },
            { pinyin: 'hěn', translation: 'очень' },
            { pinyin: 'yǒu', translation: 'есть' },
            { pinyin: 'yì si', translation: 'интересный' },
            { pinyin: 'xiè xie', translation: 'спасибо' },
            { pinyin: 'zài jiàn', translation: 'до свидания' },
            { pinyin: 'míng tiān', translation: 'завтра' },
            { pinyin: 'jiàn', translation: 'увидимся' },
          ],
        }],
      } });
    }
    harness.reports.push(structuredClone(message));
    return Promise.resolve({ ok: true });
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'external:chinese', secondBottom: 8, fontSize: 24 },
    externalTracks: [{
      id: 'chinese',
      name: 'Chinese',
      offsetSeconds: 0,
      cues: [{ start: 1, end: 2, text: '\u2063nǐ hǎo, shì jiè\n\u2064你好，世界' }],
    }],
  }, {}, () => {});
  for (let index = 0; index < 4; index += 1) await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const phrase = overlay.children[0].children[0].children[0];
  phrase.dispatch('click', { stopPropagation() {} });
  const tooltip = overlay.children.at(-1);

  assert.equal(tooltip.children[1].children.map((child) => child.textContent).join(' '), 'Перевод Привет, мир');
  assert.equal(tooltip.children[2].children.map((child) => child.textContent).join(' '), 'Слова nǐ hǎo — здравствуйте shì jiè — мир wǒ — я men — множественное число xué — учиться zhōng wén — китайский язык hěn — очень yǒu — есть yì si — интересный xiè xie — спасибо zài jiàn — до свидания míng tiān — завтра jiàn — увидимся');
});

test('production shows a full English sentence translation with a phrase list', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = (message) => {
    if (message.type === 'dualCaptions.caption.translate') {
      return Promise.resolve({ ok: true, data: {
        items: [{
          start: 0,
          end: 8,
          text: 'Built in',
          dictionary: 'Встроено.',
          context: 'Встроено.',
          glossary: [{ text: 'Built in', translation: 'встроено' }],
          isSentenceTranslation: true,
        }],
      } });
    }
    harness.reports.push(structuredClone(message));
    return Promise.resolve({ ok: true });
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const phrase = overlay.children[0].children[0];
  assert.equal(phrase.textContent, 'Built in');
  const translationLine = overlay.children[0].children[1];
  assert.equal(translationLine.className, 'dual-captions-sentence-translation');
  assert.equal(translationLine.textContent, 'Встроено.');
  assert.match(translationLine.style.cssText, /font-size:\.72em/);
  assert.match(translationLine.style.cssText, /opacity:\.68/);
  phrase.dispatch('click', { stopPropagation() {} });
  assert.equal(
    overlay.children.at(-1).children[1].children.map((child) => child.textContent).join(' '),
    'Перевод Встроено.',
  );
  assert.equal(
    overlay.children.at(-1).children[2].children.map((child) => child.textContent).join(' '),
    'Фразы Built in — встроено',
  );

  phrase.dispatch('click', { stopPropagation() {} });
  assert.equal(overlay.children.length, 2);
});

test('English inline fallback keeps the completed sentence translation out of the caption', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = (message) => {
    if (message.type === 'dualCaptions.caption.translate') return Promise.resolve({ ok: true, data: {
      items: [{
        start: 0, end: 8, text: 'Built in', dictionary: 'Встроено.', context: 'Встроено.',
        glossary: [{ text: 'missing', translation: 'отсутствует' }], isSentenceTranslation: true,
      }],
    } });
    return Promise.resolve({ ok: true });
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  [...harness.onMessage.listeners][0]({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24, inlineTranslations: true },
    externalTracks: [],
  }, {}, () => {});
  for (let index = 0; index < 4; index += 1) await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.equal(overlay.children[0].children.some((child) => child.className === 'dual-captions-sentence-translation'), false);
});

test('production does not queue a second translation while the same caption is in flight', async () => {
  const harness = await makeHarness();
  const pending = [];
  harness.document.videos[0].textTracks[0].activeCues = [{ text: 'Current line' }];
  harness.document.videos[0].textTracks[0].cues = [
    { startTime: 1, endTime: 2, text: 'Current line' },
    { startTime: 5, endTime: 6, text: 'First next' },
    { startTime: 10, endTime: 11, text: 'Second next' },
    { startTime: 15, endTime: 16, text: 'Third next' },
  ];
  harness.context.chrome.runtime.sendMessage = (message) => {
    harness.reports.push(structuredClone(message));
    if (message.type !== 'dualCaptions.caption.translate') return Promise.resolve({ ok: true });
    return new Promise((resolve) => pending.push({ message, resolve }));
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  pending.shift().resolve({ ok: true, data: { items: [] } });
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  harness.scheduled.shift()?.();
  await Promise.resolve();

  harness.document.videos[0].currentTime = 5.5;
  harness.document.videos[0].textTracks[0].activeCues = [{ text: 'First next' }];
  harness.document.videos[0].dispatch('timeupdate');
  pending.shift().resolve({ ok: true, data: { items: [] } });
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  harness.scheduled.shift()?.();
  await Promise.resolve();

  assert.equal(
    harness.reports.filter((message) => (
      message.type === 'dualCaptions.caption.translate' && message.text === 'First next'
    )).length,
    1,
  );
});

test('production makes the original caption clickable while its translation is loading', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = (message) => {
    if (message.type === 'dualCaptions.caption.translate') return new Promise(() => {});
    harness.reports.push(structuredClone(message));
    return Promise.resolve({ ok: true });
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const token = overlay.children[0].children[0];
  assert.equal(token.textContent, 'Built in');
  token.dispatch('click', { stopPropagation() {} });
  assert.equal(
    overlay.children.at(-1).children[1].children.map((child) => child.textContent).join(' '),
    'Обычно Перевод готовится…',
  );
});

test('production shows an OpenAI translation error and retries only after a click', async () => {
  const harness = await makeHarness();
  let requests = 0;
  harness.context.chrome.runtime.sendMessage = (message) => {
    if (message.type !== 'dualCaptions.caption.translate') return Promise.resolve({ ok: true });
    requests += 1;
    return Promise.resolve({ ok: false, error: 'OpenAI временно недоступен (400). Попробуйте позже' });
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  for (let index = 0; index < 5; index += 1) await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const token = overlay.children[0].children[0];
  token.dispatch('click', { stopPropagation() {} });
  assert.equal(overlay.children.at(-1).children[1].children.map((child) => child.textContent).join(' '),
    'Обычно OpenAI временно недоступен (400). Попробуйте позже');
  assert.equal(overlay.children.at(-1).children[2].children.map((child) => child.textContent).join(' '),
    'Здесь Нажмите, чтобы повторить.');
  assert.equal(requests, 1, 'a failed translation is not retried continuously');

  harness.scheduled.shift()?.();
  await Promise.resolve();
  assert.equal(requests, 2, 'a click explicitly retries the failed current caption');
});

test('production keeps the full original caption clickable when AI returns no phrases', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = (message) => {
    if (message.type === 'dualCaptions.caption.translate') return Promise.resolve({ ok: true, data: { items: [] } });
    harness.reports.push(structuredClone(message));
    return Promise.resolve({ ok: true });
  };
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const token = overlay.children[0].children[0];
  assert.equal(token.textContent, 'Built in');
  assert.equal(token.listeners.get('click')?.size, 1);
});

test('production always prepares the selected original second track for translation', async () => {
  const harness = await makeHarness();
  Object.assign(harness.document.videos[0].textTracks[0], {
    label: 'Русский', language: 'ru', activeCues: [{ text: 'A name appears' }],
  });
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();

  assert.equal(harness.reports.some((message) => message.type === 'dualCaptions.caption.translate'), true);
});

test('production saves selected built-in subtitle cues before an audio switch can remove them', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();

  const snapshot = harness.reports.find((message) => message.type === 'dualCaptions.track.cacheBuiltin');
  assert.ok(snapshot);
  assert.equal(snapshot.track.cues[0].text, 'Built in');
  assert.equal(snapshot.track.cues[1].start, 3);
});

test('production uses the saved fallback only after the native track disappears', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  const settings = {
    secondTrackId: 'track-0', secondBottom: 8, fontSize: 24,
    secondTrackCacheId: 'builtin-cache-fixture-cache-uuid',
    secondTrackCacheSource: '\u0000track-0',
  };
  const cached = [{ id: 'builtin-cache-fixture-cache-uuid', sourceType: 'builtin-cache', name: 'Saved', offsetSeconds: 0, timeScale: 1, cues: [{ start: 1, end: 2, text: 'Saved fallback' }] }];

  listener({ type: 'dualCaptions.content.fullState', settings, externalTracks: cached }, {}, () => {});
  let overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'Built in');

  harness.document.videos[0].textTracks[0] = undefined;
  harness.document.videos[0].textTracks.length = 0;
  harness.document.videos[0].textTracks[Symbol.iterator] = function* noTracks() {};
  listener({ type: 'dualCaptions.content.tracks', settings, externalTracks: cached }, {}, () => {});
  overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'Saved fallback');
});

test('production prepares the next three original captions before they appear', async () => {
  const harness = await makeHarness();
  harness.document.videos[0].textTracks[0].activeCues = [{ text: 'Current line' }];
  harness.document.videos[0].textTracks[0].cues = [
    { startTime: 1, endTime: 2, text: 'Current line' },
    { startTime: 5, endTime: 6, text: 'First next' },
    { startTime: 10, endTime: 11, text: 'Second next' },
    { startTime: 15, endTime: 16, text: 'Third next' },
  ];
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    harness.scheduled.shift()?.();
  }

  assert.deepEqual(
    harness.reports.filter((message) => message.type === 'dualCaptions.caption.translate').map((message) => message.text),
    ['Current line', 'First next', 'Second next', 'Third next'],
  );
});

test('production recognizes English metadata used by Russian players', async () => {
  const harness = await makeHarness();
  Object.assign(harness.document.videos[0].textTracks[0], {
    label: 'Английский', language: 'eng', activeCues: [{ text: 'A name appears' }],
  });
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  await Promise.resolve();

  assert.equal(harness.reports.some((message) => message.type === 'dualCaptions.caption.translate'), true);
});

test('production keeps a selected built-in track when the player recreates it during an audio switch', async () => {
  const harness = await makeHarness();
  const video = harness.document.videos[0];
  const originalTrack = video.textTracks[0];
  originalTrack.id = 'subtitle-before-audio-switch';
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  const selectedId = harness.context.DualCaptionsContentRuntime.trackChoices(video.textTracks)[0].id;
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: selectedId, secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');

  const recreatedTrack = Object.assign(new FakeTarget(), {
    id: 'subtitle-after-audio-switch',
    kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled', activeCues: [{ text: 'After switch' }],
  });
  video.textTracks[0] = recreatedTrack;
  video.textTracks.dispatch('removetrack', { track: originalTrack });
  video.textTracks.dispatch('addtrack', { track: recreatedTrack });

  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'After switch');
  assert.equal(originalTrack.mode, 'disabled');
});

test('production restores a built-in track after an audio switch recreates the player context', async () => {
  const harness = await makeHarness();
  const originalTrack = harness.document.videos[0].textTracks[0];
  originalTrack.id = 'subtitle-before-context-reload';
  vm.runInContext(harness.runtimeSource, harness.context);
  const selected = harness.context.DualCaptionsContentRuntime.trackChoices([originalTrack])[0];
  const recreatedVideo = fakeVideo();
  Object.assign(recreatedVideo.textTracks[0], {
    id: 'subtitle-after-context-reload',
    label: 'Original CC',
    language: 'en-US',
    activeCues: [{ text: 'After context reload' }],
  });
  harness.document.videos = [recreatedVideo];
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];

  listener({
    type: 'dualCaptions.content.fullState',
    settings: {
      secondTrackId: selected.id,
      secondTrackFallbackId: selected.fallbackId,
      secondBottom: 8,
      fontSize: 24,
    },
    externalTracks: [],
  }, {}, () => {});

  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.equal(overlay.children[0].children.map((child) => child.textContent).join(''), 'After context reload');
});

test('production late built-in track report keeps the bound video reference', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const reportsBefore = harness.reports.length;

  harness.document.videos[0].dispatch('loadedmetadata');

  assert.equal(harness.reports.length, reportsBefore + 1);
  assert.equal(harness.reports.at(-1).player.tracks[0].label, 'English');
});

test('production overlay moves inside a fullscreen player container and returns afterwards', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const fullscreenPlayer = new FakeElement('div');
  fullscreenPlayer.contains = (node) => node === harness.document.videos[0];

  harness.document.fullscreenElement = fullscreenPlayer;
  harness.document.dispatch('fullscreenchange');
  assert.equal(overlay.parentElement, fullscreenPlayer);

  harness.document.fullscreenElement = null;
  harness.document.dispatch('fullscreenchange');
  assert.equal(overlay.parentElement, harness.document.documentElement);
});

test('restoring full state does not report the player back in an activation loop', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  const reportCount = harness.reports.filter((message) => message.type === 'dualCaptions.player.report').length;

  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0' },
    externalTracks: [],
  }, {}, () => {});

  assert.equal(harness.reports.filter((message) => message.type === 'dualCaptions.player.report').length, reportCount);
});

test('production overlay text changes do not trigger a discovery-report loop', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  const reportCount = harness.reports.length;

  harness.observers[0].callback([{
    target: overlay,
    addedNodes: [overlay.children[0]],
    removedNodes: [],
  }]);

  assert.equal(harness.reports.length, reportCount);
});

test('production mutation discovery detaches listeners from a replaced video', async () => {
  const harness = await makeHarness();
  const first = harness.document.videos[0];
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const second = fakeVideo(900, 500);
  harness.document.videos = [second];

  harness.observers[0].callback([{
    target: harness.document.documentElement,
    addedNodes: [second],
    removedNodes: [first],
  }]);

  assert.equal(first.listenerCount(), 0);
  assert.ok(second.listenerCount() > 0);
});


test('reset and destroy stop queued translation work and late responses cannot revive the overlay', async () => {
  for (const action of ['reset', 'destroy']) {
    const harness = await makeHarness();
    let finishTranslation;
    harness.context.chrome.runtime.sendMessage = (message) => {
      harness.reports.push(structuredClone(message));
      if (message.type === 'dualCaptions.caption.translate') return new Promise((resolve) => { finishTranslation = resolve; });
      return Promise.resolve({ ok: true });
    };
    vm.runInContext(harness.runtimeSource, harness.context);
    vm.runInContext(harness.contentSource, harness.context);
    const controller = harness.context.__dualCaptionsControllerV3;
    controller.handle({ type: 'dualCaptions.content.fullState', settings: { secondTrackId: 'track-0' }, externalTracks: [] });
    if (action === 'reset') controller.handle({ type: 'dualCaptions.content.reset' });
    else controller.destroy();
    finishTranslation({ ok: true, data: { items: [] } });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    for (const scheduled of harness.scheduled.splice(0)) scheduled();
    assert.equal(harness.reports.filter((message) => message.type === 'dualCaptions.caption.translate').length, 1, action);
    const overlays = harness.document.documentElement.children.filter((child) => child.id === 'dual-captions-overlay');
    if (action === 'destroy') assert.equal(overlays.length, 0);
    else assert.equal(overlays[0].style.display, 'none');
  }
});

test('extension invalidation does not throw from discovery or late metadata listeners', async () => {
  const harness = await makeHarness();
  harness.context.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
  vm.runInContext(harness.runtimeSource, harness.context);
  assert.doesNotThrow(() => vm.runInContext(harness.contentSource, harness.context));
  assert.doesNotThrow(() => harness.document.videos[0].dispatch('loadedmetadata'));
});

test('production reset clears page subtitles and restores native track mode', async () => {
  const harness = await makeHarness();
  vm.runInContext(harness.runtimeSource, harness.context);
  vm.runInContext(harness.contentSource, harness.context);
  const listener = [...harness.onMessage.listeners][0];
  const video = harness.document.videos[0];
  listener({
    type: 'dualCaptions.content.fullState',
    settings: { secondTrackId: 'track-0', secondBottom: 8, fontSize: 24 },
    externalTracks: [],
  }, {}, () => {});
  const overlay = harness.document.documentElement.children.find((child) => child.id === 'dual-captions-overlay');
  assert.equal(video.textTracks[0].mode, 'hidden');

  listener({ type: 'dualCaptions.content.reset' }, {}, () => {});

  assert.equal(video.textTracks[0].mode, 'disabled');
  assert.equal(overlay.style.display, 'none');
  assert.equal(overlay.children[0].textContent, '');
});
