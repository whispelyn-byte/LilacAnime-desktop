// Real renderer check of 이어서 보기 미리보기: a card rested on plays its episode muted from where it was left.
// Run: npx electron tests/continue-preview.electron.cjs [--shot=<png path>]
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const ffmpeg = require('ffmpeg-static');
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-preview-ui-'));
app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = process.argv.find(arg => arg.startsWith('--shot='))?.slice(7), errors = [], prepared = [], resolved = [], used = [];
app.whenReady().then(async () => {
  // A 40 s test video as an HLS stream (the online episode) and as a file (the downloaded one).
  const media = path.join(dir, 'media'); fs.mkdirSync(media);
  const source = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-c:a', 'aac'];
  for (const out of [['-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', path.join(media, 'video.m3u8')], ['-movflags', '+faststart', path.join(media, 'file.mp4')]]) {
    const made = spawnSync(ffmpeg, [...source, ...out], { windowsHide: true, encoding: 'utf8' }); assert.equal(made.status, 0, made.stderr);
  }
  const server = http.createServer((req, res) => { try { const data = fs.readFileSync(path.join(media, path.basename(new URL(req.url, 'http://localhost').pathname))); res.writeHead(200, { 'content-length': data.length, 'access-control-allow-origin': '*' }); res.end(data); } catch { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stream = { url: `http://127.0.0.1:${server.address().port}/video.m3u8`, hls: true, headers: {} };
  const anime = id => ({ provider: 'linkani', id, mal_id: `linkani:${id}`, title: `작품 ${id}`, genres: [], studios: [], images: { webp: { large_image_url: '' } }, url: `https://example.test/${id}` });
  const episode = id => ({ name: '3', number: 3, url: `https://example.test/${id}/3`, provider: 'linkani' });
  const history = [
    { key: 'linkani:https://example.test/on/3', name: '작품 on · 3화', subtitleTitle: '작품 on', anime: anime('on'), episode: episode('on'), progress: 50, updated: 3 },
    { key: 'linkani:https://example.test/off/3', name: '작품 off · 3화', subtitleTitle: '작품 off', anime: anime('off'), episode: episode('off'), progress: 25, updated: 2 },
    { key: 'linkani:phone', name: '작품 phone · 3화', subtitleTitle: '작품 phone', anime: anime('phone'), episode: { name: '3', number: 3, provider: 'linkani' }, progress: 10, updated: 1 }];
  const job = { id: 'job1', status: 'completed', progress: 100, title: '작품 off', anime: anime('off'), episode: episode('off'), episodeNumber: 3, filePath: path.join(media, 'file.mp4') };
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  const handlers = {
    'provider:prepare': async (_, item) => { prepared.push(item.url); await delay(150); return stream; },
    'provider:resolve': (_, item) => { resolved.push(item.url); return stream; }, 'stream:use': (_, item) => { used.push(item.url); return true; }, 'stream:alive': () => true, 'stream:warm': () => 0,
    'downloads:list': () => [job], 'downloads:play': () => ({ url: pathToFileURL(job.filePath).href, subtitleTracks: [], job }),
    'provider:detail': (_, item) => ({ data: item, episodes: [episode(item.id)] }), 'provider:catalog': () => ({ data: [], total: 0 }), 'catalog:updates': () => ({ data: [], done: true }),
    'provider:season': () => ({ data: [] }), 'provider:airing': () => ({ data: [] }), 'provider:schedule': () => ({ items: [], timed: true, provider: 'linkani', native: true, note: '' }),
    'anime:season': () => ({ data: [] }), 'anime:top': () => ({ data: [] }), 'provider:subtitle-tracks': () => ({ tracks: [], referer: '' }), 'provider:cross-site-tracks': () => ({ tracks: [] }), 'provider:korean-site-tracks': () => [],
    'cover:data': (_, url) => url, 'titles:resolve': () => [], 'titles:variants': () => [], 'catalog:search-korean': () => [], 'catalog:activate': () => ({ sources: [] }), 'catalog-index:state': () => ({ sources: [] }),
    'subtitle-store:list': () => [], 'subtitle:find': () => { throw new Error('자막 게시물을 찾지 못했습니다.'); }, 'anissia:makers': () => ({ subject: '', makers: [] }), 'oped:get': () => [], 'episode:thumbnails': () => ({}), 'mpv:status': () => ({ available: false }),
    'desktop:settings': () => ({ trayEnabled: false }), 'device-sync:status': () => ({ connected: false }),
    'gemini:get': () => ({ localModels: [], models: [], openaiModels: [], qwenModels: [] }),
    'update:state': () => ({ status: 'latest', current: '0.5.63' }), 'subtitle-cache:usage': () => ({ total: 0, removable: 0 })
  };
  for (const name of new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]))) ipcMain.handle(name, handlers[name] || (() => null));
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, backgroundColor: '#121212', webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs') } });
  win.webContents.on('console-message', event => { if (event.level === 'error' && !/Failed to load resource|Content Security Policy|GPU/.test(event.message)) errors.push(`${event.message} @${String(event.sourceId).split('/').pop()}:${event.lineNumber}`); });
  const run = code => win.webContents.executeJavaScript(code);
  await win.loadFile(path.join(root, 'src/index.html'));
  await run(`localStorage.setItem('contentSource','linkani');localStorage.setItem('history',${JSON.stringify(JSON.stringify(history))}); void 0;`);
  await win.loadFile(path.join(root, 'src/index.html')); await delay(1500);
  await run(`if (document.querySelector('#changelogDialog')?.open) document.querySelector('#changelogClose').click(); void 0;`);
  const card = at => `document.querySelectorAll('#continueRail .continue-card')[${at}]`;
  const point = (at, type) => run(`${card(at)}.dispatchEvent(new PointerEvent('${type}', { pointerType: 'mouse' })); void 0;`);
  const state = at => run(`(() => { const el = ${card(at)}, video = el.querySelector('video.continue-preview'); return { cards: document.querySelectorAll('#continueRail .continue-card').length, video: Boolean(video), playing: el.classList.contains('previewing'), muted: video?.muted, time: video?.currentTime || 0, duration: video?.duration || 0, opacity: video ? getComputedStyle(video).opacity : '' }; })()`);
  assert.equal((await state(0)).cards, 3);
  assert.equal(await run(`document.querySelector('#continuePreview').checked`), true);

  // Sweeping across a card asks for nothing.
  await point(0, 'pointerenter'); await delay(200); await point(0, 'pointerleave'); await delay(900);
  assert.deepEqual(prepared, []); assert.equal((await state(0)).video, false);

  // Resting on an online episode: its stream is found once and played muted from half way (progress 50%).
  await point(0, 'pointerenter'); await delay(5000);
  let online = await state(0);
  assert.deepEqual(prepared, ['https://example.test/on/3']);
  assert.equal(online.playing, true, JSON.stringify(online)); assert.equal(online.muted, true); assert.equal(online.opacity, '1');
  assert.ok(Math.abs(online.duration - 40) < 1.5, `duration ${online.duration}`); assert.ok(online.time >= 18.5 && online.time < 30, `resumed at ${online.time}`);
  if (shot) fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  await point(0, 'pointerleave'); await delay(200);
  online = await state(0); assert.equal(online.video, false); assert.equal(online.playing, false);

  // A downloaded episode plays from its file (no site asked), from a quarter in.
  await point(1, 'pointerenter'); await delay(3500);
  const local = await state(1);
  assert.equal(local.playing, true, JSON.stringify(local)); assert.ok(local.time >= 8.5 && local.time < 20, `resumed at ${local.time}`); assert.equal(prepared.length, 1);
  // Moving on to another card ends this one; an entry without an address (from the phone) shows nothing.
  await point(2, 'pointerenter'); await delay(1500);
  assert.equal((await state(1)).video, false); assert.equal((await state(2)).video, false); assert.equal(prepared.length, 1);
  await point(2, 'pointerleave');

  // The same card again within minutes: the stream found before is used, not looked for again.
  await point(0, 'pointerenter'); await delay(3000);
  assert.equal((await state(0)).playing, true); assert.equal(prepared.length, 1);

  // Switched off in 설정: the preview ends and no card starts one.
  await run(`(() => { const box = document.querySelector('#continuePreview'); box.checked = false; box.dispatchEvent(new Event('change')); })(); void 0;`); await delay(200);
  assert.equal((await state(0)).video, false);
  await point(0, 'pointerleave'); await point(0, 'pointerenter'); await delay(1200); assert.equal((await state(0)).video, false);
  await run(`(() => { const box = document.querySelector('#continuePreview'); box.checked = true; box.dispatchEvent(new Event('change')); })(); void 0;`);

  // Clicking the card plays the episode with the stream the preview found: it is not resolved a second time.
  await point(0, 'pointerleave'); await point(0, 'pointerenter'); await delay(2500);
  await run(`${card(0)}.click(); void 0;`); await delay(3000);
  assert.equal(await run(`document.querySelector('.view.active')?.id`), 'playerView');
  assert.equal(await run(`document.querySelectorAll('video.continue-preview').length`), 0);
  assert.deepEqual(resolved, []); assert.deepEqual(used, ['https://example.test/on/3']);
  assert.ok(await run(`document.querySelector('#video').currentTime`) > 15, 'the player resumes where the episode was left');
  // While the player is open nothing previews.
  await point(1, 'pointerenter'); await delay(1500); assert.equal(await run(`document.querySelectorAll('video.continue-preview').length`), 0);
  assert.deepEqual(errors, []);
  server.close(); console.log('CONTINUE_PREVIEW_OK');
}).then(() => app.exit(0), error => { console.error('CONTINUE_PREVIEW_FAILED', error.stack || error, '\nconsole errors:', errors); app.exit(1); });
