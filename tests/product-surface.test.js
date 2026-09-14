import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('popup exposes one original track and explicit local YouTube subtitle controls', async () => {
  const html = await fs.readFile(new URL('../popup.html', import.meta.url), 'utf8');

  assert.match(html, /id="originalTrack"/);
  assert.match(html, /id="restartSearch"[^>]*>Перезапустить поиск субтитров</);
  assert.match(html, /id="youtubeSubtitles"/);
  assert.match(html, /id="createYoutubeSubtitles"[^>]*>Создать свои субтитры</);
  assert.match(html, /id="youtubeSubtitleStatus"/);
  assert.match(html, /распознает английскую или китайскую речь/);
  assert.match(html, /для создания — китайский/);
  assert.doesNotMatch(html, /id="firstTrack"|id="secondTrack"/);
});

test('popup has accessible job navigation and an always-available appearance preview', async () => {
  const html = await fs.readFile(new URL('../popup.html', import.meta.url), 'utf8');
  assert.match(html, /role="tablist"/);
  for (const name of ['player', 'appearance', 'settings']) {
    assert.match(html, new RegExp(`id="${name}Tab"[^>]*role="tab"[^>]*aria-controls="${name}Panel"`));
    assert.match(html, new RegExp(`id="${name}Panel"[^>]*role="tabpanel"`));
  }
  assert.match(html, /id="subtitlePreview"/);
  assert.match(html, /id="saveStatus"[^>]*role="status"/);
  assert.match(html, /id="retryYoutubeSubtitles"/);
  assert.doesNotMatch(html, /id="controls" hidden/);
});

test('popup lets the user choose DeepSeek Flash or Pro', async () => {
  const html = await fs.readFile(new URL('../popup.html', import.meta.url), 'utf8');

  assert.match(html, /<select id="deepseekModel">/);
  assert.match(html, /<option value="deepseek-v4-flash">DeepSeek V4 Flash<\/option>/);
  assert.match(html, /<option value="deepseek-v4-pro">DeepSeek V4 Pro<\/option>/);
});

test('manifest grants network access only to DeepSeek and the fixed local server', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

  assert.deepEqual(manifest.host_permissions, [
    'https://api.deepseek.com/*',
    'http://127.0.0.1:43817/*',
  ]);
  assert.match(manifest.description, /оригинальн/i);
  assert.doesNotMatch(manifest.description, /две дорожки|находит/i);
});

test('background protocol exposes local subtitle actions without page subtitle sampling', async () => {
  const [protocol, background] = await Promise.all([
    fs.readFile(new URL('../protocol.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../background.js', import.meta.url), 'utf8'),
  ]);

  assert.match(protocol, /LOCAL_SUBTITLE_EXISTING/);
  assert.match(protocol, /LOCAL_SUBTITLE_GENERATE/);
  assert.match(protocol, /TRACK_UPSERT_LOCAL/);
  assert.doesNotMatch(protocol, /CONTENT_SAMPLE_TRACK|sampleTrack/);
  assert.match(background, /LocalSubtitleClient/);
});
