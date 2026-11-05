const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKoreanSiteSubtitles, koreanSeason, koreanBase, nativeSeason, candidates, sameWork, episodeOf } = require('../electron/korean-site-subtitles.cjs');
const { createCrossSiteTracks } = require('../electron/cross-site-tracks.cjs');

test('Korean titles compare without their season, which is read from "N기", "시즌 N" or the Japanese title', () => {
  assert.equal(koreanSeason('약사의 혼잣말 2기'), 2); assert.equal(koreanSeason('스파이 패밀리 시즌 3'), 3); assert.equal(koreanSeason('단다단'), 1);
  assert.equal(koreanSeason('기기괴괴'), 1); // "기" inside a word is no season
  assert.equal(koreanBase('약사의 혼잣말 2기'), koreanBase('약사의혼잣말'));
  assert.equal(nativeSeason('薬屋のひとりごと 第2期'), 2); assert.equal(nativeSeason('薬屋のひとりごと'), null);
});

test('search hits of the same title and season are kept, by the Korean or the Japanese title\'s season', () => {
  const hits = [{ ref: 'a', title: '약사의 혼잣말 3기' }, { ref: 'b', title: '약사의 혼잣말 2기' }, { ref: 'c', title: '약사의 혼잣말' }, { ref: 'd', title: '약사의 혼잣말 외전' }];
  assert.deepEqual(candidates(hits, ['약사의 혼잣말 2기']).map(hit => hit.ref), ['b']);
  assert.deepEqual(candidates(hits, ['약사의 혼잣말'], '薬屋のひとりごと 第2期').map(hit => hit.ref), ['b', 'c']);
  assert.deepEqual(candidates(hits, ['약'], '').map(hit => hit.ref), []); // too short to tell
});

test('a show page is the work by its Japanese title first, its AniList entry otherwise', () => {
  const work = { anilistId: 5, native: 'ダンダダン 第2期' };
  assert.equal(sameWork({ native: 'ダンダダン 2期', anilistId: 999 }, work), true); // a loose AniList id loses to the title
  assert.equal(sameWork({ native: 'ダンダダン', anilistId: 5 }, work), false);
  assert.equal(sameWork({ native: '', anilistId: 5 }, work), true);
  assert.equal(sameWork({ native: '', anilistId: 6 }, { anilistId: 5, native: '' }), false);
});

test('the numbered episode is taken, never a special or a dub of that number', () => {
  const list = [{ number: 1, special: true, url: 'ova' }, { number: 1, dub: true, url: 'dub' }, { number: 1, url: 'ep1' }];
  assert.equal(episodeOf(list, 1).url, 'ep1'); assert.equal(episodeOf(list, 2), null);
});

function harness({ search = {}, details = {}, files = {}, catalog = null, failSubtitle = false } = {}) {
  const calls = [], writes = [];
  const site = name => ({
    search: async titles => { calls.push(`${name} search ${titles.join('|')}`); return search[name] || []; },
    detail: async ref => { calls.push(`${name} detail ${ref}`); return details[ref] || null; },
    subtitle: async episode => { calls.push(`${name} file ${episode.url}`); if (failSubtitle) throw new Error('offline'); return files[episode.url] ? { path: files[episode.url], url: `file:///${files[episode.url]}` } : null; }
  });
  const korean = createKoreanSiteSubtitles({
    koreanTitles: async anime => { calls.push('korean titles'); return ['약사의 혼잣말 2기']; },
    readCache: () => ({}), writeCache: value => writes.push(JSON.parse(JSON.stringify(value))), timeout: 200,
    sites: {
      ohli24: site('ohli24'), linkani: site('linkani'),
      linkkf: { ...site('linkkf'), search: null, byAnilist: async id => { calls.push(`linkkf id ${id}`); return catalog; } }
    }
  });
  return { korean, calls, writes };
}
const anime = { provider: 'reanime', id: 'r', title: 'The Apothecary Diaries Season 2' };
const entry = { id: 161645, titles: ['薬屋のひとりごと 第2期', 'The Apothecary Diaries Season 2'] };
const showPage = (native, numbers = [1, 2, 3]) => ({ native, anilistId: null, episodes: numbers.map(number => ({ number, url: `${native}-${number}` })) });

test('a Korean site\'s file of the episode is found through its search and its show page, marked with its site', async () => {
  const state = harness({
    search: { ohli24: [{ ref: 'o1', title: '약사의 혼잣말' }, { ref: 'o2', title: '약사의 혼잣말 2기' }] },
    details: { o2: showPage('薬屋のひとりごと 第2期') }, files: { '薬屋のひとりごと 第2期-3': 'C:/sub/ohli24.srt' }
  });
  const tracks = await state.korean.tracks({ anime, episode: { number: 3 }, entry });
  assert.deepEqual(tracks.map(track => [track.origin, track.language, track.path, track.crossSite]), [['ohli24', 'ko', 'C:/sub/ohli24.srt', true]]);
  assert.equal(tracks[0].localUrl, 'file:///C:/sub/ohli24.srt');
  assert.equal(state.writes.at(-1)['korean:ohli24:161645'].ref, 'o2');
  assert.ok(!state.calls.includes('ohli24 detail o1')); // "약사의 혼잣말" is the first season by its Korean title
});

test('a show of another Japanese title is not taken, and a miss is remembered', async () => {
  const state = harness({ search: { ohli24: [{ ref: 'o2', title: '약사의 혼잣말 2기' }] }, details: { o2: showPage('別の作品') } });
  assert.deepEqual(await state.korean.tracks({ anime, episode: { number: 1 }, entry }), []);
  await state.korean.tracks({ anime, episode: { number: 2 }, entry });
  assert.equal(state.calls.filter(call => call.startsWith('ohli24 search')).length, 1);
});

test('Linkkf is found by its catalog\'s AniList entry, without a search', async () => {
  const state = harness({ catalog: 'post9', details: { post9: showPage('薬屋のひとりごと 第2期') }, files: { '薬屋のひとりごと 第2期-1': 'C:/sub/linkkf.vtt' } });
  const tracks = await state.korean.tracks({ anime, episode: { number: 1 }, entry });
  assert.deepEqual(tracks.map(track => track.origin), ['linkkf']);
  assert.ok(state.calls.includes('linkkf id 161645')); assert.ok(!state.calls.some(call => call.startsWith('linkkf search')));
});

test('the playing site, specials and dubs are not asked, and a failing or slow site leaves the others', async () => {
  const state = harness({ catalog: 'post9', details: { post9: showPage('薬屋のひとりごと 第2期') }, files: { '薬屋のひとりごと 第2期-1': 'C:/sub/linkkf.vtt' } });
  assert.deepEqual(await state.korean.tracks({ anime: { ...anime, provider: 'linkkf' }, episode: { number: 1 }, entry }), []);
  assert.deepEqual(await state.korean.tracks({ anime, episode: { number: 1, special: true }, entry }), []);
  const failing = harness({ catalog: 'post9', details: { post9: showPage('薬屋のひとりごと 第2期') }, failSubtitle: true });
  assert.deepEqual(await failing.korean.tracks({ anime, episode: { number: 1 }, entry }), []);
});

test('the Korean sites are asked apart from RE:Anime and Miruro, always, for the numbered entry only', async () => {
  const asked = [];
  const lookup = createCrossSiteTracks({
    searchAnilist: async () => [], reanimeTracks: async () => ({ tracks: [{ url: 'ko', language: 'ko', label: 'Korean' }], referer: '' }),
    koreanSites: async request => { asked.push(`${request.anime.provider}:${request.entry.id}`); return [{ url: 'file:///k.vtt', language: 'ko', label: '한국어', crossSite: true, origin: 'ohli24' }]; },
    readCache: () => ({}), writeCache: () => {}
  });
  // RE:Anime's own Korean track does not keep them from being asked, nor are they part of its (faster) answer.
  assert.deepEqual((await lookup.tracks({ provider: 'linkkf', id: 'l', anilistId: 8 }, { number: 1 })).tracks.map(track => track.url), ['ko']);
  assert.deepEqual((await lookup.koreanSiteTracks({ provider: 'linkkf', id: 'l', anilistId: 8 }, { number: 1 })).map(track => track.origin), ['ohli24']);
  assert.deepEqual(await lookup.koreanSiteTracks({ provider: 'linkkf', id: 'l', anilistId: 8 }, { number: 1, special: true }), []);
  assert.deepEqual(asked, ['linkkf:8']);
});
