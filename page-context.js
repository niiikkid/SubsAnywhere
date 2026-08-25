const TRANSIENT_QUERY_KEYS = new Set([
  '_', 'auth', 'authorization', 'exp', 'expires', 'key', 'sig', 'signature',
  't', 'timestamp', 'token',
]);

const LANGUAGE_ALIASES = Object.freeze({
  ar: 'ar', arabic: 'ar',
  bg: 'bg', bulgarian: 'bg',
  cs: 'cs', cze: 'cs', ces: 'cs', czech: 'cs',
  da: 'da', dan: 'da', danish: 'da',
  de: 'de', deu: 'de', ger: 'de', german: 'de', deutsch: 'de',
  el: 'el', ell: 'el', gre: 'el', greek: 'el',
  en: 'en', eng: 'en', english: 'en',
  es: 'es', spa: 'es', spanish: 'es', español: 'es',
  fa: 'fa', per: 'fa', fas: 'fa', persian: 'fa', farsi: 'fa',
  fi: 'fi', fin: 'fi', finnish: 'fi',
  fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr', français: 'fr',
  he: 'he', heb: 'he', hebrew: 'he',
  hi: 'hi', hin: 'hi', hindi: 'hi',
  hr: 'hr', hrv: 'hr', croatian: 'hr',
  hu: 'hu', hun: 'hu', hungarian: 'hu',
  id: 'id', ind: 'id', indonesian: 'id',
  is: 'is', isl: 'is', ice: 'is', icelandic: 'is',
  it: 'it', ita: 'it', italian: 'it', italiano: 'it',
  ja: 'ja', jpn: 'ja', japanese: 'ja', 日本語: 'ja',
  ko: 'ko', kor: 'ko', korean: 'ko', 한국어: 'ko',
  lt: 'lt', lit: 'lt', lithuanian: 'lt',
  lv: 'lv', lav: 'lv', latvian: 'lv',
  mk: 'mk', mkd: 'mk', macedonian: 'mk',
  ms: 'ms', msa: 'ms', may: 'ms', malay: 'ms',
  nl: 'nl', nld: 'nl', dut: 'nl', dutch: 'nl',
  no: 'no', nor: 'no', norwegian: 'no',
  pl: 'pl', pol: 'pl', polish: 'pl',
  pt: 'pt', por: 'pt', portuguese: 'pt', português: 'pt',
  ro: 'ro', ron: 'ro', rum: 'ro', romanian: 'ro',
  ru: 'ru', rus: 'ru', russian: 'ru', русский: 'ru', русские: 'ru',
  sk: 'sk', slk: 'sk', slo: 'sk', slovak: 'sk',
  sl: 'sl', slv: 'sl', slovenian: 'sl',
  sr: 'sr', srp: 'sr', serbian: 'sr',
  sv: 'sv', swe: 'sv', swedish: 'sv',
  ta: 'ta', tam: 'ta', tamil: 'ta',
  th: 'th', tha: 'th', thai: 'th',
  tr: 'tr', tur: 'tr', turkish: 'tr',
  uk: 'uk', ukr: 'uk', ukrainian: 'uk', українська: 'uk',
  vi: 'vi', vie: 'vi', vietnamese: 'vi',
  zh: 'zh', zho: 'zh', chi: 'zh', chinese: 'zh', 中文: 'zh',
});

const FORCED_WORDS = /\b(forced|signs?|songs?|commentary|sdh|hearing impaired|foreign only)\b/i;

function cleanText(value) {
  return String(value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalPageKey(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
    const routedHash = /^#(?:!\/|\/)/.test(url.hash) ? url.hash : '';
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      const lower = name.toLowerCase();
      if (TRANSIENT_QUERY_KEYS.has(lower) || lower.startsWith('utm_')) url.searchParams.delete(name);
    }
    const sorted = [...url.searchParams.entries()].sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    ));
    url.search = new URLSearchParams(sorted).toString();
    url.hash = routedHash;
    return url.href;
  } catch {
    return String(value || 'unknown-page').split('#')[0];
  }
}

export function normalizeLanguageCode(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[()[\]]/g, ' ').trim();
  if (!normalized) return '';
  for (const token of normalized.split(/[\s,;/|_-]+/).filter(Boolean)) {
    if (LANGUAGE_ALIASES[token]) return LANGUAGE_ALIASES[token];
    if (/^[a-z]{2}$/i.test(token)) return token.toLowerCase();
  }
  return LANGUAGE_ALIASES[normalized] ?? '';
}

export function trackLanguage(track) {
  return normalizeLanguageCode(track?.language) || normalizeLanguageCode(track?.label);
}

function trackQuality(track) {
  const label = cleanText(track?.label);
  let score = 0;
  if (!FORCED_WORDS.test(label)) score += 5;
  if (/\b(full|complete|dialogue|original)\b/i.test(label)) score += 2;
  if (/\b(default|main)\b/i.test(label)) score += 1;
  return score;
}

function bestTrack(tracks) {
  return [...tracks].sort((left, right) => trackQuality(right) - trackQuality(left))[0] ?? null;
}

export function chooseBuiltInRoles(tracks = [], originalLanguage = '') {
  const captionTracks = Array.from(tracks).filter((track) => track && typeof track.id === 'string');
  const requestedOriginal = normalizeLanguageCode(originalLanguage);
  const russian = bestTrack(captionTracks.filter((track) => trackLanguage(track) === 'ru'));
  let original = null;

  if (requestedOriginal && requestedOriginal !== 'ru') {
    original = bestTrack(captionTracks.filter((track) => trackLanguage(track) === requestedOriginal));
  }
  original ??= bestTrack(captionTracks.filter((track) => /\boriginal\b/i.test(track.label || '') && track !== russian));
  original ??= bestTrack(captionTracks.filter((track) => trackLanguage(track) === 'en' && track !== russian));
  original ??= bestTrack(captionTracks.filter((track) => trackLanguage(track) && trackLanguage(track) !== 'ru'));
  original ??= bestTrack(captionTracks.filter((track) => track !== russian));

  return {
    russian,
    original,
    reference: original ?? russian ?? bestTrack(captionTracks),
  };
}

export function likelyOriginalLanguage(tracks = []) {
  const nonRussian = Array.from(tracks)
    .map((track) => ({ track, language: trackLanguage(track) }))
    .filter((entry) => entry.language && entry.language !== 'ru');
  const explicitlyOriginal = nonRussian.find(({ track }) => /\boriginal\b/i.test(track.label || ''));
  if (explicitlyOriginal) return explicitlyOriginal.language;
  const distinct = [...new Set(nonRussian.map((entry) => entry.language))];
  if (distinct.length === 1) return distinct[0];
  return '';
}

function parseSeasonEpisode(value) {
  const text = cleanText(value).replace(/%20/gi, ' ');
  const patterns = [
    /\bS(?:eason)?\s*0?(\d{1,2})\s*E(?:pisode)?\s*0?(\d{1,3})\b/i,
    /\b0?(\d{1,2})\s*[xх]\s*0?(\d{1,3})\b/i,
    // «2 сезон 10 серия», «2 сезон, 10 серия»
    /(?<![\p{L}\p{N}])0?(\d{1,2})\s*(?:season|сезон)\D{0,12}0?(\d{1,3})\s*(?:episode|ep|сер(?:ия|ии|ию|ий))(?![\p{L}\p{N}])/iu,
    // «сезон 2 серия 10», «Season 2 Episode 10»
    /(?<![\p{L}\p{N}])(?:season|сезон)\s*0?(\d{1,2})\D{0,12}(?:episode|ep|сер(?:ия|ии|ию|ий))\s*0?(\d{1,3})(?![\p{L}\p{N}])/iu,
    // «10 серия» без сезона
    /(?<![\p{L}\p{N}])0?(\d{1,3})\s*(?:episode|ep|сер(?:ия|ии|ию|ий))(?![\p{L}\p{N}])/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const season = match[1] !== undefined ? Number(match[1]) : null;
      const episode = match[2] !== undefined ? Number(match[2]) : Number(match[1]);
      return { season, episode, matched: match[0] };
    }
  }
  const seasonOnly = /(?<![\p{L}\p{N}])(?:S|season|сезон)\s*0?(\d{1,2})(?![\p{L}\p{N}])/iu.exec(text);
  if (seasonOnly) return { season: Number(seasonOnly[1]), episode: null, matched: seasonOnly[0] };
  return { season: null, episode: null, matched: '' };
}

function stripRussianNoise(value, matched = '') {
  let text = cleanText(value);
  if (matched) text = text.replace(matched, ' ');
  text = text
    .replace(/(?<![\p{L}\p{N}])\d{1,2}\s*(?:season|сезон)(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])(?:season|сезон)\s*\d{1,2}(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])\d{1,3}\s*(?:episode|ep|сер(?:ия|ии|ию|ий))(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])(?:episode|ep|сер(?:ия|ии|ию|ий))\s*\d{1,3}(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])(?:смотреть|смотри)\s+онлайн(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])смотреть\s+онлайн(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])онлайн(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])бесплатно(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])в хорошем качестве(?![\p{L}\p{N}])/giu, ' ')
    .replace(/(?<![\p{L}\p{N}])(?:hd|полностью|целиком|все серии|все сезоны)(?![\p{L}\p{N}])/giu, ' ')
    .replace(/\s*[:：]\s*[-–—]?\s*$/u, ' ')
    .replace(/[-–—]\s*$/u, ' ')
    .replace(/^(?:смотреть|смотри)\s+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function stripReleaseNoise(value, matched = '') {
  let text = cleanText(value);
  if (matched) text = text.replace(matched, ' ');
  text = text
    .replace(/\.(mkv|mp4|avi|m4v|mov|wmv|webm)$/i, '')
    .replace(/\b(2160p|1080p|720p|480p|uhd|hdr10?|webrip|web[- .]?dl|bluray|brrip|hdtv|dvdrip|x26[45]|h\.?26[45]|hevc|av1|aac|dts|atmos|remux)\b/gi, ' ')
    .replace(/\b(?:watch|смотреть)\b.*$/i, ' ')
    .replace(/\s+[|•·]\s+.*$/, ' ')
    .replace(/\s*[|•·-]+\s*$/, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/[\[\]()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

export function inferMediaDescriptor({ title = '', url = '', playerTitle = '', sourceName = '' } = {}) {
  let decodedUrl = String(url || '');
  try { decodedUrl = decodeURIComponent(decodedUrl); } catch { /* keep raw URL */ }
  const combined = [title, playerTitle, sourceName, decodedUrl].filter(Boolean).join(' ');
  const parsed = parseSeasonEpisode(combined);
  const candidates = [title, sourceName, playerTitle]
    .map((value) => stripRussianNoise(stripReleaseNoise(value, parsed.matched)))
    .filter((value) => value && !/^(video|player)$/i.test(value));
  let mediaTitle = candidates[0] ?? '';
  const yearMatch = combined.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) mediaTitle = mediaTitle.replace(new RegExp(`\\b${yearMatch[1]}\\b`), ' ').replace(/\s+/g, ' ').trim();
  return {
    title: mediaTitle,
    season: parsed.season,
    episode: parsed.episode,
    year: yearMatch ? Number(yearMatch[1]) : null,
  };
}

export function titleMatchScore(query, candidate, preferredYear = null) {
  const tokenize = (value) => new Set(cleanText(value).toLowerCase().replace(/&[^;]+;/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []);
  const queryTokens = tokenize(query);
  const candidateTokens = tokenize([candidate?.name, candidate?.original_name].filter(Boolean).join(' '));
  if (!queryTokens.size || !candidateTokens.size) return 0;
  let intersection = 0;
  for (const token of queryTokens) if (candidateTokens.has(token)) intersection += 1;
  const union = new Set([...queryTokens, ...candidateTokens]).size;
  let score = intersection / union;
  if (cleanText(candidate?.name).toLowerCase() === cleanText(query).toLowerCase()) score += 1;
  if (preferredYear && Number(candidate?.year) === Number(preferredYear)) score += 0.35;
  return score;
}
