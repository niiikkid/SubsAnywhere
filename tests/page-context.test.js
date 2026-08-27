import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPageKey } from '../page-context.js';

test('canonicalPageKey preserves episode identity but removes fragments and temporary tokens', () => {
  assert.equal(
    canonicalPageKey('https://watch.example/show?episode=2&token=secret#player'),
    'https://watch.example/show?episode=2',
  );
  assert.notEqual(
    canonicalPageKey('https://watch.example/show?episode=2'),
    canonicalPageKey('https://watch.example/show?episode=3'),
  );
  assert.notEqual(
    canonicalPageKey('https://watch.example/#/episode/2'),
    canonicalPageKey('https://watch.example/#/episode/3'),
  );
});
