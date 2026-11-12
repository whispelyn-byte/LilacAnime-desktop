// Real renderer check and screenshot. --live uses data saved by provider-schedule.live.cjs.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const assert = require('node:assert/strict');
const { createWeeklySchedule } = require('../electron/weekly-schedule.cjs');
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-weekly-ui-'));
app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const live = process.argv.includes('--live'), errors = [], requests = [], searches = [], details = [];
const captureSource = process.argv.find(arg => arg.startsWith('--source='))?.split('=')[1] || 'reanime';
app.whenReady().then(async () => {
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  const fn = main.slice(main.indexOf('function reanimeItems('), main.indexOf('\nfunction absoluteUrl('));
  const convert = vm.runInNewContext(`${fn}; reanimeItems`, { REANIME_WEB: 'https://reanime.cz', REANIME_ID: 'https://reanime.to' });
  let shows = [];
  if (live) shows = convert(JSON.parse(fs.readFileSync(path.join(root, 'build/schedule-home-live.json'), 'utf8'))).filter(item => item.availableEpisodes > 0);
  const load = createWeeklySchedule(async day => {
    return Array.from({ length: 9 }, (_, index) => ({ animeNo: day * 100 + index, subject: `요일 ${day} 작품 ${index + 1}`, time: `${String(index).padStart(2, '0')}:30`, genres: '판타지,일상', status: index === 2 ? 'OFF' : 'ON' }));
  });
  let mode = 'normal';
  const liveSchedule = live ? JSON.parse(fs.readFileSync(path.join(root, 'build/provider-schedule-live.json'), 'utf8')) : [];
  async function result(provider, day) {
    if (mode === 'empty') return { items: [], timed: true, provider, native: true, note: provider };
    if (live && mode === 'normal') return liveSchedule.find(item => item.provider === provider && item.day === day);
    const items = await load(day);
    return { provider, native: mode !== 'fallback', timed: true, note: mode === 'fallback' ? 'Anissia · 한국 시간' : provider,
      items: items.map(item => mode === 'fallback' ? item : { ...item, anime: { provider, id: item.id, mal_id: `${provider}:${item.id}`, title: item.title, genres: [], studios: [], images: {} } }) };
  }
  const handlers = {
    'provider:schedule': async (_, provider, day) => { requests.push({ provider, day }); if (mode === 'error') throw new Error('offline'); await delay(day === 1 ? 160 : 15); return result(provider, day); },
    'provider:detail': (_, anime) => { details.push(anime); return { data: anime, episodes: [] }; },
    'linkkf:detail': (_, id) => { const anime = { provider: 'linkkf', id, mal_id: `linkkf:${id}`, title: id, genres: [], studios: [], images: {} }; details.push(anime); return { data: anime }; },
    'provider:catalog': (_, provider, query) => { if (query) searches.push({ provider, query }); return { data: shows, total: shows.length }; }, 'provider:season': () => ({ data: shows }), 'provider:airing': () => ({ data: [] }),
    'anime:season': () => ({ data: shows }), 'anime:top': () => ({ data: shows }), 'downloads:list': () => [],
    'cover:data': (_, url) => url, 'titles:resolve': () => [], 'titles:variants': () => [], 'catalog:search-korean': () => [], 'catalog:activate': () => ({ sources: [] }), 'catalog-index:state': () => ({ sources: [] }),
    'desktop:settings': () => ({ trayEnabled: false }), 'device-sync:status': () => ({ connected: false }),
    'gemini:get': () => ({ localModels: [], models: [], openaiModels: [], qwenModels: [] }),
    'update:state': () => ({ status: 'latest', current: '0.5.25' }), 'subtitle-cache:usage': () => ({ total: 0, removable: 0 })
  };
  for (const [, name] of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)) if (!ipcMain._weeklyRegistered?.has(name)) {
    ipcMain._weeklyRegistered ||= new Set(); ipcMain._weeklyRegistered.add(name);
    ipcMain.handle(name, handlers[name] || (() => null));
  }
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, backgroundColor: '#121212', webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs') } });
  win.webContents.on('console-message', event => { if (event.level === 'error' && !/Failed to load resource|Content Security Policy|GPU/.test(event.message)) errors.push(event.message); });
  await win.loadFile(path.join(root, 'src/index.html'));
  if (captureSource !== 'reanime') {
    await win.webContents.executeJavaScript(`localStorage.setItem('contentSource', ${JSON.stringify(captureSource)}); void 0;`);
    await win.loadFile(path.join(root, 'src/index.html'));
  }
  async function waitLoaded() { for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript(`document.querySelector('#scheduleRail').getAttribute('aria-busy') === 'false'`)) return; await delay(100); } throw new Error('Schedule timed out'); }
  await waitLoaded(); await delay(600);
  await win.webContents.executeJavaScript(`if (document.querySelector('#changelogDialog').open) document.querySelector('#changelogClose').click(); void 0;`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#scheduleTabs button').length`), 7);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#scheduleTabs .today').getAttribute('aria-selected')`), 'true');
  assert.ok(await win.webContents.executeJavaScript(`document.querySelectorAll('.schedule-show').length > 0`));
  const initialCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.schedule-show').length`);
  if (initialCount === 6) {
    await win.webContents.executeJavaScript(`document.querySelector('#scheduleMore').click();`);
    assert.ok(await win.webContents.executeJavaScript(`document.querySelectorAll('.schedule-show').length > 6`));
    await win.webContents.executeJavaScript(`document.querySelector('#scheduleMore').click();`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.schedule-show').length`), 6);
  }
  // Capture the real home page with the schedule in view, using the public live response when requested.
  await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop = document.querySelector('#scheduleSection').offsetTop - 110; void 0;`);
  await delay(400);
  const output = path.join(root, 'build', `weekly-schedule-${captureSource}.png`); fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelectorAll('#scheduleTabs button')[0].click(); document.querySelectorAll('#scheduleTabs button')[1].click(); void 0;`);
  await waitLoaded(); await delay(220);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#scheduleTabs button')[1].getAttribute('aria-selected')`), 'true');
  assert.match(await win.webContents.executeJavaScript(`document.querySelector('#scheduleStatus').textContent`), /^화요일/);
  mode = 'empty'; await win.webContents.executeJavaScript(`document.querySelector('#scheduleRetry').click();`); await waitLoaded();
  assert.match(await win.webContents.executeJavaScript(`document.querySelector('#scheduleStatus').textContent`), /등록된 방영 일정이 없습니다/);
  mode = 'error'; await win.webContents.executeJavaScript(`document.querySelector('#scheduleRetry').click();`); await waitLoaded();
  assert.match(await win.webContents.executeJavaScript(`document.querySelector('#scheduleStatus').textContent`), /불러오지 못했어요/);
  mode = 'normal'; await win.webContents.executeJavaScript(`document.querySelector('#scheduleRetry').click();`); await waitLoaded();
  assert.ok(await win.webContents.executeJavaScript(`document.querySelectorAll('.schedule-show').length > 0`));
  await win.webContents.executeJavaScript(`document.querySelectorAll('#scheduleTabs button')[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));`); await waitLoaded();
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#scheduleTabs button')[6].getAttribute('aria-selected')`), 'true');
  // Every provider must open details with its own ID, even when absent from home/catalog lists.
  mode = 'fixture';
  for (const provider of ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani', 'linkkf']) {
    await win.webContents.executeJavaScript(`state.source = ${JSON.stringify(provider)}; document.querySelector('#scheduleRetry').click();`); await waitLoaded();
    await win.webContents.executeJavaScript(`document.querySelector('.schedule-show').click();`); await delay(150);
    assert.equal(details.at(-1)?.provider, provider);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#detailDialog').open`), true);
    await win.webContents.executeJavaScript(`document.querySelector('#detailDialog').close();`);
  }
  mode = 'fallback';
  await win.webContents.executeJavaScript(`state.source = 'reanime'; document.querySelector('#scheduleRetry').click();`); await waitLoaded();
  // Clear known fixture titles to ensure this checks the fallback search, not an existing exact match.
  await win.webContents.executeJavaScript(`state.current = []; state.airing = []; state.season = []; state.library = [];`);
  const wanted = await win.webContents.executeJavaScript(`document.querySelector('.schedule-show-copy b').textContent`);
  await win.webContents.executeJavaScript(`document.querySelector('.schedule-show').click();`); await delay(250);
  assert.equal(searches.at(-1)?.query, wanted); assert.equal(searches.at(-1)?.provider, 'reanime');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#searchView').classList.contains('active')`), true);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Weekly schedule: tabs, stale responses, expand/collapse, empty/error/retry, keyboard, all 6 native detail routes and fallback search passed.');
  console.log('Screenshot:', output); win.destroy(); app.quit();
}).catch(error => { console.error(error.stack || error); app.exit(1); });
