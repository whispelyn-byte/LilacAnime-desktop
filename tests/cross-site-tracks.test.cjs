const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCrossSiteTracks, titleKey, nativeOf, yearOf, pickByNative, pickByTitle } = require('../electron/cross-site-tracks.cjs');

const media = (id, native, year, extra = {}) => ({ id, seasonYear: year, title: { native, english: extra.english || '', romaji: extra.romaji || '' }, synonyms: extra.synonyms || [], episodes: extra.episodes ?? 12 });

test('titles compare without spacing, punctuation, "uncensored" or the way a season is written', () => {
  assert.equal(titleKey('Magic Repo Man: I\'ll Cash In'), titleKey('Magic Repo Man Ill Cash In'));
  assert.equal(titleKey('Show 2nd Season'), titleKey('Show Season 2'));
  assert.equal(titleKey('Even the Student Council Has Its Holes (Uncensored)'), titleKey('Even The Student Council Has Its Holes'));
  assert.equal(titleKey('マロニエ王国の 七人の騎士'), titleKey('マロニエ王国の七人の騎士'));
  assert.equal(titleKey('ダンダダン 2期'), titleKey('ダンダダン 第2期'));
  assert.equal(titleKey('薬屋のひとりごと 第二期'), titleKey('薬屋のひとりごと 第2期'));
  assert.notEqual(titleKey('ダンダダン 第2期'), titleKey('ダンダダン'));
});

test('a Japanese title counts only in kana or kanji, and the year comes from year or air date', () => {
  assert.equal(nativeOf({ title_japanese: '葬送のフリーレン' }), '葬送のフリーレン');
  assert.equal(nativeOf({ title_japanese: 'Sousou no Frieren' }), '');
  assert.equal(nativeOf({ title_japanese: '장송의 프리렌' }), '');
  assert.equal(yearOf({ year: '2023' }), 2023);
  assert.equal(yearOf({ aired: '2026-10-03 ~ 2026-12-19' }), 2026);
  assert.equal(yearOf({}), null);
});

test('the same Japanese title of the air year wins over a remake, and no other title is taken', () => {
  const list = [media(1, 'うる星やつら', 1981), media(2, 'うる星やつら', 2022), media(3, 'うる星やつら 完結編', 1988)];
  assert.equal(pickByNative(list, 'うる星やつら', 2022).id, 2);
  assert.equal(pickByNative(list, 'うる星やつら', 2023).id, 2); // a year off (late December)
  assert.equal(pickByNative(list, 'うる星やつら', 2000), null); // two of that title, neither of the year
  assert.equal(pickByNative([media(4, '別の作品', 2022)], 'うる星やつら', 2022), null);
  assert.equal(pickByNative(list, 'うる星やつら', null).id, 1);
});

test('an English title matches the English, romaji or another name of the entry', () => {
  const list = [media(10, 'マロニエ王国の七人の騎士', 2026, { english: 'The Seven Knights of the Marronnier Kingdom' }), media(11, '別', 2026, { romaji: 'Betsu', synonyms: ['Other Show'] })];
  assert.equal(pickByTitle(list, 'The Seven Knights Of The Marronnier Kingdom', 2026).id, 10);
  assert.equal(pickByTitle(list, 'Other Show', null).id, 11);
  assert.equal(pickByTitle(list, 'The Seven Knights', 2026), null);
});

function harness({ results = {}, fail = false, miruro = null } = {}) {
  const searches = [], asked = [], writes = [], miruroAsked = [];
  const lookup = createCrossSiteTracks({
    searchAnilist: async text => { searches.push(text); if (fail) throw new Error('AniList HTTP 429'); return results[text] || []; },
    reanimeTracks: async (id, number) => { asked.push(`${id}:${number}`); return { tracks: [{ url: `ja-${id}-${number}`, language: 'ja', label: 'Japanese' }], referer: 'https://flixcloud.cc/e/x' }; },
    ...(miruro ? {
      miruroId: async (id, titles) => { miruroAsked.push(`id ${id} ${titles.join('|')}`); return miruro.id ?? null; },
      miruroTracks: async (id, number) => { miruroAsked.push(`tracks ${id}:${number}`); if (miruro.fail) throw new Error('Miruro HTTP 500'); return { tracks: miruro.tracks || [] }; }
    } : {}),
    readCache: () => ({}), writeCache: value => writes.push(JSON.parse(JSON.stringify(value)))
  });
  return { lookup, searches, asked, writes, miruroAsked };
}

test('another site\'s episode gets RE:Anime tracks of its AniList entry, marked as another site\'s', async () => {
  const state = harness({ results: { '薬屋のひとりごと': [media(161645, '薬屋のひとりごと', 2023, { episodes: 24 })] } });
  const result = await state.lookup.tracks({ provider: 'ohli24', id: 'x', title: '약사의 혼잣말', title_japanese: '薬屋のひとりごと', year: '2023' }, { number: 3 });
  assert.deepEqual(state.asked, ['161645:3']);
  assert.equal(result.tracks[0].crossSite, true); assert.equal(result.tracks[0].origin, 'reanime');
  assert.equal(result.referer, 'https://flixcloud.cc/e/x');
  assert.equal(state.writes.at(-1)['ohli24:x'].id, 161645);
});

test('Miruro and Linkkf ids are used as they are; 애니24 ids are checked by the Japanese title first', async () => {
  const state = harness({ results: { '薬屋のひとりごと': [media(161645, '薬屋のひとりごと', 2023)] } });
  await state.lookup.tracks({ provider: 'miruro', id: 'm', anilistId: 999, title_japanese: '薬屋のひとりごと' }, { number: 1 });
  await state.lookup.tracks({ provider: 'linkkf', id: 'l', anilistId: 998 }, { number: 1 });
  await state.lookup.tracks({ provider: 'ohli24', id: 'o', anilistId: 777, title_japanese: '薬屋のひとりごと', year: '2023' }, { number: 1 });
  assert.deepEqual(state.asked, ['999:1', '998:1', '161645:1']);
  assert.deepEqual(state.searches, ['薬屋のひとりごと']);
});

test('no tracks for specials, dubs, half episodes or a number past the entry, and none from the site playing', async () => {
  const state = harness({ results: { '作品': [media(5, '作品', 2024, { episodes: 12 })] } });
  const anime = { provider: 'linkani', id: 'a', title_japanese: '作品', year: '2024' };
  for (const [show, episode] of [[{ ...anime, provider: 'reanime', anilistId: 5 }, { number: 1 }], [anime, { number: 1, special: true }], [anime, { number: 1, dub: true }], [anime, { number: 9.5 }], [anime, { number: 13 }]]) {
    assert.deepEqual((await state.lookup.tracks(show, episode)).tracks, []);
  }
  assert.deepEqual(state.asked, []);
});

test('Miruro\'s tracks are found by the entry\'s titles and added for languages RE:Anime has none of', async () => {
  const miruroTracks = [{ url: 'm-ko', language: 'ko', label: 'Korean' }, { url: 'm-ja', language: 'ja', label: 'Japanese' }, { url: 'm-es', language: 'es', label: 'Spanish' }];
  const state = harness({ results: { '作品': [media(5, '作品', 2024, { english: 'The Work' })] }, miruro: { id: 'mid', tracks: miruroTracks } });
  const result = await state.lookup.tracks({ provider: 'animenosub', id: 'w', title: 'The Work', title_japanese: '作品', year: '2024' }, { number: 2 });
  assert.deepEqual(result.tracks.map(track => `${track.origin}:${track.url}`), ['reanime:ja-5-2', 'miruro:m-ko', 'miruro:m-es']);
  assert.equal(result.tracks.every(track => track.crossSite), true);
  assert.equal(result.tracks[0].referer, 'https://flixcloud.cc/e/x'); assert.equal(result.tracks[1].referer, '');
  assert.deepEqual(state.miruroAsked, ['id 5 作品|The Work', 'tracks mid:2']);
  assert.equal(state.writes.at(-1)['miruro:5'].id, 'mid');
});

test('a Re:Anime episode asks Miruro only, a Miruro episode RE:Anime only, and one site failing leaves the other', async () => {
  const state = harness({ miruro: { id: 'mid', tracks: [{ url: 'm-ko', language: 'ko', label: 'Korean' }] } });
  const own = await state.lookup.tracks({ provider: 'reanime', id: 'r', anilistId: 7 }, { number: 1 });
  assert.deepEqual(own.tracks.map(track => track.url), ['m-ko']); assert.deepEqual(state.asked, []);
  const miruro = await state.lookup.tracks({ provider: 'miruro', id: 'mid', anilistId: 7 }, { number: 1 });
  assert.deepEqual(miruro.tracks.map(track => track.url), ['ja-7-1']);
  const failing = harness({ miruro: { id: 'mid', fail: true } });
  const result = await failing.lookup.tracks({ provider: 'linkkf', id: 'l', anilistId: 8 }, { number: 3 });
  assert.deepEqual(result.tracks.map(track => track.url), ['ja-8-3']);
});

test('a show Miruro does not have is remembered as missing', async () => {
  const state = harness({ miruro: { id: null } });
  await state.lookup.tracks({ provider: 'linkkf', id: 'l', anilistId: 8 }, { number: 1 });
  await state.lookup.tracks({ provider: 'linkkf', id: 'l', anilistId: 8 }, { number: 2 });
  assert.equal(state.miruroAsked.filter(line => line.startsWith('id')).length, 1);
});

test('an English-titled show is found by its English title when it has no Japanese one', async () => {
  const state = harness({ results: { 'Frieren: Beyond Journey\'s End': [media(154587, '葬送のフリーレン', 2023, { english: 'Frieren: Beyond Journey\'s End' })] } });
  await state.lookup.tracks({ provider: 'animenosub', id: 'frieren', title: 'Frieren: Beyond Journey\'s End' }, { number: 2 });
  assert.deepEqual(state.asked, ['154587:2']);
});

test('a match and a miss are kept, a failed lookup is asked again', async () => {
  const found = harness({ results: { '作品': [media(5, '作品', 2024)] } });
  const anime = { provider: 'linkani', id: 'a', title_japanese: '作品', year: '2024' };
  await found.lookup.tracks(anime, { number: 1 }); await found.lookup.tracks(anime, { number: 2 });
  assert.equal(found.searches.length, 1);
  const missing = harness();
  await missing.lookup.tracks({ ...anime, title_japanese: '無い作品' }, { number: 1 }); await missing.lookup.tracks({ ...anime, title_japanese: '無い作品' }, { number: 1 });
  assert.equal(missing.searches.length, 1); assert.equal(missing.writes.at(-1)['linkani:a'].id, null);
  const failing = harness({ fail: true });
  await assert.rejects(failing.lookup.tracks(anime, { number: 1 }));
  await assert.rejects(failing.lookup.tracks(anime, { number: 1 }));
  assert.equal(failing.searches.length, 2); assert.equal(failing.writes.length, 0);
});
