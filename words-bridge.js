const PANEL_ORIGIN = 'http://127.0.0.1:43817';
const EXPLAIN_REQUEST = 'subsanywhere.words.explain';
const TRANSLATE_REQUEST = 'subsanywhere.words.translate';

if (location.origin === PANEL_ORIGIN && location.pathname === '/words' && !location.search && !location.hash) {
  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== PANEL_ORIGIN || !data
      || ![EXPLAIN_REQUEST, TRANSLATE_REQUEST].includes(data.type)
      || typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(data.requestId)
      || !['words', 'sentences'].includes(data.kind)
      || !Number.isSafeInteger(data.id) || data.id < 1) return;

    const translate = data.type === TRANSLATE_REQUEST;
    if (translate && data.kind !== 'words') return;

    let response;
    try {
      const sentence = data.kind === 'sentences';
      const result = await chrome.runtime.sendMessage({
        type: translate ? 'dualCaptions.words.translate' : (sentence ? 'dualCaptions.sentences.explain' : 'dualCaptions.words.explain'),
        id: data.id,
      });
      response = result?.ok
        ? { ok: true, [sentence ? 'sentence' : 'word']: result.data?.[sentence ? 'sentence' : 'word'] }
        : { ok: false, error: result?.error || (translate ? 'Не удалось получить перевод' : 'Не удалось получить объяснение') };
    } catch {
      response = { ok: false, error: 'Расширение недоступно. Перезагрузите его на странице chrome://extensions' };
    }
    window.postMessage({ type: `${data.type}.result`, requestId: data.requestId, ...response }, PANEL_ORIGIN);
  });
}
