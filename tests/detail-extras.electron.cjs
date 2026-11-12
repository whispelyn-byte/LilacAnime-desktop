// Real renderer check of the detail page's AniList / MAL extras and of 내 목록's update order (GitHub issue #28).
// Run: npx electron tests/detail-extras.electron.cjs [--shot=<png path>]
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-extras-ui-'));
app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = process.argv.find(arg => arg.startsWith('--shot='))?.slice(7), errors = [], searches = [], opened = [], refreshed = [];
const show = (provider, id, extra = {}) => ({ provider, id, mal_id: `${provider}:${id}`, title: `작품 ${id}`, title_japanese: `作品${id}`, genres: [{ name: '판타지' }], studios: [], images: { webp: { large_image_url: '' } }, type: 'TV', year: 2026, url: `https://example.test/${id}`, ...extra });
const shows = [show('ohli24', 'a', { availableEpisodes: 3 }), show('ohli24', 'b', { availableEpisodes: 3 }), show('ohli24', 'c', { availableEpisodes: 1 })];
const entry = (id, title, extra = {}) => ({ anilistId: id, malId: null, title, romaji: title, title_japanese: '', image: '', year: 2025, type: 'TV', score: 8.2, ...extra });
const extras = { anilistId: 10, malId: 20, url: 'https://anilist.co/anime/10', nextAiring: { episode: 8, at: Date.now() + 50 * 3600000 }, trailer: 'https://www.youtube.com/watch?v=abcDEF12345',
  characters: [{ name: 'Aoi Sora', native: '空あおい', image: '', role: 'MAIN', voice: 'Voice One', voiceNative: '声一' }, { name: 'Ren <b>', native: '', image: '', role: 'SUPPORTING', voice: '', voiceNative: '' }],
  relations: [entry(11, 'Show Season 2', { relationType: 'SEQUEL' })], recommendations: [entry(30, 'Another Show'), entry(31, 'Third Show')],
  tags: ['School', 'Magic'], links: [{ site: 'Official Site', url: 'https://show.example/', language: 'Japanese' }], themes: { openings: ['"Song" by Band (eps 1-12)'], endings: ['"Bye" by Duo'] } };
app.whenReady().then(async () => {
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  const handlers = {
    'provider:detail': (_, anime) => ({ data: anime, episodes: [{ name: '1', number: 1, url: `${anime.url}/1`, provider: anime.provider }] }),
    'anime:extras': (_, anime) => anime.id === 'a' ? extras : null,
    'library:refresh': (_, list) => { refreshed.push(list.map(item => item.mal_id)); return [{ mal_id: 'ohli24:a', availableEpisodes: 7, totalEpisodes: 12, updatedAt: '2026-11-08T00:00:00.000Z' }, { mal_id: 'ohli24:b', availableEpisodes: 5, updatedAt: '2026-11-10T00:00:00.000Z' }, { mal_id: 'ohli24:c', availableEpisodes: 2, updatedAt: '2026-11-09T00:00:00.000Z' }]; },
    'provider:catalog': (_, provider, query) => { if (query) searches.push({ provider, query }); return { data: shows, total: shows.length }; }, 'catalog:updates': () => ({ data: [], done: true }),
    'provider:season': () => ({ data: shows }), 'provider:airing': () => ({ data: [] }), 'provider:schedule': () => ({ items: [], timed: true, provider: 'ohli24', native: true, note: '' }),
    'anime:season': () => ({ data: shows }), 'anime:top': () => ({ data: shows }), 'downloads:list': () => [], 'open:external': (_, url) => { opened.push(url); },
    'cover:data': (_, url) => url, 'titles:resolve': () => [], 'titles:variants': () => [], 'catalog:search-korean': () => [], 'catalog:activate': () => ({ sources: [] }), 'catalog-index:state': () => ({ sources: [] }),
    'anime:artwork': () => ({ banner: '', logos: [] }), 'anime:overview': () => '', 'episode:thumbnails': () => ({}),
    'desktop:settings': () => ({ trayEnabled: false }), 'device-sync:status': () => ({ connected: false }),
    'gemini:get': () => ({ localModels: [], models: [], openaiModels: [], qwenModels: [] }),
    'update:state': () => ({ status: 'latest', current: '0.5.63' }), 'subtitle-cache:usage': () => ({ total: 0, removable: 0 })
  };
  for (const name of new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]))) ipcMain.handle(name, handlers[name] || (() => null));
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, backgroundColor: '#121212', webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs') } });
  win.webContents.on('console-message', event => { if (event.level === 'error' && !/Failed to load resource|Content Security Policy|GPU/.test(event.message)) errors.push(event.message); });
  const run = code => win.webContents.executeJavaScript(code);
  await win.loadFile(path.join(root, 'src/index.html'));
  // Saved in the order a, b, c on the day each had fewer episodes; "updated" order picked.
  const library = JSON.stringify(shows.map((item, index) => ({ ...item, savedAt: 1000 - index })));
  await run(`localStorage.setItem('contentSource','ohli24');localStorage.setItem('libraryOrder','updated');localStorage.setItem('library',${JSON.stringify(library)}); void 0;`);
  await win.loadFile(path.join(root, 'src/index.html')); await delay(1500);
  await run(`if (document.querySelector('#changelogDialog')?.open) document.querySelector('#changelogClose').click(); void 0;`);

  // --- 내 목록: counts of now and the order of the latest episodes' days ---
  await run(`switchView('library'); void 0;`); await delay(800);
  const cardFacts = `[...document.querySelectorAll('#libraryGrid .anime-card')].map(card => [card.dataset.id, card.querySelector('p').textContent])`;
  const cards = await run(cardFacts);
  assert.deepEqual(cards.map(card => card[0]), ['ohli24:b', 'ohli24:c', 'ohli24:a']);
  assert.match(cards[2][1], /업로드 7화 \/ 총 12화/); assert.match(cards[0][1], /업로드 5화/);
  assert.equal(refreshed.length, 1);
  await run(`document.querySelector('#libraryOrder [data-order="saved"]').click(); void 0;`); await delay(300);
  const savedOrder = await run(cardFacts);
  assert.deepEqual(savedOrder.map(card => card[0]), ['ohli24:a', 'ohli24:b', 'ohli24:c']); assert.match(savedOrder[0][1], /업로드 7화/);
  assert.equal(refreshed.length, 1, 'a work looked at just now is not read again');

  // --- detail page extras ---
  await run(`openDetail('ohli24:a'); void 0;`); await delay(900);
  assert.match(await run(`document.querySelector('#detailContent .detail-airing').textContent`), /^다음 화 · 8화 일본 방영 .+\(2일 후\)$/);
  assert.equal(await run(`document.querySelector('#detailContent .detail-airing').classList.contains('hidden')`), false);
  await run(`document.querySelector('#detailContent .detail-trailer').click(); void 0;`); await delay(100);
  assert.deepEqual(opened, ['https://www.youtube.com/watch?v=abcDEF12345']);
  const tabs = await run(`[...document.querySelectorAll('#detailContent [data-detail-tab]')].map(tab => [tab.dataset.detailTab, tab.classList.contains('hidden')])`);
  assert.deepEqual(tabs, [['episodes', false], ['related', false], ['info', false]]);
  assert.equal(await run(`document.querySelector('#detailContent .detail-tabs').classList.contains('hidden')`), false);
  await run(`document.querySelector('[data-detail-tab="info"]').click(); void 0;`); await delay(100);
  assert.equal(await run(`document.querySelector('#episodeBlock').classList.contains('hidden') && !document.querySelector('#infoBlock').classList.contains('hidden')`), true);
  const info = await run(`document.querySelector('#infoBlock').innerText`);
  for (const text of ['캐릭터 · 성우', '空あおい', 'CV 声一', 'Ren <b>', '오프닝 곡', '"Song" by Band', '엔딩 곡', '태그', 'School', 'Official Site', 'MyAnimeList']) assert.ok(info.includes(text), text);
  assert.equal(await run(`document.querySelectorAll('#infoBlock .cast-item b b').length`), 0, 'names are text, not markup');
  if (shot) fs.writeFileSync(shot.replace(/\.png$/, '-info.png'), (await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('[data-detail-tab="related"]').click(); void 0;`); await delay(100);
  const groups = await run(`[...document.querySelectorAll('#extraRelatedBlock .related-group')].map(group => [group.querySelector('h3').firstChild.textContent.trim(), group.querySelectorAll('.extra-card').length])`);
  assert.deepEqual(groups, [['후속편', 1], ['비슷한 작품', 2]]);
  if (shot) fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  // A recommended work's card searches the current source for it.
  await run(`document.querySelector('#extraRelatedBlock .related-group:last-child .extra-card').click(); void 0;`); await delay(500);
  assert.equal(await run(`document.querySelector('#detailDialog').open`), false);
  assert.deepEqual(searches.at(-1), { provider: 'ohli24', query: 'Another Show' });
  // A work without an entry keeps the page as it was.
  await run(`openDetail('ohli24:b'); void 0;`); await delay(700);
  assert.equal(await run(`document.querySelector('#detailContent .detail-tabs').classList.contains('hidden') && document.querySelector('#detailContent .detail-airing').classList.contains('hidden') && !document.querySelector('#detailContent .detail-trailer')`), true);
  assert.deepEqual(errors, []);
  console.log('DETAIL_EXTRAS_OK');
}).then(() => app.exit(0), error => { console.error('DETAIL_EXTRAS_FAILED', error.stack || error, '\nconsole errors:', errors); app.exit(1); });
