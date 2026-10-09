// Native pixel regression: node node_modules/electron/cli.js tests/subtitle-layout.electron.cjs
// Plain VTTCue property tests cannot detect Chromium's percentage-position layout behavior.
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-subtitle-layout-'));
app.setPath('userData', path.join(dir, 'profile'));
app.disableHardwareAcceleration();
function fail(error) { console.error(error.stack || error); process.exitCode = 1; app.exit(1); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing section: ${start}`);
  return source.slice(first, last);
}

app.whenReady().then(async () => {
  // Real player markup/CSS and production layout functions, without app startup or remote media.
  const html = fs.readFileSync(path.join(repo, 'src/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(repo, 'src') + path.sep).href}">`);
  const file = path.join(dir, 'player.html'); fs.writeFileSync(file, html);
  const win = new BrowserWindow({ show: false, width: 1920, height: 1080,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(file);
  const player = fs.readFileSync(path.join(repo, 'src/player.js'), 'utf8');
  const source = fs.readFileSync(path.join(repo, 'src/app.js'), 'utf8');
  await win.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
    let cueFamily = "'Malgun Gothic',sans-serif";
    ${section(player, 'const PLAYER_ASPECTS', 'new ResizeObserver(applyPlayerAspect)')}
    ${section(player, 'function vttBaseline()', '// Android subtitle source chips')}
    ${section(source, 'function vttVideoHeight()', 'async function applyCueStyle()')}
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.body.classList.add('player-mode'); $('#playerView').classList.add('active');
    $('#playerView').style.animation = 'none'; $('#playerEmpty').classList.add('hidden');
    $('#immersivePlayer').classList.remove('controls-visible');
    const frames = document.createElement('canvas'); frames.width = 1920; frames.height = 1080;
    const paint = () => { const ctx = frames.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1920, 1080); };
    paint(); setInterval(paint, 100); $('#video').muted = true; $('#video').srcObject = frames.captureStream(10);
    const track = $('#video').addTextTrack('subtitles', 'layout test', 'en'); track.mode = 'showing';
    $('#video').play(); void 0;
  `);
  await wait(700);
  const cases = [
    { name: '1080p', width: 1920, height: 1080, zoom: 1 },
    { name: '4K', width: 3840, height: 2160, zoom: 1 },
    { name: '4K at 150%', width: 3840, height: 2160, zoom: 1.5 },
    { name: '4K at 200%', width: 3840, height: 2160, zoom: 2 },
    { name: '4K top caption', width: 3840, height: 2160, zoom: 1, top: true },
    { name: 'windowed large wrapped subtitle', width: 800, height: 600, zoom: 1, size: 150,
      text: '긴 대사도 화면 양옆에서 잘리지 않고 중앙에 표시됩니다. '.repeat(3), wrapped: true },
    { name: 'stretched 4:3 video', width: 1920, height: 1080, zoom: 1, aspect: '4:3' }
  ];
  for (const item of cases) {
    win.setContentSize(item.width, item.height); win.webContents.setZoomFactor(item.zoom);
    await win.webContents.executeJavaScript(`(() => {
      localStorage.setItem('playerAspect', ${JSON.stringify(item.aspect || 'original')});
      localStorage.setItem('subtitleSize', ${JSON.stringify(String(item.size || 100))});
      applyPlayerAspect(); renderCueStyle();
      for (const cue of [...track.cues]) track.removeCue(cue); track.lilacFlat = false;
      track.addCue(new VTTCue(0, 3600, ${JSON.stringify((item.top ? String.raw`{\an8}` : '') + (item.text || 'CENTERED SUBTITLE'))}));
      applyVttLayout();
    })()`);
    await wait(700);
    const shot = await win.webContents.capturePage(), size = shot.getSize(), pixels = shot.toBitmap();
    const layout = await win.webContents.executeJavaScript(`({ width: innerWidth, height: innerHeight,
      video: $('#video').getBoundingClientRect().toJSON(), fontSize: vttVideoHeight() * 0.05 * Number(localStorage.getItem('subtitleSize')) / 100,
      cue: { text: track.cues[0].text, top: track.cues[0].lilacTop, line: track.cues[0].line } })`);
    let min = size.width, max = -1, minY = size.height, maxY = -1;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
      const at = (y * size.width + x) * 4;
      if (pixels[at] > 210 && pixels[at + 1] > 210 && pixels[at + 2] > 210) {
        min = Math.min(min, x); max = Math.max(max, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    assert.ok(max >= min, `${item.name}: subtitle pixels are visible`);
    const scale = size.width / layout.width, expected = (layout.video.x + layout.video.width / 2) * scale;
    const center = (min + max + 1) / 2;
    assert.ok(Math.abs(center - expected) <= Math.max(3, size.width * .003), `${item.name}: center ${center}, expected ${expected}`);
    if (item.wrapped) {
      assert.ok(min >= size.width * .04 && max < size.width * .96, 'wrapped dialogue stays inside the safe margins');
      assert.ok(maxY - minY > layout.fontSize * scale * 1.5, 'long dialogue wraps onto multiple lines');
    }
    if (item.top) assert.ok(maxY < size.height * .3, `top captions stay at the top: ${minY}-${maxY}, ${JSON.stringify(layout.cue)}`);
    console.log(`${item.name}: centered at ${center.toFixed(1)} / ${expected.toFixed(1)} px`);
  }
  win.destroy(); app.quit();
}).catch(fail);
