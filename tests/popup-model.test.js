import test from 'node:test';
import assert from 'node:assert/strict';
import {
  choosePlayer,

  decodeSubtitleBuffer,
  loadPopupSnapshot,
} from '../popup-model.js';
import { MESSAGE } from '../protocol.js';

const players = [
  { frameId: 4, key: 'first', title: 'One' },
  { frameId: 8, key: 'second', title: 'Two' },
];

test('choosePlayer restores the persistent player key after popup reopen', () => {
  assert.equal(choosePlayer(players, 'second')?.frameId, 8);
});

test('choosePlayer keeps the current frame while the popup rerenders', () => {
  assert.equal(choosePlayer(players, 'first', 8)?.frameId, 8);
});

test('choosePlayer falls back safely without mutating persistent state', () => {
  assert.equal(choosePlayer(players, 'missing')?.frameId, 4);
  assert.equal(choosePlayer([], 'missing'), null);
});

test('loadPopupSnapshot reads state and players without issuing any write message', async () => {
  const calls = [];
  const request = async (type, payload) => {
    calls.push({ type, payload });
    if (type === MESSAGE.STATE_GET) return { state: { settings: {}, externalTracks: [] } };
    if (type === MESSAGE.PLAYER_GET) return { players };
    if (type === MESSAGE.AI_CONFIG_GET) return { hasApiKey: true };
    throw new Error(`unexpected ${type}`);
  };

  const snapshot = await loadPopupSnapshot(request, 42, 'https://example.test/video');

  assert.deepEqual(calls.map((call) => call.type), [MESSAGE.STATE_GET, MESSAGE.PLAYER_GET, MESSAGE.AI_CONFIG_GET]);
  assert.equal(calls[0].payload.pageKey, 'https://example.test/video');
  assert.equal(snapshot.players.length, 2);
  assert.equal(snapshot.state.settings.secondTrackId, '');
  assert.equal(snapshot.hasApiKey, true);
});

test('subtitle decoder prefers UTF-8 and falls back to Windows-1251', () => {
  const utf8 = new TextEncoder().encode('Привет').buffer;
  const windows1251 = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]).buffer;

  assert.equal(decodeSubtitleBuffer(utf8), 'Привет');
  assert.equal(decodeSubtitleBuffer(windows1251), 'Привет');
});
