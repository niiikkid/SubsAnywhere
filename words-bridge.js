const PANEL_ORIGIN = 'http://127.0.0.1:43817';
const REQUEST = 'subsanywhere.words.explain';
const RESPONSE = 'subsanywhere.words.explain.result';

if (location.origin === PANEL_ORIGIN && location.pathname === '/words' && !location.search && !location.hash) {
  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== PANEL_ORIGIN || !data || data.type !== REQUEST
      || typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(data.requestId)
      || !Number.isSafeInteger(data.id) || data.id < 1) return;

    let response;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'dualCaptions.words.explain', id: data.id });
      response = result?.ok ? { ok: true, word: result.data?.word } : { ok: false, error: result?.error || 'Не удалось получить объяснение' };
    } catch {
      response = { ok: false, error: 'Расширение недоступно. Перезагрузите его на странице chrome://extensions' };
    }
    window.postMessage({ type: RESPONSE, requestId: data.requestId, ...response }, PANEL_ORIGIN);
  });
}
