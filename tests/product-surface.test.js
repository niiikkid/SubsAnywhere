import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('popup exposes one original subtitle track and no automatic subtitle search', async () => {
  const html = await fs.readFile(new URL('../popup.html', import.meta.url), 'utf8');

  assert.match(html, /id="originalTrack"/);
  assert.doesNotMatch(html, /id="firstTrack"|id="secondTrack"/);
  assert.doesNotMatch(html, /findSubtitles|Автопоиск|SubDL/);
});

test('popup lets the user choose DeepSeek Flash or Pro', async () => {
  const html = await fs.readFile(new URL('../popup.html', import.meta.url), 'utf8');

  assert.match(html, /<select id="deepseekModel">/);
  assert.match(html, /<option value="deepseek-v4-flash">DeepSeek V4 Flash<\/option>/);
  assert.match(html, /<option value="deepseek-v4-pro">DeepSeek V4 Pro<\/option>/);
});

test('manifest keeps only DeepSeek network access', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

  assert.deepEqual(manifest.host_permissions, ['https://api.deepseek.com/*']);
  assert.match(manifest.description, /оригинальн/i);
  assert.doesNotMatch(manifest.description, /две дорожки|находит/i);
});

test('background protocol contains no subtitle search or subtitle sampling', async () => {
  const [protocol, background] = await Promise.all([
    fs.readFile(new URL('../protocol.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../background.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(protocol, /SUBTITLE_FIND|CONTENT_SAMPLE_TRACK|subtitle\.find|sampleTrack/);
  assert.doesNotMatch(background, /SubtitleFinder|subtitleFinder|subtitle-finder/);
});
