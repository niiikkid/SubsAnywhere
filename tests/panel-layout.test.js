import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function loadPanelLayout() {
  const source = await fs.readFile(new URL('../panel-layout.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.SubsAnywherePanelLayout;
}

test('page panel docks only beside a normal YouTube watch page and stays bounded when floating', async () => {
  const panel = await loadPanelLayout();
  const normal = {
    isYouTubeWatch: true,
    hasSidebar: true,
    theater: false,
    fullscreen: false,
    manuallyFloating: false,
  };
  assert.equal(panel.resolveLayout(normal), 'docked');
  assert.equal(panel.resolveLayout({ ...normal, theater: true }), 'floating');
  assert.equal(panel.resolveLayout({ ...normal, fullscreen: true }), 'floating');
  assert.equal(panel.resolveLayout({ ...normal, manuallyFloating: true }), 'floating');
  assert.equal(panel.resolveLayout({ ...normal, isYouTubeWatch: false }), 'floating');
  assert.equal(panel.fitDockedHeight(760, 512, 1000), 512);
  assert.equal(panel.fitDockedHeight(420, 512, 1000), 420);
  assert.deepEqual(
    { ...panel.moveOrResize(
      { left: 900, top: 700, width: 400, height: 600 },
      500,
      500,
      'move',
      { width: 1200, height: 800 },
      { margin: 8, minWidth: 340, minHeight: 360 },
    ) },
    { left: 792, top: 192, width: 400, height: 600 },
  );
});
