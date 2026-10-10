const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawnSync } = require('node:child_process');
const { DownloadManager } = require('../electron/download-manager.cjs');
const ffmpeg = require('ffmpeg-static');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-download-test-'));
  const app = { getPath: name => path.join(dir, name) };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, app };
}
async function finished(manager) {
  for (let i = 0; i < 200; i++) {
    await tick();
    if (manager.active.size) await Promise.all([...manager.active.values()].map(value => value.finished));
    if (!manager.active.size && !manager.jobs.some(job => ['queued', 'downloading', 'resolving'].includes(job.status))) return;
  }
  assert.fail('download did not finish');
}

test('closing during an ordinary HLS download resumes cached segments after restart and produces a playable MP4', async t => {
  const { dir, app } = fixture(t), media = path.join(dir, 'media'); fs.mkdirSync(media);
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', path.join(media, 'video.m3u8')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const requested = []; let token = 'first';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'), name = path.basename(url.pathname); requested.push(name);
    if (name === 'video.m3u8') { const text = fs.readFileSync(path.join(media, name), 'utf8').replace(/^(video\d+\.ts)$/gm, `$1?token=${token}`); res.end(text); }
    else { const data = fs.readFileSync(path.join(media, name)); res.writeHead(200, { 'content-length': data.length }); res.end(data); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const stream = () => ({ url: `http://127.0.0.1:${server.address().port}/video.m3u8?token=${token}`, hls: true, burnedKorean: true });
  let first, stopped = false;
  first = new DownloadManager({ app, resolveEpisode: async () => stream(), broadcast: (_, jobs) => {
    if (!stopped && jobs.some(job => job.status === 'downloading' && job.progress > 0 && job.progress < 95)) { stopped = true; first.shutdown(); }
  } });
  t.after(() => first.shutdown());
  const job = first.enqueue({ title: 'Resume Test', anime: { id: 'series' }, episode: { id: 'one', number: 1 }, episodeNumber: 1 });
  await Promise.all([...first.active.values()].map(value => value.finished));
  assert.equal(stopped, true); assert.equal(job.status, 'queued');
  const cached = fs.readdirSync(`${job.partialPath}.hls`).filter(name => /\.ts$/.test(name)); assert.ok(cached.length > 0);
  const keptIndex = Number(cached[0].match(/_(\d+)\.ts$/)[1]); requested.length = 0; token = 'second';
  const second = new DownloadManager({ app, resolveEpisode: async () => stream(), broadcast() {} }); t.after(() => second.shutdown());
  await finished(second);
  const saved = second.jobs[0]; assert.equal(saved.status, 'completed', saved.error); assert.equal(saved.progress, 100);
  assert.equal(requested.includes(`video${keptIndex}.ts`), false, 'completed segments must not be downloaded again');
  assert.equal(fs.existsSync(`${saved.filePath}.part.hls`), false);
  const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', saved.filePath, '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(decoded.status, 0, decoded.stderr);
});

test('progress ticks do not move a downloading episode to the top of the list', async t => {
  const { dir, app } = fixture(t), media = path.join(dir, 'media'); fs.mkdirSync(media);
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '5',
    '-f', 'hls', '-hls_time', '0.5', '-hls_list_size', '0', path.join(media, 'video.m3u8')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const server = http.createServer((req, res) => res.end(fs.readFileSync(path.join(media, path.basename(new URL(req.url, 'http://localhost').pathname)))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const seen = new Map();
  const manager = new DownloadManager({ app, resolveEpisode: async () => ({ url: `http://127.0.0.1:${server.address().port}/video.m3u8`, hls: true, burnedKorean: true }), broadcast: (_, jobs) => {
    for (const job of jobs) if (job.status === 'downloading') { const entry = seen.get(job.updated) || new Set(); entry.add(job.progress || 0); seen.set(job.updated, entry); }
  } }); t.after(() => manager.shutdown());
  manager.enqueue({ title: 'Order Test', anime: { id: 'series' }, episode: { id: 'one', number: 1 }, episodeNumber: 1 });
  await finished(manager);
  assert.equal(manager.jobs[0].status, 'completed', manager.jobs[0].error);
  assert.equal(seen.size, 1, 'the order timestamp changes only when the episode changes state');
  assert.ok([...seen.values()][0].size > 2, 'progress was reported while downloading');
});

test('pause followed by immediate resume while resolving cannot let the abandoned run write files', async t => {
  const { app } = fixture(t); let resolveFirst, lookups = 0, remuxes = 0;
  const manager = new DownloadManager({ app, broadcast() {}, resolveEpisode: async () => {
    lookups++; if (lookups === 1) return new Promise(resolve => { resolveFirst = resolve; }); return { url: 'https://example/video.mp4', burnedKorean: true };
  } }); t.after(() => manager.shutdown());
  manager.mirrorFile = async () => ({ inputs: [] });
  manager.runFfmpeg = async job => { remuxes++; fs.writeFileSync(job.partialPath, 'test'); };
  const job = manager.enqueue({ title: 'Race Test', episode: { id: 'one' } }); await tick();
  manager.cancel(job.id); manager.resume(job.id); resolveFirst({ url: 'https://example/abandoned.mp4' });
  await finished(manager);
  assert.equal(lookups, 2); assert.equal(remuxes, 1); assert.equal(job.status, 'completed');
  assert.equal(manager.resume(job.id), false, 'completed jobs cannot be downloaded over themselves');
});

test('removal waits for an active transfer to stop and removes temporary caches without a later resurrection', async t => {
  const { app } = fixture(t); let transferStarted;
  const started = new Promise(resolve => { transferStarted = resolve; });
  const manager = new DownloadManager({ app, broadcast() {}, resolveEpisode: async () => ({ url: 'https://example/video.mp4' }) }); t.after(() => manager.shutdown());
  manager.mirrorFile = async job => {
    fs.mkdirSync(`${job.partialPath}.hls`); fs.writeFileSync(path.join(`${job.partialPath}.hls`, 'segment.ts'), 'kept');
    const signal = manager.active.get(job.id).controller.signal; transferStarted();
    await new Promise(resolve => signal.addEventListener('abort', () => { fs.writeFileSync(job.partialPath, 'last chunk'); resolve(); }, { once: true }));
    return { inputs: [] };
  };
  manager.runFfmpeg = async () => assert.fail('deleted transfer must not remux');
  const job = manager.enqueue({ title: 'Delete Test', episode: { id: 'one' } }); await started;
  await manager.remove(job.id); await tick();
  assert.equal(manager.jobs.length, 0); assert.equal(manager.active.size, 0);
  assert.equal(fs.existsSync(job.partialPath), false); assert.equal(fs.existsSync(`${job.partialPath}.hls`), false);
});

test('HLS byte ranges are cached separately and rewritten for local playback', async t => {
  const { dir } = fixture(t), original = globalThis.fetch, requests = [];
  t.after(() => { globalThis.fetch = original; });
  const media = Buffer.from('INIT11112222');
  globalThis.fetch = async (value, options) => {
    if (String(value).endsWith('list.m3u8')) return new Response('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="video.mp4",BYTERANGE="4@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:4@4\nvideo.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:4\nvideo.mp4\n#EXT-X-ENDLIST\n');
    requests.push(options.headers.Range); const [start, end] = options.headers.Range.match(/\d+/g).map(Number);
    return new Response(media.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${media.length}` } });
  };
  const job = { id: 'one', filePath: path.join(dir, 'out.mp4'), partialPath: path.join(dir, 'out.mp4.part') };
  const manager = Object.assign(Object.create(DownloadManager.prototype), { active: new Map([[job.id, { controller: new AbortController() }]]), save() {} });
  const result = await manager.mirrorHls(job, { url: 'https://example/list.m3u8' });
  assert.deepEqual(requests.sort(), ['bytes=0-3', 'bytes=4-7', 'bytes=8-11']);
  const text = fs.readFileSync(result.inputs[0], 'utf8'); assert.equal(text.includes('BYTERANGE'), false);
  assert.equal(fs.readFileSync(path.join(result.dir, 'video_00001.m4s'), 'utf8'), '1111');
  assert.equal(fs.readFileSync(path.join(result.dir, 'video_00002.m4s'), 'utf8'), '2222');
});

test('a new Flix proxy session reuses matching cached segments, while a changed segment layout starts fresh', async t => {
  const { dir } = fixture(t), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let session = 'one', content = 'video', segmentCalls = 0;
  const proxy = target => `http://127.0.0.1:43210/__flix/${session}/${Buffer.from(target).toString('base64url')}`;
  globalThis.fetch = async value => {
    const target = Buffer.from(new URL(value).pathname.split('/').pop(), 'base64url').toString();
    if (target.includes('list.m3u8')) return new Response(`#EXTM3U\n#EXTINF:1,\n${proxy(`https://cdn.example/${content}.ts?token=${session}`)}\n#EXT-X-ENDLIST\n`);
    segmentCalls++; return new Response('segment');
  };
  const job = { id: 'one', filePath: path.join(dir, 'out.mp4'), partialPath: path.join(dir, 'out.mp4.part') };
  const manager = Object.assign(Object.create(DownloadManager.prototype), { active: new Map([[job.id, { controller: new AbortController() }]]), save() {} });
  await manager.mirrorHls(job, { url: proxy('https://cdn.example/list.m3u8') }); assert.equal(segmentCalls, 1);
  session = 'two'; await manager.mirrorHls(job, { url: proxy('https://cdn.example/list.m3u8') }); assert.equal(segmentCalls, 1);
  content = 'replacement'; await manager.mirrorHls(job, { url: proxy('https://cdn.example/list.m3u8') }); assert.equal(segmentCalls, 2);
});

test('ordinary HTTP video downloads are staged and remuxed into a playable offline MP4', async t => {
  const { dir, app } = fixture(t), input = path.join(dir, 'input.mp4');
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10', '-t', '1', '-c:v', 'libx264', input], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const server = http.createServer((req, res) => { const data = fs.readFileSync(input); res.writeHead(200, { 'content-length': data.length, etag: '"one"' }); res.end(data); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const manager = new DownloadManager({ app, broadcast() {}, resolveEpisode: async () => ({ url: `http://127.0.0.1:${server.address().port}/video.mp4`, burnedKorean: true }) }); t.after(() => manager.shutdown());
  const job = manager.enqueue({ title: 'HTTP Test', episode: { id: 'one' } }); await finished(manager);
  assert.equal(job.status, 'completed', job.error); assert.equal(fs.existsSync(`${job.filePath}.part.source`), false);
  const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', job.filePath, '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' }); assert.equal(decoded.status, 0, decoded.stderr);
});
