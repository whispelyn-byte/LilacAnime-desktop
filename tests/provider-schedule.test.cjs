const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProviderSchedule, weekDate } = require('../electron/provider-schedule.cjs');
const now = () => Date.parse('2026-10-17T10:00:00+09:00');
const anime = (provider, id) => ({ provider, id, mal_id: `${provider}:${id}`, title: id, genres: [] });
test('Korean calendar week is independent of the system timezone, including Sunday', () => {
  assert.equal(weekDate(0, now()), '2026-10-18');
  assert.equal(weekDate(1, Date.parse('2026-10-18T16:00:00Z')), '2026-10-19');
});
test('RE schedule retains native IDs, converts time, shows one row per episode and marks its dub', async () => {
  let calls = 0;
  const load = createProviderSchedule({ now, reanimeBase: 'https://re.test', reanimeFetch: async url => {
    calls++; assert.match(url, /tz=Asia%2FSeoul/);
    return { schedule: [{ date: '2026-10-17', episodes: ['raw', 'sub', 'dub'].map(air_type => ({ anime_id: 'show', episode_number: 2, episode_date: '2026-10-16T15:30:00Z', air_type })) }] };
  }, reanimeItems: rows => rows.map(raw => anime('reanime', raw.anime_id)) });
  const result = await load('reanime', 6);
  assert.equal(result.native, true); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].time, '00:30'); assert.equal(result.items[0].track, 'sub'); assert.equal(result.items[0].dub, true);
  assert.equal(result.items[0].anime.mal_id, 'reanime:show');
  await load('reanime', 6); assert.equal(calls, 1);
});
test('Miruro reads pagination, filters Korean date boundaries and joins native IDs', async () => {
  const calls = [];
  const load = createProviderSchedule({ now, miruroItem: raw => anime('miruro', raw.id), miruroApi: async (route, params) => {
    calls.push({ route, params });
    if (route === 'anime') return { data: [{ id: 'show' }] };
    if (!params.cursor) return { data: [{ anime_id: 'wrong-day', air_at: '2026-10-16T14:59:00Z' }], has_more: true, next_cursor: 'next' };
    return { data: [{ anime_id: 'show', air_at: '2026-10-16T15:00:00Z', episode_number: 3, track: 'sub' }] };
  } });
  const result = await load('miruro', 6);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].time, '00:00');
  assert.equal(result.items[0].anime.mal_id, 'miruro:show');
  assert.equal(calls[0].params.from, '2026-10-11'); assert.equal(calls[0].params.to, '2026-10-18');
  assert.equal(calls[2].params.id_in, 'show');
});
test('Miruro raw, sub and dub airings of one episode are one row at the sub time (#30)', async () => {
  const at = (time, track, episode_number = 6) => ({ anime_id: 'show', air_at: `2026-10-16T${time}:00Z`, episode_number, track });
  const load = createProviderSchedule({ now, miruroItem: raw => anime('miruro', raw.id), miruroApi: async route => route === 'anime'
    ? { data: [{ id: 'show' }] } : { data: [at('15:00', 'raw'), at('15:30', 'dub'), at('15:30', 'sub'), at('16:00', 'dub', 3)] } });
  const result = await load('miruro', 6);
  assert.deepEqual(result.items.map(item => [item.time, item.episode, item.track, item.dub]), [['00:30', 6, 'sub', true], ['01:00', 3, 'dub', false]]);
});
test('weekday sources preserve grouping and do not invent broadcast times', async () => {
  let ohliUrl;
  const load = createProviderSchedule({ now, animenosubBase: 'https://ans.test',
    animenosubFetch: async () => '<div class="schedulepage sch_saturday"><div class="bs"><a>sat</a></div></div><div class="schedulepage sch_sunday"><div class="bs">sun</div></div>',
    animenosubItems: html => [anime('animenosub', html.includes('sat') ? 'sat' : 'sun')],
    ohliBase: 'https://ohli.test', ohliPage: async url => { ohliUrl = url; return { sca: '토요일', items: [{ id: 'sat' }] }; }, ohliAnime: raw => anime('ohli24', raw.id),
    linkaniBase: 'https://link.test', linkaniFetch: async url => `<div class="vod-list"><div class="vod-item">${url.includes('page/2') ? 'two' : 'one'}</div></div>${url.includes('page/2') ? '' : '<a href="/list/2/class/%ED%86%A0/page/2/">2</a>'}`,
    linkaniItems: html => [anime('linkani', html.includes('two') ? 'two' : 'one')],
    linkkfTags: [11, 12, 13, 14, 15, 16, 17], linkkfBase: 'https://kf.test', linkkfFetch: async url => { assert.match(url, /categorytagid=17/); return { data: [{ id: 'sun' }] }; }, linkkfAnime: raw => anime('linkkf', raw.id)
  });
  const ans = await load('animenosub', 6); assert.equal(ans.items[0].anime.id, 'sat'); assert.equal(ans.timed, false); assert.equal(ans.items[0].time, '');
  assert.equal((await load('ohli24', 6)).items[0].anime.id, 'sat'); assert.equal(new URL(ohliUrl).searchParams.get('weekday'), '토요일');
  assert.equal((await load('linkani', 6)).items.length, 2);
  assert.equal((await load('linkkf', 0)).items[0].anime.id, 'sun');
});
test('source failure explicitly falls back, retry recovers, empty native days stay empty', async () => {
  let failed = true, calls = 0;
  const load = createProviderSchedule({ now, ohliBase: 'https://ohli.test', ohliPage: async () => { calls++; if (failed) throw new Error('offline'); return { sca: '토요일', items: [] }; }, fallback: async () => [{ title: 'fallback' }] });
  const fallback = await load('ohli24', 6); assert.equal(fallback.native, false); assert.match(fallback.note, /Anissia/);
  failed = false;
  const result = await load('ohli24', 6); assert.equal(result.native, true); assert.deepEqual(result.items, []); assert.equal(calls, 2);
  await assert.rejects(load('unknown', 0)); await assert.rejects(load('ohli24', 7));
});
test('Monday requests share the week fetch without waiting on their own pending day request', { timeout: 1000 }, async () => {
  let calls = 0;
  const load = createProviderSchedule({ now, reanimeBase: 'https://re.test', reanimeFetch: async () => { calls++; return { schedule: [{ date: '2026-10-12', episodes: [] }] }; },
    animenosubBase: 'https://ans.test', animenosubFetch: async () => '<div class="schedulepage sch_monday"></div>' });
  const [one, two, ans] = await Promise.all([load('reanime', 1), load('reanime', 1), load('animenosub', 1)]);
  assert.equal(one.native, true); assert.equal(two.native, true); assert.equal(ans.native, true); assert.equal(calls, 1);
});
