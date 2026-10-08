const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogBrowser } = require('../electron/catalog-browser.cjs');

function setup(overrides = {}) {
  const requests = [];
  const deps = {
    reanimeBase: 'https://reanime.test', animenosubBase: 'https://animenosub.test', linkaniBase: 'https://linkani.test', ohliBase: 'https://ohli.test',
    reanimeFetch: async url => { requests.push(url); return url.includes('facets=true') ? { facets: { genres: { Action: 100, Comedy: 200 }, format: { TV: 100, MOVIE: 30 } } } : { results: Array.from({ length: 36 }, (_, at) => ({ mal_id: String(Number(new URL(url).searchParams.get('offset')) + at), title: `작품 ${at}` })), total: 80 }; },
    reanimeItems: root => root.results,
    animenosubFetch: async url => { requests.push(url); return '<input name="genre[]" value="action"><input name="type" value="tv"><input name="type" value="movie"><input name="season[]" value="winter-2026"><input name="season[]" value="spring-2026"><input name="season[]" value="fall-2025">'; },
    animenosubItems: () => [],
    linkkfTags: async () => ({ genres: [{ id: 10, name: '액션' }], formats: [{ id: 20, name: '극장판' }], years: [{ id: 30, name: '2026년' }] }),
    linkkfFilter: async request => { requests.push(request); return { data: [{ mal_id: 'linkkf:1' }], total: 100, totalPages: 3 }; },
    miruroApi: async (name, request) => { requests.push(request); return { data: [{ id: 'show' }], next_cursor: 'next:cursor', has_more: true }; }, miruroItem: raw => ({ mal_id: `miruro:${raw.id}` }),
    linkaniFetch: async url => { requests.push(url); return 'page'; }, linkaniItems: () => [{ mal_id: 'linkani:tv', type: 'TV' }],
    ohliFetch: async url => { requests.push(url); return 'page'; }, ohliItems: () => [{ mal_id: 'ohli:tv', type: 'TV' }, { mal_id: 'ohli:movie', type: 'Movie' }],
    ...overrides
  };
  return { browser: createCatalogBrowser(deps), requests, deps };
}

test('RE:Anime genre, format, year and quarter apply to the server catalog with pagination', async () => {
  const { browser, requests } = setup();
  const first = await browser.browse('reanime', { genre: 'Action', format: 'TV', year: '2026', season: 'FALL', sort: 'score' });
  const url = new URL(requests.at(-1));
  for (const [name, value] of Object.entries({ genre: 'Action', format: 'TV', year: '2026', season: 'FALL', sort: 'score_desc', offset: '0', limit: '36' })) assert.equal(url.searchParams.get(name), value);
  assert.equal(first.total, 80); assert.equal(first.nextOffset, 36); assert.equal(first.done, false);
  await browser.browse('reanime', { genre: 'Comedy', offset: first.nextOffset, sort: 'popular' });
  assert.equal(new URL(requests.at(-1)).searchParams.get('offset'), '36');
  assert.equal(new URL(requests.at(-1)).searchParams.get('genre'), 'Comedy');
});

test('empty results finish cleanly and retain a zero total', async () => {
  const h = setup(), original = h.deps.reanimeFetch;
  h.deps.reanimeFetch = url => url.includes('facets=true') ? original(url) : Promise.resolve({ results: [], total: 0 });
  const result = await h.browser.browse('reanime', { year: '1800', season: 'WINTER' });
  assert.equal(result.done, true); assert.equal(result.total, 0); assert.deepEqual(result.data, []);
});

test('facet requests are shared; a failed request can be retried', async () => {
  const h = setup(); await Promise.all([h.browser.facets('reanime'), h.browser.facets('reanime')]);
  assert.equal(h.requests.length, 1);
  let calls = 0;
  const retry = setup({ reanimeFetch: async () => { if (++calls === 1) throw new Error('offline'); return { facets: { genres: { Comedy: 1 }, format: { TV: 1 } } }; } });
  await assert.rejects(retry.browser.facets('reanime'), /offline/);
  assert.equal((await retry.browser.facets('reanime')).genres[0].name, '코미디'); assert.equal(calls, 2);
});

test('unsupported genres, formats, years and quarters never become ignored server filters', async () => {
  const h = setup();
  for (const request of [{ genre: 'unknown' }, { format: 'unknown' }, { season: 'FALL' }, { year: 'NaN' }, { year: '2026', season: 'unknown' }]) await assert.rejects(h.browser.browse('reanime', request));
  await assert.rejects(h.browser.browse('miruro', { genre: 'Action' }));
  await assert.rejects(h.browser.browse('ohli24', { year: '2026' }));
});

test('Animenosub keeps native genre slugs and combines all available quarters for a year', async () => {
  const h = setup(), facets = await h.browser.facets('animenosub');
  assert.deepEqual(facets.yearOptions.map(item => item.value), ['2026', '2025']);
  const result = await h.browser.browse('animenosub', { genre: 'action', format: 'tv', year: '2026', sort: 'popular' });
  const params = new URL(h.requests.at(-1)).searchParams;
  assert.equal(params.get('genre[0]'), 'action'); assert.equal(params.get('type'), 'tv');
  assert.equal(params.get('season[0]'), 'winter-2026'); assert.equal(params.get('season[1]'), 'spring-2026');
  assert.equal(result.done, true);
});

test('Animenosub a missing quarter returns empty instead of the unfiltered list', async () => {
  const h = setup(); await h.browser.facets('animenosub');
  const count = h.requests.length, result = await h.browser.browse('animenosub', { year: '2026', season: 'SUMMER' });
  assert.deepEqual(result.data, []); assert.equal(result.done, true); assert.equal(h.requests.length, count);
});

test('Linkkf uses taxonomy ids and its real total-page boundary', async () => {
  const h = setup(), result = await h.browser.browse('linkkf', { genre: '10', format: '20', year: '30', offset: 3 });
  assert.deepEqual(h.requests[0], { page: 3, limit: 36, seasonTypeIds: [20], genreIds: [10], yearIds: [30] });
  assert.equal(result.done, true); assert.equal(result.total, 100);
});

test('Miruro keeps its opaque cursor and sends only its supported filters', async () => {
  const h = setup(), first = await h.browser.browse('miruro', { year: '2026', season: 'SPRING', sort: 'popular' });
  assert.equal(first.nextOffset, 'next:cursor'); assert.equal(first.done, false);
  await h.browser.browse('miruro', { year: '2026', season: 'SPRING', offset: first.nextOffset });
  assert.equal(h.requests.at(-1).cursor, 'next:cursor'); assert.equal(h.requests.at(-1).season_year, '2026'); assert.equal(h.requests.at(-1).season, 'SPRING');
});

test('Linkani year requests use its full year archive, and a page without format matches can advance', async () => {
  const h = setup(), first = await h.browser.browse('linkani', { format: 'Movie', year: '2026' });
  assert.equal(h.requests[0], 'https://linkani.test/list/2/year/2026/'); assert.deepEqual(first.data, []); assert.equal(first.done, false); assert.equal(first.nextOffset, 2);
  await h.browser.browse('linkani', { format: 'Movie', year: '2026', offset: 2 }); assert.equal(h.requests[1], 'https://linkani.test/list/2/year/2026/page/2/');
});

test('Ohli format selection continues into its finished archive', async () => {
  const h = setup(), first = await h.browser.browse('ohli24', { format: 'Movie' });
  assert.equal(first.data.length, 1); assert.equal(first.data[0].mal_id, 'ohli:movie');
  await h.browser.browse('ohli24', { format: 'Movie', offset: first.nextOffset });
  assert.equal(h.requests[1], 'https://ohli.test/finished/1-1.html');
});
