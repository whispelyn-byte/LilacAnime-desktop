const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const cheerio = require('cheerio'), AdmZip = require('adm-zip');
const matching = require('../electron/community-matching.cjs');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
  return source.slice(first, last);
}
function setup(extra = {}) {
  let now = 1800000000000;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ URL, AbortSignal, Buffer, TextDecoder, Date: Clock, path, cheerio, AdmZip, fs,
    ...matching, hasHangul: value => /[가-힣]/.test(value), absoluteUrl: (url, base) => new URL(url, base).href,
    app: { getPath: () => '/stub-cache' }, ANISSIA_API: 'https://api.anissia.net', ...extra });
  // Cache files (writeCacheFile in main) go to the test's fs.
  context.writeCacheFile ??= (file, text) => { context.fs.writeFileSync(file, text); return Promise.resolve(); };
  for (const [start, end] of [
    ['function simpleTitle(', '// Same as Android KairanSubtitleService'],
    ['function communitySeason(', 'const COMMUNITY_FILE='],
    ['function rankCommunityPosts(', '// Episodes of the previous seasons'],
    ['function driveFolderId(', 'async function driveFolderEntries(']
  ]) vm.runInContext(section(start, end), context);
  return { context, load(start, end) { vm.runInContext(section(start, end), context); }, advance(ms) { now += ms; } };
}
const post = (title, id, labels = ['1화']) => ({ title, url: `https://example.blogspot.com/${id}.html`,
  html: labels.map((label, i) => `<a href="https://drive.google.com/file/d/${id}_${i}/view">${label}</a>`).join('') });
const feed = (start, count, total) => ({ feed: { openSearch$totalResults: { $t: String(total) }, entry: Array.from({ length: count }, (_, i) => ({
  title: { $t: `작품 ${start + i}화` }, link: [{ rel: 'alternate', href: `https://example.blogspot.com/${start + i}` }], content: { $t: '' }
})) } });

test('Csora never assumes its first labelled link is episode one', () => {
  const { context: c } = setup();
  const p = post('장송의 프리렌', 'missing-first', ['폰트', '2화', '3화']);
  assert.equal(c.rankCommunityPosts([p], '장송의 프리렌', 1).length, 0);
  const matches = c.rankCommunityPosts([p], '장송의 프리렌', 2);
  assert.equal(matches.length, 1); assert.equal(matches[0].episode, 2);
  assert.deepEqual(Array.from(matches[0].links), ['https://drive.google.com/file/d/missing-first_1/view', 'https://drive.google.com/file/d/missing-first_0/view']);
});

test('continued numbering requires a verified previous-season offset', () => {
  const { context: c } = setup();
  const p = post('장송의 프리렌 2기', 'season-two', ['13화', '14화']);
  assert.equal(c.rankCommunityPosts([p], '장송의 프리렌 2기', 1).length, 0);
  assert.equal(c.rankCommunityPosts([p], '장송의 프리렌 2기', 1, '', { offsets: [12] })[0].episode, 13);
  assert.equal(c.rankCommunityPosts([post('장송의 프리렌 13화', 'continued')], '장송의 프리렌 2기', 1, '', { offsets: [12] })[0].episode, 13);
  assert.equal(c.rankCommunityPosts([p], '장송의 프리렌', 1, '', { offsets: [12] }).length, 0);
});

test('decimal episodes and roman season numbers survive title filtering', () => {
  const { context: c } = setup();
  assert.equal(c.communityPostTitle('어떤 작품 12.5화 자막'), '어떤 작품');
  assert.equal(c.communitySeason('무직전생 Ⅱ'), 2);
  assert.equal(c.rankCommunityPosts([post('어떤 작품 12.5화 자막', 'decimal')], '어떤 작품', 5).length, 0);
  assert.equal(c.rankCommunityPosts([post('어떤 작품 12.5화 자막', 'decimal')], '어떤 작품', 12.5).length, 1);
});

test('an ordinal inside the title is not a season', () => {
  const { context: c } = setup();
  const prince = 'I Was Reincarnated as the 7th Prince so I Can Take My Time Perfecting My Magical Ability';
  assert.equal(c.titleSeason(prince), null);
  assert.equal(c.titleSeason(`${prince} Season 2`), 2);
  assert.equal(c.titleSeason('Mushoku Tensei 2nd Season'), 2);
  assert.equal(c.communitySeason('환생했는데 제7왕자라 내맘대로 마술을 연마합니다'), null);
  assert.equal(c.titleSeason('JMAF23th'), null, 'an ordinal glued to a word');
  assert.equal(c.titleSeason('DNA²'), null, 'a superscript is part of the name');
  assert.equal(c.titleSeason('Hell Mode 3rd Season'), 3);
  assert.equal(c.titleSeason('Wagnaria!!3'), 3);
});

// kannasub.tistory.com: posts are linked by title ("/entry/…-2기-4화-자막"), its search page draws results in script
// (the HTML has none), and its sidebar links the show's category, whose page lists the posts in its structured data.
test('a Tistory blog whose search shows nothing is read through the show\'s category', async () => {
  const origin = 'https://kannasub.tistory.com', show = '환생했는데 제7왕자라 내맘대로 마술을 연마합니다 2기';
  const category = `/category/${encodeURIComponent('2025년 3분기 자막')}/${encodeURIComponent(show)}`;
  const listed = [4, 5].map(n => ({ '@type': 'ListItem', position: n, item: { '@id': `${origin}/entry/${encodeURIComponent(`${show.replace(/ /g, '-')}-${n}화-자막`)}`, name: `${show} ${n}화 자막` } }));
  const pages = {
    search: `<a href="${category}">${show}</a><a href="/category/${encodeURIComponent('2026년 4분기 자막')}/${encodeURIComponent('빌려준 마력은 리볼빙으로 강제징수')}">other</a><a href="/entry/post">글쓰기</a>`,
    category: `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: listed })}</script>`,
  };
  const asked = [];
  const { context: c, load } = setup({ fetch: async () => { throw new Error('no rss'); }, LINKKF_UA: 'test',
    providerFetch: async url => { asked.push(url); return url.includes('/search/') ? pages.search : url.includes('?page=') ? pages.category : pages.category; } });
  load('async function tistoryPosts(', '// A maker\'s own name');
  const posts = await c.tistoryPosts(origin, show);
  assert.deepEqual(Array.from(posts, post => post.title), [`${show} 4화 자막`, `${show} 5화 자막`]);
  assert.ok(asked.some(url => url === `${origin}${category}`), 'the matching category is read');
  assert.ok(!asked.some(url => url.includes(encodeURIComponent('빌려준'))), 'another show\'s category is not');
});

test('extensionless Tistory attachments are taken by their link text', () => {
  const { context: c } = setup();
  const html = ['24309F3C5383FF2226">[leopard-raws]No Game No Life 07.smi', '223F803C5383FF2817">No Game No Life 07.rar']
    .map(link => `<a href="https://t1.daumcdn.net/cfile/tistory/${link}</a>`).join('') + '<a href="https://example.com/about">소개</a>';
  const found = c.communityLinks({ title: '노 게임 노 라이프 7화 자막', url: 'https://therapi.tistory.com/323', html }, 7);
  assert.deepEqual(Array.from(found.links), ['https://t1.daumcdn.net/cfile/tistory/24309F3C5383FF2226', 'https://t1.daumcdn.net/cfile/tistory/223F803C5383FF2817']);
});

test('range posts require bundle matching and duplicate episode links remain available as alternatives', () => {
  const { context: c } = setup();
  assert.equal(c.communityLinks(post('어떤 작품 1~12화', 'range'), 1).bundle, true);
  assert.equal(c.communityLinks(post('어떤 작품 1, 2화', 'multi'), 1).strict, true);
  const alternatives = c.communityLinks(post('어떤 작품', 'mirrors', ['1화 ASS', '1화 SRT', '2화']), 1);
  assert.equal(alternatives.links.length, 2); assert.equal(alternatives.strict, false);
});

test('Blogger requests share the complete index and fetch at most three additional pages concurrently', async () => {
  let calls = 0, active = 0, peak = 0; const writes = [];
  const h = setup({ fs: { readFileSync() { throw Error('missing'); }, writeFileSync(_, data) { writes.push(JSON.parse(data)); } },
    providerFetch: async url => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      const start = Number(new URL(url).searchParams.get('start-index'));
      return feed(start, Math.min(150, 785 - start + 1), 785);
    } });
  h.load('const communityPostCache=', 'function communitySeason(');
  const results = await Promise.all([h.context.communityPosts('https://example.blogspot.com/'), h.context.communityPosts('https://example.blogspot.com')]);
  assert.equal(calls, 6); assert.equal(peak, 3); assert.equal(results[0].length, 785);
  assert.equal(results[0], results[1]); assert.equal(writes.length, 1);
  assert.equal(results[0][150].url, 'https://example.blogspot.com/151');
});

test('an incomplete Blogger refresh keeps the old index, waits before retrying and recovers', async () => {
  let calls = 0, complete = false; const writes = [];
  const stale = { time: 1, posts: [post('이전 작품 1화', 'stale')] };
  const h = setup({ fs: { readFileSync: () => JSON.stringify(stale), writeFileSync(_, data) { writes.push(JSON.parse(data)); } },
    providerFetch: async url => { calls++; const start = Number(new URL(url).searchParams.get('start-index')); return feed(start, start === 1 ? 150 : complete ? 1 : 0, 151); } });
  h.load('const communityPostCache=', 'function communitySeason(');
  assert.equal((await h.context.communityPosts('https://example.blogspot.com'))[0].url, stale.posts[0].url);
  assert.equal(writes.length, 0); assert.equal(calls, 2);
  await h.context.communityPosts('https://example.blogspot.com', { force: true }); assert.equal(calls, 2);
  complete = true; h.advance(60001);
  assert.equal((await h.context.communityPosts('https://example.blogspot.com')).length, 151); assert.equal(writes.length, 1);
});

test('a failed first lookup does not cache an empty Blogger index', async () => {
  let fail = true;
  const h = setup({ fs: { readFileSync() { throw Error('missing'); }, writeFileSync() {} },
    providerFetch: async () => { if (fail) throw Error('offline'); return feed(1, 1, 1); } });
  h.load('const communityPostCache=', 'function communitySeason(');
  await assert.rejects(h.context.communityPosts('https://example.blogspot.com'), /offline/);
  fail = false; assert.equal((await h.context.communityPosts('https://example.blogspot.com')).length, 1);
});

test('Kairan and Csora try the next ranked post after a broken attachment', async () => {
  for (const source of ['kairan', 'csora']) {
    const tried = [], posts = [post('장송의 프리렌 1화', 'broken'), post('장송의 프리렌 1화', 'good')];
    const h = setup({ communityPosts: async () => posts, downloadCommunityMatch: async match => {
      tried.push(match.post.url); if (match.post.url.includes('broken')) throw Error('broken zip'); return { path: 'good.ass' };
    } });
    h.load('async function findCommunitySubtitle(', '// Downloads a ranked post');
    assert.equal((await h.context.findCommunitySubtitle(source, '장송의 프리렌', 1)).path, 'good.ass');
    assert.deepEqual(tried, posts.map(p => p.url));
  }
});

test('a refreshed post can retry changed links without downloading identical failures twice', async () => {
  const tried = [], old = post('장송의 프리렌', 'same'), fresh = { ...old, html: old.html.replace('same_0', 'fixed_0') };
  const h = setup({ communityPosts: async (_, { force }) => [force ? fresh : old], downloadCommunityMatch: async match => {
    tried.push(match.links[0]); if (!match.links[0].includes('fixed')) throw Error('old link'); return { path: 'fixed.ass' };
  } });
  h.load('async function findCommunitySubtitle(', '// Downloads a ranked post');
  assert.equal((await h.context.findCommunitySubtitle('csora', '장송의 프리렌', 1)).path, 'fixed.ass'); assert.equal(tried.length, 2);
  h.context.communityPosts = async () => [old]; tried.length = 0;
  await assert.rejects(h.context.findCommunitySubtitle('csora', '장송의 프리렌', 1), /old link/); assert.equal(tried.length, 1);
});

test('Anissia searches later pages before accepting a weak first-page title match', async () => {
  const pages = [];
  const h = setup({ anissiaFetch: async url => {
    const page = Number(url.match(/list\/(\d+)/)[1]); pages.push(page);
    return { content: [{ animeNo: page + 1, subject: page ? '장송의 프리렌' : '장송의 프리렌 스페셜' }], totalPages: 2, last: page === 1 };
  } });
  h.load('async function anissiaAnime(', '// Tistory:');
  assert.equal((await h.context.anissiaAnime('장송의 프리렌')).animeNo, 2); assert.deepEqual(pages, [0, 1]);
});

test('Anissia keeps seasons separate and distinguishes an empty search from a network failure', async () => {
  const h = setup({ anissiaFetch: async () => ({ content: [{ animeNo: 1, subject: '장송의 프리렌' }, { animeNo: 2, subject: '장송의 프리렌 2기' }], totalPages: 1 }) });
  h.load('async function anissiaAnime(', '// Tistory:');
  assert.equal((await h.context.anissiaAnime('장송의 프리렌 2기')).animeNo, 2);
  h.context.anissiaFetch = async () => ({ content: [], totalPages: 0 }); assert.equal(await h.context.anissiaAnime('장송의 프리렌'), null);
  h.context.anissiaFetch = async () => { throw Error('offline'); }; await assert.rejects(h.context.anissiaAnime('장송의 프리렌'), /offline/);
});

test('Anissia shares successful requests, expires its cache and retries failed responses', async () => {
  let calls = 0, fail = true;
  const h = setup({ fetch: async () => { calls++; await new Promise(resolve => setImmediate(resolve)); if (fail) throw Error('offline'); return { ok: true, json: async () => ({ code: 'ok', data: [] }) }; } });
  h.load('const anissiaResponseCache=', '// The Anissia entry');
  await assert.rejects(h.context.anissiaFetch('/test'), /offline/); fail = false;
  const results = await Promise.all([h.context.anissiaFetch('/test'), h.context.anissiaFetch('/test')]); assert.equal(calls, 2); assert.equal(results[0], results[1]);
  await h.context.anissiaFetch('/test'); assert.equal(calls, 2); h.advance(60001); await h.context.anissiaFetch('/test'); assert.equal(calls, 3);
  h.context.fetch = async () => ({ ok: true, json: async () => ({ code: 'fail', data: [] }) });
  await assert.rejects(h.context.anissiaFetch('/bad'), /Anissia fail/);
});

test('Anissia finds titles with a roman season or a hyphenated subtitle by their bare name', async () => {
  const entries = { '클레바테스': [{ animeNo: 1, subject: '클레바테스 ~마수왕과 아기와 시체 용사~' }, { animeNo: 2, subject: '클레바테스Ⅱ ~마수왕과 가짜 용사 전승~' }],
    '이세계 유유자적 농가': [{ animeNo: 6, subject: '이세계 유유자적 농가 2' }, { animeNo: 7, subject: '이세계 유유자적 농가' }],
    '시광대리인 영도편': [], '시광대리인': [{ animeNo: 3, subject: '시광대리인 -Link Click- 영도편' }, { animeNo: 4, subject: '시광대리인 Ⅱ -Link Click Ⅱ-' }, { animeNo: 5, subject: '시광대리인 -Link Click-' }] };
  const h = setup({ anissiaFetch: async url => ({ content: entries[decodeURIComponent(url.split('?q=')[1])] || [], totalPages: 1, last: true }) });
  h.load('async function anissiaAnime(', '// Tistory:');
  assert.equal((await h.context.anissiaAnime('클레바테스Ⅱ ~마수왕과 가짜 용사 전승~')).animeNo, 2);
  assert.equal((await h.context.anissiaAnime('클레바테스 ~마수왕과 아기와 시체 용사~')).animeNo, 1);
  assert.equal((await h.context.anissiaAnime('시광대리인 -Link Click- 영도편')).animeNo, 3);
  assert.equal((await h.context.anissiaAnime('시광대리인 Ⅱ -Link Click Ⅱ-')).animeNo, 4);
  // Anissia's own titles may mark a season with a bare digit.
  assert.equal((await h.context.anissiaAnime('이세계 유유자적 농가 2기')).animeNo, 6);
  assert.equal((await h.context.anissiaAnime('이세계 유유자적 농가')).animeNo, 7);
});

test('a post keeping several seasons serves each season its own archive', () => {
  const { context: c } = setup();
  assert.deepEqual([...c.communitySeasons('자판기 1기/2기/3기')], [1, 2, 3]); assert.deepEqual([...c.communitySeasons('작품 2기')], [2]);
  assert.equal(c.communitySeason('클레바테스Ⅱ ~마수왕과 가짜 용사 전승~'), 2);
  const name = '자동판매기로 다시 태어난 나는 미궁을 방랑한다';
  const p = post(`${name} 1기/2기/3기`, 'seasons', [`${name} 3기 1-2 SubsPlease`, `${name} 2기 1-12 SubsPlease`, `${name} 1-12 Ohys`]);
  const links = (title, episode) => c.rankCommunityPosts([p], title, episode).map(match => Array.from(match.links).join());
  assert.deepEqual(links(`${name} 3기`, 1), ['https://drive.google.com/file/d/seasons_0/view']);
  assert.deepEqual(links(`${name} 2기`, 5), ['https://drive.google.com/file/d/seasons_1/view']);
  assert.deepEqual(links(name, 5), ['https://drive.google.com/file/d/seasons_2/view']);
});

test('a Drive folder archive is searched for the title, newest years first, within a listing budget', async () => {
  const tree = { root: [['완결', 'done', 1], ['극장판', 'movies', 1]], movies: [['어떤 극장판', 'm1', 1]], done: [['2025', 'y25', 1], ['2026', 'y26', 1]],
    y25: [['4분기', 'q254', 1]], y26: [['1분기', 'q261', 1], ['2분기', 'q262', 1]], q262: [['다른 작품', 'other', 1]], q261: [['마술사 쿠논은 보인다', 'kunon', 1]],
    kunon: [['마술사 쿠논은 보인다 01.zip', 'f1', 0], ['마술사 쿠논은 보인다 02.zip', 'f2', 0]], flat: [['푸드코트에서 1화 자막.ass', 'a1', 0]] };
  const listed = [], h = setup();
  h.load('function driveFolderId(', '// Downloads a ranked post');
  h.context.driveFolderEntries = async id => { listed.push(id); return (tree[id] || []).map(([name, entry, folder]) => ({ id: entry, name, folder: Boolean(folder) })); };
  assert.equal(h.context.driveFolderId('https://drive.google.com/drive/folders/root?usp=sharing'), 'root');
  assert.deepEqual((await h.context.driveFolderFiles('root', '마술사 쿠논은 보인다')).map(entry => entry.id), ['f1', 'f2']);
  assert.ok(listed.indexOf('q261') >= 0 && (listed.indexOf('q254') < 0 || listed.indexOf('q262') < listed.indexOf('q254')));
  assert.deepEqual((await h.context.driveFolderFiles('flat', '푸드코트에서')).map(entry => entry.id), ['a1']);
});

test('previous-season lookup retries a failure, shares concurrent chains, and stops cycles', async () => {
  let fail = true, calls = 0;
  const h = setup({ fetch: async (_, options) => {
    calls++; await new Promise(resolve => setImmediate(resolve)); if (fail) throw Error('offline');
    const id = JSON.parse(options.body).variables.id;
    return { ok: true, json: async () => ({ data: { Media: { relations: { edges: [{ relationType: 'PREQUEL', node: { id: id === 3 ? 2 : 3, format: 'TV', episodes: '12' } }] } } } }) };
  } });
  h.load('const prequelEpisodeCache=', 'async function findCommunitySubtitle(');
  const anime = { anilistId: 3, title: 'Show Season 2' };
  await assert.rejects(h.context.previousSeasonEpisodes(anime), /offline/); fail = false;
  const results = await Promise.all([h.context.previousSeasonEpisodes(anime), h.context.previousSeasonEpisodes(anime)]);
  assert.deepEqual(Array.from(results[0]), [12]); assert.equal(results[0], results[1]); assert.equal(calls, 3);
  await h.context.previousSeasonEpisodes(anime); assert.equal(calls, 3);
});

test('Anissia tries multiple posts of the chosen maker and refreshes a missing Blogger episode', async () => {
  const tried = [], refreshes = [], posts = [post('장송의 프리렌 1화', 'broken'), post('장송의 프리렌 1화', 'good')];
  const h = setup({
    anissiaMakers: async () => ({ anime: { subject: '장송의 프리렌' }, captions: [{ name: '제작자', website: 'https://example.blogspot.com/' }] }),
    naverBlogRef: () => null, anissiaLinkedPost: async () => null,
    communityPosts: async (_, { force = false } = {}) => { refreshes.push(force); return force ? posts : []; },
    downloadCommunityMatch: async match => { tried.push(match.post.url); if (match.post.url.includes('broken')) throw Error('broken'); return { path: 'good.ass' }; }
  });
  h.load('async function findAnissiaSubtitle(', 'async function downloadHls(');
  const result = await h.context.findAnissiaSubtitle('장송의 프리렌', 1, { maker: '제작자' });
  assert.equal(result.path, 'good.ass'); assert.equal(result.maker, '제작자');
  assert.deepEqual(refreshes, [false, true]); assert.deepEqual(tried, posts.map(p => p.url));
});

test('an Anissia link marked as another season cannot become a subtitle or WinPNG fallback', async () => {
  let downloads = 0, images = 0;
  const linked = { ...post('장송의 프리렌 2기 장송의 프리렌 1기 1화', 'old'), pageTitle: '장송의 프리렌 1기 1화' };
  const h = setup({ anissiaMakers: async () => ({ anime: { subject: '장송의 프리렌 2기' }, captions: [{ name: '제작자', website: 'https://example.tistory.com/1' }] }),
    naverBlogRef: () => null, anissiaLinkedPost: async () => linked, anissiaNickname: () => '', tistoryPosts: async () => [],
    winPngSubtitle: async () => { images++; return { path: 'wrong.ass' }; }, downloadCommunityMatch: async () => { downloads++; return { path: 'wrong.ass' }; }
  });
  h.load('async function findAnissiaSubtitle(', 'async function downloadHls(');
  await assert.rejects(h.context.findAnissiaSubtitle('장송의 프리렌 2기', 1), /찾지 못했습니다/);
  assert.equal(downloads, 0); assert.equal(images, 0);
});

test('WinPNG uses original episode names rather than generated extraction indices', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-winpng-test-'));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = setup({ app: { getPath: () => dir }, winPngEntries: async () => [{ name: 'Show 03.jmk', ass: 'third' }, { name: 'Show 02.jmk', ass: 'second' }],
    subtitleResult: file => ({ path: file }) });
  h.load('const COMMUNITY_FILE=', '// Large Drive files');
  h.load('const WINPNG_EXTRA=', '// --- Jimaku');
  assert.equal(await h.context.winPngSubtitle('https://example.tistory.com/1', '작품', 1), null);
  const result = await h.context.winPngSubtitle('https://example.tistory.com/1', '작품', 2);
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'second');
});

test('links are downloaded a tier at a time and a Korean post address is sent percent-encoded', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-community-tier-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = names => { const z = new AdmZip(); for (const name of names) z.addFile(name, Buffer.from('[Script Info]\nTitle: ' + name)); return z.toBuffer(); };
  const archives = { 'https://example.tistory.com/a/3.zip': zip(['Show - 03 (1080p) [ABCDEF12].ass']), 'https://example.tistory.com/a/all.zip': zip(['Show - 01.ass', 'Show - 03.ass']) };
  const fetched = [], referers = [];
  const h = setup({ app: { getPath: () => dir }, driveId: () => null, subtitleResult: (file, options) => ({ path: file, ...options }), LINKKF_UA: 'test', AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { fetched.push(url); referers.push(options.headers.Referer); const data = archives[url];
      return { ok: true, headers: { get: () => null }, body: { getReader: () => { let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: data }) }; } } }; } });
  h.load('// Same as Android KairanSubtitleService/GoogleDriveDownloader', 'function driveId(');
  h.load('const COMMUNITY_FILE=', '// Posts of one blog ranked');
  h.load('function driveFolderId(', '// Some makers pack');
  const post = { title: '작품', url: 'https://example.tistory.com/entry/작품-3화', html: '<a href="https://example.tistory.com/a/all.zip">1~12화</a><a href="https://example.tistory.com/a/3.zip">3화</a>' };
  const match = { ...h.context.communityLinks(post, 3), post };
  const result = await h.context.downloadCommunityMatch(match, 'anissia', '작품', 3);
  assert.match(path.basename(result.path), /Show - 03 \(1080p\)/); assert.deepEqual(fetched, ['https://example.tistory.com/a/3.zip']);
  assert.equal(referers[0], 'https://example.tistory.com/entry/%EC%9E%91%ED%92%88-3%ED%99%94');
  const first = await h.context.downloadCommunityMatch({ ...h.context.communityLinks(post, 1), post }, 'anissia', '작품', 1);
  assert.match(fs.readFileSync(first.path, 'utf8'), /Show - 01/);
});

test('actual ZIP extraction picks the requested script and isolates sources and concurrent searches', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-community-test-'));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = new AdmZip(); zip.addFile('Show - 01 [1080p][A1B2C3D4].ass', Buffer.from('[Script Info]\nTitle: first'));
  zip.addFile('Show - 02.ass', Buffer.from('[Script Info]\nTitle: second')); zip.addFile('test.ttf', Buffer.from('fixture-font'));
  const h = setup({ app: { getPath: () => dir }, driveId: () => null, downloadDriveBuffer: async () => zip.toBuffer(), subtitleResult: (file, options) => ({ path: file, ...options }) });
  h.load('const COMMUNITY_FILE=', '// Posts of one blog ranked');
  h.context.downloadDriveBuffer = async () => zip.toBuffer();
  h.load('function driveFolderId(', '// Some makers pack');
  const match = { episode: 1, strict: true, bundle: true, links: ['https://example.com/files.zip'], post: post('작품 1~2화', 'bundle') };
  const results = await Promise.all(['kairan', 'csora', 'anissia', 'kairan'].map(source => h.context.downloadCommunityMatch(match, source, '작품', 1)));
  assert.equal(new Set(results.map(result => path.dirname(result.path))).size, 4);
  for (const result of results) { assert.match(fs.readFileSync(result.path, 'utf8'), /first/); assert.equal(fs.existsSync(path.join(path.dirname(result.path), 'test.ttf')), true); }
  await assert.rejects(h.context.downloadCommunityMatch({ ...match, episode: 3 }, 'csora', '작품', 3), /이 회차/);
});

// Anissia's catalog as the Korean name of a show without a TMDB key: matched by the Japanese title, its season and its
// start date choosing between the entries (a season named without its number, a movie of the same name).
test('a show is named by the Anissia entry of its Japanese title, season and start date', async () => {
  const items = [
    { no: 1, subject: '약사의 혼잣말', original: '薬屋のひとりごと', start: '2023-10-22' },
    { no: 2, subject: '약사의 혼잣말 2기', original: '薬屋のひとりごと 第2期', start: '2025-01-10' },
    { no: 3, subject: '약사의 혼잣말 3기', original: '薬屋のひとりごと', start: '2026-10-02' },
    { no: 4, subject: '극장판 약사의 혼잣말', original: '劇場版 薬屋のひとりごと', start: '2026-12-11' },
    { no: 5, subject: '반딧불이의 혼례', original: 'ホタルの嫁入り', start: '2026-10-03' },
    { no: 6, subject: '란마 1/2 (2024) 3기', original: 'らんま1/2 第3期', start: '2026-10-04' },
  ];
  let info = null;
  const { context: c, load } = setup({ anissiaCatalog: async () => items, nativeInfo: async () => info });
  load("const JAPANESE_SEASON=", 'async function koreanTitleCandidates(');
  const name = async (native, start, format = 'TV', title = '') => { info = { native, start: Date.parse(start), format }; return c.anissiaKoreanTitle({}, title); };
  assert.equal(await name('薬屋のひとりごと 第3期', '2026-10-02'), '약사의 혼잣말 3기');
  assert.equal(await name('薬屋のひとりごと 第2期', '2025-01-10'), '약사의 혼잣말 2기');
  assert.equal(await name('薬屋のひとりごと', '2023-10-22'), '약사의 혼잣말');
  assert.equal(await name('劇場版 薬屋のひとりごと', '2026-12-11', 'MOVIE'), '극장판 약사의 혼잣말');
  assert.equal(await name('ホタルの嫁入り', '2026-10-03'), '반딧불이의 혼례');
  assert.equal(await name('らんま1/2 第3期', '2026-10-04'), '란마 1/2 (2024) 3기');
  assert.equal(await name('進撃の巨人', '2013-04-07'), '', 'not in the catalog');
  assert.equal(await name('薬屋のひとりごと 第4期', '2028-01-01'), '', 'a season Anissia does not have yet');
});

// Anissia's search reads Japanese titles: one request (the title less its season) instead of the daily catalog, which
// is read only when the search fails or finds none.
test('Anissia is searched by the Japanese title before its catalog is read', async () => {
  const asked = [];let catalogReads = 0, info = null;
  const found = [{ animeNo: 2588, subject: '환생했는데 제7왕자라 내맘대로 마술을 연마합니다', originalSubject: '転生したら第七王子だったので、気ままに魔術を極めます', startDate: '2024-04-02' },
    { animeNo: 2986, subject: '환생했는데 제7왕자라 내맘대로 마술을 연마합니다 2기', originalSubject: '転生したら第七王子だったので、気ままに魔術を極めます', startDate: '2025-07-10' }];
  const { context: c, load } = setup({ nativeInfo: async () => info,
    anissiaFetch: async pathname => { asked.push(decodeURIComponent(pathname)); if (/失敗/.test(decodeURIComponent(pathname))) throw new Error('Anissia error'); return { content: /第七王子/.test(decodeURIComponent(pathname)) ? found : [] }; },
    anissiaCatalog: async () => { catalogReads++; return [{ no: 9, subject: '실패작', original: '失敗作', start: '2020-01-01' }]; } });
  load("const JAPANESE_SEASON=", 'async function koreanTitleCandidates(');
  const name = async (native, start) => { info = { native, start: Date.parse(start), format: 'TV' }; return c.anissiaKoreanTitle({}, ''); };
  assert.equal(await name('転生したら第七王子だったので、気ままに魔術を極めます 第2期', '2025-07-10'), '환생했는데 제7왕자라 내맘대로 마술을 연마합니다 2기');
  assert.equal(asked.at(-1), '/anime/list/0?q=転生したら第七王子だったので、気ままに魔術を極めます', 'asked without its season');
  assert.equal(catalogReads, 0);
  assert.equal(await name('失敗作', '2020-01-01'), '실패작', 'a failed search reads the catalog');
  assert.equal(catalogReads, 1);
});

// A maker whose Anissia page is a Google Drive folder (수퍼소닉EX): the folder is downloaded as the episode's post (its
// files picked by number), not passed over for being neither a blog nor Naver.
test('an Anissia maker linking a Google Drive folder is searched in that folder', async () => {
  const folder = 'https://drive.google.com/drive/folders/1p25lnE0v1SOXkwjMlJi5Iohp4ndKTxQI', asked = [];
  const h = setup({
    anissiaMakers: async () => ({ anime: { subject: '전생했더니 검이었습니다 2기' }, captions: [{ name: '수퍼소닉EX', website: folder }] }),
    naverBlogRef: () => null, anissiaLinkedPost: async () => null, communityPosts: async () => [],
    downloadCommunityMatch: async (match, source, title, episode) => { asked.push([match.links[0], match.episode, match.fileSeason, title, episode]); return { path: 'S02E04.vtt' }; }
  });
  h.load('async function findAnissiaSubtitle(', 'async function downloadHls(');
  const result = await h.context.findAnissiaSubtitle('전생했더니 검이었습니다 2기', 4, {});
  assert.equal(result.path, 'S02E04.vtt'); assert.equal(result.maker, '수퍼소닉EX');
  assert.deepEqual(asked, [[folder, 4, 2, '전생했더니 검이었습니다 2기', 4]]);
});
