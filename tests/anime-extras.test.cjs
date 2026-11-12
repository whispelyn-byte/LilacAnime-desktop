const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
function section(start, end) { const from = source.indexOf(start), to = source.indexOf(end, from); assert.ok(from >= 0 && to > from, start); return source.slice(from, to); }
function load(globals) {
  const context = vm.createContext({ Date, Map, Number, String, Array, Object, Promise, setTimeout, clearTimeout, ...globals });
  vm.runInContext(`${section('const EXTRAS_QUERY=', 'async function translationContext(')}\n${section('const LIBRARY_REFRESH_SOURCES=', 'function createWindow()')}\nthis.exported={animeExtras,loadAnimeExtras,libraryFacts}`, context);
  return context.exported;
}
const media = {
  id: 10, idMal: 20, siteUrl: 'https://anilist.co/anime/10', title: { romaji: 'Sho', english: 'Show', native: 'ショー' },
  nextAiringEpisode: { episode: 8, airingAt: 1800000000 }, trailer: { id: 'abcDEF12345\t', site: 'youtube' },
  tags: [{ name: 'School', rank: 90 }, { name: 'Twist', rank: 95, isMediaSpoiler: true }, { name: 'Minor', rank: 20 }],
  characters: { edges: [{ role: 'MAIN', node: { name: { full: 'Aoi Sora', native: '空あおい' }, image: { medium: 'https://img/a.jpg' } }, voiceActors: [{ name: { full: 'Voice One', native: '声一' } }] }] },
  relations: { edges: [{ relationType: 'SEQUEL', node: { id: 11, type: 'ANIME', format: 'TV', seasonYear: 2027, title: { english: 'Show 2' }, coverImage: { large: 'https://img/2.jpg' } } }, { relationType: 'ADAPTATION', node: { id: 12, type: 'MANGA', title: { english: 'Show (manga)' } } }] },
  recommendations: { nodes: [{ mediaRecommendation: { id: 30, type: 'ANIME', averageScore: 81, title: { romaji: 'Other' }, coverImage: { large: 'javascript:alert(1)' } } }, { mediaRecommendation: null }] },
  externalLinks: [{ site: 'Official Site', url: 'https://show.example/', type: 'INFO' }, { site: 'Twitter', url: 'https://x.example/', type: 'SOCIAL' }, { site: 'Bad', url: 'http://plain.example/', type: 'INFO' }]
};

test('extras: the entry by its id, shaped for the detail page, with MAL song names', async () => {
  const asked = [];
  const api = load({ anilist: async (_, variables) => { asked.push(variables); return { Media: media }; }, crossSiteTracks: { anilistEntry: async () => { throw new Error('not needed'); } },
    api: async pathname => { assert.equal(pathname, '/anime/20/themes'); return { data: { openings: ['1: "Song" by Band (eps 1-12)'], endings: [] } }; } });
  const extras = await api.loadAnimeExtras({ provider: 'reanime', id: 'show', anilistId: 10 });
  assert.equal(JSON.stringify(asked), '[{"id":10}]');
  assert.equal(JSON.stringify(extras.nextAiring), '{"episode":8,"at":1800000000000}'); assert.equal(extras.trailer, 'https://www.youtube.com/watch?v=abcDEF12345');
  assert.deepEqual(Array.from(extras.tags), ['School']);
  assert.equal(extras.characters[0].voiceNative, '声一');
  // Only anime among the relations; a picture that is not https is dropped; links are official / streaming https ones.
  assert.equal(JSON.stringify(extras.relations.map(item => [item.anilistId, item.relationType])), '[[11,"SEQUEL"]]');
  assert.equal(JSON.stringify(extras.recommendations.map(item => [item.anilistId, item.title, item.image, item.score])), '[[30,"Other","",8.1]]');
  assert.equal(extras.links.map(link => link.site).join(), 'Official Site');
  assert.deepEqual(Array.from(extras.themes.openings), ['"Song" by Band (eps 1-12)']);
});

test('extras: a Korean site\'s work is found by its original title; none without an entry; a failure is not kept', async () => {
  let entries = 0, fail = true, calls = 0;
  const api = load({ api: async () => null, crossSiteTracks: { anilistEntry: async anime => { entries++; return anime.title_japanese ? { id: 10 } : null; } },
    anilist: async (_, variables) => { calls++; if (fail) throw new Error('limit'); assert.equal(JSON.stringify(variables), '{"id":10}'); return { Media: media }; } });
  assert.equal(await api.loadAnimeExtras({ provider: 'linkani', id: '5', title: '쇼' }), null);
  // 애니24's own id is not trusted as it is: the entry is checked by the original title.
  const anime = { provider: 'ohli24', id: '쇼', anilistId: 999, title_japanese: 'ショー' };
  await assert.rejects(api.animeExtras(anime), /limit/); fail = false;
  assert.equal((await api.animeExtras(anime)).anilistId, 10); await api.animeExtras(anime);
  assert.equal(calls, 2); assert.equal(entries, 3);
});

test('library facts: the latest episode that is out dates the work', () => {
  const api = load({}), now = Date.parse('2026-11-10T12:00:00Z');
  const facts = api.libraryFacts({ availableEpisodes: 7, totalEpisodes: '12', status: 'Releasing' }, [
    { number: 6, airedDate: '2026-11-03' }, { number: 7, airedDate: '2026-11-10' }, { number: 8, airedDate: '2026-11-17' },
    { number: 9, airedDate: '2026-11-09', playable: false }, { number: 1, airedDate: '' }], now);
  assert.equal(facts.availableEpisodes, 7); assert.equal(facts.totalEpisodes, 12); assert.equal(facts.episodes, null);
  assert.equal(facts.updatedAt, '2026-11-10T00:00:00.000Z');
  assert.equal(api.libraryFacts({}, [], now).updatedAt, '');
});
