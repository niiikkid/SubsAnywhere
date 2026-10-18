// Serialized by chrome.scripting into the YouTube page. Keep it self-contained.
export async function readYouTubePageCaptions(videoId, language) {
  const base = { videoId, language, source: 'youtube-page' };
  const failure = (code, error, status = 'error') => ({ ...base, status, error_code: code, error });
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '') || !['en', 'zh'].includes(language)) {
    return failure('invalid_context', 'Некорректное видео или язык субтитров');
  }
  const family = (code) => /^en(?:-|$)/i.test(code || '') ? 'en' : /^zh(?:-|$)/i.test(code || '') ? 'zh' : '';
  const currentId = () => {
    const url = new URL(location.href);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return '';
    return url.pathname === '/watch' ? url.searchParams.get('v')
      : url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)$/)?.[1];
  };
  if (currentId() !== videoId) return failure('stale', 'Страница видео изменилась');
  const player = document.getElementById('movie_player');
  const response = player?.getPlayerResponse?.();
  if (response?.videoDetails?.videoId !== videoId) return failure('stale', 'Дождитесь загрузки текущего видео');
  const stillCurrent = () => currentId() === videoId && player.getPlayerResponse?.()?.videoDetails?.videoId === videoId;
  const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const candidates = (Array.isArray(tracks) ? tracks : []).filter((track) => {
    try {
      const url = new URL(track.baseUrl);
      return family(track.languageCode) === language && !url.searchParams.has('tlang');
    } catch { return false; }
  }).sort((a, b) => Number(a.kind === 'asr') - Number(b.kind === 'asr'));
  const track = candidates[0];
  if (!track) return failure('captions_missing', 'На странице YouTube нет субтитров на этом языке', 'missing');
  const matches = (value) => {
    try {
      const url = new URL(typeof value === 'string' ? value : value?.url, location.href);
      return ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)
        && url.pathname === '/api/timedtext' && url.searchParams.get('v') === videoId
        && family(url.searchParams.get('lang')) === language && !url.searchParams.has('tlang')
        && (url.searchParams.get('kind') === 'asr') === (track.kind === 'asr');
    } catch { return false; }
  };
  const usable = (text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 5 * 1024 * 1024) return false;
    try {
      const body = JSON.parse(text);
      return Array.isArray(body.events) && body.events.some((event) => Number.isFinite(event.tStartMs)
        && event.dDurationMs > 0 && event.segs?.some((segment) => typeof segment.utf8 === 'string' && segment.utf8.trim()));
    } catch { return false; }
  };
  const ready = (captionBody) => ({ ...base, status: 'ready', captionBody });
  globalThis.__subsAnywhereCaptionCapture?.cancel?.();
  const originalFetch = window.fetch;
  try {
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');
    if (matches(url.href)) {
      const result = await originalFetch.call(window, url.href, { credentials: 'include', signal: AbortSignal.timeout(3000) });
      const text = result.ok ? await result.text() : '';
      if (!stillCurrent()) return failure('stale', 'Страница видео изменилась');
      if (usable(text)) return ready(text);
    }
  } catch { /* Some players return an empty response unless they request captions themselves. */ }
  if (!stillCurrent()) return failure('stale', 'Страница видео изменилась');
  if (typeof player.loadModule !== 'function' || typeof player.getOption !== 'function' || typeof player.setOption !== 'function') {
    return failure('player_unavailable', 'Плеер YouTube не разрешил получить субтитры');
  }

  // Observe only the chosen video's original-language caption response. Do not
  // export signed URLs, headers, cookies, or any unrelated page traffic.
  globalThis.__subsAnywhereCaptionCapture?.cancel?.();
  return new Promise((resolve) => {
    let finished = false;
    let timer;
    let navigationTimer;
    let selected;
    let temporarilyOff = false;
    const previous = player.getOption('captions', 'track');
    const originalOpen = XMLHttpRequest.prototype.open;
    const owner = { cancel: () => finish(failure('cancelled', 'Получение субтитров заменено новым запросом')) };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(navigationTimer);
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen;
      if (globalThis.__subsAnywhereCaptionCapture === owner) delete globalThis.__subsAnywhereCaptionCapture;
      try {
        const current = player.getOption('captions', 'track');
        if (stillCurrent() && selected && ((temporarilyOff && !current?.languageCode)
          || (current?.languageCode === selected.languageCode && (current.kind || '') === (selected.kind || '')))) {
          player.setOption('captions', 'track', previous?.languageCode ? previous : {});
        }
      } catch { /* The player can be destroyed during navigation. */ }
      resolve(stillCurrent() ? result : failure('stale', 'Страница видео изменилась'));
    };
    const accept = (url, text) => {
      if (!finished && stillCurrent() && matches(url) && usable(text)) finish(ready(text));
    };
    const wrappedFetch = async function (...args) {
      const result = await originalFetch.apply(this, args);
      if (matches(args[0]) && result.ok) result.clone().text().then((text) => accept(args[0], text)).catch(() => undefined);
      return result;
    };
    const wrappedOpen = function (method, url, ...args) {
      if (matches(url)) this.addEventListener('load', () => {
        try { accept(url, this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText); }
        catch { /* Ignore unsupported response types. */ }
      }, { once: true });
      return originalOpen.call(this, method, url, ...args);
    };
    globalThis.__subsAnywhereCaptionCapture = owner;
    window.fetch = wrappedFetch;
    XMLHttpRequest.prototype.open = wrappedOpen;
    timer = setTimeout(() => finish(failure('page_download_failed', 'YouTube не отдал текст субтитров в открытой вкладке')), 8000);
    navigationTimer = setInterval(() => {
      if (!stillCurrent()) finish(failure('stale', 'Страница видео изменилась'));
    }, 150);
    void (async () => {
      try {
        player.loadModule('captions');
        for (let attempt = 0; attempt < 20 && !finished; attempt += 1) {
          const list = player.getOption('captions', 'tracklist') || [];
          selected = list.find((item) => family(item.languageCode) === language && (item.kind || '') === (track.kind || ''));
          if (selected) break;
          await new Promise((done) => setTimeout(done, 50));
        }
        if (finished || !stillCurrent()) return;
        selected ||= { languageCode: track.languageCode, kind: track.kind || '', name: '', vss_id: track.vssId };
        temporarilyOff = true;
        player.setOption('captions', 'track', {});
        await new Promise((done) => setTimeout(done, 150));
        if (!finished && stillCurrent()) {
          temporarilyOff = false;
          player.setOption('captions', 'track', selected);
        }
      } catch { finish(failure('player_unavailable', 'Плеер YouTube не разрешил получить субтитры')); }
    })();
  });
}

export function pageCaptionPayload(result, videoId, language) {
  if (result?.videoId !== videoId || result?.language !== language || !['en', 'zh'].includes(language)) {
    throw new Error('Субтитры со страницы относятся к другому видео или языку');
  }
  if (result.status !== 'ready') return result;
  if (typeof result.captionBody !== 'string' || new TextEncoder().encode(result.captionBody).length > 5 * 1024 * 1024) {
    throw new Error('Субтитры со страницы слишком большие');
  }
  const events = JSON.parse(result.captionBody).events;
  if (!Array.isArray(events) || events.length > 50_000) throw new Error('Неверные субтитры со страницы YouTube');
  const cues = [];
  for (const event of events) {
    if (!Number.isFinite(event.tStartMs) || !Number.isFinite(event.dDurationMs)) continue;
    const start = event.tStartMs / 1000;
    const end = start + event.dDurationMs / 1000;
    const text = (Array.isArray(event.segs) ? event.segs : []).map((segment) => typeof segment.utf8 === 'string' ? segment.utf8 : '').join('');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text.trim()) continue;
    const previous = cues.at(-1);
    if (event.aAppend && previous && previous.windowId === event.wWinId && start <= previous.end) {
      previous.text += text;
      previous.end = Math.max(previous.end, end);
    } else cues.push({ start, end, text, windowId: event.wWinId });
  }
  if (!cues.length) throw new Error('YouTube вернул пустые субтитры');
  const timestamp = (seconds) => {
    const value = Math.round(seconds * 1000);
    return `${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')},${String(value % 1000).padStart(3, '0')}`;
  };
  cues.sort((a, b) => a.start - b.start);
  const srt = cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text.trim().replace(/\n{2,}/g, '\n')}\n`).join('\n');
  if (new TextEncoder().encode(srt).length > 5 * 1024 * 1024) throw new Error('Субтитры со страницы слишком большие');
  return { status: 'ready', source: 'youtube-page', videoId, language, srt };
}
