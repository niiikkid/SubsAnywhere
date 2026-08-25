import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalPageKey,
  chooseBuiltInRoles,
  inferMediaDescriptor,
  normalizeLanguageCode,
} from '../page-context.js';

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

test('inferMediaDescriptor reads Russian season and episode formats', () => {
  assert.deepEqual(inferMediaDescriptor({ title: 'Игра престолов: 2 сезон 10 серия - смотреть онлайн' }), {
    title: 'Игра престолов', season: 2, episode: 10, year: null,
  });
  assert.deepEqual(inferMediaDescriptor({ title: 'Игра престолов (2 сезон, 10 серия) смотреть онлайн' }), {
    title: 'Игра престолов', season: 2, episode: 10, year: null,
  });
  assert.deepEqual(inferMediaDescriptor({ title: 'Смотреть Игра престолов 2 сезон 10 серия' }), {
    title: 'Игра престолов', season: 2, episode: 10, year: null,
  });
});

test('inferMediaDescriptor extracts common season and episode notation without release noise', () => {
  const media = inferMediaDescriptor({
    title: 'Game.of.Thrones.S01E03.1080p.WEB-DL | Watch online',
    url: 'https://watch.example/game-of-thrones/season-1/episode-3',
  });

  assert.equal(media.title, 'Game of Thrones');
  assert.equal(media.season, 1);
  assert.equal(media.episode, 3);
});

test('language normalization recognizes player labels and ISO variants', () => {
  assert.equal(normalizeLanguageCode('Русский (RUS)'), 'ru');
  assert.equal(normalizeLanguageCode('English CC'), 'en');
  assert.equal(normalizeLanguageCode('ja-JP'), 'ja');
});

test('built-in role selection always assigns Russian first and requested original separately', () => {
  const tracks = [
    { id: 'ru-forced', label: 'Русский forced', language: 'ru' },
    { id: 'ru-full', label: 'Русский', language: 'ru' },
    { id: 'ja', label: '日本語 Original', language: 'ja' },
    { id: 'en', label: 'English', language: 'en' },
  ];

  const roles = chooseBuiltInRoles(tracks, 'ja');

  assert.equal(roles.russian.id, 'ru-full');
  assert.equal(roles.original.id, 'ja');
  assert.equal(roles.reference.id, 'ja');
});
