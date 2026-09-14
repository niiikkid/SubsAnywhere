import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A real, isolated Chrome profile. No user cookies, API keys or permissions.
const root = fileURLToPath(new URL('../', import.meta.url));
const browser = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome');
const profile = await mkdtemp(join(tmpdir(), 'subsanywhere-browser-'));
const chrome = spawn(browser, [
  '--headless=new', '--enable-unsafe-extension-debugging', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const pending = new Map();
let sequence = 0;
const errors = [];
let fixtureServer;

try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not expose DevTools within 15 seconds')), 15000);
    let log = '';
    chrome.once('error', (error) => { clearTimeout(timer); reject(error); });
    chrome.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited: ${code}`)); });
    chrome.stderr.on('data', (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { id: extensionId } = await cdp('Extensions.loadUnpacked', { path: root });
  assert.match(extensionId, /^[a-p]{32}$/);
  const openPopup = async () => {
    const { targetId } = await cdp('Target.createTarget', {
      url: `chrome-extension://${extensionId}/popup.html`, background: true,
    });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 740, deviceScaleFactor: 1, mobile: false }, sessionId);
    const evaluate = async (expression) => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async (expression) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      throw new Error(`Browser assertion timed out: ${expression}`);
    };
    await until(`document.getElementById('controls') && !document.getElementById('controls').hidden`);
    await until(`Boolean(document.getElementById('fontSizeValue')?.value)`);
    await until(`!document.getElementById('fontSize').disabled`);
    return { targetId, sessionId, evaluate, until };
  };
  const popup = await openPopup();

  await popup.evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Внешний вид')?.click()`);
  await popup.until(`document.getElementById('fontSize').getBoundingClientRect().width > 0`);
  await popup.evaluate(`(() => {
    const input = document.getElementById('fontSize');
    input.value = '31';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // No change/blur event: the input event itself must leave the ephemeral popup.
  await popup.until(`document.getElementById('fontSizeValue').value === '31px'`);
  await popup.evaluate(`document.getElementById('inlineTranslations').click()`);
  await cdp('Target.closeTarget', { targetId: popup.targetId });
  const reopened = await openPopup();

  await reopened.until(`document.getElementById('fontSize').value === '31'`);
  await reopened.until(`document.getElementById('inlineTranslations').checked`);
  await reopened.evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Внешний вид')?.click()`);
  assert.equal(await reopened.evaluate(`document.querySelectorAll('[data-subsanywhere-overlay]').length`), 0);
  assert.equal(await reopened.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
  const { data: screenshot } = await cdp('Page.captureScreenshot', { format: 'png' }, reopened.sessionId);
  const artifacts = resolve(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'appearance-smoke.png'), Buffer.from(screenshot, 'base64'));
  const playerFixture = await readFile(join(root, 'tests/fixtures/player.html'));
  fixtureServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(request.url === '/player' ? playerFixture
      : '<!doctype html><title>Local iframe test</title><iframe src="/player" width="660" height="380"></iframe>');
  });
  fixtureServer.listen(0, '127.0.0.1');
  await once(fixtureServer, 'listening');
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;
  const { targetId: videoTarget } = await cdp('Target.createTarget', { url: fixtureUrl });
  const { sessionId: videoSession } = await cdp('Target.attachToTarget', { targetId: videoTarget, flatten: true });
  await cdp('Runtime.enable', {}, videoSession);
  const inspectVideo = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, videoSession);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const videoDeadline = Date.now() + 8000;
  while (!await inspectVideo(`document.querySelector('iframe')?.contentDocument?.querySelector('video')?.readyState >= 2`)) {
    if (Date.now() > videoDeadline) throw new Error('Local video fixture did not become ready');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  await cdp('Target.activateTarget', { targetId: videoTarget });
  // This is Chrome's actual action gesture, not a mocked host permission.
  const { targetInfos: browserTabs } = await cdp('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
  const videoTab = browserTabs.find(tab => tab.url === fixtureUrl);
  assert.ok(videoTab, 'Chrome must expose the fixture tab target');
  await cdp('Extensions.triggerAction', { id: extensionId, targetId: videoTab.targetId });
  const connection = await reopened.evaluate(`(async () => {
    const { MESSAGE } = await import('./protocol.js');
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url === ${JSON.stringify(fixtureUrl)});
    if (!tab) throw new Error('activeTab access was not granted');
    const request = async (type, extra = {}) => {
      const result = await chrome.runtime.sendMessage({ type, tabId: tab.id, pageKey: tab.url, ...extra });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    };
    const { players } = await request(MESSAGE.PLAYER_DISCOVER);
    const player = players.find(p => p.frameId > 0 && p.tracks.length);
    if (!player) throw new Error('Iframe player with native track was not discovered');
    await request(MESSAGE.PLAYER_SELECT, { frameId: player.frameId, playerKey: player.key });
    await request(MESSAGE.STATE_PATCH, { patch: { secondTrackId: player.tracks[0].id } });
    await request(MESSAGE.PLAYER_DISCOVER);
    return { frameId: player.frameId };
  })()`);
  assert.ok(connection.frameId > 0);
  const overlay = await inspectVideo(`(() => {
    const frame = document.querySelector('iframe').contentDocument;
    return { count: frame.querySelectorAll('#dual-captions-overlay').length,
      text: frame.querySelector('.subs-anywhere-original')?.textContent };
  })()`);
  assert.equal(overlay.count, 1, 'Reinjection must not duplicate overlays');
  assert.equal(overlay.text, 'Hello from a local video.');
  const { data: playerScreenshot } = await cdp('Page.captureScreenshot', { format: 'png' }, videoSession);
  await writeFile(join(artifacts, 'player-smoke.png'), Buffer.from(playerScreenshot, 'base64'));
  const positionExpression = `(async () => {
    const { canonicalPageKey } = await import('./page-context.js');
    const stored = await chrome.storage.local.get('dualCaptionsState');
    return stored.dualCaptionsState.pages[canonicalPageKey(${JSON.stringify(fixtureUrl)})].settings.secondLeft;
  })()`;
  const initialPosition = await reopened.evaluate(positionExpression);
  assert.notEqual(initialPosition, 72);
  // Stop only this disposable profile's workers. Do not wake it via popup APIs.
  await cdp('ServiceWorker.enable', {}, videoSession);
  await cdp('ServiceWorker.stopAllWorkers', {}, videoSession);
  const { targetInfos: stoppedTargets } = await cdp('Target.getTargets');
  assert.equal(stoppedTargets.some(target => target.type === 'service_worker'
    && target.url.startsWith(`chrome-extension://${extensionId}/`)), false, 'Worker must actually stop');
  // Exercise Chrome's real content sender/document identity without discovery.
  // This tests worker recovery, not pointer capture (verified separately by hand).
  const handoff = await reopened.evaluate(`(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url === ${JSON.stringify(fixtureUrl)});
    return chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [${connection.frameId}] }, world: 'ISOLATED',
      func: async () => chrome.runtime.sendMessage({
        type: 'dualCaptions.content.positionPatch', secondLeft: 72, secondBottom: 27,
      }),
    });
  })()`);
  assert.equal(handoff[0]?.result?.ok, true, 'Cold worker must accept the current selected content document');
  await reopened.until(`(${positionExpression}).then(value => value === 72)`);

  // Display-only fixture: real DOM/layout, deterministic glossary, no AI/network.
  const { targetId: displayTarget } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId: displaySession } = await cdp('Target.attachToTarget', { targetId: displayTarget, flatten: true });
  await cdp('Runtime.enable', {}, displaySession);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 600, deviceScaleFactor: 1, mobile: false }, displaySession);
  const displayEval = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, displaySession);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await displayEval(`(() => {
    document.body.style.cssText = 'margin:0;background:#161a24';
    const video = document.createElement('video');
    video.style.cssText = 'width:1000px;height:600px;display:block';
    document.body.append(video);
    window.fixtureListeners = [];
    window.fixtureRequests = 0;
    window.chrome = { runtime: {
      onMessage: { addListener: fn => fixtureListeners.push(fn), removeListener() {} },
      sendMessage: async message => {
        if (message.type !== 'dualCaptions.caption.translate') return { ok: true };
        fixtureRequests++;
        return { ok: true, data: { items: [{ start: 0, end: message.displayText.length,
          dictionary: 'Учебный пример перевода', isSentenceTranslation: true,
          glossary: window.fixtureGlossary ?? (message.language === 'zh' ? [
            { pinyin: 'nǐ hǎo', translation: 'здравствуйте, приветствую вас' },
            { pinyin: 'shì jiè', translation: 'мир, окружающий нас мир во всём его многообразии' },
          ] : [
            { text: 'Hello', translation: 'здравствуйте, приветствую вас' },
            { text: 'world', translation: 'мир, окружающий нас мир во всём его многообразии' },
          ]) }] } };
      }
    } };
  })()`);
  await displayEval(await readFile(join(root, 'content-runtime.js'), 'utf8'));
  await displayEval(await readFile(join(root, 'content.js'), 'utf8'));
  for (const language of ['en', 'zh']) {
    const text = language === 'zh' ? '\u2063nǐ hǎo, shì jiè\n\u2064你好，世界' : 'Hello, world';
    await displayEval(`(async () => {
      fixtureListeners[0]({ type: 'dualCaptions.content.fullState',
        settings: { secondTrackId: 'external:demo', fontSize: 32, inlineTranslations: true, subtitleBackground: true },
        externalTracks: [{ id: 'demo', cues: [{ start: 0, end: 999, text: ${JSON.stringify(text)} }] }]
      }, {}, () => {});
      await new Promise(resolve => setTimeout(resolve, 850));
    })()`);
    const geometry = await displayEval(`(() => {
      const cells = [...document.querySelector('.dual-captions-inline').children];
      return cells.every(cell => {
        const meaning = cell.children[0], source = cell.children[1];
        const box = cell.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && cell.scrollWidth <= cell.clientWidth + 1
          && meaning.getBoundingClientRect().bottom <= source.getBoundingClientRect().top + 1
          && parseFloat(getComputedStyle(meaning).fontSize) < parseFloat(getComputedStyle(source).fontSize);
      });
    })()`);
    assert.equal(geometry, true, 'Translations stay above source, smaller and inside wrapping cells');
    assert.equal(await displayEval(`document.querySelector('.subs-anywhere-original').getBoundingClientRect().width < 750`),
      true, 'A short glossary must not paint a full-width background');
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, displaySession);
    await writeFile(join(artifacts, `inline-${language}-smoke.png`), Buffer.from(data, 'base64'));
  }
  assert.equal(await displayEval('fixtureRequests'), 2);
  const bookstore = JSON.parse(await readFile(join(root, 'tests/fixtures/bookstore-captions.json'), 'utf8'));
  const longCaption = bookstore.captions[2];
  await displayEval(`(async () => {
    document.querySelector('video').style.cssText = 'width:873px;height:491px;display:block';
    fixtureGlossary = ${JSON.stringify(longCaption.glossary)};
    fixtureListeners[0]({ type: 'dualCaptions.content.fullState',
      settings: { secondTrackId: 'external:demo', fontSize: 28, inlineTranslations: true, subtitleBackground: true },
      externalTracks: [{ id: 'demo', cues: [{ start: 0, end: 999, text: ${JSON.stringify(longCaption.text)} }] }]
    }, {}, () => {});
    await new Promise(resolve => setTimeout(resolve, 850));
  })()`);
  const rows = await displayEval(`(() => {
    const counts = {};
    for (const cell of document.querySelector('.dual-captions-inline').children) {
      const y = Math.round(cell.getBoundingClientRect().bottom);
      counts[y] = (counts[y] || 0) + 1;
    }
    return Object.values(counts);
  })()`);
  assert.deepEqual(rows, [3, 3], 'The bookstore caption should balance rows instead of stranding one phrase');
  assert.equal(await displayEval(`document.querySelector('.subs-anywhere-original').getBoundingClientRect().width < 600`),
    true, 'Wrapped background must hug the actual balanced rows, not the maximum available width');
  const { data: bookstoreScreenshot } = await cdp('Page.captureScreenshot', { format: 'png' }, displaySession);
  await writeFile(join(artifacts, 'bookstore-balanced.png'), Buffer.from(bookstoreScreenshot, 'base64'));
  for (const [width, height, left, bottom, fontSize] of [
    [1000, 600, 5, 95, 32], [360, 240, 95, 0, 48], [640, 360, 50, 22, 32],
  ]) {
    await displayEval(`(() => {
      document.querySelector('video').style.cssText = 'width:${width}px;height:${height}px;display:block';
      fixtureListeners[0]({ type: 'dualCaptions.content.settings', settings: {
        secondTrackId: 'external:demo', inlineTranslations: true, subtitleBackground: true,
        secondLeft: ${left}, secondBottom: ${bottom}, fontSize: ${fontSize}
      } }, {}, () => {});
    })()`);
    const bounds = await displayEval(`(() => {
      const root = document.querySelector('#dual-captions-overlay').getBoundingClientRect();
      const caption = document.querySelector('.subs-anywhere-original');
      const box = caption.getBoundingClientRect();
      return box.left >= root.left && box.right <= root.right && box.top >= root.top && box.bottom <= root.bottom
        && caption.scrollWidth <= caption.clientWidth + 1;
    })()`);
    assert.equal(bounds, true, 'Large captions must remain inside small players and at extreme saved positions');
    await displayEval(`document.querySelector('.dual-captions-inline [role="button"]').click()`);
    assert.equal(await displayEval(`(() => {
      const root = document.querySelector('#dual-captions-overlay').getBoundingClientRect();
      const tip = document.querySelector('[role="tooltip"]').getBoundingClientRect();
      return tip.left >= root.left && tip.right <= root.right && tip.top >= root.top && tip.bottom <= root.bottom;
    })()`), true, 'The full translation must remain reachable at every player edge');
    await displayEval(`document.querySelector('[aria-label="Закрыть перевод"]').click()`);
  }
  const stressCases = [
    ...bookstore.captions,
    { text: 'WordWithoutBreaks'.repeat(18), glossary: [{ text: 'WordWithoutBreaks'.repeat(18), translation: 'ОченьДлинноеЗначение'.repeat(8) }] },
    { text: 'Hello '.repeat(50) + 'world!', glossary: [{ text: 'Hello', translation: 'здравствуйте, приветствую вас' }] },
    { text: '«Hello»,\n(world)!', glossary: [{ text: 'Hello', translation: 'привет' }, { text: 'world', translation: 'мир' }] },
    { text: 'No glossary here', glossary: [] },
  ];
  const stressResults = await displayEval(`(async () => {
    const results = [];
    const video = document.querySelector('video');
    video.style.cssText = 'width:360px;height:240px;display:block';
    const settings = { secondTrackId: 'external:stress', inlineTranslations: true, subtitleBackground: true, fontSize: 48 };
    const show = text => fixtureListeners[0]({ type: 'dualCaptions.content.fullState', settings,
      externalTracks: [{ id: 'stress', cues: [{ start: 0, end: 999, text }] }]
    }, {}, () => {});
    for (const sample of ${JSON.stringify(stressCases)}) {
      fixtureGlossary = sample.glossary;
      show(sample.text);
      await new Promise(resolve => setTimeout(resolve, 850));
      const caption = document.querySelector('.subs-anywhere-original');
      const root = document.querySelector('#dual-captions-overlay').getBoundingClientRect();
      const box = caption.getBoundingClientRect();
      const cells = [...document.querySelectorAll('.dual-captions-inline [role="button"]')];
      const original = cells.map(cell => cell.children[1].textContent).join('');
      const visibleText = sample.text.startsWith('\u2063') ? sample.text.split('\\n')[0].slice(1) : sample.text;
      results.push({ bounded: box.left >= root.left && box.right <= root.right + 1 && box.top >= root.top && box.bottom <= root.bottom + 1,
        overflow: caption.scrollWidth > caption.clientWidth + 1,
        preserved: !cells.length || original.replace(/\\s/g, '') === visibleText.replace(/\\s/g, ''),
        scrollable: caption.scrollHeight > caption.clientHeight });
      if (caption.scrollHeight > caption.clientHeight) {
        caption.scrollTop = caption.scrollHeight;
        if (!caption.scrollTop) throw new Error('Tall caption is not scrollable');
      }
      const requests = fixtureRequests;
      for (const inlineTranslations of [false, true]) {
        fixtureListeners[0]({ type: 'dualCaptions.content.settings', settings: { ...settings, inlineTranslations } }, {}, () => {});
      }
      if (fixtureRequests !== requests) throw new Error('Display toggles must not spend more translation requests');
      show('');
      if (caption.getBoundingClientRect().height !== 0) throw new Error('Empty caption paints a background');
    }
    // Theatre-mode resize while paused: no synthetic window resize or cue event.
    show('Hello, world');
    await new Promise(resolve => setTimeout(resolve, 50));
    video.style.width = '700px';
    await new Promise(resolve => setTimeout(resolve, 100));
    if (document.querySelector('#dual-captions-overlay').getBoundingClientRect().width !== 700) throw new Error('ResizeObserver did not track the paused player');
    return results;
  })()`);
  assert.equal(stressResults.length, stressCases.length);
  assert.ok(stressResults.every(result => result.bounded && !result.overflow && result.preserved), JSON.stringify(stressResults));
  assert.ok(stressResults.some(result => result.scrollable), 'The height-overflow fallback must actually be exercised');
  assert.deepEqual(errors, [], 'Chrome must not report runtime exceptions');
  console.log(`PASS: balanced bookstore caption; edge positions and bounded tooltips; ${stressResults.length} short/long/empty-glossary/multiline cases; lossless tall-caption scrolling; cached mode toggles; paused player resize.`);
  console.log('PASS: inline mode persists across popup reopen; English/pinyin glossary cells wrap long meanings above the source in real Chrome (offline fixtures).');
  console.log('PASS: actual unpacked extension loads; appearance works without a player; input survives popup close/reopen; real iframe video/native captions render; reinjection creates no duplicate overlay; real content position message persists after actual service-worker shutdown without reconnecting; no page exceptions or horizontal overflow.');
  console.log(`Screenshot: ${join(artifacts, 'appearance-smoke.png')}`);
} finally {
  fixtureServer?.closeAllConnections();
  fixtureServer?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close();
  const exited = once(chrome, 'exit').catch(() => undefined);
  chrome.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolveDelay) => setTimeout(resolveDelay, 2000))]);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
