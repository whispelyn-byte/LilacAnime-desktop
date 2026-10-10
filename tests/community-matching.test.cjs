const { test } = require('node:test');
const assert = require('node:assert/strict');
const { communityEpisodes, communityFileEpisode, selectCommunityFile } = require('../electron/community-matching.cjs');

test('episode labels retain decimals and distinguish ranges from individual episodes', () => {
  const episodes = communityEpisodes('1, 3화 / 10–12화 / 12.5화자막 / EP. 14');
  for (const n of [1, 3, 10, 11, 12, 12.5, 14]) assert.equal(episodes.has(n), true, String(n));
  for (const n of [2, 5, 13]) assert.equal(episodes.has(n), false, String(n));
  assert.equal(communityEpisodes('제목 2기 1080p').any, false);
});

test('subtitle filenames match episode numbers without consuming resolution, years or CRC tags', () => {
  const cases = [
    ['Show [01].ass', 1], ['Show - 01 [1080p][A1B2C3D4].ass', 1],
    ['[Show][01v2].ass', 1], ['Show_01_1080p_x264.ass', 1],
    ['Show E01.1080p.ass', 1], ['Show EP.12.5.ass', 12.5],
    ['Show 12.5v2.ass', 12.5], ['Show 01 (완).ass', 1],
    ['Show 12화 자막.srt', 12], ['Show [1080p][5A2B3C4D].ass', null],
    ['Show 2026.ass', null], ['Kaiju No. 8.ass', null], ['Show Part 2.ass', null],
    ['csora_file0.ass', null], ['anissia_file1.ass', null]
  ];
  for (const [name, episode] of cases) assert.equal(communityFileEpisode(name).episode, episode, name);
  assert.deepEqual(communityFileEpisode('Show_S02E05.ass'), { episode: 5, season: 2 });
});

test('a bundle never substitutes another episode or an unnumbered script', () => {
  for (const files of [['Show 03.ass'], ['Show 03.ass', 'main.ass'], ['main.ass']]) {
    assert.equal(selectCommunityFile(files, { episode: 1, strict: true, bundle: true }), null);
  }
  assert.equal(selectCommunityFile(['Show 12.5.ass', 'Show 12.ass'], { episode: 12.5, strict: true }).file, 'Show 12.5.ass');
});

test('unnumbered movies and episode-specific posts still work without accepting wrong numbered files', () => {
  assert.equal(selectCommunityFile(['main.ass'], { episode: 1, strict: true }).file, 'main.ass');
  assert.equal(selectCommunityFile(['main.ass'], { episode: 7 }).file, 'main.ass');
  assert.equal(selectCommunityFile(['main.ass'], { episode: 7, strict: true }), null);
  assert.equal(selectCommunityFile(['Show 03.ass'], { episode: 1 }), undefined);
});

test('matching season, full scripts, ASS and revised versions are preferred in that order', () => {
  const files = ['Show S01E01.ass', 'Show S02E01.srt', 'Show S02E01.ass', 'Show S02E01v2.ass', 'Show S02E01 PV.ass'];
  assert.equal(selectCommunityFile(files, { episode: 1, season: 2 }).file, 'Show S02E01v2.ass');
  assert.equal(selectCommunityFile(['Show 01 NCOP.ass', 'Show 01.srt'], { episode: 1 }).file, 'Show 01.srt');
  assert.equal(selectCommunityFile(['Show_01_NCOP.ass', 'Show 01.srt'], { episode: 1 }).file, 'Show 01.srt');
});
