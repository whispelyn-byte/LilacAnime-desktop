const { test } = require('node:test');
const assert = require('node:assert/strict');
const { communityEpisodes, communityFileEpisode, communityLinkEpisodes, planCommunityLinks, pickCommunityFile, selectCommunityFile } = require('../electron/community-matching.cjs');

test('episode labels retain decimals and distinguish ranges from individual episodes', () => {
  const episodes = communityEpisodes('1, 3화 / 10–12화 / 12.5화자막 / EP. 14');
  for (const n of [1, 3, 10, 11, 12, 12.5, 14]) assert.equal(episodes.has(n), true, String(n));
  for (const n of [2, 5, 13]) assert.equal(episodes.has(n), false, String(n));
  assert.equal(communityEpisodes('제목 2기 1080p').any, false);
});

test('bundled posts written with +, · or 화 on both ends of a range keep every episode', () => {
  for (const [title, has, not] of [['작품 1+5화', [1, 5], [2]], ['작품 1·5화', [1, 5], [3]], ['작품 1・2화', [1, 2], [3]], ['작품 1화~3화', [1, 2, 3], [4]], ['작품 1화 - 3화', [1, 2, 3], [4]]]) {
    const episodes = communityEpisodes(title);
    for (const n of has) assert.equal(episodes.has(n), true, `${title} ${n}`);
    for (const n of not) assert.equal(episodes.has(n), false, `${title} ${n}`);
  }
  assert.deepEqual(communityEpisodes('작품 2기 - 5화').ranges, []);
});

test('subtitle filenames match episode numbers without consuming resolution, years or CRC tags', () => {
  const cases = [
    ['Show [01].ass', 1], ['Show - 01 [1080p][A1B2C3D4].ass', 1],
    ['[Show][01v2].ass', 1], ['Show_01_1080p_x264.ass', 1],
    ['Show E01.1080p.ass', 1], ['Show EP.12.5.ass', 12.5],
    ['Show 12.5v2.ass', 12.5], ['Show 01 (완).ass', 1],
    ['Show 12화 자막.srt', 12], ['Show [1080p][5A2B3C4D].ass', null],
    ['Show 2026.ass', null], ['Kaiju No. 8.ass', null], ['Show Part 2.ass', null],
    ['csora_file0.ass', null], ['anissia_file1.ass', null],
    ['Yasei no Last Boss ga Arawareta - 01SubsPlease.smi', 1], ['Show - 2nd.ass', null],
    // Release names as Anissia makers ship them.
    ['[SubsPlease] Black Torch - 07 (1080p) [6D89AB2F].srt', 7], ['[Ohys-Raws] Kikansha no Mahou wa Tokubetsu Desu - 01 (BS11 1280x720 x264 AAC).smi', 1],
    ['Hotaru Yome 01_SubsPlease.srt', 1], ['슈뒤담 - 12_ToonsHub.srt', 12], ['약사의 혼잣말03.ass', 3], ['꽃피우는 그대들에게2.smi', null],
    ['[SubsPlease] Iseleve - OVA (1080p) [FEE28781].smi', null]
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

test('a set of files differing in one number is numbered by it, never given to every episode', () => {
  // An Anissia archive whose names the parser alone did not read: episode 1 got episode 8's subtitle.
  const files = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `Yasei no Last Boss ga Arawareta - 0${n}SubsPlease.smi`).concat('Yasei no Last Boss ga Arawareta - 08SubsPlease.vtt');
  assert.equal(selectCommunityFile(files, { episode: 1 }).file, 'Yasei no Last Boss ga Arawareta - 01SubsPlease.smi');
  assert.equal(selectCommunityFile(files, { episode: 8 }).file, 'Yasei no Last Boss ga Arawareta - 08SubsPlease.vtt');
  const odd = ['ab01cd.smi', 'ab02cd.smi', 'ab03cd.smi'];
  assert.equal(selectCommunityFile(odd, { episode: 2 }).file, 'ab02cd.smi');
  assert.equal(selectCommunityFile(odd, { episode: 4 }), undefined);
});

test('link texts read bare ranges and file names, not seasons or sizes', () => {
  const read = label => { const e = communityLinkEpisodes(label); return [...e.list, ...e.ranges.map(r => r.join('~'))].join(','); };
  assert.equal(read('이세계 유유자적 농가 1-12 SubsPlease'), '1~12');
  assert.equal(read('Kami no Shizuku1-24.Zip 0.26MB'), '1~24');
  assert.equal(read('클레바테스 S2 03-04 SubsPlease'), '3~4');
  assert.equal(read('Kanata kara - 03Subsplease.smi'), '3');
  assert.equal(read('Hotaru Yome 01.zip 0.02MB'), '1');
  for (const label of ['LasTame S2.zip 0.17MB', '[CoNe] 애니 나소흑전기 - 회차 전체 통합.zip 7.29MB', '자막 다운로드', 'BLACK TORCH']) assert.equal(read(label), '', label);
});

test('links are tiered by what they name, and a post for other episodes is skipped unless it may bundle them', () => {
  const plan = (title, labels, episode) => planCommunityLinks(title, communityEpisodes(title), labels.map((label, i) => ({ href: `h${i}`, label })), episode)
    .tiers.map(tier => tier.map(link => link.href).join('+')).join(' > ');
  assert.equal(plan('작품', ['1~12화', '3화', '폰트', '자막 다운로드', '4화'], 3), 'h1 > h0 > h3');
  assert.equal(plan('작품 3화', ['자막 다운로드'], 5), '');
  // A finished series' last post, a range link in a later post, and a later post's large archive may hold it.
  assert.equal(plan('카구야 님은 고백받고 싶어 12화 자막(完)', ['카구야 님은 고백받고 싶어.zip'], 5), 'h0');
  assert.equal(plan('타코피의 원죄 6화', ['Takopii_no _Genzai_ 01~06.zip 0.06MB'], 3), 'h0');
  assert.equal(plan('무리무리 10화', ['무리무리.zip 0.17MB'], 3), 'h0');
  assert.equal(plan('무리무리 10화', ['무리무리.zip 0.02MB'], 3), '');
  assert.equal(plan('어떤 암부의 소녀공서 2화 자막', ['어떤 암부의 소녀공서 2화 [이전 화 포함].zip 2.62MB'], 1), 'h0');
  // A post for this episode alone keeps a link numbered the maker's way, after the ones that agree.
  assert.equal(plan('골든 카무이 5기 13화 자막', ['Golden Kamuy - 62.zip', '13화 SRT'], 13), 'h1 > h0');
});

test('a series post listing several seasons gives each season its own archives and files', () => {
  const labels = ['클레바테스 S2 1-4 SubsPlease', '클레바테스 1-12 SubsPlease', '자판기 2기 1-12 SubsPlease'];
  const plan = season => planCommunityLinks('클레바테스', communityEpisodes(''), labels.map((label, i) => ({ href: `h${i}`, label })), 1, { season })
    .tiers.map(tier => tier.map(link => link.href).join('+')).join(' > ');
  assert.equal(plan(1), 'h1'); assert.equal(plan(2), 'h0+h2');
  assert.deepEqual(communityFileEpisode('Clevatess S2 - 04SubsPlease.smi'), { episode: 4, season: 2 });
  const files = ['Clevatess S2 - 01SubsPlease.smi', 'Clevatess - 01SubsPlease.smi'];
  assert.equal(selectCommunityFile(files, { episode: 1, season: 1 }).file, files[1]);
  assert.equal(selectCommunityFile(files, { episode: 1, season: 2 }).file, files[0]);
  // A title marking no season: a later season's files are used only when they are all there is (시광대리인 영도편).
  assert.equal(selectCommunityFile(files, { episode: 1 }).file, files[1]);
  assert.equal(selectCommunityFile(['Link.Click.S03E02.1080p.ass'], { episode: 2, strict: true, bundle: true }).file, 'Link.Click.S03E02.1080p.ass');
});

test('a link named for the episode alone gives its one episode whatever its number; other links need the number', () => {
  const files = ['[SubsPlease] Golden Kamuy - 62 (1080p) [851C234E].srt'];
  assert.equal(pickCommunityFile(files, { episode: 13, exact: true }).file, files[0]);
  assert.equal(pickCommunityFile(files, { episode: 13 }), null);
  assert.equal(pickCommunityFile(['Show - 01.ass', 'Show - 02.ass'], { episode: 3, exact: true }), null);
  assert.equal(pickCommunityFile(['anissia_file0.smi'], { episode: 4, exact: true }).file, 'anissia_file0.smi');
});

test('matching season, full scripts, ASS and revised versions are preferred in that order', () => {
  const files = ['Show S01E01.ass', 'Show S02E01.srt', 'Show S02E01.ass', 'Show S02E01v2.ass', 'Show S02E01 PV.ass'];
  assert.equal(selectCommunityFile(files, { episode: 1, season: 2 }).file, 'Show S02E01v2.ass');
  assert.equal(selectCommunityFile(['Show 01 NCOP.ass', 'Show 01.srt'], { episode: 1 }).file, 'Show 01.srt');
  assert.equal(selectCommunityFile(['Show_01_NCOP.ass', 'Show 01.srt'], { episode: 1 }).file, 'Show 01.srt');
});
