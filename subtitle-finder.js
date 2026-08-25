import { parseSrt } from './caption-core.js';
import {
  estimateAffineSync,
  normalizeAiOptions,
  sampleCueList,
} from './ai-client.js';
import {
  chooseBuiltInRoles,
  inferMediaDescriptor,
  likelyOriginalLanguage,
  normalizeLanguageCode,
  titleMatchScore,
  trackLanguage,
} from './page-context.js';

const SUBDL_ORIGIN = 'https://subdl.com';
const SEARCH_URL = 'https://api3.subdl.com/auto?query=';
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 120;
const MAX_DOWNLOAD_ATTEMPTS = 4;

const LANGUAGE_INFO = Object.freeze({
  ar: { slug: 'arabic', label: 'Арабские' },
  bg: { slug: 'bulgarian', label: 'Болгарские' },
  cs: { slug: 'czech', label: 'Чешские' },
  da: { slug: 'danish', label: 'Датские' },
  de: { slug: 'german', label: 'Немецкие' },
  el: { slug: 'greek', label: 'Греческие' },
  en: { slug: 'english', label: 'Английские' },
  es: { slug: 'spanish', label: 'Испанские' },
  fa: { slug: 'farsi_persian', label: 'Персидские' },
  fi: { slug: 'finnish', label: 'Финские' },
  fr: { slug: 'french', label: 'Французские' },
  he: { slug: 'hebrew', label: 'Иврит' },
  hi: { slug: 'hindi', label: 'Хинди' },
  hr: { slug: 'croatian', label: 'Хорватские' },
  hu: { slug: 'hungarian', label: 'Венгерские' },
  id: { slug: 'indonesian', label: 'Индонезийские' },
  is: { slug: 'icelandic', label: 'Исландские' },
  it: { slug: 'italian', label: 'Итальянские' },
  ja: { slug: 'japanese', label: 'Японские' },
  ko: { slug: 'korean', label: 'Корейские' },
  lt: { slug: 'lithuanian', label: 'Литовские' },
  lv: { slug: 'latvian', label: 'Латышские' },
  mk: { slug: 'macedonian', label: 'Македонские' },
  ms: { slug: 'malay', label: 'Малайские' },
  nl: { slug: 'dutch', label: 'Нидерландские' },
  no: { slug: 'norwegian', label: 'Норвежские' },
  pl: { slug: 'polish', label: 'Польские' },
  pt: { slug: 'portuguese', label: 'Португальские' },
  ro: { slug: 'romanian', label: 'Румынские' },
  ru: { slug: 'russian', label: 'Русские' },
  sk: { slug: 'slovak', label: 'Словацкие' },
  sl: { slug: 'slovenian', label: 'Словенские' },
  sr: { slug: 'serbian', label: 'Сербские' },
  sv: { slug: 'swedish', label: 'Шведские' },
  ta: { slug: 'tamil', label: 'Тамильские' },
  th: { slug: 'thai', label: 'Тайские' },
  tr: { slug: 'turkish', label: 'Турецкие' },
  vi: { slug: 'vietnamese', label: 'Вьетнамские' },
  zh: { slug: 'chinese-bg-code', label: 'Китайские' },
});

function decodeHtml(value) {
  const named = { amp: '&', quot: '"', apos: "'", '#39': "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (named[lower] !== undefined) return named[lower];
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return match;
  });
}

function stripTags(value) {
  return decodeHtml(String(value ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteSubdlUrl(value) {
  try {
    const url = new URL(decodeHtml(value), SUBDL_ORIGIN);
    return /^https:\/\/(?:www\.)?subdl\.com$/i.test(url.origin) ? url.href : '';
  } catch {
    return '';
  }
}

function attribute(source, name) {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(source);
  return decodeHtml(match?.[1] ?? match?.[2] ?? '');
}

export function parseSubdlSearchResults(payload) {
  return (Array.isArray(payload?.results) ? payload.results : [])
    .filter((item) => item && typeof item.name === 'string' && /^\/subtitle\//.test(item.link || ''))
    .map((item) => ({
      type: item.type === 'tv' ? 'tv' : 'movie',
      name: stripTags(item.name),
      originalName: stripTags(item.original_name),
      year: Number(item.year) || null,
      url: absoluteSubdlUrl(item.link),
    }))
    .filter((item) => item.url);
}

export function parseSubdlLinks(html) {
  const links = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html).matchAll(pattern)) {
    const href = absoluteSubdlUrl(attribute(match[1], 'href'));
    if (href) links.push({ href, text: stripTags(match[2]) });
  }
  return links;
}

export function findSeasonUrl(html, season) {
  const wanted = Number(season);
  if (!Number.isInteger(wanted) || wanted < 0) return '';
  const matches = parseSubdlLinks(html).filter((link) => {
    const textMatch = /\bSeason\s+(\d{1,2})\b/i.exec(link.text);
    return textMatch && Number(textMatch[1]) === wanted;
  });
  return matches[0]?.href ?? '';
}

export function findLanguageUrl(html, language) {
  const code = normalizeLanguageCode(language);
  const slug = LANGUAGE_INFO[code]?.slug;
  if (!slug) return '';
  return parseSubdlLinks(html).find((link) => {
    try { return new URL(link.href).pathname.toLowerCase().endsWith(`/${slug}`); } catch { return false; }
  })?.href ?? '';
}

export function parseSubtitleRows(html) {
  const rows = [];
  const pattern = /<li\b([^>]*\bdata-row(?:=(?:"[^"]*"|'[^']*'))?[^>]*)>([\s\S]*?)<\/li>/gi;
  for (const match of String(html).matchAll(pattern)) {
    const attrs = match[1];
    const body = match[2];
    const name = stripTags(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i.exec(body)?.[1] ?? '');
    const downloadMatch = /href=(?:"(https:\/\/dl\.subdl\.com\/subtitle\/[^"?#]+\.zip)"|'(https:\/\/dl\.subdl\.com\/subtitle\/[^'?#]+\.zip)')/i.exec(body);
    const downloadUrl = decodeHtml(downloadMatch?.[1] ?? downloadMatch?.[2] ?? '');
    if (!downloadUrl) continue;
    const episodeFrom = Number(attribute(attrs, 'data-episode-from')) || null;
    const episodeTo = Number(attribute(attrs, 'data-episode-to')) || episodeFrom;
    rows.push({
      id: attribute(attrs, 'data-id') || downloadUrl,
      name: name || 'SubDL subtitles',
      episodeFrom,
      episodeTo,
      fullSeason: !episodeFrom && /\b(?:S\d{1,2}(?!\s*E\d)|season\s*\d+|complete)\b/i.test(name),
      downloadUrl,
    });
  }
  return rows;
}

function releaseTokens(value) {
  return new Set(String(value ?? '').toLowerCase().match(/[a-z\d]{2,}/g) ?? []);
}

function tokenOverlap(left, right) {
  const leftTokens = releaseTokens(left);
  const rightTokens = releaseTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let common = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) common += 1;
  return common / Math.max(leftTokens.size, rightTokens.size);
}

function filenameEpisodeScore(name, season, episode) {
  if (!episode) return 0;
  const normalized = String(name ?? '');
  const patterns = [
    new RegExp(`\\bS0?${Number(season) || '\\d{1,2}'}[ ._-]*E0?${episode}\\b`, 'i'),
    new RegExp(`\\b0?${Number(season) || '\\d{1,2}'}[xх]0?${episode}\\b`, 'i'),
    new RegExp(`\\bE0?${episode}\\b`, 'i'),
  ];
  return patterns.some((pattern) => pattern.test(normalized)) ? 8 : 0;
}

export function rankSubtitleRows(rows, { season = null, episode = null, sourceName = '' } = {}) {
  return [...rows].map((row, index) => {
    let score = tokenOverlap(sourceName, row.name) * 5;
    if (episode && row.episodeFrom && row.episodeFrom <= episode && (row.episodeTo ?? row.episodeFrom) >= episode) score += 12;
    score += filenameEpisodeScore(row.name, season, episode);
    if (episode && row.fullSeason) score += 3;
    if (!episode && row.fullSeason) score += 5;
    return { row, index, score };
  }).sort((left, right) => right.score - left.score || right.index - left.index).map(({ row }) => row);
}

async function defaultInflateRaw(data) {
  if (typeof DecompressionStream !== 'function') throw new Error('Этот Chrome не умеет распаковывать ZIP');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntries(buffer, { inflateRaw = defaultInflateRaw } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);
  let endOffset = -1;
  for (let offset = Math.max(0, bytes.length - 65_557); offset <= bytes.length - 22; offset += 1) {
    if (u32(offset) === 0x06054b50) endOffset = offset;
  }
  if (endOffset < 0) throw new Error('Повреждённый ZIP: не найден список файлов');
  const entryCount = u16(endOffset + 10);
  let cursor = u32(endOffset + 16);
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error('В ZIP слишком много файлов');

  const entries = [];
  let totalUncompressed = 0;
  let actualUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || u32(cursor) !== 0x02014b50) throw new Error('Повреждённый ZIP: неверный список файлов');
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const compressedSize = u32(cursor + 20);
    const uncompressedSize = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder((flags & 0x800) ? 'utf-8' : 'windows-1251').decode(nameBytes);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!/\.srt$/i.test(name) || name.endsWith('/')) continue;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('Распакованные субтитры слишком большие');
    if (localOffset + 30 > bytes.length || u32(localOffset) !== 0x04034b50) throw new Error('Повреждённый ZIP: неверная запись файла');
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) throw new Error('Повреждённый ZIP: файл обрезан');
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = await inflateRaw(compressed);
    else throw new Error(`ZIP использует неподдерживаемое сжатие: ${method}`);
    if (data.length > MAX_UNCOMPRESSED_BYTES) throw new Error('Файл субтитров слишком большой');
    actualUncompressed += data.length;
    if (actualUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('Распакованные субтитры слишком большие');
    entries.push({ name, data });
  }
  if (!entries.length) throw new Error('В ZIP нет файлов SRT');
  return entries;
}

function decodeSubtitleBytes(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

export function chooseArchiveEntry(entries, { season = null, episode = null, duration = null } = {}) {
  const candidates = entries.map((entry) => {
    const cues = parseSrt(decodeSubtitleBytes(entry.data));
    const lastTime = cues.at(-1)?.end ?? 0;
    let score = filenameEpisodeScore(entry.name, season, episode);
    if (entries.length === 1) score += 5;
    if (cues.length >= 20) score += 4;
    if (Number.isFinite(duration) && duration > 0 && lastTime > 0) {
      const ratio = lastTime / duration;
      score += Math.max(-5, 3 - Math.abs(1 - ratio) * 10);
    }
    return { ...entry, cues, lastTime, score };
  }).filter((entry) => entry.cues.length >= 5);
  if (!candidates.length) return null;
  if (episode && candidates.length > 1) {
    const episodeMatches = candidates.filter((entry) => filenameEpisodeScore(entry.name, season, episode) > 0);
    if (episodeMatches.length) return episodeMatches.sort((left, right) => right.score - left.score)[0];
  }
  if (!episode && candidates.length > 1) return null;
  return candidates.sort((left, right) => right.score - left.score || right.cues.length - left.cues.length)[0];
}

function stableTrackId(language, downloadUrl, entryName) {
  const source = `${language}|${downloadUrl}|${entryName}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `subdl-${language}-${(hash >>> 0).toString(36)}`;
}

export class SubdlWebClient {
  #fetch;

  constructor(fetchImpl) {
    this.#fetch = fetchImpl;
  }

  async #text(url) {
    const response = await this.#fetch(url, { credentials: 'omit', redirect: 'follow' });
    if (!response.ok) throw new Error(`SubDL: страница недоступна (${response.status})`);
    const text = await response.text();
    if (text.length > MAX_HTML_BYTES) throw new Error('SubDL: страница слишком большая');
    return text;
  }

  async search(title, year = null) {
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await this.#fetch(`${SEARCH_URL}${encodeURIComponent(title)}`, { credentials: 'omit' });
      if (response.status !== 429 || attempt > 0) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter)
        ? Math.min(2_000, Math.max(250, retryAfter * 1000))
        : 750;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!response.ok) throw new Error(`SubDL: поиск недоступен (${response.status})`);
    const results = parseSubdlSearchResults(await response.json());
    return results.sort((left, right) => (
      titleMatchScore(title, { name: right.name, original_name: right.originalName, year: right.year }, year)
      - titleMatchScore(title, { name: left.name, original_name: left.originalName, year: left.year }, year)
    ));
  }

  async resolveScope({ title, titles = [], year = null, season = null, episode = null }) {
    const queries = [...new Set([title, ...titles]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim()))]
      .slice(0, 5);
    const merged = new Map();
    let lastSearchError;
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
      const query = queries[queryIndex];
      try {
        const queryResults = await this.search(query, year);
        let bestQueryScore = 0;
        for (const item of queryResults) {
          const score = titleMatchScore(query, {
            name: item.name,
            original_name: item.originalName,
            year: item.year,
          }, year) + Math.max(0, 0.2 - queryIndex * 0.04);
          bestQueryScore = Math.max(bestQueryScore, score);
          const existing = merged.get(item.url);
          if (!existing || score > existing.score) merged.set(item.url, { ...item, score, matchedQuery: query });
        }
        if (bestQueryScore >= 1.1) break;
      } catch (error) {
        lastSearchError = error;
      }
    }
    const results = [...merged.values()].sort((left, right) => right.score - left.score);
    if (!results.length) {
      if (lastSearchError) throw lastSearchError;
      throw new Error(`SubDL не нашёл «${queries[0] || title}»`);
    }
    const hasSeason = Number.isInteger(Number(season)) && season !== null && season !== '';
    const hasEpisode = Number.isInteger(Number(episode)) && episode !== null && episode !== '';
    const selected = hasSeason
      ? (results.find((item) => item.type === 'tv') ?? results[0])
      : results[0];
    if (selected.type === 'tv' && (!hasSeason || !hasEpisode)) {
      throw new Error('Для сериала укажите сезон и серию');
    }
    const titleHtml = await this.#text(selected.url);
    if (hasSeason && selected.type === 'tv') {
      const seasonUrl = findSeasonUrl(titleHtml, season);
      if (!seasonUrl) throw new Error(`На SubDL не найден сезон ${season}`);
      return { selected, url: seasonUrl, html: await this.#text(seasonUrl), queries };
    }
    return { selected, url: selected.url, html: titleHtml, queries };
  }

  async downloadLanguage(scope, language, media) {
    const code = normalizeLanguageCode(language);
    const languageUrl = findLanguageUrl(scope.html, code);
    if (!languageUrl) return null;
    const rows = rankSubtitleRows(parseSubtitleRows(await this.#text(languageUrl)), {
      season: media.season,
      episode: media.episode,
      sourceName: media.sourceName,
    });
    if (!rows.length) return null;
    let lastError;
    for (const row of rows.slice(0, MAX_DOWNLOAD_ATTEMPTS)) {
      try {
        const response = await this.#fetch(row.downloadUrl, { credentials: 'omit', redirect: 'follow' });
        if (!response.ok) throw new Error(`файл недоступен (${response.status})`);
        const declaredSize = Number(response.headers.get('content-length'));
        if (declaredSize > MAX_ARCHIVE_BYTES) throw new Error('архив слишком большой');
        const archive = await response.arrayBuffer();
        if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('архив слишком большой');
        const entry = chooseArchiveEntry(await readZipEntries(archive), media);
        if (!entry) throw new Error(media.episode ? 'в архиве нет нужной серии' : 'в архиве несколько серий');
        const info = LANGUAGE_INFO[code] ?? { label: code.toUpperCase() };
        return {
          id: stableTrackId(code, row.downloadUrl, entry.name),
          name: `${info.label}: ${entry.name.replace(/\.srt$/i, '')}`,
          language: code,
          cues: entry.cues,
          offsetSeconds: 0,
          timeScale: 1,
          source: {
            provider: 'subdl-web',
            pageUrl: languageUrl,
            downloadUrl: row.downloadUrl,
            release: row.name,
            entryName: entry.name,
          },
        };
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw new Error(`SubDL: ${lastError.message}`);
    return null;
  }
}

function roleDescription(track, builtIn) {
  if (!track) return { found: false, kind: 'none', name: '' };
  return {
    found: true,
    kind: builtIn ? 'builtin' : 'subdl',
    name: track.label || track.name || 'Субтитры',
    language: trackLanguage(track) || track.language || '',
  };
}

export class SubtitleFinder {
  #subdl;
  #ai;

  constructor(fetchImpl, aiClient) {
    this.#subdl = new SubdlWebClient(fetchImpl);
    this.#ai = aiClient;
  }

  async find({ media = {}, player = {}, aiOptions = {}, getBuiltInSamples }) {
    const normalizedAi = normalizeAiOptions(aiOptions);
    const tracks = Array.isArray(player.tracks) ? player.tracks : [];
    const sourceName = String(player.sourceName || '');
    const pageTitle = String(player.title || player.tabTitle || '').trim();
    let originalLanguage = likelyOriginalLanguage(tracks);
    const enteredTitle = String(media.title || '').trim();
    const heuristicTitle = inferMediaDescriptor({
      title: enteredTitle,
      sourceName,
      playerTitle: pageTitle,
    }).title;
    const notes = [];
    const isNonLatin = (value) => /[^\p{Script=Latin}\p{N}\p{P}\p{Z}]/u.test(String(value || ''));
    const nonLatinInput = [enteredTitle, heuristicTitle, pageTitle].some(isNonLatin);
    let aiAvailable = false;

    try { aiAvailable = await this.#ai.available(); } catch { aiAvailable = false; }

    let aiTitle = '';
    let aiAlternates = [];
    if (aiAvailable && (enteredTitle || heuristicTitle)) {
      try {
        const detected = await this.#ai.detectMedia({
          ...media,
          title: enteredTitle || pageTitle || heuristicTitle,
          pageTitle,
          sourceName,
        }, normalizedAi);
        aiTitle = String(detected.englishSearchTitle || detected.originalTitle || '').trim();
        aiAlternates = (Array.isArray(detected.alternateSearchTitles) ? detected.alternateSearchTitles : [])
          .map((title) => String(title || '').trim())
          .filter((title) => title && title !== aiTitle)
          .slice(0, 3);
        const detectedLanguage = normalizeLanguageCode(detected.originalLanguage);
        if (detectedLanguage) originalLanguage = detectedLanguage;
        if (aiTitle) {
          notes.push(`DeepSeek определил название для поиска: ${aiTitle}${originalLanguage ? `; язык оригинала ${originalLanguage}` : ''}`);
        } else {
          notes.push('DeepSeek не вернул название для поиска; использую название со страницы.');
        }
      } catch (error) {
        notes.push(`DeepSeek не смог определить название: ${error.message}`);
      }
    }

    const titles = [aiTitle, ...aiAlternates];
    for (const candidate of [enteredTitle, heuristicTitle]) {
      if (candidate && !isNonLatin(candidate)) titles.push(candidate);
    }
    const searchTitles = [...new Set(titles.filter((title) => typeof title === 'string' && title.trim()))];
    if (!searchTitles.length) {
      if (nonLatinInput && !aiAvailable) {
        throw new Error('Название на русском, а ключ DeepSeek не сохранён. Сохраните ключ DeepSeek в настройках расширения или введите английское название вручную.');
      }
      if (nonLatinInput) {
        throw new Error('DeepSeek не смог определить название для поиска. Введите английское название вручную.');
      }
      throw new Error('Не удалось определить название. Введите его вручную.');
    }
    const originalTitle = searchTitles[0];
    originalLanguage ||= 'en';

    const roles = chooseBuiltInRoles(tracks, originalLanguage);
    if (roles.original && originalLanguage && trackLanguage(roles.original) && trackLanguage(roles.original) !== originalLanguage) {
      roles.original = null;
    }
    let russian = roles.russian;
    let original = roles.original;
    const externalTracks = [];
    const year = Number(media.year) || null;
    const queryVariants = [...new Set([
      originalTitle,
      ...searchTitles,
      ...(year ? [originalTitle ? `${originalTitle} ${year}` : ''] : []),
    ].filter(Boolean))];
    let scope;
    const ensureScope = async () => {
      scope ??= await this.#subdl.resolveScope({
        title: originalTitle,
        titles: queryVariants,
        year,
        season: media.season === 0 ? 0 : (Number(media.season) || null),
        episode: media.episode === 0 ? 0 : (Number(media.episode) || null),
      });
      return scope;
    };

    if (!original) {
      const found = await this.#subdl.downloadLanguage(await ensureScope(), originalLanguage, {
        season: Number(media.season) || null,
        episode: Number(media.episode) || null,
        duration: Number(player.duration) || null,
        sourceName,
      });
      if (!found) {
        const hint = notes.length ? `\n\n${notes.join('\n')}` : '';
        throw new Error(`Оригинальные субтитры (${originalLanguage}) на SubDL не найдены.${hint}`);
      }
      original = found;
      externalTracks.push(found);
    }

    if (!russian) {
      try {
        const found = await this.#subdl.downloadLanguage(await ensureScope(), 'ru', {
          season: Number(media.season) || null,
          episode: Number(media.episode) || null,
          duration: Number(player.duration) || null,
          sourceName,
        });
        if (found) {
          russian = found;
          externalTracks.push(found);
        } else {
          notes.push('Русские субтитры на SubDL не найдены');
        }
      } catch (error) {
        notes.push(`Русские субтитры не добавлены: ${error.message}`);
      }
    }

    const builtInIds = new Set(tracks.map((track) => track.id));
    const reference = roles.reference;
    const syncResults = [];
    if (externalTracks.length && reference) {
      if (!aiAvailable) {
        notes.push('Для автосинхронизации нужен API-ключ DeepSeek; оставлена ручная настройка');
      } else if (typeof getBuiltInSamples !== 'function') {
        notes.push('Не удалось получить встроенную опорную дорожку; синхронизация оставлена ручной');
      } else {
        let referenceSamples = [];
        try {
          referenceSamples = sampleCueList(await getBuiltInSamples(reference.id), 18);
        } catch (error) {
          notes.push(`Не удалось прочитать встроенные субтитры: ${error.message}`);
        }
        if (referenceSamples.length < 3) {
          notes.push('Во встроенной дорожке мало доступных строк; синхронизация оставлена ручной');
        } else {
          for (const external of externalTracks) {
            try {
              const candidateSamples = sampleCueList(external.cues, 18);
              const matched = await this.#ai.matchSubtitleSamples(referenceSamples, candidateSamples, normalizedAi);
              const estimate = estimateAffineSync(matched.reference, matched.candidate, matched.pairs);
              if (!estimate || estimate.pairCount < 2 || matched.confidence < 0.62 || estimate.residualSeconds > 3.5) {
                notes.push(`${external.language}: AI не нашёл достаточно надёжных совпадений; оставлена ручная настройка`);
                continue;
              }
              external.offsetSeconds = estimate.offsetSeconds;
              external.timeScale = estimate.timeScale;
              external.sync = {
                method: 'deepseek-samples',
                confidence: matched.confidence,
                pairCount: estimate.pairCount,
                residualSeconds: estimate.residualSeconds,
              };
              syncResults.push({
                language: external.language,
                offsetSeconds: estimate.offsetSeconds,
                timeScale: estimate.timeScale,
                pairCount: estimate.pairCount,
              });
            } catch (error) {
              notes.push(`${external.language}: автосинхронизация не выполнена — ${error.message}`);
            }
          }
        }
      }
    } else if (externalTracks.length && !reference) {
      notes.push('Встроенной опорной дорожки нет; синхронизация оставлена ручной');
    }

    const firstTrackId = russian
      ? (builtInIds.has(russian.id) ? russian.id : `external:${russian.id}`)
      : '';
    const secondTrackId = original
      ? (builtInIds.has(original.id) ? original.id : `external:${original.id}`)
      : '';
    if (!secondTrackId) throw new Error('Оригинальные субтитры не найдены');

    return {
      tracks: externalTracks,
      settingsPatch: {
        firstTrackId,
        secondTrackId,
        mediaTitle: originalTitle,
        mediaSeason: Number(media.season) || null,
        mediaEpisode: Number(media.episode) || null,
        aiModel: normalizedAi.model,
        reasoningEffort: normalizedAi.reasoningEffort,
      },
      summary: {
        originalLanguage,
        title: originalTitle,
        russian: roleDescription(russian, Boolean(russian && builtInIds.has(russian.id))),
        original: roleDescription(original, Boolean(original && builtInIds.has(original.id))),
        sync: syncResults,
        notes,
      },
    };
  }
}
