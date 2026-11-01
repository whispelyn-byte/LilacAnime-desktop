// Native regression: node node_modules/electron/cli.js tests/seek-preview.electron.cjs
// The seek bar preview over a real HLS stream (made here with ffmpeg-static): the first hover of a new source showed a
// black box, its picture kept but never drawn.
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-seek-preview-')), hlsDir = path.join(dir, 'hls');
app.setPath('userData', path.join(dir, 'profile'));
function fail(error) { console.error(error.stack || error); process.exitCode = 1; app.exit(1); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing section: ${start}`);
  return source.slice(first, last);
}

app.whenReady().then(async () => {
  fs.mkdirSync(hlsDir);
  execFileSync(require('ffmpeg-static'), ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=40', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-g', '48', '-sc_threshold', '0', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(hlsDir, 's%03d.ts'), path.join(hlsDir, 'index.m3u8')]);
  const server = http.createServer((req, res) => {
    const file = path.join(hlsDir, path.basename(new URL(req.url, 'http://127.0.0.1').pathname));
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
    fs.createReadStream(file).pipe(res);
  }).listen(0, '127.0.0.1');
  const html = fs.readFileSync(path.join(repo, 'src/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(repo, 'src') + path.sep).href}">`);
  const file = path.join(dir, 'player.html'); fs.writeFileSync(file, html);
  const win = new BrowserWindow({ show: false, width: 1280, height: 720,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(file);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(repo, 'node_modules/hls.js/dist/hls.min.js'), 'utf8') + ';void 0');
  const player = fs.readFileSync(path.join(repo, 'src/player.js'), 'utf8');
  await win.webContents.executeJavaScript(`
    var $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
    var playerLocked = false, formatTime = time => String(Math.floor(time)), playbackDuration = () => $('#video').duration || 0;
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.body.classList.add('player-mode'); $('#playerView').classList.add('active');
    var hlsPlayer = new Hls(); hlsPlayer.loadSource('http://127.0.0.1:${server.address().port}/index.m3u8'); hlsPlayer.attachMedia($('#video'));
    ${section(player, 'const SEEK_PREVIEW_SLOT', '// --- Picture-in-picture')}
    var hover = ratio => { const rect = $('#playerSeek').getBoundingClientRect();
      $('#playerSeek').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width * ratio, clientY: rect.top + rect.height / 2 })); };
    var brightness = () => { const canvas = seekPreview.box.querySelector('canvas'), data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0; for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2]; return sum / (data.length / 4) / 3; };
    void 0;`);
  for (let i = 0; i < 40 && !await win.webContents.executeJavaScript(`$('#video').readyState >= 1`); i++) await wait(250);
  // The pointer rests on one place: its picture appears there without moving.
  for (const ratio of [0.25, 0.75]) {
    await win.webContents.executeJavaScript(`hover(${ratio})`);
    let shown = 0;
    for (let i = 0; i < 20 && shown < 20; i++) { await wait(250); shown = await win.webContents.executeJavaScript('brightness()'); }
    assert.ok(shown >= 20, `hover at ${ratio * 100}%: the preview stays black (${shown.toFixed(1)})`);
    console.log(`hover at ${ratio * 100}%: picture shown (brightness ${shown.toFixed(1)})`);
  }
  server.close(); win.destroy(); app.quit();
}).catch(fail);
