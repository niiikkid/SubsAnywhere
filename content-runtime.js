((root) => {
  const cueIndexCache = new WeakMap();

  function cleanSubtitleText(value) {
    return String(value ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .trim();
  }

  function captionSegments(text, items = []) {
    const source = String(text ?? '');
    const segments = [];
    let cursor = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const start = Number(item?.start);
      const end = Number(item?.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end <= start || end > source.length) continue;
      if (start > cursor) segments.push({ text: source.slice(cursor, start), item: null });
      segments.push({ text: source.slice(start, end), item });
      cursor = end;
    }
    if (cursor < source.length) segments.push({ text: source.slice(cursor), item: null });
    return segments;
  }

  function cueTextAt(cues, videoTime, offsetSeconds = 0, timeScale = 1) {
    const scale = Number(timeScale);
    const sourceTime = (Number(videoTime) - Number(offsetSeconds || 0)) / (Number.isFinite(scale) && scale > 0 ? scale : 1);
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
    const identityOccurrences = new Map();
    return Array.from(tracks ?? [])
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => isCaptionTrack(track))
      .map(({ track, index }, captionIndex) => {
        const nativeId = typeof track.id === 'string' ? track.id.trim() : '';
        const fingerprint = nativeId
          ? `id:${nativeId}`
          : `meta:${track.kind || ''}|${track.language || ''}|${track.label || ''}`;
        const occurrence = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, occurrence + 1);
        const identityFingerprint = `meta:${track.kind || ''}|${track.language || ''}|${track.label || ''}`;
        const identityOccurrence = identityOccurrences.get(identityFingerprint) ?? 0;
        identityOccurrences.set(identityFingerprint, identityOccurrence + 1);
        return {
          track,
          id: `builtin:${encodeURIComponent(fingerprint)}:${occurrence}`,
          legacyId: `track-${index}`,
          fallbackId: `caption-${captionIndex}`,
          identity: `${identityFingerprint}:${identityOccurrence}`,
          label: track.label || track.language || `Субтитры ${occurrence + 1}`,
          language: track.language || '',
        };
      });
  }

  function trackChoices(tracks) {
    return builtInTrackEntries(tracks).map(({ id, legacyId, fallbackId, label, language }) => ({
      id,
      legacyId,
      fallbackId,
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

  function createBuiltInTrackResolver() {
    const rememberedSelections = new Map();
    return {
      find(tracks, id, fallbackId = '') {
        if (!id) return null;
        const entries = builtInTrackEntries(tracks);
        const exactIndex = entries.findIndex((entry) => entry.id === id);
        if (exactIndex >= 0) {
          rememberedSelections.set(id, { identity: entries[exactIndex].identity, index: exactIndex });
          return entries[exactIndex].track;
        }
        const remembered = rememberedSelections.get(id);
        const rememberedTrack = remembered
          ? entries.find((entry) => entry.identity === remembered.identity)?.track
            ?? entries[remembered.index]?.track
          : null;
        if (rememberedTrack) return rememberedTrack;
        const fallback = /^caption-(\d+)$/.exec(String(fallbackId));
        const fallbackTrack = fallback ? entries[Number(fallback[1])]?.track ?? null : null;
        if (fallbackTrack) return fallbackTrack;
        const legacyIndex = entries.findIndex((entry) => entry.legacyId === id);
        if (legacyIndex >= 0) {
          rememberedSelections.set(id, { identity: entries[legacyIndex].identity, index: legacyIndex });
          return entries[legacyIndex].track;
        }
        return null;
      },
    };
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

  function sampleTextTrack(track, limit = 24) {
    const cues = Array.from(track?.cues ?? [])
      .map((cue) => ({
        start: Number(cue.startTime ?? cue.start),
        end: Number(cue.endTime ?? cue.end),
        text: cleanSubtitleText(cue.text),
      }))
      .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && cue.text);
    if (!cues.length) return [];
    const maximum = Math.max(3, Math.min(40, Number(limit) || 24));
    if (cues.length <= maximum) return cues;
    const samples = [];
    const first = Math.floor(cues.length * 0.05);
    const last = Math.max(first, Math.floor(cues.length * 0.95) - 1);
    for (let position = 0; position < maximum; position += 1) {
      const index = Math.round(first + ((last - first) * position) / Math.max(1, maximum - 1));
      if (cues[index] && samples.at(-1) !== cues[index]) samples.push(cues[index]);
    }
    return samples;
  }

  function normalizeSettings(value = {}) {
    const bounded = (number, low, high, fallback) => {
      const parsed = Number(number);
      return Number.isFinite(parsed) ? Math.min(high, Math.max(low, parsed)) : fallback;
    };
    return {
      firstTrackId: typeof value.firstTrackId === 'string' ? value.firstTrackId : '',
      firstTrackFallbackId: typeof value.firstTrackFallbackId === 'string' ? value.firstTrackFallbackId : '',
      secondTrackId: typeof value.secondTrackId === 'string' ? value.secondTrackId : '',
      secondTrackFallbackId: typeof value.secondTrackFallbackId === 'string' ? value.secondTrackFallbackId : '',
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
      if (event.track) callbacks.trackRemoved?.(event.track);
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
          cleanup = bindVideoEvents(video, {
            render: callbacks.render,
            report: () => callbacks.report(video, index),
            trackRemoved: callbacks.trackRemoved,
          });
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
    captionSegments,
    chooseVideo,
    cleanSubtitleText,
    createBuiltInTrackResolver,
    createVideoManager,
    cueTextAt,
    findBuiltInTrack,
    installController,
    mutationsAffectVideo,
    normalizeSettings,
    sampleTextTrack,
    trackChoices,
  });
})(globalThis);
