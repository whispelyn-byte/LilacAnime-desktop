const cheerio = require('cheerio');

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const GENRE_NAMES = { action: '액션', adventure: '모험', comedy: '코미디', drama: '드라마', fantasy: '판타지', horror: '공포', mystery: '미스터리', romance: '로맨스', 'sci-fi': 'SF', 'slice of life': '일상', sports: '스포츠', supernatural: '초자연', psychological: '심리', thriller: '스릴러', music: '음악', mecha: '메카', ecchi: '에치', 'mahou shoujo': '마법소녀' };
const FORMAT_NAMES = { TV: 'TV 애니', MOVIE: '극장판', OVA: 'OVA', ONA: '웹 애니', SPECIAL: '스페셜', TV_SHORT: '단편 TV', MUSIC: '뮤직비디오', 'LIVE ACTION': '실사', BD: 'BD' };
const option = (value, name = value) => ({ value: String(value), name: String(name) });
const genreName = name => GENRE_NAMES[String(name).toLowerCase().replace(/-/g, ' ')] || GENRE_NAMES[String(name).toLowerCase()] || name;
const formatName = name => FORMAT_NAMES[String(name).toUpperCase()] || name;
const unique = options => [...new Map(options.map(item => [item.value, item])).values()];

// Each source supplies its own taxonomy and pagination. Filters never operate only on the visible home cards.
function createCatalogBrowser(deps) {
  const cache = new Map();
  async function facets(provider) {
    const existing = cache.get(provider);
    if (existing && Date.now() - existing.time < 10 * 60 * 1000) return existing.promise;
    const promise = loadFacets(provider);
    const entry = { time: Date.now(), promise }; cache.set(provider, entry);
    try { return await promise; } catch (error) { if (cache.get(provider) === entry) cache.delete(provider); throw error; }
  }
  async function loadFacets(provider) {
    const base = { genres: [], formats: [], year: false, season: false, yearOptions: [], sorts: ['default'], note: '' };
    if (provider === 'reanime') {
      const root = await deps.reanimeFetch(`${deps.reanimeBase}/api/v1/search?facets=true&limit=0`), data = root.facets;
      if (!data?.genres || !data?.format) throw new Error('RE:Anime 분류를 불러오지 못했습니다.');
      return { ...base, genres: Object.keys(data.genres).sort().map(name => option(name, genreName(name))),
        formats: ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'].filter(name => Object.keys(data.format).some(key => key.toUpperCase() === name)).map(name => option(name, formatName(name))),
        year: true, season: true, sorts: ['popular', 'year', 'updated', 'score'] };
    }
    if (provider === 'animenosub') {
      const $ = cheerio.load(await deps.animenosubFetch(`${deps.animenosubBase}/anime/`));
      const inputs = name => $('input').filter((_, node) => $(node).attr('name') === name);
      const values = name => unique(inputs(name).map((_, node) => { const value = $(node).attr('value') || ''; const text = $(node).parent().text().trim() || value.replace(/-/g, ' '); return option(value, text); }).get().filter(item => item.value));
      const seasons = values('season[]').map(item => item.value), genres = values('genre[]');
      if (!genres.length && !seasons.length) throw new Error('Animenosub 분류를 불러오지 못했습니다.');
      const years = [...new Set(seasons.map(value => value.match(/-(\d{4})$/)?.[1]).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
      return { ...base, genres: genres.map(item => option(item.value, genreName(item.name))), formats: values('type').map(item => option(item.value, formatName(item.value))),
        year: Boolean(years.length), season: Boolean(seasons.length), seasons, yearOptions: years.map(year => option(year, `${year}년`)), sorts: ['popular', 'year', 'updated', 'score'] };
    }
    if (provider === 'linkkf') {
      const tags = await deps.linkkfTags();
      if (!tags.genres?.length && !tags.formats?.length && !tags.years?.length) throw new Error('Linkkf 분류를 불러오지 못했습니다.');
      const convert = list => (list || []).map(tag => option(tag.id, tag.name));
      return { ...base, genres: convert(tags.genres), formats: convert(tags.formats), year: Boolean(tags.years?.length), yearOptions: convert(tags.years), note: '연도는 Linkkf의 분류를 따릅니다. 별도의 분기 정보는 제공하지 않습니다.' };
    }
    if (provider === 'miruro') return { ...base, year: true, season: true, sorts: ['popular', 'year', 'updated', 'score'], note: 'Miruro는 연도·분기로 모아 볼 수 있습니다.' };
    if (provider === 'linkani') return { ...base, year: true, formats: ['TV', 'Movie'].map(name => option(name, formatName(name))), sorts: ['default', 'updated'], note: '링크애니는 작품 형태·연도로 모아 볼 수 있습니다. 장르·분기 정보는 제공하지 않습니다.' };
    if (provider === 'ohli24') return { ...base, formats: ['TV', 'Movie'].map(name => option(name, formatName(name))), sorts: ['default', 'updated'], note: '애니24는 TV 애니·극장판으로 모아 볼 수 있습니다. 연도·분기 정보는 제공하지 않습니다.' };
    throw new Error('이 콘텐츠 소스는 상세 필터를 지원하지 않습니다.');
  }
  async function browse(provider, request = {}) {
    const taxonomy = await facets(provider), genre = String(request.genre || ''), format = String(request.format || ''), year = String(request.year || ''), season = String(request.season || '');
    if (genre && !taxonomy.genres.some(item => item.value === genre)) throw new Error('장르를 다시 선택해 주세요.');
    if (format && !taxonomy.formats.some(item => item.value === format)) throw new Error('작품 형태를 다시 선택해 주세요.');
    if (year && (!taxonomy.year || !/^\d+$/.test(year) || Number(year) <= 0 || (taxonomy.yearOptions.length && !taxonomy.yearOptions.some(item => item.value === year)))) throw new Error('연도를 다시 선택해 주세요.');
    if (season && (!taxonomy.season || !SEASONS.includes(season) || !year)) throw new Error('분기와 연도를 함께 선택해 주세요.');
    const sort = taxonomy.sorts.includes(request.sort) ? request.sort : taxonomy.sorts[0];
    const offset = Math.max(0, Math.trunc(Number(request.offset) || 0));
    if (sort === 'year' && provider === 'reanime') {
      const catalog = deps.reanimeReleaseItems();
      if (!catalog) throw new Error('전체 목록의 분기 정보를 불러오는 중입니다. 잠시 뒤 다시 적용해 주세요.');
      const items = catalog.filter(item => (!genre || item.genres?.some(value => value.name === genre)) && (!format || item.type === format) && (!year || String(item.year) === year) && (!season || item.season === season));
      return { data: items.slice(offset, offset + 36), total: items.length, nextOffset: offset + 36, done: offset + 36 >= items.length };
    }
    if (sort === 'updated' && ['reanime', 'miruro'].includes(provider)) {
      const items = (await deps.updates.snapshot(provider)).filter(item => (!genre || item.genres?.some(value => value.name === genre)) && (!format || item.type === format) && (!year || String(item.year) === year) && (!season || item.season === season));
      return { data: items.slice(offset, offset + 36), total: items.length, nextOffset: offset + 36, done: offset + 36 >= items.length, note: '최근 회차 업데이트 목록에 필터를 적용했습니다.' };
    }
    if (provider === 'reanime') {
      const url = new URL('/api/v1/search', deps.reanimeBase);
      const params = { limit: 36, offset, genre, format, year, season, sort: { popular: 'popularity_desc', year: 'year_desc', score: 'score_desc' }[sort] };
      for (const [key, value] of Object.entries(params)) if (value !== '') url.searchParams.set(key, String(value));
      const root = await deps.reanimeFetch(url.href), data = deps.reanimeItems(root), total = Number(root.total);
      return { data, total: Number.isFinite(total) ? total : null, nextOffset: offset + data.length, done: !data.length || (Number.isFinite(total) ? offset + data.length >= total : data.length < 36) };
    }
    if (provider === 'miruro') {
      const root = await deps.miruroApi('anime', { season: season || undefined, season_year: year || undefined, sort: { popular: '-popularity', year: '-started_on', score: '-score' }[sort], limit: 15, cursor: request.offset || undefined });
      return { data: (root.data || []).map(deps.miruroItem), nextOffset: root.next_cursor || null, done: !root.has_more || !root.next_cursor };
    }
    if (provider === 'linkkf') {
      const page = Math.max(1, offset), root = await deps.linkkfFilter({ page, limit: 36, seasonTypeIds: format ? [Number(format)] : [], genreIds: genre ? [Number(genre)] : [], yearIds: year ? [Number(year)] : [] });
      return { ...root, nextOffset: page + 1, done: !root.data.length || page >= (root.totalPages || 1) };
    }
    if (provider === 'animenosub') {
      const page = Math.max(1, offset), url = new URL('/anime/', deps.animenosubBase);
      url.searchParams.set('page', String(page)); url.searchParams.set('order', { popular: 'popular', year: 'latest', updated: 'update', score: 'rating' }[sort]);
      if (genre) url.searchParams.set('genre[0]', genre);
      if (format) url.searchParams.set('type', format);
      if (year) {
        const seasons = taxonomy.seasons.filter(value => value.endsWith(`-${year}`) && (!season || value === `${season.toLowerCase()}-${year}`));
        if (!seasons.length) return { data: [], nextOffset: page, done: true };
        seasons.forEach((value, index) => url.searchParams.set(`season[${index}]`, value));
      }
      const $ = cheerio.load(await deps.animenosubFetch(url.href)), cards = $('article.bs');
      return { data: deps.animenosubItems(cards.map((_, node) => $.html(node)).get().join('')), nextOffset: page + 1, done: !cards.length };
    }
    const page = Math.max(1, offset);
    if (sort === 'updated' && provider === 'ohli24') {
      const result = await deps.updates.page(provider, offset);
      return { ...result, data: result.data.filter(item => !format || item.type === format) };
    }
    const raw = provider === 'linkani'
      ? deps.linkaniItems(await deps.linkaniFetch(`${deps.linkaniBase}/list/2/${year ? `year/${year}/` : ''}${page > 1 ? `page/${page}/` : ''}`))
      : deps.ohliItems(await deps.ohliFetch(page === 1 ? `${deps.ohliBase}/` : `${deps.ohliBase}/finished/${page - 1}-1.html`));
    return { data: raw.filter(item => !format || item.type === format), nextOffset: page + 1, done: !raw.length };
  }
  return { facets, browse };
}

module.exports = { createCatalogBrowser };
