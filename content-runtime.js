((root) => {
  const cueIndexCache = new WeakMap();

  function cleanSubtitleText(value) {
    return String(value ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .trim();
  }

  function cueTextAt(cues, videoTime, offsetSeconds = 0) {
    const sourceTime = Number(videoTime) - Number(offsetSeconds || 0);
    if (!Number.isFinite(sourceTime)) return '';
    const source = cues && typeof cues === 'object' ? cues : [];
    let index = cueIndexCache.get(source);
    if (!index) {
      const entries = Array.from(source)
        .map((cue) => ({ start: Number(cue.start), end: Number(cue.end), text: cue.text }))
        .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end >= cue.start)
        .sort((left, right) => left.start - right.start);
      const maximumEnd = [];
      for (let position = 0; position < entries.length; position += 1) {
        maximumEnd[position] = Math.max(maximumEnd[position - 1] ?? -Infinity, entries[position].end);
      }
      index = { entries, maximumEnd };
      cueIndexCache.set(source, index);
    }

    let low = 0;
    let high = index.entries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (index.entries[middle].start <= sourceTime) low = middle + 1;
      else high = middle;
    }
    const lastStarted = low - 1;
    if (lastStarted < 0) return '';

    low = 0;
    high = lastStarted + 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (index.maximumEnd[middle] < sourceTime) low = middle + 1;
      else high = middle;
    }

    return index.entries
      .slice(low, lastStarted + 1)
      .filter((cue) => sourceTime <= cue.end)
      .map((cue) => cleanSubtitleText(cue.text))
      .filter((text, index, all) => text && all.indexOf(text) === index)
      .join('\n');
  }

  function isCaptionTrack(track) {
    return track?.kind === 'subtitles' || track?.kind === 'captions';
  }

  function builtInTrackEntries(tracks) {
    const occurrences = new Map();
    return Array.from(tracks ?? [])
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => isCaptionTrack(track))
      .map(({ track, index }) => {
        const nativeId = typeof track.id === 'string' ? track.id.trim() : '';
        const fingerprint = nativeId
          ? `id:${nativeId}`
          : `meta:${track.kind || ''}|${track.language || ''}|${track.label || ''}`;
        const occurrence = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, occurrence + 1);
        return {
          track,
          id: `builtin:${encodeURIComponent(fingerprint)}:${occurrence}`,
          legacyId: `track-${index}`,
          label: track.label || track.language || `Субтитры ${occurrence + 1}`,
          language: track.language || '',
        };
      });
  }

  function trackChoices(tracks) {
    return builtInTrackEntries(tracks).map(({ id, legacyId, label, language }) => ({
      id,
      legacyId,
      label,
      language,
    }));
  }

  function findBuiltInTrack(tracks, id) {
    const legacy = /^track-(\d+)$/.exec(String(id ?? ''));
    if (legacy) {
      const track = Array.from(tracks ?? [])[Number(legacy[1])];
      return isCaptionTrack(track) ? track : null;
    }
    return builtInTrackEntries(tracks).find((entry) => entry.id === id)?.track ?? null;
  }

  function activeCueText(track) {
    if (!track?.activeCues) return '';
    const lines = [];
    for (const cue of track.activeCues) {
      for (const line of cleanSubtitleText(cue.text).split('\n').map((item) => item.trim()).filter(Boolean)) {
        if (!lines.includes(line)) lines.push(line);
      }
    }
    return lines.join('\n');
  }

  function normalizeSettings(value = {}) {
    const bounded = (number, low, high, fallback) => {
      const parsed = Number(number);
      return Number.isFinite(parsed) ? Math.min(high, Math.max(low, parsed)) : fallback;
    };
    return {
      firstTrackId: typeof value.firstTrackId === 'string' ? value.firstTrackId : '',
      secondTrackId: typeof value.secondTrackId === 'string' ? value.secondTrackId : '',
      firstBottom: bounded(value.firstBottom, 0, 95, 14),
      secondBottom: bounded(value.secondBottom, 0, 95, 5),
      fontSize: bounded(value.fontSize, 12, 48, 22),
      selectedPlayerKey: typeof value.selectedPlayerKey === 'string' ? value.selectedPlayerKey : '',
    };
  }

  function mutationsAffectVideo(records = [], overlay) {
    const isInsideOverlay = (node) => Boolean(
      overlay && node && (node === overlay || overlay.contains?.(node)),
    );
    const containsVideo = (node) => Boolean(
      node
      && !isInsideOverlay(node)
      && (node.matches?.('video') || node.querySelector?.('video')),
    );
    return Array.from(records).some((record) => {
      if (isInsideOverlay(record.target)) return false;
      return [...(record.addedNodes ?? []), ...(record.removedNodes ?? [])].some(containsVideo);
    });
  }

  function chooseVideo(videos) {
    return Array.from(videos)
      .map((video, index) => ({ video, index, rect: video.getBoundingClientRect() }))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]
      ?? { video: null, index: -1 };
  }

  function bindVideoEvents(video, callbacks) {
    const removers = [];
    const trackRemovers = new Map();
    const on = (target, type, listener) => {
      target.addEventListener(type, listener);
      removers.push(() => target.removeEventListener(type, listener));
    };
    const bindTrack = (track) => {
      if (!track || trackRemovers.has(track)) return;
      const listener = callbacks.render;
      track.addEventListener('cuechange', listener);
      trackRemovers.set(track, () => track.removeEventListener('cuechange', listener));
    };
    const unbindTrack = (track) => {
      trackRemovers.get(track)?.();
      trackRemovers.delete(track);
    };

    for (const type of ['timeupdate', 'loadeddata', 'emptied', 'seeking', 'seeked', 'ratechange']) {
      on(video, type, callbacks.render);
    }
    on(video, 'loadedmetadata', () => {
      callbacks.report();
      callbacks.render();
    });
    for (const track of video.textTracks) bindTrack(track);
    on(video.textTracks, 'addtrack', (event) => {
      if (event.track) bindTrack(event.track);
      callbacks.report();
      callbacks.render();
    });
    on(video.textTracks, 'removetrack', (event) => {
      if (event.track) unbindTrack(event.track);
      callbacks.report();
      callbacks.render();
    });

    return () => {
      for (const remove of removers.splice(0).reverse()) remove();
      for (const remove of trackRemovers.values()) remove();
      trackRemovers.clear();
    };
  }

  function createVideoManager(callbacks) {
    let video = null;
    let index = -1;
    let cleanup = null;

    return {
      discover(videos) {
        const candidate = chooseVideo(videos);
        if (!candidate.video) {
          cleanup?.();
          cleanup = null;
          video = null;
          index = -1;
          callbacks.render();
          return null;
        }
        if (candidate.video !== video) {
          cleanup?.();
          video = candidate.video;
          index = candidate.index;
          cleanup = bindVideoEvents(video, callbacks);
        }
        callbacks.report(video, index);
        callbacks.render();
        return { video, index };
      },
      current() {
        return { video, index };
      },
      destroy() {
        cleanup?.();
        cleanup = null;
        video = null;
        index = -1;
      },
    };
  }

  function installController(target, key, factory) {
    const controller = target[key] ?? factory();
    target[key] = controller;
    controller.discover();
    return controller;
  }

  root.DualCaptionsContentRuntime = Object.freeze({
    activeCueText,
    bindVideoEvents,
    chooseVideo,
    cleanSubtitleText,
    createVideoManager,
    cueTextAt,
    findBuiltInTrack,
    installController,
    mutationsAffectVideo,
    normalizeSettings,
    trackChoices,
  });
})(globalThis);
