export const MESSAGE = Object.freeze({
  PLAYER_REPORT: 'dualCaptions.player.report',
  PLAYER_DISCOVER: 'dualCaptions.player.discover',
  PLAYER_GET: 'dualCaptions.player.get',
  PLAYER_SELECT: 'dualCaptions.player.select',
  STATE_GET: 'dualCaptions.state.get',
  STATE_PATCH: 'dualCaptions.state.patch',
  TRACK_ADD: 'dualCaptions.track.add',
  TRACK_REMOVE: 'dualCaptions.track.remove',
  TRACK_OFFSET: 'dualCaptions.track.offset',
  CONTENT_FULL_STATE: 'dualCaptions.content.fullState',
  CONTENT_SETTINGS: 'dualCaptions.content.settings',
  CONTENT_TRACKS: 'dualCaptions.content.tracks',
});

export const ok = (data = {}) => ({ ok: true, data });
export const failure = (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
