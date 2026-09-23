(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SubsAnywherePanelLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function limits(viewport, options = {}) {
    const margin = Math.max(0, Number(options.margin) || 8);
    const width = Math.max(0, Number(viewport?.width) || 0);
    const height = Math.max(0, Number(viewport?.height) || 0);
    const maximumWidth = Math.max(0, width - margin * 2);
    const maximumHeight = Math.max(0, height - margin * 2);
    return {
      margin,
      maximumWidth,
      maximumHeight,
      minimumWidth: Math.min(Math.max(0, Number(options.minWidth) || 340), maximumWidth),
      minimumHeight: Math.min(Math.max(0, Number(options.minHeight) || 360), maximumHeight),
    };
  }

  function fitRect(rect, viewport, options = {}) {
    const bounds = limits(viewport, options);
    const width = clamp(Number(rect?.width) || 400, bounds.minimumWidth, bounds.maximumWidth);
    const height = clamp(Number(rect?.height) || 760, bounds.minimumHeight, bounds.maximumHeight);
    const maximumLeft = bounds.margin + bounds.maximumWidth - width;
    const maximumTop = bounds.margin + bounds.maximumHeight - height;
    return {
      left: clamp(Number(rect?.left) || bounds.margin, bounds.margin, maximumLeft),
      top: clamp(Number(rect?.top) || bounds.margin, bounds.margin, maximumTop),
      width,
      height,
    };
  }

  function moveOrResize(startRect, deltaX, deltaY, direction, viewport, options = {}) {
    const bounds = limits(viewport, options);
    const start = fitRect(startRect, viewport, options);
    const dx = Number(deltaX) || 0;
    const dy = Number(deltaY) || 0;
    if (direction === 'move') {
      return fitRect({ ...start, left: start.left + dx, top: start.top + dy }, viewport, options);
    }

    const originalRight = start.left + start.width;
    const originalBottom = start.top + start.height;
    let left = start.left;
    let top = start.top;
    let right = originalRight;
    let bottom = originalBottom;
    if (direction.includes('w')) left = clamp(start.left + dx, bounds.margin, originalRight - bounds.minimumWidth);
    if (direction.includes('e')) right = clamp(originalRight + dx, start.left + bounds.minimumWidth, bounds.margin + bounds.maximumWidth);
    if (direction.includes('n')) top = clamp(start.top + dy, bounds.margin, originalBottom - bounds.minimumHeight);
    if (direction.includes('s')) bottom = clamp(originalBottom + dy, start.top + bounds.minimumHeight, bounds.margin + bounds.maximumHeight);
    return { left, top, width: right - left, height: bottom - top };
  }

  function resolveLayout(state = {}) {
    return state.isYouTubeWatch && state.hasSidebar && !state.theater
      && !state.fullscreen && !state.manuallyFloating ? 'docked' : 'floating';
  }

  function fitDockedHeight(preferredHeight, videoHeight, viewportHeight, options = {}) {
    const minimumHeight = Math.max(0, Number(options.minHeight) || 240);
    const viewportMaximum = Math.max(0, (Number(viewportHeight) || 0) - 48);
    const videoMaximum = Number(videoHeight) > 0 ? Number(videoHeight) : viewportMaximum;
    const maximumHeight = Math.max(0, Math.min(viewportMaximum, videoMaximum));
    const effectiveMinimum = Math.min(minimumHeight, maximumHeight);
    return clamp(Number(preferredHeight) || maximumHeight, effectiveMinimum, maximumHeight);
  }

  return { fitDockedHeight, fitRect, moveOrResize, resolveLayout };
});
