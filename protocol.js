export const MESSAGE = Object.freeze({
  PLAYER_REPORT: 'dualCaptions.player.report',
  PLAYER_DISCOVER: 'dualCaptions.player.discover',
  PLAYER_GET: 'dualCaptions.player.get',
  PLAYER_SELECT: 'dualCaptions.player.select',
  STATE_GET: 'dualCaptions.state.get',
  STATE_PATCH: 'dualCaptions.state.patch',
  TRACK_ADD: 'dualCaptions.track.add',
  TRACK_UPSERT_LOCAL: 'dualCaptions.track.upsertLocal',
  TRACK_CACHE_BUILTIN: 'dualCaptions.track.cacheBuiltin',
  TRACK_REMOVE: 'dualCaptions.track.remove',
  TRACK_OFFSET: 'dualCaptions.track.offset',
  TRACK_TIMING: 'dualCaptions.track.timing',
  AI_CONFIG_GET: 'dualCaptions.ai.get',
  AI_CONFIG_PATCH: 'dualCaptions.ai.patch',
  AI_MODELS_GET: 'dualCaptions.ai.models.get',
  PANEL_AI_GET: 'dualCaptions.panel.ai.get',
  PANEL_AI_MODELS: 'dualCaptions.panel.ai.models',
  PANEL_AI_SAVE: 'dualCaptions.panel.ai.save',
  CAPTION_TRANSLATE: 'dualCaptions.caption.translate',
  WORDS_LIST: 'dualCaptions.words.list',
  WORDS_SAVE: 'dualCaptions.words.save',
  WORD_EXPLAIN: 'dualCaptions.words.explain',
  WORD_TRANSLATE: 'dualCaptions.words.translate',
  WORD_ANALYZE: 'dualCaptions.words.analyze',
  SENTENCE_ANALYZE: 'dualCaptions.sentences.analyze',
  SENTENCES_LIST: 'dualCaptions.sentences.list',
  SENTENCES_SAVE: 'dualCaptions.sentences.save',
  SENTENCE_EXPLAIN: 'dualCaptions.sentences.explain',
  SPEECH_SETTINGS_GET: 'dualCaptions.speech.settings.get',
  SPEECH_SETTINGS_PATCH: 'dualCaptions.speech.settings.patch',
  SPEECH_SPEAK: 'dualCaptions.speech.speak',
  LOCAL_SUBTITLE_EXISTING: 'dualCaptions.localSubtitle.existing',
  LOCAL_SUBTITLE_GENERATE: 'dualCaptions.localSubtitle.generate',
  LOCAL_SUBTITLE_STATUS: 'dualCaptions.localSubtitle.status',
  CONTENT_FULL_STATE: 'dualCaptions.content.fullState',
  CONTENT_SETTINGS: 'dualCaptions.content.settings',
  CONTENT_TRACKS: 'dualCaptions.content.tracks',
  CONTENT_POSITION_PATCH: 'dualCaptions.content.positionPatch',
  CONTENT_RESET: 'dualCaptions.content.reset',
  PANEL_STATE_GET: 'dualCaptions.panel.get',
  PANEL_STATE_PATCH: 'dualCaptions.panel.patch',
  PANEL_CONTEXT_GET: 'dualCaptions.panel.context',
  PANEL_TOGGLE: 'dualCaptions.panel.toggle',
  PANEL_SHOW: 'dualCaptions.panel.show',
});

// Shared strict analysis boundary: reject incomplete output; never truncate or repair it.
export function validateChineseAnalysis(value, { text, pinyinLimit = 500 } = {}) {
  const invalid = () => { throw new Error('Некорректный или неполный разбор китайского текста'); };
  // Match the SQLite boundary before comparison and persistence.
  value = JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string') return item;
    if (/\p{C}/u.test(item)) invalid();
    return item.normalize('NFC').trim().replace(/\s+/gu, ' ');
  }));
  const object = (item, keys) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).length !== keys.length || keys.some((key) => !Object.hasOwn(item, key))) invalid();
  };
  const field = (item, limit, han = false) => {
    if (typeof item !== 'string' || !item.trim() || item.length > limit
      || /[\u0000-\u001f\u007f]/u.test(item) || (!han && /\p{Script=Han}/u.test(item))) invalid();
    return item;
  };
  const source = (item) => {
    field(item, 500, true);
    if (!/\p{Script=Han}/u.test(item) || !/^[\p{Script=Han}\p{P}\p{Zs}]+$/u.test(item)) invalid();
    return item.replace(/[\p{P}\s]/gu, '');
  };
  const syllables = (item, limit) => {
    field(item, limit);
    if (!/^[\p{Script=Latin}\p{M}\p{P}\p{Zs}1-5]+$/u.test(item)) invalid();
    const parts = item.match(/\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:[1-5])?/gu) ?? [];
    if (!parts.length) invalid();
    return parts;
  };
  object(value, ['pinyin', 'translation', 'components', 'grammar', 'example']);
  const fullPinyin = syllables(value.pinyin, pinyinLimit);
  field(value.translation, 1000);
  field(value.grammar, 700);
  object(value.example, ['pinyin', 'translation']);
  syllables(value.example.pinyin, 300);
  field(value.example.translation, 300);
  if (!Array.isArray(value.components) || !value.components.length || value.components.length > 120) invalid();
  let coverage = '';
  const componentPinyin = [];
  for (const part of value.components) {
    object(part, ['text', 'pinyin', 'translation', 'usage']);
    field(part.text, 120, true);
    const han = source(part.text);
    const pronunciation = syllables(part.pinyin, 120);
    if ([...han].length !== pronunciation.length) invalid();
    coverage += han;
    componentPinyin.push(...pronunciation);
    field(part.translation, 160);
    field(part.usage, 240);
  }
  if (text !== undefined && coverage !== source(text)) invalid();
  if (JSON.stringify(componentPinyin) !== JSON.stringify(fullPinyin)) invalid();
  // Copy only the validated contract, preserving every occurrence and value exactly.
  return {
    pinyin: value.pinyin, translation: value.translation,
    components: value.components.map(({ text: han, pinyin, translation, usage }) => ({ text: han, pinyin, translation, usage })),
    grammar: value.grammar, example: { pinyin: value.example.pinyin, translation: value.example.translation },
  };
}

export const ok = (data = {}) => ({ ok: true, data });
export const failure = (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
