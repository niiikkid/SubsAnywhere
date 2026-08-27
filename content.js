(() => {
  const runtime = globalThis.DualCaptionsContentRuntime;
  if (!runtime) return;

  const CONTROLLER_KEY = '__dualCaptionsControllerV3';
  const MESSAGE = Object.freeze({
    PLAYER_REPORT: 'dualCaptions.player.report',
    CONTENT_FULL_STATE: 'dualCaptions.content.fullState',
    CONTENT_SETTINGS: 'dualCaptions.content.settings',
    CONTENT_TRACKS: 'dualCaptions.content.tracks',
    TRACK_CACHE_BUILTIN: 'dualCaptions.track.cacheBuiltin',

    CONTENT_RESET: 'dualCaptions.content.reset',
  });
  function createController() {
    const state = {
      active: false,
      settings: runtime.normalizeSettings(),
      externalTracks: [],
      root: null,
      second: null,
      tooltip: null,
      tooltipItem: null,
      renderedCaptionKey: '',
      renderedCaptionItems: null,
    };
    const builtInTrackResolver = runtime.createBuiltInTrackResolver();
    const originalTrackModes = new Map();
    const cachedBuiltInSelections = new Set();
    const cachingBuiltInSelections = new Set();
    const cleanup = [];
    const translationCache = new Map();
    const maxCachedTranslations = 80;
    const maxQueuedTranslations = 3;
    let translationInFlight = false;
    const queuedTranslations = [];
    const queuedTranslationSet = new Set();
    let lastTranslationAt = 0;
    let translationDispatchScheduled = false;



    function ensureOverlay() {
      if (state.root?.isConnected) return;
      const root = document.createElement('div');
      root.id = 'dual-captions-overlay';
      root.setAttribute('aria-live', 'polite');
      root.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;overflow:hidden;';
      const makeLayer = (name) => {
        const element = document.createElement('div');
        element.className = name;
        element.style.cssText = 'position:absolute;left:4%;right:4%;color:#fff;text-align:center;font-family:Arial,sans-serif;font-weight:700;line-height:1.25;white-space:pre-line;text-shadow:-2px -2px 2px #000,2px 2px 2px #000,0 0 7px #000;';
        root.append(element);
        return element;
      };
      state.second = makeLayer('subs-anywhere-original');
      state.second.style.pointerEvents = 'auto';
      document.documentElement.append(root);
      state.root = root;
    }

    function dismissTooltip() {
      state.tooltip?.remove();
      state.tooltip = null;
      state.tooltipItem = null;
    }

    function showTooltip(item, anchor) {
      if (state.tooltipItem === item) {
        dismissTooltip();
        return;
      }
      dismissTooltip();
      const tooltip = document.createElement('div');
      tooltip.setAttribute('role', 'tooltip');
      tooltip.style.cssText = 'position:absolute;z-index:1;min-width:145px;max-width:260px;padding:8px 28px 8px 9px;border:1px solid rgba(255,255,255,.45);border-radius:7px;background:rgba(20,20,24,.96);color:#fff;font:600 13px/1.3 Arial,sans-serif;text-align:left;white-space:normal;box-shadow:0 2px 10px #000;pointer-events:auto;transform:translate(-50%,-100%);';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Закрыть перевод');
      close.style.cssText = 'position:absolute;right:5px;top:3px;border:0;background:transparent;color:#fff;font:22px/1 Arial,sans-serif;cursor:pointer;';
      close.addEventListener('click', (event) => { event.stopPropagation(); dismissTooltip(); });
      const dictionary = document.createElement('div');
      dictionary.textContent = `Обычно: ${item.dictionary}`;
      const context = document.createElement('div');
      context.style.cssText = 'margin-top:3px;color:#c8d9ff;';
      context.textContent = `Здесь: ${item.context}`;
      tooltip.append(close, dictionary, context);
      state.root.append(tooltip);
      const word = anchor.getBoundingClientRect();
      const rootRect = state.root.getBoundingClientRect();
      tooltip.style.left = `${Math.max(20, Math.min(rootRect.width - 20, word.left - rootRect.left + word.width / 2))}px`;
      tooltip.style.top = `${Math.max(34, word.top - rootRect.top - 6)}px`;
      state.tooltip = tooltip;
      state.tooltipItem = item;
    }

    function renderPendingCaption(text) {
      for (const part of text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          state.second.append(document.createTextNode(part));
          continue;
        }
        const token = document.createElement('span');
        token.textContent = part;
        token.tabIndex = 0;
        token.setAttribute('role', 'button');
        token.style.cssText = 'pointer-events:auto;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;';
        const loading = () => showTooltip({
          dictionary: 'Перевод готовится…',
          context: 'Нажмите ещё раз через мгновение.',
        }, token);
        token.addEventListener('click', (event) => { event.stopPropagation(); loading(); });
        token.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); loading(); }
        });
        state.second.append(token);
      }
    }

    function rememberTranslation(text, items) {
      translationCache.delete(text);
      translationCache.set(text, items);
      while (translationCache.size > maxCachedTranslations) translationCache.delete(translationCache.keys().next().value);
    }

    function requestTranslation(text, priority = false) {
      if (!text || translationCache.has(text) || queuedTranslationSet.has(text)) return;
      if (queuedTranslations.length >= maxQueuedTranslations) {
        if (!priority) return;
        const displaced = queuedTranslations.pop();
        if (displaced) queuedTranslationSet.delete(displaced);
      }
      if (priority) queuedTranslations.unshift(text);
      else queuedTranslations.push(text);
      queuedTranslationSet.add(text);
      pumpTranslations();
    }

    function pumpTranslations() {
      if (translationInFlight || translationDispatchScheduled || !queuedTranslations.length) return;
      const run = () => {
        translationDispatchScheduled = false;
        if (translationInFlight) return;
        const nextText = queuedTranslations.shift();
        if (nextText) queuedTranslationSet.delete(nextText);
        if (!nextText) return;
        translationInFlight = true;
        lastTranslationAt = Date.now();
        chrome.runtime.sendMessage({ type: 'dualCaptions.caption.translate', text: nextText })
          .then((response) => {
            if (response?.ok === true && Array.isArray(response?.data?.items)) rememberTranslation(nextText, response.data.items);
          })
          .catch(() => undefined)
          .finally(() => {
            translationInFlight = false;
            render();
            pumpTranslations();
          });
      };
      const delay = Math.max(0, 750 - (Date.now() - lastTranslationAt));
      if (delay) {
        translationDispatchScheduled = true;
        setTimeout(run, delay);
      }
      else run();
    }

    function futureCaptionTexts(id, fallbackId, video) {
      if (!id) return [];
      if (id.startsWith('external:')) {
        const external = state.externalTracks.find((track) => `external:${track.id}` === id);
        if (!external) return [];
        const scale = Number(external.timeScale) > 0 ? Number(external.timeScale) : 1;
        const sourceTime = (video.currentTime - Number(external.offsetSeconds || 0)) / scale;
        return runtime.upcomingCueTexts(external.cues, sourceTime, { seconds: 30 / scale, limit: 3 });
      }
      const track = builtInTrackResolver.find(video.textTracks, id, fallbackId);
      if (!track && state.settings.secondTrackCacheSource === `${state.settings.selectedPlayerKey}\u0000${id}`) {
        const cached = state.externalTracks.find((item) => item.id === state.settings.secondTrackCacheId && item.sourceType === 'builtin-cache');
        if (cached) return runtime.upcomingCueTexts(cached.cues, video.currentTime, { seconds: 30, limit: 3 });
      }
      return runtime.upcomingCueTexts(track?.cues, video.currentTime, { seconds: 30, limit: 3 });
    }

    function cacheSelectedBuiltInTrack(id, fallbackId, video) {
      const selectionKey = `${state.settings.selectedPlayerKey}\u0000${id}`;
      if (!id || id.startsWith('external:') || cachedBuiltInSelections.has(selectionKey) || cachingBuiltInSelections.has(selectionKey)) return;
      if (state.settings.secondTrackCacheSource === selectionKey && state.settings.secondTrackCacheId) return;
      const track = builtInTrackResolver.find(video.textTracks, id, fallbackId);
      const cueCount = Number(track?.cues?.length);
      if (!Number.isInteger(cueCount) || !cueCount || cueCount > 5_000) return;
      const cues = [];
      const encoder = new TextEncoder();
      let serializedBytes = 2;
      for (let index = 0; index < cueCount; index += 1) {
        const cue = track.cues[index];
        if (String(cue?.text ?? '').length > 1_200) return;
        const normalized = {
          start: Number(cue?.startTime ?? cue?.start),
          end: Number(cue?.endTime ?? cue?.end),
          text: runtime.cleanSubtitleText(cue?.text),
        };
        if (!Number.isFinite(normalized.start) || !Number.isFinite(normalized.end) || normalized.end <= normalized.start || !normalized.text) continue;
        serializedBytes += encoder.encode(JSON.stringify(normalized)).byteLength + (cues.length ? 1 : 0);
        if (serializedBytes > 5 * 1024 * 1024) return;
        cues.push(normalized);
      }
      if (!cues.length || !globalThis.crypto?.randomUUID) return;
      cachingBuiltInSelections.add(selectionKey);
      const snapshotId = `builtin-cache-${globalThis.crypto.randomUUID()}`;
      chrome.runtime.sendMessage({
        type: MESSAGE.TRACK_CACHE_BUILTIN,
        sourceKey: selectionKey,
        track: {
          id: snapshotId,
          sourceType: 'builtin-cache',
          name: 'Сохранённые встроенные субтитры',
          cues,
          offsetSeconds: 0,
          timeScale: 1,
        },
      }).then((response) => {
        if (response?.ok === true) cachedBuiltInSelections.add(selectionKey);
        else throw new Error('Built-in subtitle cache was rejected');
      }).catch(() => {
        const retries = (state.builtInCacheRetries?.get(selectionKey) ?? 0) + 1;
        state.builtInCacheRetries ??= new Map();
        state.builtInCacheRetries.set(selectionKey, retries);
        if (retries < 3) setTimeout(() => cacheSelectedBuiltInTrack(id, fallbackId, video), 1_000);
      }).finally(() => cachingBuiltInSelections.delete(selectionKey));
    }

    function renderInteractiveCaption(text, isEnglish) {
      const items = translationCache.get(text);
      const key = `${state.settings.secondTrackId}\u0000${text}`;
      if (state.renderedCaptionKey === key && state.renderedCaptionItems === items) return;
      state.renderedCaptionKey = key;
      state.renderedCaptionItems = items;
      dismissTooltip();
      state.second.replaceChildren();
      if (!text) {
        return;
      }
      if (!isEnglish) {
        state.second.textContent = text;
        return;
      }
      if (!items || !items.length) {
        renderPendingCaption(text);
        if (!items) requestTranslation(text, true);
        return;
      }
      for (const segment of runtime.captionSegments(text, items)) {
        if (!segment.item) {
          state.second.append(document.createTextNode(segment.text));
          continue;
        }
        const phrase = document.createElement('span');
        phrase.textContent = segment.text;
        phrase.tabIndex = 0;
        phrase.setAttribute('role', 'button');
        phrase.style.cssText = 'pointer-events:auto;cursor:pointer;text-decoration:underline;text-decoration-color:rgba(255,255,255,.72);text-underline-offset:3px;';
        phrase.addEventListener('click', (event) => { event.stopPropagation(); showTooltip(segment.item, phrase); });
        phrase.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showTooltip(segment.item, phrase); }
        });
        state.second.append(phrase);
      }
    }

    function restoreTrackMode(track) {
      if (originalTrackModes.has(track)) {
        track.mode = originalTrackModes.get(track);
        originalTrackModes.delete(track);
      }
    }

    function restoreModes(video) {
      if (!video?.textTracks) return;
      for (const track of video.textTracks) restoreTrackMode(track);
    }

    function selectedText(id, fallbackId, video) {
      if (!id) return '';
      if (id.startsWith('external:')) {
        const external = state.externalTracks.find((track) => `external:${track.id}` === id);
        return external
          ? runtime.cueTextAt(external.cues, video.currentTime, external.offsetSeconds, external.timeScale)
          : '';
      }
      const native = builtInTrackResolver.find(video.textTracks, id, fallbackId);
      if (native) return runtime.activeCueText(native);
      if (state.settings.secondTrackCacheSource !== `${state.settings.selectedPlayerKey}\u0000${id}`) return '';
      const cached = state.externalTracks.find((track) => track.id === state.settings.secondTrackCacheId && track.sourceType === 'builtin-cache');
      return cached ? runtime.cueTextAt(cached.cues, video.currentTime, cached.offsetSeconds, cached.timeScale) : '';
    }

    function overlayHost(video) {
      const fullscreenElement = document.fullscreenElement ?? document.webkitFullscreenElement;
      if (fullscreenElement && (fullscreenElement === video || fullscreenElement.contains?.(video))) {
        return fullscreenElement;
      }
      return document.documentElement;
    }

    function syncOverlayHost(video) {
      const host = overlayHost(video);
      if (state.root?.parentElement !== host) host.append(state.root);
    }

    function positionOverlay() {
      const { video } = manager.current();
      if (!video || !state.root) return;
      syncOverlayHost(video);
      const rect = video.getBoundingClientRect();
      state.root.style.left = `${rect.left}px`;
      state.root.style.top = `${rect.top}px`;
      state.root.style.width = `${rect.width}px`;
      state.root.style.height = `${rect.height}px`;
      state.root.style.display = state.active && rect.width && rect.height ? 'block' : 'none';
    }

    function render() {
      const { video } = manager.current();
      if (!video || !state.active) {
        if (state.root) state.root.style.display = 'none';
        return;
      }
      ensureOverlay();
      for (const track of video.textTracks) {
        if (track.kind === 'subtitles' || track.kind === 'captions') {
          if (!originalTrackModes.has(track)) originalTrackModes.set(track, track.mode);
          track.mode = 'hidden';
        }
      }
      const secondText = selectedText(
        state.settings.secondTrackId,
        state.settings.secondTrackFallbackId,
        video,
      );
      cacheSelectedBuiltInTrack(state.settings.secondTrackId, state.settings.secondTrackFallbackId, video);
      renderInteractiveCaption(secondText, true);
      for (const text of futureCaptionTexts(state.settings.secondTrackId, state.settings.secondTrackFallbackId, video)) {
        requestTranslation(text);
      }
      state.second.style.bottom = `${state.settings.secondBottom}%`;
      state.second.style.fontSize = `${state.settings.fontSize}px`;
      positionOverlay();
    }

    function report(video, videoIndex) {
      let sourceName = '';
      try {
        sourceName = decodeURIComponent(new URL(video.currentSrc || video.src || '', location.href).pathname.split('/').pop() || '');
      } catch { /* source name stays empty */ }
      chrome.runtime.sendMessage({
        type: MESSAGE.PLAYER_REPORT,
        player: {
          title: document.title,
          frameUrl: location.href,
          videoIndex,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          sourceName: sourceName.slice(0, 240),
          tracks: runtime.trackChoices(video.textTracks),
        },
      }).catch(() => undefined);
    }

    const manager = runtime.createVideoManager({ report, render, trackRemoved: restoreTrackMode });

    function discover() {
      const previous = manager.current().video;
      const result = manager.discover(document.querySelectorAll('video'));
      if (previous && result?.video !== previous) restoreModes(previous);
      return result;
    }

    function handle(message) {
      if (message?.type === MESSAGE.CONTENT_FULL_STATE) {
        state.settings = runtime.normalizeSettings(message.settings);
        state.externalTracks = Array.isArray(message.externalTracks) ? message.externalTracks : [];
        state.active = true;
        discover();
        render();
        return { ok: true };
      }
      if (message?.type === MESSAGE.CONTENT_SETTINGS) {
        state.settings = runtime.normalizeSettings(message.settings);
        state.active = true;
        render();
        return { ok: true };
      }
      if (message?.type === MESSAGE.CONTENT_TRACKS) {
        state.settings = runtime.normalizeSettings(message.settings);
        state.externalTracks = Array.isArray(message.externalTracks) ? message.externalTracks : [];
        state.active = true;
        render();
        return { ok: true };
      }

      if (message?.type === MESSAGE.CONTENT_RESET) {
        const { video } = manager.current();
        restoreModes(video);
        state.settings = runtime.normalizeSettings();
        state.externalTracks = [];
        state.active = false;
        state.renderedCaptionKey = '';
        state.renderedCaptionItems = null;
        if (state.second) state.second.textContent = '';
        dismissTooltip();
        if (state.root) state.root.style.display = 'none';
        return { ok: true };
      }
      return undefined;
    }

    const messageListener = (message, _sender, reply) => {
      const result = handle(message);
      if (result) reply(result);
    };
    chrome.runtime.onMessage.addListener(messageListener);
    cleanup.push(() => chrome.runtime.onMessage.removeListener(messageListener));

    const observer = new MutationObserver((records) => {
      if (runtime.mutationsAffectVideo(records, state.root)) discover();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    cleanup.push(() => observer.disconnect());

    for (const [target, type, listener, options] of [
      [window, 'resize', positionOverlay],
      [window, 'scroll', positionOverlay, true],
      [document, 'fullscreenchange', positionOverlay],
      [document, 'webkitfullscreenchange', positionOverlay],
    ]) {
      target.addEventListener(type, listener, options);
      cleanup.push(() => target.removeEventListener(type, listener, options));
    }

    return {
      discover,
      handle,
      destroy() {
        restoreModes(manager.current().video);
        manager.destroy();
        for (const dispose of cleanup.splice(0).reverse()) dispose();
        dismissTooltip();
        state.root?.remove();
      },
    };
  }

  runtime.installController(globalThis, CONTROLLER_KEY, createController);
})();
