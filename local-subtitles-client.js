const DEFAULT_BASE_URL = 'http://127.0.0.1:43817';
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const SERVER_ERRORS = Object.freeze({
  start_failed: 'Не удалось запустить задание. Попробуйте ещё раз',
  timeout: 'Превышено время обработки. Повторите запрос или выберите более короткое видео',
  download_failed: 'Не удалось скачать субтитры. Прежние файлы сохранены',
  storage_error: 'Не удалось сохранить файлы. Проверьте свободное место и права на папку сервера',
  busy: 'Сервер занят другим заданием. Повторите попытку немного позже',
  cancelled: 'Загрузка остановлена. Задание API сохранено',
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

export function isLocalSubtitleTrack(track) {
  return ['local-server', 'youtube-page'].includes(track?.sourceType) || /^youtube-/.test(track?.id || '');
}

export function subtitleTrackMatchesVideo(track, videoId) {
  const match = /^youtube-([A-Za-z0-9_-]{11})-(?:youtube|generated)(?:-(?:en|zh))?$/.exec(track?.id || '');
  return Boolean(VIDEO_ID_PATTERN.test(videoId || '') && match?.[1] === videoId
    && (!track.sourceVideoId || track.sourceVideoId === videoId));
}

export function localSubtitleTrack(videoId, source, cues, language = '') {
  const safeId = assertVideoId(videoId);
  const safeSource = 'youtube';
  // Older servers have no language field; infer the label from their subtitle text.
  const safeLanguage = ['en', 'zh'].includes(language) ? language
    : cues.some((cue) => /\p{Script=Han}/u.test(cue.text)) ? 'zh' : 'en';
  const fromPage = source === 'page';
  const label = safeLanguage === 'zh' ? (fromPage ? 'Китайские' : 'Китайские с пиньинем') : 'Английские';
  return {
    id: `youtube-${safeId}-${safeSource}-${safeLanguage}`,
    name: `${label} — ${fromPage ? 'со страницы YouTube' : 'YouTube'}`,
    language: safeLanguage,
    cues,
    offsetSeconds: 0,
    timeScale: 1,
    sourceType: fromPage ? 'youtube-page' : 'local-server',
    sourceVideoId: safeId,
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
    if (!response.ok || (payload?.error && payload.status !== 'error')) {
      throw new Error(SERVER_ERRORS[payload?.error_code] || payload?.error || `Локальный сервер вернул ошибку ${response.status}`);
    }
    if (!payload || !['ready', 'running', 'missing', 'error'].includes(payload.status)
      || (payload.status === 'ready' && (typeof payload.srt !== 'string' || !payload.srt.trim()))) {
      throw new Error('Локальный сервер вернул неверный ответ');
    }
    if ((payload.videoId && payload.videoId !== safeId) || (payload.video_id && payload.video_id !== safeId)) {
      throw new Error('Сервер вернул субтитры другого видео');
    }
    payload = { ...payload, videoId: safeId };
    return payload.status === 'error'
      ? { ...payload, error: SERVER_ERRORS[payload.error_code] || payload.error || 'Не удалось обработать видео' }
      : payload;
  }
}
