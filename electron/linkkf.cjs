// Linkkf moved to linkani.tv: a MacCMS site without a JSON API, so lists, details and episodes are read from
// its pages. Each watch page carries a freshly signed HLS address and the episode's VTT subtitle.
const cheerio = require('cheerio');

const WEB = 'https://linkani.tv';
const LIST_ANIME = 2, LIST_ADULT16 = 9;
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
const FORMATS = [{ id: 1, name: 'TV', lang: 'TV' }, { id: 2, name: 'Movie', lang: 'Movie' }, { id: 3, name: 'OVA', lang: 'OVA' }, { id: 4, name: 'Ani16+', list: LIST_ADULT16 }];

function createLinkkf({ userAgent }) {
  // Android LinkkfApiClient: 30 s per call, 3 attempts, 350/700 ms apart.
  async function page(pathname) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(new URL(pathname, WEB), { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: `${WEB}/` } });
        if (response.status === 404) throw Object.assign(new Error('Linkkf에 없는 페이지입니다.'), { final: true });
        if (!response.ok) throw new Error(`Linkkf HTTP ${response.status}`);
        return cheerio.load(await response.text());
      } catch (error) {
        lastError = error;
        if (error.final) break;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
    throw new Error(lastError?.name === 'TimeoutError' ? 'Linkkf 서버 응답 시간이 초과되었습니다.' : `Linkkf 연결 실패: ${lastError?.message || '알 수 없는 오류'}`);
  }

  const absolute = value => { try { return value ? new URL(value, WEB).href : ''; } catch { return ''; } };
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const postId = href => String(href || '').match(/\/ani\/(\d+)\//)?.[1] || '';
  // Posters are AniList covers named after the AniList id ("anilist-128757.png").
  const anilistId = image => Number(String(image).match(/anilist-(\d+)\./)?.[1]) || null;

  function anime(fields) {
    const id = String(fields.id);
    return {
      provider: 'linkkf', id, mal_id: `linkkf:${id}`, title: fields.title || '', title_english: '', title_japanese: '',
      images: { webp: { large_image_url: fields.image || '' } }, score: null, year: fields.year || '', type: fields.type || 'Anime',
      episodes: fields.episodes || null, synopsis: fields.synopsis || '', genres: (fields.genres || []).map(name => ({ name })),
      studios: (fields.studios || []).map(name => ({ name })), url: `${WEB}/ani/${id}/`, anilistId: anilistId(fields.image),
      seriesTagIds: [], aired: '', source: '', romaji: '', synonyms: '', note: ''
    };
  }
  // Poster cards on list, search and home pages. The line under the title reads "TV 2017 . 12/12" or "12/12".
  function cards($) {
    const seen = new Map();
    $('.vod-item').each((_, element) => {
      const item = $(element), id = postId(item.find('a[href*="/ani/"]').first().attr('href'));
      if (!id || seen.has(id)) return;
      const info = text(item.find('.vod-item-info p, .vod-item-desc').text()).replace(/\s*\.\s*/g, ' ');
      const total = info.match(/(\d+)\s*\/\s*(\d+)/);
      seen.set(id, anime({ id, title: text(item.find('.vod-item-title').text()), image: absolute(item.find('[data-original]').first().attr('data-original')),
        year: info.match(/\b(19|20)\d{2}\b/)?.[0] || '', type: info.match(/\b(TV|Movie|OVA|ONA|Special)\b/i)?.[0] || 'Anime', episodes: total ? Number(total[2]) || null : null }));
    });
    return [...seen.values()];
  }
  // Highest page number linked from the pager.
  const lastPage = ($, current) => Math.max(current, ...$('a[href*="/page/"]').map((_, a) => Number(String($(a).attr('href')).match(/\/page\/(\d+)\//)?.[1]) || 0).get());

  async function list(pathname, pageNumber = 1) {
    const current = Math.max(1, Number(pageNumber) || 1), $ = await page(current > 1 ? `${pathname}page/${current}/` : pathname);
    const data = cards($), totalPages = lastPage($, current);
    return { data, page: current, totalPages, total: totalPages * 30 };
  }

  async function detail(id) {
    const $ = await page(`/ani/${encodeURIComponent(id)}/`), row = label => $('.detail-info-desc li').filter((_, li) => text($(li).find('span').first().text()).startsWith(label)).first();
    const links = label => row(label).find('a').map((_, a) => text($(a).text())).get().filter(Boolean);
    const episodes = new Set($('a[href*="/watch/"]').map((_, a) => String($(a).attr('href')).match(/\/k(\d+)\//)?.[1]).get().filter(Boolean));
    return anime({ id, title: text($('h1.detail-info-title').first().text()) || text($('meta[property="og:title"]').attr('content')).replace(/\s+-\s+Anime\s+-.*$/, ''),
      image: absolute($('meta[property="og:image"]').attr('content') || $('.detail-pic [data-original], [data-original]').first().attr('data-original')),
      synopsis: text($('meta[property="og:description"]').attr('content')), genres: links('장르'), studios: links('제작사'),
      year: text(row('년').text()).match(/\b(19|20)\d{2}\b/)?.[0] || '', type: links('분류')[0] || 'Anime', episodes: episodes.size || null });
  }

  // Episode links look like /watch/<id>/a<server>/k<number>/; the label is "12화" or the episode's own title.
  async function episodes(id) {
    const $ = await page(`/ani/${encodeURIComponent(id)}/`), servers = new Map();
    $('a[href*="/watch/"]').each((_, element) => {
      const href = String($(element).attr('href') || ''), match = href.match(/\/watch\/(\d+)\/a(\d+)\/k(\d+)\//);
      if (!match || match[1] !== String(id)) return;
      const server = servers.get(match[2]) || new Map(); servers.set(match[2], server);
      const label = text($(element).text()), current = server.get(match[3]);
      if (!current || (!current.title && /\p{L}/u.test(label))) server.set(match[3], { name: match[3], slug: `k${match[3]}`, token: new URL(href, WEB).pathname, postId: String(id), title: /\p{L}/u.test(label) && !/^\d+\s*화$/.test(label) ? label : '' });
    });
    return [...servers.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([server, items]) => ({ id: Number(server), name: `서버 ${server}`, episodes: [...items.values()].sort((a, b) => Number(a.name) - Number(b.name)) })).filter(server => server.episodes.length);
  }

  // Episodes saved by the old app (linkkf.app) keep their post id; the number comes from the slug or name.
  function watchPath(episode = {}) {
    if (/^\/watch\/\d+\/a\d+\/k\d+\/$/.test(String(episode.token || ''))) return episode.token;
    const number = String(episode.slug || '').match(/\d+/)?.[0] || String(episode.name || '').match(/\d+/)?.[0] || '1';
    return `/watch/${encodeURIComponent(episode.postId)}/a1/k${Number(number)}/`;
  }
  async function stream(episode) {
    const path = watchPath(episode), response = await fetch(new URL(path, WEB), { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': userAgent, Referer: `${WEB}/` } });
    if (!response.ok) throw new Error(`Linkkf HTTP ${response.status}`);
    const html = (await response.text()).replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    const url = html.match(/https?:\/\/[^"'\s<>]+?\.m3u8[^"'\s<>]*/)?.[0], subtitle = html.match(/https?:\/\/[^"'\s<>]+?\.vtt(?:\?[^"'\s<>]*)?/)?.[0] || null;
    if (!url) throw new Error('Linkkf 재생 주소를 찾지 못했습니다.');
    return { url, subtitle, referer: new URL(path, WEB).href };
  }

  // Filter tags: types (and Ani16+), the genre list of the anime list page, and years; ids map back to slugs.
  let tagCache = null;
  async function filterTags() {
    if (tagCache) return tagCache;
    const $ = await page(`/list/${LIST_ANIME}/`), genres = [], years = [];
    $(`a[href^="/list/${LIST_ANIME}/class/"]`).each((_, a) => { const slug = String($(a).attr('href')).split('/class/')[1].replace(/\/$/, ''), name = text($(a).text()); if (name && !WEEKDAYS.includes(name) && !genres.some(tag => tag.slug === slug)) genres.push({ id: genres.length + 1, name, slug, count: 0 }); });
    $(`a[href^="/list/${LIST_ANIME}/year/"]`).each((_, a) => { const year = Number(String($(a).attr('href')).match(/\/year\/(\d{4})\//)?.[1]); if (year && !years.some(tag => tag.id === year)) years.push({ id: year, name: String(year), count: 0 }); });
    tagCache = { formats: FORMATS.map(({ id, name }) => ({ id, name, count: 0 })), genres, years: years.sort((a, b) => b.id - a.id) };
    return tagCache;
  }
  async function filter({ page: pageNumber = 1, seasonTypeIds = [], genreIds = [], yearIds = [] } = {}) {
    const tags = await filterTags(), format = FORMATS.find(item => item.id === Number(seasonTypeIds[0])), genre = tags.genres.find(item => item.id === Number(genreIds[0])), year = Number(yearIds[0]) || null;
    let pathname = `/list/${format?.list || LIST_ANIME}/`;
    if (genre) pathname += `class/${genre.slug}/`;
    if (year) pathname += `year/${year}/`;
    if (format?.lang) pathname += `lang/${format.lang}/`;
    return list(pathname, pageNumber);
  }

  async function search(query) {
    const q = text(query); if (!q) return { data: [], total: 0 };
    const found = new Map();
    for (let number = 1; number <= 5; number++) {
      const $ = await page(number > 1 ? `/view/page/${number}/?wd=${encodeURIComponent(q)}` : `/view/?wd=${encodeURIComponent(q)}`);
      cards($).forEach(item => found.set(item.id, item));
      if (number >= lastPage($, number)) break;
    }
    const data = [...found.values()];
    return { data, total: data.length };
  }

  return {
    web: WEB,
    home: pageNumber => list(`/list/${LIST_ANIME}/`, pageNumber),
    detail, episodes, stream, search, filterTags, filter, watchUrl: episode => new URL(watchPath(episode), WEB).href,
    // 월~일: the weekday categories of the anime list.
    schedule: () => Promise.all(WEEKDAYS.map(day => list(`/list/${LIST_ANIME}/class/${encodeURIComponent(day)}/`).then(result => result.data).catch(() => []))),
    sections: async () => {
      const [movie, adult16] = await Promise.all([list(`/list/${LIST_ANIME}/lang/Movie/`).then(result => result.data.slice(0, 10)).catch(() => []), list(`/list/${LIST_ADULT16}/`).then(result => result.data.slice(0, 10)).catch(() => [])]);
      return { pv: [], movie, adult16 };
    }
  };
}

module.exports = { createLinkkf, LINKKF_WEB: WEB };
