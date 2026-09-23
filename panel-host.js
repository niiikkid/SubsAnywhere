(() => {
  'use strict';

  if (globalThis.__subsAnywherePanelHost) return;
  globalThis.__subsAnywherePanelHost = true;

  const layout = globalThis.SubsAnywherePanelLayout;
  if (!layout) return;

  const HOST_ID = 'subs-anywhere-panel-host';
  const PANEL_GET = 'dualCaptions.panel.get';
  const PANEL_PATCH = 'dualCaptions.panel.patch';
  const PANEL_TOGGLE = 'dualCaptions.panel.toggle';
  const PANEL_SHOW = 'dualCaptions.panel.show';
  const LIMITS = { margin: 8, minWidth: 340, minHeight: 360 };
  const PANEL_LAYOUT_VERSION = 2;
  const DOCKED_MIN_HEIGHT = 240;
  const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

  let host;
  let shadow;
  let frame;
  let shell;
  let visible = false;
  let currentLayout = 'floating';
  let manuallyFloating = false;
  let floatingRect = null;
  let dockedHeight = 760;
  let drag = null;
  let saveTimer;

  const STYLE = `
    :host {
      all: initial;
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      color-scheme: dark;
    }
    :host([hidden]) { display: none !important; }
    :host([data-layout="docked"]) {
      position: relative;
      inset: auto;
      display: block;
      width: 100%;
      margin: 0 0 16px;
      pointer-events: auto;
    }
    * { box-sizing: border-box; }
    .shell {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: auto;
      border: 1px solid rgba(255, 255, 255, .15);
      border-radius: 18px;
      background: #101217;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .58);
    }
    :host([data-layout="docked"]) .shell {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .3);
    }
    iframe {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      border-radius: inherit;
      background: #101217;
    }
    .resize-handle {
      position: absolute;
      z-index: 3;
      pointer-events: auto;
      touch-action: none;
    }
    .n, .s { left: 12px; width: calc(100% - 24px); height: 8px; cursor: ns-resize; }
    .n { top: 0; }
    .s { bottom: 0; }
    .e, .w { top: 12px; width: 8px; height: calc(100% - 24px); cursor: ew-resize; }
    .e { right: 0; }
    .w { left: 0; }
    .ne, .nw, .se, .sw { width: 16px; height: 16px; }
    .ne { top: 0; right: 0; cursor: nesw-resize; }
    .nw { top: 0; left: 0; cursor: nwse-resize; }
    .se { right: 0; bottom: 0; cursor: nwse-resize; }
    .sw { left: 0; bottom: 0; cursor: nesw-resize; }
    :host([data-layout="docked"]) .n,
    :host([data-layout="docked"]) .e,
    :host([data-layout="docked"]) .w,
    :host([data-layout="docked"]) .ne,
    :host([data-layout="docked"]) .nw,
    :host([data-layout="docked"]) .se,
    :host([data-layout="docked"]) .sw { display: none; }
  `;

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function rect() {
    const box = host.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }

  function defaultRect() {
    const width = Math.min(400, Math.max(340, window.innerWidth - 16));
    const previousHeight = Math.min(820, Math.max(360, window.innerHeight - 88));
    const height = Math.max(LIMITS.minHeight, Math.round(previousHeight * .8));
    return layout.fitRect({ left: window.innerWidth - width - 20, top: 68, width, height }, viewport(), LIMITS);
  }

  function applyFloatingRect(next) {
    floatingRect = layout.fitRect(next || floatingRect || defaultRect(), viewport(), LIMITS);
    host.style.left = `${Math.round(floatingRect.left)}px`;
    host.style.top = `${Math.round(floatingRect.top)}px`;
    host.style.width = `${Math.round(floatingRect.width)}px`;
    host.style.height = `${Math.round(floatingRect.height)}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  }

  function clearFloatingRect() {
    host.style.left = '';
    host.style.top = '';
    host.style.right = '';
    host.style.bottom = '';
    host.style.width = '';
  }

  function request(type, payload = {}) {
    try {
      return chrome.runtime.sendMessage({ type, ...payload });
    } catch {
      return Promise.resolve({ ok: false });
    }
  }

  function persist(patch, immediate = false) {
    clearTimeout(saveTimer);
    const save = () => request(PANEL_PATCH, { patch }).catch(() => undefined);
    if (immediate) void save();
    else saveTimer = setTimeout(save, 100);
  }

  function isYouTubeWatch() {
    return YOUTUBE_HOSTS.has(location.hostname) && location.pathname === '/watch';
  }

  function watchFlexy() {
    return document.querySelector('ytd-watch-flexy');
  }

  function youtubeSidebar() {
    if (!isYouTubeWatch()) return null;
    return document.querySelector('ytd-watch-flexy #secondary-inner') || document.querySelector('#secondary-inner');
  }

  function youtubePlayerHeight() {
    for (const selector of [
      'ytd-watch-flexy #movie_player',
      'ytd-watch-flexy #player-container-inner',
      'ytd-watch-flexy video',
    ]) {
      const height = document.querySelector(selector)?.getBoundingClientRect().height;
      if (height > 0) return height;
    }
    return 0;
  }

  function fittedDockedHeight(value = dockedHeight) {
    return layout.fitDockedHeight(value, youtubePlayerHeight(), window.innerHeight, {
      minHeight: DOCKED_MIN_HEIGHT,
    });
  }

  function floatingParent() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.documentElement;
  }

  function postFrameState(sidebar = youtubeSidebar()) {
    if (!frame?.contentWindow) return;
    const flexy = watchFlexy();
    const dockable = isYouTubeWatch() && Boolean(sidebar)
      && !document.fullscreenElement && !document.webkitFullscreenElement
      && !flexy?.hasAttribute('theater');
    frame.contentWindow.postMessage({
      source: 'subs-anywhere-host',
      type: 'panel-state',
      layout: currentLayout,
      dockable,
    }, '*');
  }

  function placeFloating(preferredRect = null) {
    const parent = floatingParent();
    host.dataset.layout = 'floating';
    currentLayout = 'floating';
    if (host.parentElement !== parent) parent.append(host);
    host.style.margin = '';
    applyFloatingRect(preferredRect || floatingRect || defaultRect());
    postFrameState();
  }

  function placeDocked(sidebar) {
    if (!sidebar) return;
    if (currentLayout === 'floating') floatingRect = rect();
    host.dataset.layout = 'docked';
    currentLayout = 'docked';
    if (host.parentElement !== sidebar || sidebar.firstElementChild !== host) sidebar.prepend(host);
    clearFloatingRect();
    host.style.height = `${Math.round(fittedDockedHeight())}px`;
    postFrameState(sidebar);
  }

  function syncPlacement(preferredRect = null) {
    if (!visible || !host) return;
    const sidebar = youtubeSidebar();
    const flexy = watchFlexy();
    const next = layout.resolveLayout({
      isYouTubeWatch: isYouTubeWatch(),
      hasSidebar: Boolean(sidebar && sidebar.getBoundingClientRect().width),
      theater: Boolean(flexy?.hasAttribute('theater')),
      fullscreen: Boolean(document.fullscreenElement || document.webkitFullscreenElement),
      manuallyFloating,
    });
    if (next === 'docked') {
      placeDocked(sidebar);
      return;
    }
    const previous = currentLayout === 'docked' ? rect() : null;
    const parent = floatingParent();
    if (currentLayout !== 'floating' || host.parentElement !== parent || preferredRect) {
      placeFloating(preferredRect || previous || floatingRect);
    } else {
      const current = rect();
      applyFloatingRect(floatingRect || (current.width && current.height ? current : defaultRect()));
      postFrameState(sidebar);
    }
  }

  function show(shouldPersist = true) {
    visible = true;
    host.hidden = false;
    syncPlacement();
    if (shouldPersist) persist({ open: true }, true);
  }

  function hide(shouldPersist = true) {
    visible = false;
    host.hidden = true;
    if (shouldPersist) persist({ open: false }, true);
  }

  function toggle() {
    if (visible) hide();
    else show();
  }

  function toggleDock() {
    if (!isYouTubeWatch()) return;
    const current = rect();
    manuallyFloating = currentLayout === 'docked';
    syncPlacement(manuallyFloating ? current : null);
  }

  function startResize(event, direction) {
    if (event.button !== 0 || !event.isPrimary) return;
    if (currentLayout === 'docked' && direction !== 's') return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const start = rect();
    const startX = event.clientX;
    const startY = event.clientY;
    target.setPointerCapture?.(event.pointerId);

    const move = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      if (currentLayout === 'docked') {
        const maximum = fittedDockedHeight(1_000_000);
        const minimum = Math.min(DOCKED_MIN_HEIGHT, maximum);
        dockedHeight = Math.min(Math.max(start.height + moveEvent.clientY - startY, minimum), maximum);
        host.style.height = `${Math.round(dockedHeight)}px`;
        return;
      }
      applyFloatingRect(layout.moveOrResize(start, moveEvent.clientX - startX,
        moveEvent.clientY - startY, direction, viewport(), LIMITS));
    };
    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== event.pointerId) return;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', finish);
      if (currentLayout === 'docked') persist({ dockedHeight: Math.round(dockedHeight) });
      else persist({ rect: floatingRect });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', finish);
  }

  function handleFrameMessage(event) {
    if (event.source !== frame?.contentWindow || event.data?.source !== 'subs-anywhere-frame') return;
    const message = event.data;
    if (message.type === 'close') {
      hide();
      return;
    }
    if (message.type === 'dock-toggle') {
      toggleDock();
      return;
    }
    if (message.type === 'ready') {
      postFrameState();
      return;
    }
    if (message.type === 'drag-start') {
      const current = rect();
      if (currentLayout === 'docked') {
        manuallyFloating = true;
        syncPlacement(current);
      }
      drag = { screenX: Number(message.screenX), screenY: Number(message.screenY), rect: rect() };
      return;
    }
    if (message.type === 'drag-move' && drag) {
      applyFloatingRect(layout.moveOrResize(drag.rect,
        Number(message.screenX) - drag.screenX, Number(message.screenY) - drag.screenY,
        'move', viewport(), LIMITS));
      return;
    }
    if (message.type === 'drag-end' && drag) {
      drag = null;
      persist({ rect: floatingRect });
    }
  }

  function build() {
    const stale = document.getElementById(HOST_ID);
    stale?.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.hidden = true;
    host.dataset.layout = 'floating';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${STYLE}</style>
      <section class="shell" aria-label="SubsAnywhere">
        <iframe title="SubsAnywhere" src="${chrome.runtime.getURL('popup.html?embedded=1')}"></iframe>
        ${['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map((direction) =>
          `<div class="resize-handle ${direction}" data-resize="${direction}" aria-hidden="true"></div>`).join('')}
      </section>`;
    frame = shadow.querySelector('iframe');
    shell = shadow.querySelector('.shell');
    for (const handle of shadow.querySelectorAll('[data-resize]')) {
      handle.addEventListener('pointerdown', (event) => startResize(event, handle.dataset.resize));
    }
    document.documentElement.append(host);
  }

  async function initialize() {
    build();
    window.addEventListener('message', handleFrameMessage);
    const response = await request(PANEL_GET).catch(() => null);
    const state = response?.ok ? response.data : {};
    floatingRect = state?.rect || null;
    dockedHeight = Math.max(DOCKED_MIN_HEIGHT, Number(state?.dockedHeight) || 760);
    if ((Number(state?.layoutVersion) || 0) < PANEL_LAYOUT_VERSION) {
      if (floatingRect) {
        floatingRect = {
          ...floatingRect,
          height: Math.max(LIMITS.minHeight, Math.round(Number(floatingRect.height) * .8)),
        };
      }
      persist({ rect: floatingRect, layoutVersion: PANEL_LAYOUT_VERSION }, true);
    }
    if (state?.open !== false) show(false);
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === PANEL_TOGGLE) {
      toggle();
      reply({ ok: true });
      return false;
    }
    if (message?.type === PANEL_SHOW) {
      show();
      reply({ ok: true });
      return false;
    }
    return false;
  });

  document.addEventListener('yt-navigate-finish', () => syncPlacement(), true);
  document.addEventListener('fullscreenchange', () => syncPlacement());
  document.addEventListener('webkitfullscreenchange', () => syncPlacement());
  window.addEventListener('resize', () => {
    syncPlacement();
    if (visible && currentLayout === 'floating') {
      const current = rect();
      applyFloatingRect(floatingRect || (current.width && current.height ? current : defaultRect()));
    }
  });
  if (YOUTUBE_HOSTS.has(location.hostname)) setInterval(syncPlacement, 700);
  void initialize();
})();
