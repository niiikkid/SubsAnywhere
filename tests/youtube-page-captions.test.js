import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageCaptionPayload, readYouTubePageCaptions } from '../youtube-page-captions.js';
import { parseSrt } from '../caption-core.js';

const videoId = 'repevhXG7W0';
const captionBody = JSON.stringify({ events: [
  { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: '你好，世界' }] },
  { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: 'Hello' }, { utf8: ' again' }] },
] });
const track = (languageCode, kind = '') => ({ languageCode, kind,
  baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${languageCode}${kind ? `&kind=${kind}` : ''}` });

function harness({ direct = true, tracks = [track('zh'), track('en')], nativeFetch = false } = {}) {
  const calls = [];
  const selections = [];
  const playerResponse = { videoDetails: { videoId }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } };
  const intervals = new Set();
  let option = { languageCode: 'ru', kind: '' };
  class XHR {
    listeners = new Map();
    responseText = captionBody;
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    open() { this.listeners.get('load')?.(); }
  }
  const originalOpen = XHR.prototype.open;
  const player = {
    getPlayerResponse: () => playerResponse,
    loadModule() {},
    getOption(_module, key) { return key === 'tracklist' ? tracks : option; },
    setOption(_module, _key, value) {
      option = value;
      selections.push(value.languageCode || 'off');
      if (['en', 'zh', 'zh-Hant'].includes(value.languageCode)) {
        const url = tracks.find((item) => item.languageCode === value.languageCode).baseUrl;
        if (nativeFetch) void context.fetch(url);
        else new XHR().open('GET', url);
      }
    },
  };
  const originalFetch = async (url) => {
    calls.push(url);
    const text = direct || !new URL(url).searchParams.has('fmt') ? captionBody : '';
    return { ok: true, text: async () => text, clone() { return this; } };
  };
  const context = vm.createContext({
    URL, AbortSignal, TextEncoder, Promise, XMLHttpRequest: XHR,
    document: { getElementById: () => player },
    location: { href: `https://www.youtube.com/watch?v=${videoId}` },
    fetch: originalFetch,
    setTimeout, clearTimeout,
    setInterval(fn, delay) { const timer = setInterval(fn, delay); intervals.add(timer); return timer; },
    clearInterval(timer) { intervals.delete(timer); clearInterval(timer); },
  });
  context.window = context;
  return { context, calls, selections, intervals, playerResponse, originalFetch, originalOpen, XHR,
    run: (id = videoId, language = 'zh') => vm.runInContext(`(${readYouTubePageCaptions.toString()})(${JSON.stringify(id)},${JSON.stringify(language)})`, context) };
}

test('serialized page reader gets complete matching captions without toggling the player when direct fetch works', async () => {
  const page = harness();
  const result = await page.run();
  assert.equal(result.status, 'ready');
  assert.equal(result.videoId, videoId);
  assert.equal(result.language, 'zh');
  assert.equal(result.captionBody, captionBody);
  assert.equal(page.selections.length, 0);
  assert.equal(new URL(page.calls[0]).searchParams.get('fmt'), 'json3');
});

test('an empty timedtext response falls back to the actual player request and restores hooks and caption preference', { timeout: 2000 }, async () => {
  for (const nativeFetch of [false, true]) {
    const page = harness({ direct: false, nativeFetch });
    const result = await page.run();
    assert.equal(result.status, 'ready');
    assert.equal(result.captionBody, captionBody);
    assert.deepEqual(page.selections, ['off', 'zh', 'ru']);
    assert.equal(page.context.fetch, page.originalFetch);
    assert.equal(page.XHR.prototype.open, page.originalOpen);
    assert.equal(page.intervals.size, 0);
    assert.equal(page.context.__subsAnywhereCaptionCapture, undefined);
  }
});

test('page reader rejects foreign and stale video metadata before any caption request', async () => {
  const page = harness();
  assert.equal((await page.run('eXkFIwKSCjk')).error_code, 'stale');
  page.playerResponse.videoDetails.videoId = 'eXkFIwKSCjk';
  assert.equal((await page.run()).error_code, 'stale');
  assert.equal(page.calls.length, 0);
});

test('page reader supports English and Chinese variants but never auto-translates or selects a third language', async () => {
  const page = harness({ tracks: [track('ru'), { ...track('zh'), baseUrl: `${track('zh').baseUrl}&tlang=en` }] });
  assert.equal((await page.run(videoId, 'fr')).error_code, 'invalid_context');
  assert.equal((await page.run(videoId, 'en')).status, 'missing');
  assert.equal(page.calls.length, 0);
  const chinese = harness({ tracks: [track('zh-Hant')] });
  assert.equal((await chinese.run()).status, 'ready');
  const english = harness({ tracks: [track('en', 'asr'), track('en')] });
  assert.equal((await english.run(videoId, 'en')).status, 'ready');
  assert.equal(new URL(english.calls[0]).searchParams.has('kind'), false);
});

test('page reader discards a response received after navigation', async () => {
  const page = harness();
  let finish;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  page.context.fetch = async () => ({ ok: true, text: () => new Promise((resolve) => { finish = resolve; started(); }) });
  const pending = page.run();
  await reading;
  page.context.location.href = 'https://www.youtube.com/watch?v=eXkFIwKSCjk';
  finish(captionBody);
  assert.equal((await pending).error_code, 'stale');
  assert.equal(page.selections.length, 0);
});

test('JSON3 conversion preserves full text, timed gaps, linked append text and exact video identity', () => {
  const result = { status: 'ready', videoId, language: 'zh', captionBody };
  const payload = pageCaptionPayload(result, videoId, 'zh');
  assert.deepEqual(parseSrt(payload.srt), [
    { start: 1, end: 3, text: '你好，世界' }, { start: 4, end: 5.5, text: 'Hello again' },
  ]);
  assert.equal(payload.source, 'youtube-page');
  assert.throws(() => pageCaptionPayload(result, 'eXkFIwKSCjk', 'zh'), /другому видео/);
  assert.throws(() => pageCaptionPayload(result, videoId, 'en'), /языку/);
  assert.throws(() => pageCaptionPayload({ ...result, captionBody: '{"events":[]}' }, videoId, 'zh'), /пустые/);
  const appended = pageCaptionPayload({ ...result, captionBody: JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1000, wWinId: 1, segs: [{ utf8: 'Hello' }] },
    { tStartMs: 500, dDurationMs: 1000, wWinId: 1, aAppend: 1, segs: [{ utf8: ' world' }] },
  ] }) }, videoId, 'zh');
  assert.deepEqual(parseSrt(appended.srt), [{ start: 0, end: 1.5, text: 'Hello world' }]);
});
