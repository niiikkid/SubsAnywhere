import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SubdlWebClient,
  SubtitleFinder,
  chooseArchiveEntry,
  findLanguageUrl,
  findSeasonUrl,
  parseSubtitleRows,
  parseSubdlSearchResults,
  readZipEntries,
} from '../subtitle-finder.js';

function storedZip(name, content) {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const data = encoder.encode(content);
  const localLength = 30 + nameBytes.length + data.length;
  const centralLength = 46 + nameBytes.length;
  const bytes = new Uint8Array(localLength + centralLength + 22);
  const view = new DataView(bytes.buffer);
  const u16 = (offset, value) => view.setUint16(offset, value, true);
  const u32 = (offset, value) => view.setUint32(offset, value, true);

  u32(0, 0x04034b50);
  u16(4, 20);
  u16(6, 0x800);
  u16(8, 0);
  u32(18, data.length);
  u32(22, data.length);
  u16(26, nameBytes.length);
  bytes.set(nameBytes, 30);
  bytes.set(data, 30 + nameBytes.length);

  const central = localLength;
  u32(central, 0x02014b50);
  u16(central + 4, 20);
  u16(central + 6, 20);
  u16(central + 8, 0x800);
  u16(central + 10, 0);
  u32(central + 20, data.length);
  u32(central + 24, data.length);
  u16(central + 28, nameBytes.length);
  u32(central + 42, 0);
  bytes.set(nameBytes, central + 46);

  const end = central + centralLength;
  u32(end, 0x06054b50);
  u16(end + 8, 1);
  u16(end + 10, 1);
  u32(end + 12, centralLength);
  u32(end + 16, central);
  return bytes;
}

function makeSrt(prefix = 'Line') {
  return Array.from({ length: 6 }, (_, index) => {
    const start = String(index * 2).padStart(2, '0');
    const end = String(index * 2 + 1).padStart(2, '0');
    return `${index + 1}\n00:00:${start},000 --> 00:00:${end},000\n${prefix} ${index + 1}`;
  }).join('\n\n');
}

test('SubDL parsers follow normal title, season, language, and download web links', () => {
  const search = parseSubdlSearchResults({ results: [{
    type: 'tv', name: 'Game of Thrones', original_name: 'Game of Thrones', year: 2011,
    link: '/subtitle/sd1300025/game-of-thrones',
  }] });
  const titleHtml = '<a href="/subtitle/sd1300025/game-of-thrones/first-season">Season 1 <small>First Season</small></a>';
  const seasonHtml = '<a href="/subtitle/sd1300025/game-of-thrones/first-season/russian">Russian (1)</a>';
  const languageHtml = `
    <li data-row="" data-id="3053683" data-episode-from="1" data-episode-to="1" data-full-season="">
      <a href="/s/info/test"><h4>Game.of.Thrones.S01E01.1080p.BluRay</h4></a>
      <a href="https://dl.subdl.com/subtitle/3053683-3061490.zip">Quick Download</a>
    </li>`;

  assert.equal(search[0].url, 'https://subdl.com/subtitle/sd1300025/game-of-thrones');
  assert.equal(findSeasonUrl(titleHtml, 1), 'https://subdl.com/subtitle/sd1300025/game-of-thrones/first-season');
  assert.equal(findLanguageUrl(seasonHtml, 'ru'), 'https://subdl.com/subtitle/sd1300025/game-of-thrones/first-season/russian');
  assert.deepEqual(parseSubtitleRows(languageHtml), [{
    id: '3053683',
    name: 'Game.of.Thrones.S01E01.1080p.BluRay',
    episodeFrom: 1,
    episodeTo: 1,
    fullSeason: false,
    downloadUrl: 'https://dl.subdl.com/subtitle/3053683-3061490.zip',
  }]);
});

test('ZIP reader extracts a local SRT and episode picker validates its cues', async () => {
  const archive = storedZip('S01 E02 Episode.srt', makeSrt('Привет'));
  const entries = await readZipEntries(archive);
  const selected = chooseArchiveEntry(entries, { season: 1, episode: 2, duration: 12 });

  assert.equal(entries.length, 1);
  assert.equal(selected.name, 'S01 E02 Episode.srt');
  assert.equal(selected.cues.length, 6);
  assert.equal(selected.cues[0].text, 'Привет 1');
});

test('web search tries an AI-style English title when the page title is localized', async () => {
  const titleUrl = 'https://subdl.com/subtitle/sd1300025/game-of-thrones';
  const seasonUrl = `${titleUrl}/first-season`;
  const queries = [];
  const client = new SubdlWebClient(async (url) => {
    const value = String(url);
    if (value.startsWith('https://api3.subdl.com/auto?query=')) {
      const query = decodeURIComponent(value.split('query=')[1]);
      queries.push(query);
      const results = query === 'Game of Thrones' ? [{
        type: 'tv', name: 'Game of Thrones', original_name: 'Game of Thrones', year: 2011,
        link: '/subtitle/sd1300025/game-of-thrones',
      }] : [];
      return new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value === titleUrl) return new Response(`<a href="${seasonUrl}">Season 1 First Season</a>`, { status: 200 });
    if (value === seasonUrl) return new Response('<a href="/russian">Russian</a>', { status: 200 });
    throw new Error(`Unexpected URL: ${value}`);
  });

  const scope = await client.resolveScope({
    title: 'Игра престолов',
    titles: ['Game of Thrones', 'Game of Thrones 2011'],
    year: 2011,
    season: 1,
    episode: 1,
  });

  assert.ok(queries.includes('Игра престолов'));
  assert.ok(queries.includes('Game of Thrones'));
  assert.equal(scope.selected.name, 'Game of Thrones');
  assert.equal(scope.url, seasonUrl);
});

test('autofind keeps built-in original second and downloads optional Russian first', async () => {
  const titleUrl = 'https://subdl.com/subtitle/sd1300025/game-of-thrones';
  const seasonUrl = `${titleUrl}/first-season`;
  const russianUrl = `${seasonUrl}/russian`;
  const downloadUrl = 'https://dl.subdl.com/subtitle/3053683-3061490.zip';
  const archive = storedZip('S01 E01 Winter is Coming.srt', makeSrt('Русская строка'));
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.startsWith('https://api3.subdl.com/auto?query=')) {
      return new Response(JSON.stringify({ results: [{
        type: 'tv', name: 'Game of Thrones', original_name: 'Game of Thrones', year: 2011,
        link: '/subtitle/sd1300025/game-of-thrones',
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value === titleUrl) {
      return new Response(`<a href="${seasonUrl}">Season 1 First Season</a>`, { status: 200 });
    }
    if (value === seasonUrl) {
      return new Response(`<a href="${russianUrl}">Russian (1)</a>`, { status: 200 });
    }
    if (value === russianUrl) {
      return new Response(`
        <li data-row="" data-id="3053683" data-episode-from="1" data-episode-to="1" data-full-season="">
          <a><h4>Game.of.Thrones.S01E01.1080p.BluRay</h4></a>
          <a href="${downloadUrl}">Quick Download</a>
        </li>`, { status: 200 });
    }
    if (value === downloadUrl) {
      return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  const ai = { available: async () => false };
  const finder = new SubtitleFinder(fetchImpl, ai);

  const result = await finder.find({
    media: { title: 'Game of Thrones', year: 2011, season: 1, episode: 1 },
    player: {
      sourceName: 'Game.of.Thrones.S01E01.1080p.BluRay.mkv',
      duration: 12,
      tracks: [{ id: 'builtin-en', label: 'English', language: 'en' }],
    },
    aiOptions: { model: 'deepseek-v4-flash', reasoningEffort: 'low' },
  });

  assert.equal(result.settingsPatch.firstTrackId.startsWith('external:subdl-ru-'), true);
  assert.equal(result.settingsPatch.secondTrackId, 'builtin-en');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].language, 'ru');
  assert.equal(result.summary.original.kind, 'builtin');
  assert.equal(result.summary.russian.kind, 'subdl');
  assert.match(result.summary.notes.join(' '), /ручн/);
});
