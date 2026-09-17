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

function savedWord(value) {
  const word = normalizeWord(value);
  if (!Number.isSafeInteger(value.id) || value.id < 1 || typeof value.created_at !== 'string') {
    throw new Error('Некорректный ответ словаря');
  }
  return { ...word, id: value.id, created_at: value.created_at };
}

export class VocabularyClient {
  #fetch;

  constructor(fetchImpl) { this.#fetch = fetchImpl; }

  async #request(method, body) {
    const signal = AbortSignal.timeout(8000);
    let response;
    try {
      response = await this.#fetch(`${BASE_URL}/api/words`, {
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
    const payload = await this.#request('GET');
    try {
      if (!Array.isArray(payload?.words)) throw new Error();
      return { words: payload.words.map(savedWord) };
    } catch { throw new Error('Некорректный ответ словаря'); }
  }

  async save(value) {
    const word = normalizeWord(value);
    const payload = await this.#request('POST', word);
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
}
