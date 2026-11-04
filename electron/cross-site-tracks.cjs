// Subtitle tracks for an episode played on another site (애니24, 링크애니, Linkkf, Animenosub, a Miruro episode without
// tracks of its own): RE:Anime serves an episode's tracks by its AniList entry and number alone
// (/api/flix/<anilistId>/<n>), so the work is found on AniList by the site's Japanese title and air year (else its
// English title) and the tracks are asked for by that.
// They are timed for RE:Anime's video, not the one playing: the player syncs them to the episode's audio like any
// subtitle put on, and never takes them as the timing reference for another subtitle (see syncReferences).

const DAY = 24 * 60 * 60 * 1000;
const KANA_KANJI = /[぀-ヿ㐀-鿿]/;
const hasHangul = value => /[가-힣]/.test(String(value || ''));
const EMPTY = Object.freeze({ tracks: [], referer: '' });
// Sites whose AniList id is the site's own (Re:Anime's and Miruro's catalogs, Linkkf's field). 애니24's and 링크애니's come from a looser
// lookup (any show of the same year when the title does not match), so theirs is checked again by the Japanese title.
const TRUSTED_IDS = ['reanime', 'miruro', 'linkkf'];

// A title as compared: NFKC, lower case, seasons written one way ("2nd Season", "Season 2", "第2期", "2期" → s2), "uncensored" and
// spaces, punctuation and symbols left out.
function titleKey(value = '') {
  const kanji = '一二三四五六七八九';
  return String(value).normalize('NFKC').toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b|\bseason\s+(\d+)\b/g, (_, a, b) => ` s${a || b} `)
    // Japanese seasons: 애니24 writes "ダンダダン 2期" where AniList has "ダンダダン 第2期" ("第二期", "2シーズン" too).
    .replace(/第?\s*([0-9]+|[一二三四五六七八九])\s*(?:期|シーズン)/g, (_, n) => ` s${/\d/.test(n) ? Number(n) : kanji.indexOf(n) + 1} `)
    .replace(/\(?\buncensored\b\)?/g, ' ')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}
function nativeOf(anime = {}) {
  const value = String(anime.title_japanese || '').trim();
  return value && KANA_KANJI.test(value) && !hasHangul(value) ? value : '';
}
function yearOf(anime = {}) {
  return Number((String(anime.year || '').match(/(?:19|20)\d{2}/) || String(anime.aired || '').match(/(?:19|20)\d{2}/) || [])[0]) || null;
}
const mediaYear = media => Number(media?.seasonYear || media?.startDate?.year) || null;
// Of the entries with the same title, the one of the air year (a remake shares its title with the original), else one
// a year off (a show of late December), else the only one; any of them when the year is not known.
function byYear(same, year) {
  if (!year) return same[0] || null;
  return same.find(media => mediaYear(media) === year) || same.find(media => Math.abs((mediaYear(media) || 0) - year) <= 1) || (same.length === 1 ? same[0] : null);
}
function pickByNative(list, native, year) {
  const key = titleKey(native); if (!key) return null;
  return byYear((list || []).filter(media => titleKey(media?.title?.native || '') === key), year);
}
function pickByTitle(list, title, year) {
  const key = titleKey(title); if (!key) return null;
  const names = media => [media?.title?.english, media?.title?.romaji, ...(media?.synonyms || [])].filter(Boolean).map(titleKey);
  return byYear((list || []).filter(media => names(media).includes(key)), year);
}

// A track's language for telling the same one from two sites apart: "ko", "en", "ja" by code or name, else the first
// word of its language or label.
function languageKey(track = {}) {
  const text = `${track.language || ''} ${track.label || ''}`.toLowerCase();
  if (/(?:^|[^a-z])(?:ko|kor)(?:[^a-z]|$)|korean|한국/.test(text)) return 'ko';
  if (/(?:^|[^a-z])(?:en|eng)(?:[^a-z]|$)|english/.test(text)) return 'en';
  if (/(?:^|[^a-z])(?:ja|jpn)(?:[^a-z]|$)|japanese|日本/.test(text)) return 'ja';
  return String(track.language || track.label || '').toLowerCase().split(/[\s(_-]/)[0] || 'und';
}
// The tracks of both sites in one list: RE:Anime's, then Miruro's of a language RE:Anime has none of.
function mergeTracks(reanime = [], miruro = []) {
  const have = new Set(reanime.map(languageKey));
  return [...reanime, ...miruro.filter(track => !have.has(languageKey(track)))];
}

// deps: searchAnilist(text) → AniList media list; reanimeTracks(anilistId, number) → {tracks, referer};
// miruroId(anilistId, titles) → Miruro's id of the entry or null; miruroTracks(miruroId, number) → {tracks};
// readCache() / writeCache(object): the AniList and Miruro matches kept on disk; now().
function createCrossSiteTracks(deps) {
  const now = deps.now || Date.now, pending = new Map(), trackCache = new Map();
  let disk = null;
  const store = () => disk || (disk = deps.readCache() || {});
  const save = (key, entry) => { store()[key] = entry; deps.writeCache(store()); };
  const cacheKey = anime => `${anime.provider || ''}:${anime.id || anime.title || ''}`;
  const animeTitles = anime => [nativeOf(anime), ...[anime.title_english, anime.title].filter(title => title && !hasHangul(title))].filter(Boolean);
  async function lookup(anime) {
    const native = nativeOf(anime), year = yearOf(anime);
    if (native) { const media = pickByNative(await deps.searchAnilist(native), native, year); if (media) return media; }
    if (Number(anime.anilistId)) return { id: Number(anime.anilistId), episodes: null };
    for (const title of [...new Set(animeTitles(anime).filter(title => title !== native))]) {
      const media = pickByTitle(await deps.searchAnilist(title), title, year); if (media) return media;
    }
    return null;
  }
  // Kept for 30 days when found, a day when not; a lookup that failed (unreachable, a rate limit) is not kept.
  function cached(key, load) {
    const known = store()[key];
    if (known && now() - known.at < (known.id ? 30 * DAY : DAY)) return Promise.resolve(known.id ? known : null);
    if (!pending.has(key)) pending.set(key, Promise.resolve().then(load).then(entry => { save(key, { ...entry, at: now() }); return entry.id ? store()[key] : null; }).finally(() => pending.delete(key)));
    return pending.get(key);
  }
  // The AniList entry ({id, episodes, titles}) of a site's show, or null; titles are what Miruro is searched by.
  async function anilistEntry(anime = {}) {
    if (TRUSTED_IDS.includes(anime.provider) && Number(anime.anilistId)) return { id: Number(anime.anilistId), episodes: null, titles: animeTitles(anime) };
    return cached(cacheKey(anime), async () => {
      const media = await lookup(anime);
      const titles = [media?.title?.native, media?.title?.english, media?.title?.romaji, ...animeTitles(anime)].filter(Boolean);
      return { id: Number(media?.id) || null, episodes: Number(media?.episodes) || null, titles: [...new Set(titles)] };
    });
  }
  const miruroId = entry => cached(`miruro:${entry.id}`, async () => ({ id: await deps.miruroId(entry.id, entry.titles || []) || null })).then(found => found?.id || null);
  async function fromReanime(entry, number) {
    const result = await deps.reanimeTracks(entry.id, number), referer = result?.referer || '';
    return (result?.tracks || []).map(track => ({ ...track, crossSite: true, origin: 'reanime', referer }));
  }
  async function fromMiruro(entry, number) {
    if (!deps.miruroId || !deps.miruroTracks) return [];
    const id = await miruroId(entry); if (!id) return [];
    return ((await deps.miruroTracks(id, number))?.tracks || []).map(track => ({ ...track, crossSite: true, origin: 'miruro', referer: '' }));
  }
  // The episode's tracks on the other sites (RE:Anime, Miruro; never the one playing), each marked crossSite with its
  // origin and the Referer its file wants. None for a special or dub (no numbered episode of the entry) or a number
  // past the entry's episodes (a site numbering a later season on from the first). Kept for half an hour; an empty
  // answer is asked again, and one site failing leaves the other's tracks.
  async function tracks(anime = {}, episode = {}) {
    const number = Number(episode.number);
    if (episode.special || episode.dub || !Number.isInteger(number) || number <= 0) return EMPTY;
    const entry = await anilistEntry({ ...anime, anilistId: anime.anilistId || episode.anilistId || null });
    if (!entry || (entry.episodes && number > entry.episodes)) return EMPTY;
    const key = `${anime.provider || ''}>${entry.id}:${number}`, known = trackCache.get(key);
    if (known && now() - known.at < 30 * 60 * 1000) return known.promise;
    const ask = (site, load) => anime.provider === site ? Promise.resolve([]) : load(entry, number).catch(() => []);
    const promise = Promise.all([ask('reanime', fromReanime), ask('miruro', fromMiruro)]).then(([reanime, miruro]) => {
      const list = mergeTracks(reanime, miruro);
      return { tracks: list, referer: reanime[0]?.referer || '', origin: [...new Set(list.map(track => track.origin))].join(','), anilistId: entry.id };
    });
    trackCache.set(key, { at: now(), promise });
    promise.then(result => { if (!result.tracks.length && trackCache.get(key)?.promise === promise) trackCache.delete(key); });
    return promise;
  }
  return { anilistEntry, tracks };
}

module.exports = { createCrossSiteTracks, titleKey, nativeOf, yearOf, pickByNative, pickByTitle, languageKey, mergeTracks };
