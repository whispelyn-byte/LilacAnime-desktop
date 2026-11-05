// The Korean subtitle files of the Korean sites (애니24, 링크애니, Linkkf) for an episode played elsewhere, as tracks
// beside the other sites' (see cross-site-tracks.cjs). Always asked; the player waits for them only without a Korean track.
// Most of their videos have the Korean subtitle in the picture: only an episode whose player hands a subtitle file
// (애니24's and 링크애니's raw videos, Linkkf's) gives one.
// Their shows are found by the work's Korean title (the sites' searches take nothing else) and checked on their own
// page: the same Japanese title, or the same AniList entry. Linkkf's catalog names the AniList entry outright.
// The files are timed for that site's video: put on, they are synced to the one playing like any subtitle.

const { titleKey } = require('./cross-site-tracks.cjs');

const DAY = 24 * 60 * 60 * 1000;
const KANA_KANJI = /[぀-ヿ㐀-鿿]/;
const SITES = ['ohli24', 'linkani', 'linkkf'];
const LABELS = { ohli24: '애니24', linkani: '링크애니', linkkf: 'Linkkf' };

// A Korean title's season ("약사의 혼잣말 2기", "시즌 2", "2nd Season"), 1 without one.
function koreanSeason(title = '') {
  const value = String(title).normalize('NFKC'), match = value.match(/(\d+)\s*기(?![가-힣])|시즌\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|season\s*(\d+)/i);
  return Number(match?.[1] || match?.[2] || match?.[3] || match?.[4]) || 1;
}
// A Korean title without its season, spacing and punctuation ("약사의 혼잣말 2기" → "약사의혼잣말").
function koreanBase(title = '') {
  return String(title).normalize('NFKC').toLowerCase()
    .replace(/(\d+)\s*기(?![가-힣])|시즌\s*\d+|\d+(?:st|nd|rd|th)\s*season|season\s*\d+/gi, ' ')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}
// A Japanese title's season ("薬屋のひとりごと 第2期" → 2), null without one.
function nativeSeason(native = '') {
  const match = titleKey(native).match(/s(\d+)/);
  return match ? Number(match[1]) : null;
}
// The search hits that may be the work: the same title less its season, of the season the Korean title or the
// Japanese one names (a Korean title found without "2기" still finds the second season by "第2期").
function candidates(hits, titles, native = '') {
  const extra = nativeSeason(native);
  const wanted = titles.map(title => ({ base: koreanBase(title), seasons: [koreanSeason(title), ...(extra ? [extra] : [])] })).filter(item => item.base.length >= 2);
  return (hits || []).filter(hit => wanted.some(item => koreanBase(hit.title) === item.base && item.seasons.includes(koreanSeason(hit.title))));
}
// A show page that is the work: the same Japanese title (seasons written either way), else the same AniList entry. The
// Japanese title is trusted first: 애니24's and 링크애니's AniList ids come from a looser lookup.
function sameWork(detail, work) {
  const mine = titleKey(work.native || ''), theirs = titleKey(detail?.native || '');
  if (mine && theirs) return mine === theirs;
  return Boolean(Number(detail?.anilistId) && Number(detail.anilistId) === Number(work.anilistId));
}
// The episode of a site's list: the numbered one (no special, no dub) of that number.
const episodeOf = (episodes, number) => (episodes || []).find(item => Number(item.number) === Number(number) && !item.special && !item.dub) || null;

// deps.sites[site]: { search(titles) → hits [{ref, title}], detail(ref) → {anilistId, native, episodes}, subtitle(episode)
//   → {path, assPath} | null, byAnilist(anilistId, native) → ref | null (a catalog that names the entry; then no search) }.
// deps.koreanTitles(anime) → the work's Korean titles; readCache / writeCache: the shows found, kept on disk; now().
function createKoreanSiteSubtitles(deps) {
  const now = deps.now || Date.now, timeout = deps.timeout ?? 10000, pending = new Map(), details = new Map(), files = new Map();
  let disk = null;
  const store = () => disk || (disk = deps.readCache() || {});
  const limited = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms, null))]);
  function detail(site, ref) {
    const key = `${site}:${ref}`, known = details.get(key);
    if (known && now() - known.at < 10 * 60 * 1000) return known.promise;
    const promise = Promise.resolve().then(() => deps.sites[site].detail(ref));
    details.set(key, { at: now(), promise }); promise.catch(() => details.delete(key));
    return promise;
  }
  // The site's show of the work, kept for 30 days when found and a day when not; a failed lookup is not kept.
  async function show(site, work, anime) {
    const key = `korean:${site}:${work.anilistId || `${anime.provider}:${anime.id}`}`, known = store()[key];
    if (known && now() - known.at < (known.ref ? 30 * DAY : DAY)) return known.ref || null;
    if (!pending.has(key)) pending.set(key, (async () => {
      const api = deps.sites[site];
      let ref = api.byAnilist ? await api.byAnilist(work.anilistId, work.native) : null;
      if (!ref && api.search) {
        const titles = (await deps.koreanTitles(anime)) || [];
        const hits = candidates(await api.search(titles), titles, work.native).slice(0, 3);
        for (const hit of hits) { if (sameWork(await detail(site, hit.ref).catch(() => null), work)) { ref = hit.ref; break; } }
      }
      store()[key] = { ref: ref || null, at: now() }; deps.writeCache(store());
      return ref || null;
    })().finally(() => pending.delete(key)));
    return pending.get(key);
  }
  async function siteTrack(site, work, anime, number) {
    const ref = await show(site, work, anime); if (!ref) return null;
    const episode = episodeOf((await detail(site, ref))?.episodes, number); if (!episode) return null;
    const key = `${site}:${ref}:${number}`, known = files.get(key);
    if (known && now() - known.at < 30 * 60 * 1000) return known.promise;
    const promise = Promise.resolve().then(() => deps.sites[site].subtitle(episode)).then(file => file?.path ? {
      url: file.url, localUrl: file.url, path: file.path, assPath: file.assPath || null, assUrl: file.assUrl || null,
      language: 'ko', label: '한국어', format: /\.(ass|ssa)$/i.test(file.assPath || '') ? 'ass' : 'vtt', crossSite: true, origin: site
    } : null);
    files.set(key, { at: now(), promise }); promise.then(track => { if (!track) files.delete(key); }, () => files.delete(key));
    return promise;
  }
  // The Korean sites' files of the episode (never the playing site's), in the order 애니24, 링크애니, Linkkf; each
  // site is given `timeout` ms, and one failing leaves the others.
  async function tracks({ anime = {}, episode = {}, entry = {} } = {}) {
    const number = Number(episode.number);
    if (!entry.id || episode.special || episode.dub || !Number.isInteger(number) || number <= 0) return [];
    const work = { anilistId: entry.id, native: entry.native || (entry.titles || []).find(title => KANA_KANJI.test(title)) || '' };
    const found = await Promise.all(SITES.filter(site => site !== anime.provider && deps.sites[site]).map(site => limited(siteTrack(site, work, anime, number).catch(() => null), timeout)));
    return found.filter(Boolean);
  }
  return { tracks };
}

module.exports = { createKoreanSiteSubtitles, koreanSeason, koreanBase, nativeSeason, candidates, sameWork, episodeOf, LABELS };
