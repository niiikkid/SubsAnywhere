const DEFAULT_BASE_URL = 'http://127.0.0.1:43817';
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const SERVER_ERRORS = Object.freeze({
  interrupted: 'Сервер перезапущен. Запустите создание субтитров заново; прежние файлы сохранены',
  start_failed: 'Не удалось запустить задание. Попробуйте ещё раз',
  timeout: 'Превышено время обработки. Повторите запрос или выберите более короткое видео',
  dependency_missing: 'Не найдены зависимости сервера. Проверьте окружение Docker и наличие моделей',
  command_failed: 'Не удалось обработать видео. Проверьте доступность ролика, авторизацию YouTube и окружение сервера',
  generation_failed: 'Не удалось создать субтитры. Прежние файлы сохранены',
  storage_error: 'Не удалось сохранить файлы. Проверьте свободное место и права на папку сервера',
  busy: 'Сервер занят другим заданием. Повторите попытку немного позже',
  cancelled: 'Создание остановлено. Прежние файлы сохранены',
  invalid_output: 'Обработка не дала корректных субтитров. Попробуйте другой ролик',
  too_large: 'Файл превышает ограничение сервера. Выберите более короткое видео или меньший SRT',
});

function assertVideoId(videoId) {
  if (!VIDEO_ID_PATTERN.test(String(videoId ?? ''))) {
    throw new Error('Invalid YouTube video ID');
  }
  return String(videoId);
}

export function youtubeVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let candidate = '';
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') candidate = url.searchParams.get('v') ?? '';
      else {
        const match = url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)$/);
        candidate = match?.[1] ?? '';
      }
    } else if (host === 'youtu.be') {
      candidate = url.pathname.split('/').filter(Boolean)[0] ?? '';
    }
    return VIDEO_ID_PATTERN.test(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

export function localSubtitleTrack(videoId, source, cues, language = '') {
  const safeId = assertVideoId(videoId);
  const safeSource = source === 'generated' ? 'generated' : 'youtube';
  // Older servers have no language field; infer the label from their subtitle text.
  const safeLanguage = ['en', 'zh'].includes(language) ? language
    : cues.some((cue) => /\p{Script=Han}/u.test(cue.text)) ? 'zh' : 'en';
  const label = safeLanguage === 'zh' ? 'Китайские с пиньинем' : 'Английские';
  return {
    id: `youtube-${safeId}-${safeSource}`,
    name: `${label} — ${safeSource === 'generated' ? 'распознаны локально' : 'YouTube'}`,
    language: safeLanguage,
    cues,
    offsetSeconds: 0,
    timeScale: 1,
    sourceType: 'local-server',
  };
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return 'меньше минуты';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} ч${remainingMinutes ? ` ${remainingMinutes} мин` : ''}`;
}

export function formatGenerationProgress(payload) {
  if (payload?.status !== 'running') return { visible: false, value: 0, label: '', detail: '' };
  const value = Math.max(0, Math.min(100, Math.round(Number(payload.progress) || 0)));
  if (payload.stage !== 'recognizing') {
    const label = payload.stage === 'downloading' ? 'Скачиваю аудио…' : 'Подготавливаю распознавание…';
    return { visible: true, value, label, detail: `${value}%` };
  }
  const completed = Math.max(0, Math.round(Number(payload.completed_segments) || 0));
  const total = Math.max(0, Math.round(Number(payload.total_segments) || 0));
  const eta = formatEta(Number(payload.eta_seconds));
  return {
    visible: true,
    value,
    label: total ? `Распознаю речь: ${completed} из ${total} сегментов.` : 'Определяю объём речи…',
    detail: `${value}%${eta ? ` · осталось примерно ${eta}` : ''}`,
  };
}

export class LocalSubtitleClient {
  #fetch;
  #baseUrl;

  constructor(fetchImpl, baseUrl = DEFAULT_BASE_URL) {
    if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable');
    this.#fetch = fetchImpl;
    this.#baseUrl = baseUrl;
  }

  existing(videoId, language = '') {
    if (!['', 'en', 'zh'].includes(language)) throw new Error('Некорректный язык субтитров');
    return this.#request('/api/subtitles/existing', videoId, 'GET', language);
  }

  generate(videoId) {
    return this.#request('/api/subtitles/generate', videoId, 'POST');
  }

  status(videoId) {
    return this.#request('/api/subtitles/generated', videoId);
  }

  async #request(path, videoId, method = 'GET', language = '') {
    const safeId = assertVideoId(videoId);
    const url = `${this.#baseUrl}${path}?video_id=${encodeURIComponent(safeId)}${language ? `&language=${language}` : ''}`;
    const signal = AbortSignal.timeout(25_000);
    let response;
    try {
      response = await this.#fetch(url, {
        method,
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'X-SubsAnywhere-Client': 'extension-v1',
        },
      });
    } catch {
      if (signal.aborted) throw new Error('Сервер не ответил вовремя. Повторите проверку — задание не отменено');
      throw new Error('Локальный сервер субтитров не запущен');
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Локальный сервер вернул неверный ответ');
    }
    if (!response.ok || payload?.error) {
      throw new Error(SERVER_ERRORS[payload?.error_code] || payload?.error || `Локальный сервер вернул ошибку ${response.status}`);
    }
    if (!payload || !['ready', 'running', 'missing', 'error'].includes(payload.status)
      || (payload.status === 'ready' && (typeof payload.srt !== 'string' || !payload.srt.trim()))) {
      throw new Error('Локальный сервер вернул неверный ответ');
    }
    return payload;
  }
}
