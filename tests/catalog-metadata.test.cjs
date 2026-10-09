const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { compareRelease, releaseDate, episodeLabel } = require('../src/anime-metadata.js');
const { createCatalogUpdates, decodeData } = require('../electron/catalog-updates.cjs');

test('newest release order distinguishes quarters and full dates within one year', () => {
  const items = [{ year: 2026, season: 'WINTER' }, { year: 2026, season: 'FALL' }, { year: 2026, aired: '2026-10-05 ~ 2026-12-01' }, { year: 2025, season: 'FALL' }];
  assert.deepEqual(items.slice().sort(compareRelease), [items[2], items[1], items[0], items[3]]);
  assert.equal(releaseDate({ year: 2026, season: 'SUMMER' }), 20260701);
});

test('uploaded episodes and total episodes are distinct, including zero and unknown totals', () => {
  assert.equal(episodeLabel({ provider: 'reanime', episodes: 12, subbed: 2, dubbed: 1 }), '업로드 2화 / 총 12화');
  assert.equal(episodeLabel({ provider: 'reanime', episodes: 1, availableEpisodes: 1, totalEpisodes: null }), '업로드 1화');
  assert.equal(episodeLabel({ provider: 'reanime', episodes: 12, subbed: 0, dubbed: 0 }), '업로드 0화 / 총 12화');
  assert.equal(episodeLabel({ provider: 'miruro', episodes: 24 }), '총 24화');
  assert.equal(episodeLabel({ provider: 'linkani', episodes: 2, totalEpisodes: 12 }), '업로드 2화 / 총 12화');
  assert.equal(episodeLabel({ provider: 'animenosub', episodes: null }), '');
  assert.equal(episodeLabel({ episodes: 12 }), '총 12화');
});

test('RE catalog mapping carries quarters and separate counts into cached and saved cards', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const at = source.indexOf('function reanimeItems('), last = source.indexOf('function absoluteUrl(', at);
  const context = vm.createContext({ REANIME_WEB: 'https://re.test' }); vm.runInContext(source.slice(at, last), context);
  const item = context.reanimeItems({ results: [{ anime_id: 'show', title: 'Show', season_year: 2026, season: 'FALL', episodes: 12, subbed: 2, dubbed: 1 }] })[0];
  assert.equal(item.season, 'FALL'); assert.equal(item.totalEpisodes, 12); assert.equal(item.availableEpisodes, 2);
  assert.equal(episodeLabel(item), '업로드 2화 / 총 12화');
});

test('newest index order excludes future dates and includes playable shows with stale status', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const first = source.indexOf('function sortedFromIndex('), last = source.indexOf('async function sortedCatalog(', first);
  const index = { items: [
    { id: 'winter', year: 2026, season: 'WINTER', popularity: 100 },
    { id: 'fall', year: 2026, season: 'FALL', availableEpisodes: 2, status: 'Not Yet Released' },
    { id: 'future', year: 2099, season: 'WINTER' },
    { id: 'announced', year: 2026, season: 'FALL', status: 'Not Yet Released', availableEpisodes: 0 }
  ] };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-09T00:00:00Z'])); } }
  const context = vm.createContext({ Date: Clock, compareRelease, releaseDate, catalogIndex: () => index, sortedLists: new Map() });
  vm.runInContext(source.slice(first, last), context);
  assert.deepEqual(Array.from(context.sortedFromIndex('reanime', 'year'), item => item.id), ['fall', 'winter']);
});

test('Svelte payload decoding follows references without executing scripts', () => {
  const result = decodeData([{ latestAired: 1 }, [2], { anime_id: 3, episode: 4 }, 'show', { aired: 5 }, '2026-10-08']);
  assert.equal(result.latestAired[0].anime_id, 'show'); assert.equal(result.latestAired[0].episode.aired, '2026-10-08');
});

test('RE updates cache and page actual recent episodes in descending update order', async () => {
  let requests = 0;
  const api = createCatalogUpdates({ reanimeBase: 'https://re.test', reanimeFetch: async () => { requests++; return { nodes: [{ data: [{ latestAired: 1 }, [2, 3], { id: 4, updatedAt: 5 }, { id: 6, updatedAt: 7 }, 'old', '2026-10-01', 'new', '2026-10-08'] }] }; }, reanimeItems: items => items });
  const result = await api.page('reanime'); assert.deepEqual(result.data.map(item => item.id), ['new', 'old']); assert.equal(result.done, true);
  await api.page('reanime'); assert.equal(requests, 1); assert.equal((await api.page('reanime', 36)).data.length, 0);
});

test('Miruro updates use episode schedule, ignore future episodes and shows without playable counts', async () => {
  const calls = [], aired = new Date(Date.now() - 2 * 86400000).toISOString();
  const api = createCatalogUpdates({ miruroItem: raw => ({ id: raw.id }), miruroApi: async (name, params) => {
    calls.push([name, params]);
    if (name === 'schedule') return { data: [{ anime_id: 'live', air_at: aired, episode_number: 2 }, { anime_id: 'future', air_at: '2099-01-01' }, { anime_id: 'empty', air_at: aired }], has_more: false };
    return { data: [{ id: 'live', episode_counts: { sub: 2 } }, { id: 'empty', episode_counts: { sub: 0 } }] };
  } });
  const result = await api.page('miruro'); assert.deepEqual(result.data.map(item => item.id), ['live']); assert.equal(result.data[0].updatedAt, aired);
  assert.equal(calls[0][0], 'schedule'); assert.equal(calls[1][1].id_in, 'live,empty');
});

test('native update order is requested and failed feeds can retry', async () => {
  const urls = []; let fail = true;
  const api = createCatalogUpdates({ animenosubBase: 'https://an.test', animenosubFetch: async url => { urls.push(url); if (fail) throw Error('offline'); return '<article class="bs">fresh</article>'; }, animenosubItems: () => [{ id: 'fresh' }] });
  await assert.rejects(api.page('animenosub'), /offline/); fail = false;
  assert.equal((await api.page('animenosub')).data[0].id, 'fresh'); assert.match(urls[1], /order=update/);
  await assert.rejects(api.page('linkkf'), /제공하지/);
});
