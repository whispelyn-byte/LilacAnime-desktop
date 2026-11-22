const cheerio = require('cheerio');
const LABELS = { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkani: '링크애니', linkkf: 'Linkkf' };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const koreaDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const koreaTime = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
function weekDate(day, now) {
  const date = new Date(`${koreaDate(now)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7 + (day + 6) % 7);
  return date.toISOString().slice(0, 10);
}
function entry(anime, extra = {}) {
  return { id: anime.mal_id, title: anime.title, originalTitle: anime.title_japanese || '', time: '', cancelled: false,
    genres: (anime.genres || []).map(item => item.name), startDate: '', endDate: '', anime, ...extra };
}
// One row per episode of a work (GitHub issue #30): the sites list its raw, sub and dub airings apart, often at
// different times (raw 00:00, sub and dub 00:30), so the same episode showed up two or three times. The sub airing is
// kept (when it can be watched with subtitles), else raw; a dub of the same episode only marks that row (dub: true).
// A dub on its own (an earlier episode dubbed later) stays a row of its own.
function onePerEpisode(rows, workOf, trackOf) {
  const rank = track => track === 'sub' ? 0 : track === 'dub' ? 2 : 1, byEpisode = new Map();
  for (const raw of rows) {
    const id = `${workOf(raw)}:${raw.episode_number}`, kept = byEpisode.get(id);
    if (!kept) byEpisode.set(id, { id, raw, dubbed: trackOf(raw) === 'dub' });
    else {
      kept.dubbed ||= trackOf(raw) === 'dub';
      if (rank(trackOf(raw)) < rank(trackOf(kept.raw))) kept.raw = raw;
    }
  }
  // dub marks a sub/raw row that also has a dub; a dub-only row says so by its own track.
  return [...byEpisode.values()].map(({ id, raw, dubbed }) => ({ id, raw, dub: dubbed && trackOf(raw) !== 'dub' }));
}
function createProviderSchedule(deps) {
  const cache = new Map(), pending = new Map();
  async function cached(key, fetcher) {
    const saved = cache.get(key);
    if (saved && Date.now() - saved.at < 300000) return saved.value;
    if (pending.has(key)) return pending.get(key);
    const work = Promise.resolve().then(fetcher).then(value => { cache.set(key, { at: Date.now(), value }); return value; });
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }
  async function pages(route, params) {
    const data = [], seen = new Set(); let cursor;
    for (let page = 0; page < 30; page++) {
      const root = await deps.miruroApi(route, { ...params, cursor });
      if (!Array.isArray(root?.data)) throw new Error('방영표 응답을 읽지 못했습니다.');
      data.push(...root.data);
      if (!root.has_more) return data;
      if (!root.next_cursor || seen.has(root.next_cursor)) throw new Error('방영표 다음 페이지를 읽지 못했습니다.');
      cursor = root.next_cursor; seen.add(cursor);
    }
    throw new Error('방영표 페이지가 너무 많습니다.');
  }
  async function native(provider, day, date, monday) {
    if (provider === 'reanime') {
      const root = await cached(`reanime:week:${monday}`, () => deps.reanimeFetch(`${deps.reanimeBase}/api/v1/schedule?tz=Asia%2FSeoul&week=0`));
      if (!Array.isArray(root?.schedule)) throw new Error('리애니 방영표를 읽지 못했습니다.');
      const group = root.schedule.find(item => item.date === date);
      if (!group || !Array.isArray(group.episodes)) throw new Error('리애니 방영표의 날짜가 일치하지 않습니다.');
      const rows = group.episodes.filter(raw => raw.anime_id && Number.isFinite(Date.parse(raw.episode_date)));
      return onePerEpisode(rows, raw => raw.anime_id, raw => raw.air_type).flatMap(({ id, raw, dub }) => {
        const anime = deps.reanimeItems([raw])[0];
        return anime ? [entry(anime, { id, time: koreaTime(raw.episode_date), episode: raw.episode_number, track: raw.air_type, dub,
          airingStatus: raw.airing_status })] : [];
      });
    }
    if (provider === 'miruro') {
      // Miruro accepts a weekly range, rejecting individual-day queries with HTTP 400.
      // Cover every UTC date touched by this Korean Monday–Sunday week.
      const from = new Date(`${monday}T00:00:00+09:00`).toISOString().slice(0, 10);
      const end = new Date(`${monday}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
      const rows = (await cached(`miruro:week:${monday}`, () => pages('schedule', { from, to: end.toISOString().slice(0, 10), track: 'raw,sub,dub', limit: 10000 })))
        .filter(raw => raw.anime_id && Number.isFinite(Date.parse(raw.air_at)) && koreaDate(raw.air_at) === date);
      const ids = [...new Set(rows.map(raw => raw.anime_id))], anime = new Map();
      for (let i = 0; i < ids.length; i += 200) {
        for (const raw of await pages('anime', { id_in: ids.slice(i, i + 200).join(','), limit: 200 })) anime.set(raw.id, deps.miruroItem(raw));
      }
      return onePerEpisode(rows.filter(raw => anime.has(raw.anime_id)), raw => raw.anime_id, raw => raw.track)
        .map(({ id, raw, dub }) => entry(anime.get(raw.anime_id), { id, time: koreaTime(raw.air_at), episode: raw.episode_number, track: raw.track, dub }));
    }
    if (provider === 'animenosub') {
      const html = await cached(`animenosub:week:${monday}`, () => deps.animenosubFetch(`${deps.animenosubBase}/schedule/`)), $ = cheerio.load(html);
      if (!$('.schedulepage').length) throw new Error('Animenosub 방영표를 읽지 못했습니다.');
      return $(`.schedulepage.sch_${DAYS[day]} .bs`).toArray().flatMap(node => {
        const anime = deps.animenosubItems($.html(node))[0];
        // The page does not declare a timezone. Keep its weekday grouping without claiming KST times.
        return anime ? [entry(anime)] : [];
      });
    }
    if (provider === 'ohli24') {
      const weekday = `${'일월화수목금토'[day]}요일`, url = new URL(`/${encodeURIComponent('방영중')}`, deps.ohliBase);
      url.searchParams.set('weekday', weekday);
      const root = await deps.ohliPage(url.href);
      if (!Array.isArray(root?.items) || root.sca !== weekday) throw new Error('애니24 요일 목록을 읽지 못했습니다.');
      return root.items.map(raw => entry(deps.ohliAnime(raw)));
    }
    if (provider === 'linkani') {
      const base = `${deps.linkaniBase}/list/2/class/${encodeURIComponent('일월화수목금토'[day])}/`, result = new Map();
      let url = base;
      for (let page = 1; page <= 30; page++) {
        const html = await deps.linkaniFetch(url), $ = cheerio.load(html);
        if (!$('.vod-list, .vod-item, .page-container').length) throw new Error('링크애니 요일 목록을 읽지 못했습니다.');
        for (const anime of deps.linkaniItems(html)) result.set(anime.mal_id, entry(anime));
        const next = `${base}page/${page + 1}/`;
        if (!$('a[href]').toArray().some(node => { try { return new URL($(node).attr('href'), url).href === next; } catch { return false; } })) return [...result.values()];
        url = next;
      }
      throw new Error('링크애니 방영표 페이지가 너무 많습니다.');
    }
    const tag = deps.linkkfTags[(day + 6) % 7];
    const root = await deps.linkkfFetch(`${deps.linkkfBase}/singlefilter.php?categorytagid=${tag}&limit=200`);
    if (!Array.isArray(root?.data)) throw new Error('Linkkf 요일 목록을 읽지 못했습니다.');
    return root.data.map(raw => entry(deps.linkkfAnime(raw)));
  }
  return async (provider, day) => {
    if (!Object.hasOwn(LABELS, provider) || !Number.isInteger(day) || day < 0 || day > 6) throw new Error('올바른 소스와 방영 요일을 선택해 주세요.');
    const now = deps.now ? deps.now() : Date.now(), date = weekDate(day, now), monday = weekDate(1, now);
    try {
      return await cached(`${provider}:${date}`, async () => {
        const items = await native(provider, day, date, monday), timed = ['reanime', 'miruro'].includes(provider);
        items.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.title.localeCompare(b.title, 'ko'));
        return { items, provider, native: true, timed, note: `${LABELS[provider]} · ${timed ? '한국 시간' : provider === 'animenosub' ? '예상 업데이트' : provider === 'linkani' ? '요일별 분류' : '방영 목록'}` };
      });
    } catch (error) {
      console.warn(`[schedule:${provider}] ${error.message}`);
      // Do not cache the fallback: retry must retry the source, not the cached outage.
      return { items: await deps.fallback(day), provider, native: false, timed: true,
        note: 'Anissia · 한국 시간' };
    }
  };
}
module.exports = { createProviderSchedule, weekDate };
