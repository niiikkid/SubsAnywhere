export const SPEECH_STORAGE_KEY = 'dualCaptionsSpeech';
export const DEFAULT_SPEECH_SETTINGS = Object.freeze({ rate: 0.8, voiceName: '' });

export function normalizeSpeechRate(value, fallback = DEFAULT_SPEECH_SETTINGS.rate) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0.5, parsed)) : fallback;
}

export function normalizeSpeechVoiceName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

export function normalizeSpeechSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { rate: normalizeSpeechRate(source.rate), voiceName: normalizeSpeechVoiceName(source.voiceName) };
}

const NOVELTY_CHINESE_VOICES = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)(\s|$)/i;

export function selectSpeechVoice(voices, language, preferredVoiceName = '') {
  if (!Array.isArray(voices)) return '';
  const locale = language.toLowerCase();
  const matching = voices.filter((voice) => String(voice?.lang || '').toLowerCase().replace('_', '-').startsWith(locale));
  const configured = matching.find((voice) => voice.voiceName === preferredVoiceName);
  const preferred = matching.find((voice) => /ting[ -]?ting/i.test(String(voice.voiceName || '')));
  const natural = matching.find((voice) => !NOVELTY_CHINESE_VOICES.test(String(voice.voiceName || '')));
  return String(configured?.voiceName || preferred?.voiceName || natural?.voiceName || matching[0]?.voiceName || '');
}

export class SpeechService {
  #chrome;
  #storage;
  #voices;

  constructor(chromeApi, storage) {
    this.#chrome = chromeApi;
    this.#storage = storage;
    this.#voices = null;
  }

  async getVoices() {
    if (this.#voices) return this.#voices;
    if (typeof this.#chrome.tts?.getVoices !== 'function') return [];
    this.#voices = await new Promise((resolve) => {
      try {
        this.#chrome.tts.getVoices((voices) => resolve(Array.isArray(voices) ? voices : []));
      } catch {
        resolve([]);
      }
    });
    return this.#voices;
  }

  async getVoiceOptions(language = 'zh-CN') {
    const locale = language.toLowerCase();
    const seen = new Set();
    return (await this.getVoices())
      .filter((voice) => String(voice?.lang || '').toLowerCase().replace('_', '-').startsWith(locale))
      .map((voice) => ({ voiceName: normalizeSpeechVoiceName(voice.voiceName), lang: String(voice.lang || '') }))
      .filter((voice) => voice.voiceName && !seen.has(voice.voiceName) && seen.add(voice.voiceName))
      .sort((left, right) => {
        const leftPreferred = /ting[ -]?ting/i.test(left.voiceName) ? 0 : 1;
        const rightPreferred = /ting[ -]?ting/i.test(right.voiceName) ? 0 : 1;
        return leftPreferred - rightPreferred || left.voiceName.localeCompare(right.voiceName);
      });
  }

  async getSettings() {
    const stored = await this.#storage.get(SPEECH_STORAGE_KEY);
    return normalizeSpeechSettings(stored[SPEECH_STORAGE_KEY]);
  }

  async patchSettings(patch = {}) {
    const current = await this.getSettings();
    const next = normalizeSpeechSettings({
      ...current,
      ...(Object.hasOwn(patch, 'rate') ? { rate: patch.rate } : {}),
      ...(Object.hasOwn(patch, 'voiceName') ? { voiceName: patch.voiceName } : {}),
    });
    if (next.voiceName && !(await this.getVoiceOptions()).some((voice) => voice.voiceName === next.voiceName)) {
      throw new Error('Выбранный голос недоступен');
    }
    await this.#storage.set({ [SPEECH_STORAGE_KEY]: next });
    return next;
  }

  async speak(value = {}) {
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    if (!text || text.length > 2_000) throw new Error('Некорректный текст для произношения');
    if (!['zh', 'en'].includes(value.language)) throw new Error('Язык произношения не поддерживается');
    if (typeof this.#chrome.tts?.speak !== 'function') throw new Error('Системное озвучивание недоступно');
    const settings = await this.getSettings();
    const language = value.language === 'zh' ? 'zh-CN' : 'en-US';
    const voiceName = selectSpeechVoice(await this.getVoices(), language, settings.voiceName);
    await new Promise((resolve, reject) => {
      try {
        this.#chrome.tts.speak(text, {
          lang: language,
          rate: settings.rate,
          enqueue: false,
          ...(voiceName ? { voiceName } : {}),
        }, () => {
          const error = this.#chrome.runtime?.lastError;
          if (error) reject(new Error(error.message || 'Не удалось запустить произношение'));
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
    return { language: value.language, rate: settings.rate, voiceName };
  }
}
