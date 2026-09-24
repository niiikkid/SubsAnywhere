import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  studyDeck, nextStudyPosition, previousStudyPosition, studyPositionForWord, removeStudyItem, learningText, pronunciationText, wordsTsv, validAnalysis
} from '../local-server/web/words.js';

const words = [
  { id: 1, text: '你好', learned: false },
  { id: 2, text: 'hello', learned: true },
  { id: 3, text: '谢谢', learned: false },
];

test('study deck contains every word marked for review in its saved order', () => {
  assert.deepEqual(studyDeck(words).map((word) => word.id), [1, 3]);
});

test('study progress reaches completion only after the final card and stays there', () => {
  assert.equal(nextStudyPosition(0, 2), 1);
  assert.equal(nextStudyPosition(1, 2), 2);
  assert.equal(nextStudyPosition(2, 2), 2);
  assert.equal(nextStudyPosition(0, 0), 0);
});

test('study can return to the previous card without moving before the first word', () => {
  assert.equal(previousStudyPosition(2, 3), 1);
  assert.equal(previousStudyPosition(0, 3), 0);
  assert.equal(previousStudyPosition(3, 3), 2);
});

test('saved study word restores its exact unlearned card after a page reload', () => {
  assert.equal(studyPositionForWord(words, 3), 1);
  assert.equal(studyPositionForWord(words, 2), -1);
  assert.equal(studyPositionForWord(words, 999), -1);
});

test('deleting the active study word keeps the round open on the following word', () => {
  assert.deepEqual(removeStudyItem(words, 1, 2), {
    words: [words[0], words[2]],
    position: 1,
  });
});

test('Chinese saved sentences are learned through pinyin instead of Han characters', () => {
  const sentence = { language: 'zh', text: '我已经吃过饭了。', pinyin: 'wǒ yǐjīng chī guò fàn le.' };
  assert.equal(learningText(sentence, 'sentences'), sentence.pinyin);
  assert.equal(learningText(sentence, 'words'), sentence.pinyin);
  assert.equal(learningText({ language: 'en', text: 'I have already eaten.', pinyin: '' }, 'sentences'), 'I have already eaten.');
});

test('pronunciation always uses canonical source text instead of displayed pinyin', () => {
  assert.equal(pronunciationText({ language: 'zh', text: '我已经吃过饭了。', pinyin: 'wǒ yǐjīng chī guò fàn le.' }), '我已经吃过饭了。');
  assert.equal(pronunciationText({ language: 'en', text: 'take off', pinyin: '' }), 'take off');
  assert.equal(pronunciationText({ language: 'fr', text: 'bonjour' }), '');
});

test('word export is compact TSV with source, Chinese pronunciation, and Russian translation only', () => {
  assert.equal(wordsTsv([
    { language: 'zh', text: '你好', pinyin: 'nǐ hǎo', translation: 'привет' },
    { language: 'en', text: 'take off', pinyin: '', translation: 'снимать; взлетать' },
  ]), 'word\tpinyin\ttranslation\n你好\tnǐ hǎo\tпривет\ntake off\t\tснимать; взлетать\n');
});

class PanelElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.attributes = {};
    this.listeners = new Map();
    this.classList = { toggle() {} };
    this._text = '';
  }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  toggleAttribute(name) { if (name in this.attributes) delete this.attributes[name]; else this.attributes[name] = ''; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  click() { if (!this.disabled) return this.listeners.get('click')?.({ target: this }); }
  focus() {}
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const analysis = {
  pinyin: 'nǐ hǎo', translation: 'Здравствуйте!',
  components: [{ text: '你', pinyin: 'nǐ', translation: 'ты', usage: 'Обращение к собеседнику.' }],
  grammar: 'Обычное приветствие.', example: { pinyin: 'nǐ hǎo ma?', translation: 'Как дела?' },
};
const savedChinese = (id = 1) => ({
  id, language: 'zh', text: '你好', pinyin: 'nǐ hǎo', translation: 'старый перевод',
  explanation: 'Старое объяснение 你', ai_translations: [{ translation: 'старый вариант', usage: 'старый контекст' }],
  created_at: '', learned: false,
});
async function bootPanel({ kind = 'words', analyzed = false, resume = false, english = false } = {}) {
  const html = readFileSync(new URL('../local-server/web/index.html', import.meta.url), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new PanelElement()]));
  elements['study-mode'].hidden = true;
  const document = {
    getElementById: id => elements[id], createElement: tag => new PanelElement(tag),
    createElementNS: (_, tag) => new PanelElement(tag), createDocumentFragment: () => new PanelElement('fragment'),
  };
  const item = { ...savedChinese(), ...(analyzed ? { analysis, pinyin: analysis.pinyin, translation: analysis.translation } : {}),
    ...(english ? { language: 'en', text: 'hello', pinyin: '', translation: 'привет', explanation: 'Приветствие.', ai_translations: [] } : {}) };
  const items = [item, savedChinese(2)];
  const messages = [], timers = new Map(), listeners = new Set(), storage = new Map();
  if (resume) storage.set(`subsanywhere.${kind}.study.v1`, JSON.stringify({ ids: [1, 2], position: 0 }));
  const window = {
    addEventListener: (name, fn) => { if (name === 'message') listeners.add(fn); },
    removeEventListener: (_, fn) => listeners.delete(fn),
    postMessage: data => messages.push(data),
  };
  let sequence = 0;
  const context = {
    document, window, location: { origin: 'http://127.0.0.1:43817' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => `request${++sequence}` }, AbortSignal,
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async path => ({ ok: true, json: async () => path === '/api/words' ? { words: kind === 'words' ? items : [] } : { sentences: kind === 'sentences' ? items : [] } }),
  };
  vm.runInNewContext(readFileSync(new URL('../local-server/web/words.js', import.meta.url), 'utf8').replace(/^export /gm, ''), context);
  await tick();
  if (kind === 'sentences') elements['sentences-tab'].click();
  return {
    elements, item, messages, timers, storage,
    respond(data, origin = context.location.origin) { for (const fn of [...listeners]) fn({ source: window, origin, data }); },
  };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const analyzeMessages = panel => panel.messages.filter(message => message.type === 'subsanywhere.words.analyze');

for (const kind of ['words', 'sentences']) {
  test(`Chinese ${kind}: only explicit unified analysis updates a fixed review round`, async () => {
    const panel = await bootPanel({ kind });
    const { elements } = panel;
    assert.equal(analyzeMessages(panel).length, 0);
    assert.ok(descendants(elements['word-list']).some(node => node.tagName === 'button' && node.textContent === 'Разобрать'));
    assert.ok(!descendants(elements['word-list']).some(node => node.textContent === 'Перевод ИИ'));
    elements['study-start'].click();
    assert.equal(elements['study-word'].textContent, 'nǐ hǎo');
    assert.equal(analyzeMessages(panel).length, 0);
    elements['study-explain'].click();
    const request = analyzeMessages(panel)[0];
    assert.deepEqual(JSON.parse(JSON.stringify(request)), { type: 'subsanywhere.words.analyze', requestId: request.requestId, id: 1, kind });
    assert.ok([...panel.timers.values()].some(timer => timer.ms === 70000));
    assert.equal(elements['study-explain'].disabled, true);
    const fresh = { ...panel.item, analysis, pinyin: analysis.pinyin, translation: analysis.translation };
    panel.respond({ type: `${request.type}.result`, requestId: 'wrong', ok: true, [kind === 'words' ? 'word' : 'sentence']: fresh });
    await tick();
    assert.equal(elements['study-explain'].disabled, true);
    panel.respond({ type: `${request.type}.result`, requestId: request.requestId, ok: true, [kind === 'words' ? 'word' : 'sentence']: fresh });
    await tick();
    assert.equal(elements['study-explain'].textContent, 'Обновить разбор');
    assert.equal(elements['study-translation'].textContent, analysis.translation);
    assert.match(elements['study-analysis'].textContent, /nǐ — ты/);
    assert.match(elements['study-analysis'].textContent, /nǐ hǎo ma\? — Как дела\?/);
    assert.doesNotMatch(elements['study-analysis'].textContent, /\p{Script=Han}/u);
    assert.equal(elements['study-explanation'].hidden, true);
    assert.doesNotMatch(elements['word-list'].textContent, /старый вариант|Старое объяснение/);
    assert.equal(elements['study-progress'].textContent, '1 из 2');
    elements['study-next'].click();
    elements['study-back'].click();
    assert.equal(elements['study-translation'].textContent, analysis.translation);
    assert.equal(analyzeMessages(panel).length, 1);
  });

  test(`Chinese ${kind}: resume does not infer; failed refresh preserves the entire prior analysis`, async () => {
    const panel = await bootPanel({ kind, analyzed: true, resume: true });
    const { elements } = panel;
    assert.equal(elements['study-mode'].hidden, false);
    assert.equal(analyzeMessages(panel).length, 0);
    const prior = elements['study-analysis'].textContent;
    elements['study-explain'].click();
    const request = analyzeMessages(panel)[0];
    panel.respond({ type: `${request.type}.result`, requestId: request.requestId, ok: false, error: 'Попробуйте ещё раз' });
    await tick();
    assert.equal(elements['study-analysis'].textContent, prior);
    assert.equal(elements['study-translation'].textContent, analysis.translation);
    assert.equal(elements['study-explain'].disabled, false);
    assert.equal(elements.status.textContent, 'Попробуйте ещё раз');
    assert.equal(elements['study-progress'].textContent, '1 из 2');
  });

  test(`Chinese ${kind}: explicit list refresh replaces all analysis fields and canonical export`, async () => {
    const panel = await bootPanel({ kind, analyzed: true });
    const { elements } = panel;
    descendants(elements['word-list']).find(node => node.tagName === 'button' && node.textContent === 'Обновить разбор').click();
    const request = analyzeMessages(panel)[0];
    const replacement = { ...analysis, pinyin: 'ní hǎo', translation: 'Привет!',
      components: [{ text: '好', pinyin: 'hǎo', translation: 'хорошо', usage: 'Часть приветствия.' }],
      grammar: 'Здесь используется приветствие.', example: { pinyin: 'nǐmen hǎo!', translation: 'Всем привет!' } };
    const fresh = { ...panel.item, pinyin: replacement.pinyin, translation: replacement.translation, analysis: replacement };
    panel.respond({ type: `${request.type}.result`, requestId: request.requestId, ok: true, [kind === 'words' ? 'word' : 'sentence']: fresh });
    await tick();
    elements['study-start'].click();
    assert.equal(elements['study-word'].textContent, replacement.pinyin);
    assert.equal(elements['study-translation'].textContent, replacement.translation);
    assert.match(elements['study-analysis'].textContent, /hǎo — хорошо/);
    assert.doesNotMatch(elements['study-analysis'].textContent, /nǐ — ты|Как дела/);
    assert.match(wordsTsv([fresh]), /ní hǎo\tПривет!/);
    assert.equal(analyzeMessages(panel).length, 1);
  });
}

test('analysis rejects Han in visible fields but keeps source component text', () => {
  assert.equal(validAnalysis(analysis), true);
  assert.equal(validAnalysis({ ...analysis, grammar: '你 — ты' }), false);
  assert.equal(validAnalysis({ ...analysis, components: [{ ...analysis.components[0], usage: '你' }] }), false);
  assert.equal(validAnalysis({ ...analysis, example: { pinyin: '你好', translation: 'Привет' } }), false);
  assert.equal(validAnalysis(null), false);
  assert.equal(learningText({ language: 'zh', text: '你好', pinyin: '你好 nǐ hǎo' }), 'nǐ hǎo');
});

test('malformed analysis and timeout preserve prior data, and late replies cannot overwrite a retry', async () => {
  const panel = await bootPanel({ analyzed: true, resume: true });
  const { elements } = panel;
  const prior = elements['study-analysis'].textContent;
  elements['study-explain'].click();
  let request = analyzeMessages(panel)[0];
  panel.respond({ type: `${request.type}.result`, requestId: request.requestId, ok: true,
    word: { ...panel.item, analysis: { ...analysis, grammar: '你好' } } });
  await tick();
  assert.equal(elements['study-analysis'].textContent, prior);
  assert.match(elements.status.textContent, /не подтвердило/);
  elements['study-explain'].click();
  request = analyzeMessages(panel)[1];
  [...panel.timers.values()].find(timer => timer.ms === 70000).fn();
  await tick();
  assert.equal(elements['study-explain'].disabled, false);
  assert.equal(elements['study-analysis'].textContent, prior);
  panel.respond({ type: `${request.type}.result`, requestId: request.requestId, ok: true, word: panel.item });
  await tick();
  assert.match(elements.status.textContent, /не ответило/);
});

test('English review retains its manual explanation and canonical speech', async () => {
  const panel = await bootPanel({ english: true, resume: true });
  const { elements } = panel;
  assert.equal(elements['study-word'].textContent, 'hello');
  assert.equal(elements['study-explain'].textContent, 'Показать объяснение');
  elements['study-explain'].click();
  assert.equal(elements['study-explanation'].hidden, false);
  assert.equal(elements['study-explanation-text'].textContent, 'Приветствие.');
  assert.equal(elements['study-analysis'].hidden, true);
  assert.equal(panel.messages.some(message => /words\.(analyze|explain|translate)/u.test(message.type)), false);
  elements['study-speak'].click();
  assert.equal(panel.messages.at(-1).text, 'hello');
  assert.equal(panel.messages.at(-1).language, 'en');
});

test('word export prevents spreadsheet formulas in saved subtitle and translation text', () => {
  assert.equal(wordsTsv([
    { language: 'en', text: '=HYPERLINK("https://example.test")', pinyin: '', translation: '+unsafe' },
  ]), 'word\tpinyin\ttranslation\n\'=HYPERLINK("https://example.test")\t\t\'+unsafe\n');
});
