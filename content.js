(() => {
  const runtime = globalThis.DualCaptionsContentRuntime;
  if (!runtime) return;

  const CONTROLLER_KEY = '__dualCaptionsControllerV3';
  const MESSAGE = Object.freeze({
    PLAYER_REPORT: 'dualCaptions.player.report',
    CONTENT_FULL_STATE: 'dualCaptions.content.fullState',
    CONTENT_SETTINGS: 'dualCaptions.content.settings',
    CONTENT_TRACKS: 'dualCaptions.content.tracks',
  });
  function createController() {
    const state = {
      active: false,
      settings: runtime.normalizeSettings(),
      externalTracks: [],
      root: null,
      first: null,
      second: null,
    };
    const builtInTrackResolver = runtime.createBuiltInTrackResolver();
    const originalTrackModes = new Map();
    const cleanup = [];



    function ensureOverlay() {
      if (state.root?.isConnected) return;
      const root = document.createElement('div');
      root.id = 'dual-captions-overlay';
      root.setAttribute('aria-hidden', 'true');
      root.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;overflow:hidden;';
      const makeLayer = (name) => {
        const element = document.createElement('div');
        element.className = name;
        element.style.cssText = 'position:absolute;left:4%;right:4%;color:#fff;text-align:center;font-family:Arial,sans-serif;font-weight:700;line-height:1.25;white-space:pre-line;text-shadow:-2px -2px 2px #000,2px 2px 2px #000,0 0 7px #000;';
        root.append(element);
        return element;
      };
      state.first = makeLayer('dual-captions-first');
      state.second = makeLayer('dual-captions-second');
      document.documentElement.append(root);
      state.root = root;
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

    function selectedText(id, video) {
      if (!id) return '';
      if (id.startsWith('external:')) {
        const external = state.externalTracks.find((track) => `external:${track.id}` === id);
        return external ? runtime.cueTextAt(external.cues, video.currentTime, external.offsetSeconds) : '';
      }
      return runtime.activeCueText(builtInTrackResolver.find(video.textTracks, id));
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
      state.first.textContent = selectedText(state.settings.firstTrackId, video);
      state.second.textContent = selectedText(state.settings.secondTrackId, video);
      state.first.style.bottom = `${state.settings.firstBottom}%`;
      state.second.style.bottom = `${state.settings.secondBottom}%`;
      state.first.style.fontSize = `${state.settings.fontSize}px`;
      state.second.style.fontSize = `${state.settings.fontSize}px`;
      positionOverlay();
    }

    function report(video, videoIndex) {
      chrome.runtime.sendMessage({
        type: MESSAGE.PLAYER_REPORT,
        player: {
          title: document.title,
          frameUrl: location.href,
          videoIndex,
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
        state.root?.remove();
      },
    };
  }

  runtime.installController(globalThis, CONTROLLER_KEY, createController);
})();
