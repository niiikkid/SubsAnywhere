import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../local-server/web/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../local-server/web/words.css', import.meta.url), 'utf8');

test('sidebar stays minimal and panel model settings open in a separate dialog', () => {
  const sidebar = html.match(/<aside class="panel-sidebar"[\s\S]*?<\/aside>/)?.[0];
  assert.ok(sidebar);
  for (const id of ['panel-ai-open', 'speech-open']) {
    assert.ok(sidebar.includes(`id="${id}"`), id);
    assert.equal(html.split(`id="${id}"`).length, 2, `unique ${id}`);
  }
  assert.match(sidebar, /SubsAnywhere/);
  assert.doesNotMatch(sidebar, /Словарь и практика/);
  assert.ok(html.indexOf('</aside>') < html.indexOf('<main>'));
  const dialog = html.match(/<dialog id="panel-ai-dialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(dialog);
  for (const id of ['panel-ai-provider', 'panel-ai-model', 'panel-ai-load', 'panel-ai-save', 'panel-ai-status']) {
    assert.ok(dialog.includes(`id="${id}"`), id);
    assert.equal(html.split(`id="${id}"`).length, 2, `unique ${id}`);
  }
  assert.match(dialog, /Только для этой панели/);
});

test('desktop learning content scrolls independently of navigation without truncation', () => {
  assert.match(css, /body \{[^}]*height: 100dvh;[^}]*overflow: hidden;/);
  assert.match(css, /\.study-content \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /\.study-actions \{[^}]*flex: 0 0 auto;/);
  assert.match(css, /\.study-tools \{[^}]*flex: 0 0 auto;/);
  assert.match(css, /\.study-analysis \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  assert.match(css, /\.study-analysis > \.analysis-block:first-child \{[^}]*grid-row: 1 \/ 3;/);
  assert.doesNotMatch(css, /line-clamp|text-overflow:\s*ellipsis/);
  const contentEnd = html.indexOf('<div class="study-tools"');
  assert.ok(contentEnd > html.indexOf('id="study-analysis"'));
  assert.ok(html.indexOf('<div class="study-actions"') > contentEnd);
});
