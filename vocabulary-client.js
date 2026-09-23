const BASE_URL = 'http://127.0.0.1:43817';

function normalizeWord(value) {
  const string = (text, limit) => {
    if (typeof text !== 'string' || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw new Error('Некорректные данные слова');
    }
    return text.normalize('NFC').trim().replace(/\s+/gu, ' ');
  };
  const language = value?.language;
  if (!['zh', 'en'].includes(language)) throw new Error('Некорректный язык слова');
  const text = string(value.text, 120);
  const pinyin = string(value.pinyin, 120);
  const translation = string(value.translation, 1000);
  if (!text || !translation || (language === 'zh' && (!/\p{Script=Han}/u.test(text) || !pinyin))) {
    throw new Error('Нет иероглифов, пиньиня или перевода этого слова');
  }
  if (language === 'en' && pinyin) throw new Error('Некорректные данные слова');
  return { language, text, pinyin, translation };
}

function normalizeSentence(value) {
  const string = (text, limit) => {
    if (typeof text !== 'string' || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw new Error('Некорректные данные предложения');
    }
    return text.normalize('NFC').trim().replace(/\s+/gu, ' ');
  };
  const language = value?.language;
  if (!['zh', 'en'].includes(language)) throw new Error('Некорректный язык предложения');
  const text = string(value.text, 500);
  const pinyin = string(value.pinyin, 500);
  const translation = string(value.translation, 1200);
  if (!text || !translation || (language === 'zh' && (!/\p{Script=Han}/u.test(text) || !pinyin))) {
    throw new Error('Нет текста, пиньиня или перевода этого предложения');
  }
  if (language === 'en' && pinyin) throw new Error('Некорректные данные предложения');
  return { language, text, pinyin, translation };
}

function storedExplanation(value) {
  if (typeof value !== 'string' || value.length > 1200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Некорректное объяснение слова');
  }
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function normalizeExplanation(value) {
  const explanation = storedExplanation(value);
  if (!explanation) throw new Error('Некорректное объяснение слова');
  return explanation;
}

function storedAiTranslations(value, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > 3 || (required && !value.length)) {
    throw new Error('Некорректные переводы ИИ');
  }
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'translation') || !Object.hasOwn(item, 'usage')) {
      throw new Error('Некорректные переводы ИИ');
    }
    const translation = storedExplanation(item.translation);
    const usage = storedExplanation(item.usage);
    if (!translation || translation.length > 320 || !usage || usage.length > 240
      || seen.has(translation.toLocaleLowerCase())) throw new Error('Некорректные переводы ИИ');
    seen.add(translation.toLocaleLowerCase());
    return { translation, usage };
  });
}

function savedWord(value) {
  const word = normalizeWord(value);
  if (!Number.isSafeInteger(value.id) || value.id < 1 || typeof value.created_at !== 'string'
    || typeof value.learned !== 'boolean') {
    throw new Error('Некорректный ответ словаря');
  }
  const explanation = value.explanation === undefined ? '' : storedExplanation(value.explanation);
  const aiTranslations = value.ai_translations === undefined ? undefined : storedAiTranslations(value.ai_translations);
  return {
    ...word, id: value.id, created_at: value.created_at, learned: value.learned, explanation,
    ...(aiTranslations === undefined ? {} : { ai_translations: aiTranslations }),
  };
}

function savedSentence(value) {
  const sentence = normalizeSentence(value);
  if (!Number.isSafeInteger(value.id) || value.id < 1 || typeof value.created_at !== 'string'
    || typeof value.learned !== 'boolean') throw new Error('Некорректный ответ списка предложений');
  const explanation = value.explanation === undefined ? '' : storedExplanation(value.explanation);
  return { ...sentence, id: value.id, created_at: value.created_at, learned: value.learned, explanation };
}

export class VocabularyClient {
  #fetch;

  constructor(fetchImpl) { this.#fetch = fetchImpl; }

  async #request(path, method, body) {
    const signal = AbortSignal.timeout(8000);
    let response;
    try {
      response = await this.#fetch(`${BASE_URL}${path}`, {
        method, signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { 'X-SubsAnywhere-Client': 'extension-v1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error('Словарь недоступен. Запустите сервер в Docker и повторите');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Не удалось обратиться к словарю (${response.status}). Проверьте сервер Docker`);
    }
    try { return await response.json(); }
    catch { throw new Error('Некорректный ответ словаря'); }
  }

  async list() {
    const payload = await this.#request('/api/words', 'GET');
    try {
      if (!Array.isArray(payload?.words)) throw new Error();
      return { words: payload.words.map(savedWord) };
    } catch { throw new Error('Некорректный ответ словаря'); }
  }

  async save(value) {
    const word = normalizeWord(value);
    const payload = await this.#request('/api/words', 'POST', word);
    let saved;
    try { saved = savedWord(payload?.word); }
    catch { throw new Error('Некорректный ответ словаря'); }
    const { words } = await this.list();
    const confirmed = words.find((item) => item.id === saved.id
      && item.language === saved.language && item.text === saved.text && item.pinyin === saved.pinyin
      && item.translation === saved.translation);
    const key = (item) => JSON.stringify([
      item.language, item.language === 'en' ? item.text.toLowerCase() : item.text, item.pinyin.toLowerCase(),
    ]);
    if (!confirmed || key(confirmed) !== key(word)) throw new Error('Не удалось подтвердить сохранение. Повторите попытку');
    return { word: confirmed };
  }

  async saveExplanation(id, value) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Некорректный идентификатор слова');
    const explanation = normalizeExplanation(value);
    const payload = await this.#request('/api/words/explanation', 'POST', { id, explanation });
    let saved;
    try { saved = savedWord(payload?.word); }
    catch { throw new Error('Некорректный ответ словаря'); }
    if (saved.id !== id || saved.explanation !== explanation) throw new Error('Сервер не подтвердил объяснение слова');
    const { words } = await this.list();
    const confirmed = words.find((item) => item.id === id && item.explanation === explanation);
    if (!confirmed) throw new Error('Объяснение слова не сохранилось. Повторите попытку');
    return { word: confirmed };
  }

  async saveAiTranslations(id, value) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Некорректный идентификатор слова');
    const translations = storedAiTranslations(value, { required: true });
    const payload = await this.#request('/api/words/ai-translations', 'POST', { id, translations });
    let saved;
    try { saved = savedWord(payload?.word); }
    catch { throw new Error('Некорректный ответ словаря'); }
    if (saved.id !== id || JSON.stringify(saved.ai_translations) !== JSON.stringify(translations)) {
      throw new Error('Сервер не подтвердил переводы ИИ');
    }
    const { words } = await this.list();
    const confirmed = words.find((item) => item.id === id
      && JSON.stringify(item.ai_translations) === JSON.stringify(translations));
    if (!confirmed) throw new Error('Переводы ИИ не сохранились. Повторите попытку');
    return { word: confirmed };
  }

  async listSentences() {
    const payload = await this.#request('/api/sentences', 'GET');
    try {
      if (!Array.isArray(payload?.sentences)) throw new Error();
      return { sentences: payload.sentences.map(savedSentence) };
    } catch { throw new Error('Некорректный ответ списка предложений'); }
  }

  async saveSentence(value) {
    const sentence = normalizeSentence(value);
    const payload = await this.#request('/api/sentences', 'POST', sentence);
    let saved;
    try { saved = savedSentence(payload?.sentence); }
    catch { throw new Error('Некорректный ответ списка предложений'); }
    const { sentences } = await this.listSentences();
    const confirmed = sentences.find((item) => item.id === saved.id
      && item.language === saved.language && item.text === saved.text && item.pinyin === saved.pinyin
      && item.translation === saved.translation);
    if (!confirmed) throw new Error('Не удалось подтвердить сохранение предложения. Повторите попытку');
    return { sentence: confirmed };
  }

  async saveSentenceExplanation(id, value) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Некорректный идентификатор предложения');
    const explanation = normalizeExplanation(value);
    const payload = await this.#request('/api/sentences/explanation', 'POST', { id, explanation });
    let saved;
    try { saved = savedSentence(payload?.sentence); }
    catch { throw new Error('Некорректный ответ списка предложений'); }
    if (saved.id !== id || saved.explanation !== explanation) throw new Error('Сервер не подтвердил разбор предложения');
    const { sentences } = await this.listSentences();
    const confirmed = sentences.find((item) => item.id === id && item.explanation === explanation);
    if (!confirmed) throw new Error('Разбор предложения не сохранился. Повторите попытку');
    return { sentence: confirmed };
  }
}
