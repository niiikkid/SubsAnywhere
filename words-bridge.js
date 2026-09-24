const PANEL_ORIGIN = 'http://127.0.0.1:43817';
const EXPLAIN_REQUEST = 'subsanywhere.words.explain';
const TRANSLATE_REQUEST = 'subsanywhere.words.translate';
const SPEECH_GET_REQUEST = 'subsanywhere.speech.get';
const SPEECH_PATCH_REQUEST = 'subsanywhere.speech.patch';
const SPEECH_SPEAK_REQUEST = 'subsanywhere.speech.speak';
const REQUESTS = new Set([
  EXPLAIN_REQUEST, TRANSLATE_REQUEST, SPEECH_GET_REQUEST, SPEECH_PATCH_REQUEST, SPEECH_SPEAK_REQUEST,
]);

if (location.origin === PANEL_ORIGIN && location.pathname === '/words' && !location.search && !location.hash) {
  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== PANEL_ORIGIN || !data
      || !REQUESTS.has(data.type)
      || typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(data.requestId)) return;

    const translate = data.type === TRANSLATE_REQUEST;
    const explain = data.type === EXPLAIN_REQUEST;
    if ((translate || explain) && (!['words', 'sentences'].includes(data.kind)
      || !Number.isSafeInteger(data.id) || data.id < 1 || (translate && data.kind !== 'words'))) return;
    if (data.type === SPEECH_PATCH_REQUEST
      && ((!Number.isFinite(Number(data.rate)) || Number(data.rate) < 0.5 || Number(data.rate) > 1)
        || typeof data.voiceName !== 'string' || data.voiceName.length > 160)) return;
    if (data.type === SPEECH_SPEAK_REQUEST
      && (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 2_000
        || !['zh', 'en'].includes(data.language))) return;

    let response;
    try {
      let message;
      if (translate || explain) {
        const sentence = data.kind === 'sentences';
        message = {
          type: translate ? 'dualCaptions.words.translate' : (sentence ? 'dualCaptions.sentences.explain' : 'dualCaptions.words.explain'),
          id: data.id,
        };
      } else if (data.type === SPEECH_GET_REQUEST) {
        message = { type: 'dualCaptions.speech.settings.get' };
      } else if (data.type === SPEECH_PATCH_REQUEST) {
        message = { type: 'dualCaptions.speech.settings.patch', rate: Number(data.rate), voiceName: data.voiceName };
      } else {
        message = { type: 'dualCaptions.speech.speak', text: data.text, language: data.language };
      }
      const result = await chrome.runtime.sendMessage(message);
      if (!result?.ok) throw new Error(result?.error || 'Расширение не выполнило действие');
      if (translate || explain) {
        const key = data.kind === 'sentences' ? 'sentence' : 'word';
        response = { ok: true, [key]: result.data?.[key] };
      } else {
        response = { ok: true, ...(result.data || {}) };
      }
    } catch (error) {
      response = { ok: false, error: error?.message || 'Расширение недоступно. Перезагрузите его на странице chrome://extensions' };
    }
    window.postMessage({ type: `${data.type}.result`, requestId: data.requestId, ...response }, PANEL_ORIGIN);
  });
}
