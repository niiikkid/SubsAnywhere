export const MESSAGE = Object.freeze({
  PLAYER_REPORT: 'dualCaptions.player.report',
  PLAYER_DISCOVER: 'dualCaptions.player.discover',
  PLAYER_GET: 'dualCaptions.player.get',
  PLAYER_SELECT: 'dualCaptions.player.select',
  STATE_GET: 'dualCaptions.state.get',
  STATE_PATCH: 'dualCaptions.state.patch',
  TRACK_ADD: 'dualCaptions.track.add',
  TRACK_CACHE_BUILTIN: 'dualCaptions.track.cacheBuiltin',
  TRACK_REMOVE: 'dualCaptions.track.remove',
  TRACK_OFFSET: 'dualCaptions.track.offset',
  TRACK_TIMING: 'dualCaptions.track.timing',
  AI_CONFIG_GET: 'dualCaptions.ai.get',
  AI_CONFIG_PATCH: 'dualCaptions.ai.patch',
  CAPTION_TRANSLATE: 'dualCaptions.caption.translate',
  CONTENT_FULL_STATE: 'dualCaptions.content.fullState',
  CONTENT_SETTINGS: 'dualCaptions.content.settings',
  CONTENT_TRACKS: 'dualCaptions.content.tracks',
  CONTENT_RESET: 'dualCaptions.content.reset',
});

export const ok = (data = {}) => ({ ok: true, data });
export const failure = (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
