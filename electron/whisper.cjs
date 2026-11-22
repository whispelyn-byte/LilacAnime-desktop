// Whisper AI 자막 (Android WhisperTranscriptionService): the episode's Japanese speech made into a subtitle by whisper.cpp,
// for the existing translation to turn into Korean. The audio is read by FFmpeg and handed over as it comes, so the
// first lines are there within seconds; the part of the episode from where it is playing is done first, then the
// beginning.
// - Windows: whisper.cpp's own builds, as the local AI takes llama.cpp's: the CUDA build for an NVIDIA card (with the
//   CPU build beside it, used when the card's fails), else the CPU build; whisper-server keeps the model loaded and is
//   sent the audio in pieces. On a GTX 1050 Ti, 5 minutes of an episode took 43 s with large-v3-turbo (190 s on the CPU)
//   and 26 s with small (66 s). whisper.cpp has no build for AMD or Intel cards.
// - macOS (no whisper.cpp program is published for it): its own Python with pywhispercpp, installed once under
//   userData/tools/whisper by uv, as ffsubsync is.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const WORKER = require('./whisper-worker.py.cjs');

const UV_VERSION = '0.13.1', PYTHON_VERSION = '3.12';
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32', NATIVE = WIN && process.arch === 'x64';
const RATE = 16000;
// whisper.cpp's Windows builds; the CUDA ones carry the CUDA runtime (685 MB), so no CUDA install is needed.
const BUILDS = {
  cuda12: { label: 'NVIDIA GPU (CUDA 12)', gpu: true, asset: /^whisper-bin-win-cuda-12\.[\d.]+-x64\.zip$/ },
  cuda11: { label: 'NVIDIA GPU (CUDA 11)', gpu: true, asset: /^whisper-bin-win-cuda-11\.[\d.]+-x64\.zip$/ },
  cpu: { label: 'CPU', gpu: false, asset: /^whisper-bin-x64\.zip$/ },
};
// pywhispercpp has macOS Intel wheels only up to 1.2.0 (the API used here is the same).
const PACKAGE = MAC && process.arch !== 'arm64' ? 'pywhispercpp==1.2.0' : 'pywhispercpp==1.5.1';
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
// Times measured on 5 minutes of an episode (8 threads of a 12-thread desktop CPU): tiny / base 23 s, small 66 s,
// large-v3-turbo 190 s. small is the first that gets most lines right; turbo gets names and places too.
const MODELS = [
  { id: 'tiny', label: 'Tiny', file: 'ggml-tiny.bin', size: 77691713, note: '가장 빠르지만 자주 틀려요' },
  { id: 'base', label: 'Base', file: 'ggml-base.bin', size: 147951465, note: '빠름 · 대사를 반복해 만들어 내는 일이 있어요' },
  { id: 'small', label: 'Small', file: 'ggml-small.bin', size: 487601967, note: '정확도와 속도의 균형 (CPU로도 재생보다 약 4배 빠름)' },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', file: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195, note: '가장 정확 · NVIDIA 그래픽카드면 권장 (CPU로는 재생보다 약 1.5배 빠름)' },
];

// Lines Whisper is known to make up over music or silence, sound captions, and loops: left out (the Python worker
// does the same).
const MADE_UP = ['ご視聴ありがとうございました', 'ご視聴ありがとうございます', 'チャンネル登録', '字幕', 'by H.', 'エンディング', 'おやすみなさい', 'お疲れ様でした', 'ありがとうございました。', 'Thank you for watching'];
const NOT_SPEECH = /^[\s♪♫~〜ー…・.。、!！?？]*$|^\s*[(（[【][^)）\]】]*[)）\]】][\s♪~〜]*$/;
function keepLine(text, recent) {
  if (!text || NOT_SPEECH.test(text) || MADE_UP.some(made => text.includes(made)) || recent.includes(text)) return false;
  if (new Set(text.replace(/ /g, '')).size <= 2 && text.length > 4) return false;
  recent.push(text); recent.splice(0, recent.length - 4); return true;
}
// The quietest 0.3 s between low and high seconds of 16 kHz samples: where a piece is cut.
function quietCut(samples, low, high) {
  const win = Math.round(0.3 * RATE), step = Math.round(0.1 * RATE); let best = Infinity, at = high * RATE;
  for (let i = low * RATE; i < high * RATE - win; i += step) { let energy = 0; for (let k = i; k < i + win; k++) energy += samples[k] * samples[k]; if (energy < best) { best = energy; at = i + (win >> 1); } }
  return Math.floor(at);
}
function wavOf(samples) {
  const head = Buffer.alloc(44), bytes = samples.length * 2;
  head.write('RIFF', 0); head.writeUInt32LE(36 + bytes, 4); head.write('WAVE', 8); head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(bytes, 40);
  return Buffer.concat([head, Buffer.from(samples.buffer, samples.byteOffset, bytes)]);
}

function uvAsset() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return MAC ? `uv-${arch}-apple-darwin.tar.gz` : WIN ? `uv-${arch}-pc-windows-msvc.zip` : `uv-${arch}-unknown-linux-gnu.tar.gz`;
}
function vttStamp(value) {
  const ms = Math.max(0, Math.round(value * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
// A line as cue text (the player and the translator read it back the same way).
const cueText = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const vttOf = lines => `WEBVTT\n\n${lines.slice().sort((a, b) => a.start - b.start).map(line => `${vttStamp(line.start)} --> ${vttStamp(Math.max(line.end, line.start + 0.5))}\n${cueText(line.text)}\n`).join('\n')}`;

// The parts of the episode transcribed so far, as merged [start, end] spans (end Infinity: to the end).
function spans() {
  const list = [];
  const add = (start, end) => { if (!(end > start)) return; list.push([start, end]); list.sort((a, b) => a[0] - b[0]); for (let i = 1; i < list.length;) if (list[i][0] <= list[i - 1][1] + 0.05) { list[i - 1][1] = Math.max(list[i - 1][1], list[i][1]); list.splice(i, 1); } else i++; };
  const has = time => list.some(([start, end]) => time >= start - 0.5 && time < end);
  // The first part not transcribed from `from` on: [start, end] (end 0: to the end of the episode), or null.
  const gapFrom = (from, duration) => { let time = from; for (const [start, end] of list) if (time >= start - 0.05 && time < end) time = end; if (!Number.isFinite(time) || (duration > 0 && time >= duration - 1)) return null; const next = list.find(([start]) => start > time); return [time, next ? next[0] : 0]; };
  const length = duration => list.reduce((sum, [start, end]) => sum + (Math.min(end, duration || end) - start), 0);
  return { add, has, gapFrom, length };
}

// proxy(url, headers): a stream address FFmpeg can read (segments some hosts disguise as pictures are cut at their
// video data by the app's local proxy).
function createWhisper({ userData, ffmpegPath, subtitleRoot, proxy = url => Promise.resolve(url) }) {
  const root = path.join(userData, 'tools', 'whisper'), venv = path.join(root, 'venv'), marker = path.join(root, 'installed.json');
  const python = path.join(venv, WIN ? 'Scripts/python.exe' : 'bin/python'), worker = path.join(root, 'worker.py');
  const modelDir = path.join(userData, 'whisper', 'models'), settingsFile = path.join(userData, 'whisper', 'settings.json');
  const outDir = path.join(subtitleRoot, 'whisper');
  const uvEnv = () => ({ ...process.env, UV_CACHE_DIR: path.join(root, 'cache'), UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_NO_PROGRESS: '1' });
  let installing = null, current = null; const downloads = new Map();

  const settings = () => { try { return { model: 'small', ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { return { model: 'small' }; } };
  const modelFile = id => path.join(modelDir, MODELS.find(model => model.id === id)?.file || 'none');
  const modelInstalled = id => { try { return fs.statSync(modelFile(id)).size >= MODELS.find(model => model.id === id).size * 0.98; } catch { return false; } };
  // --- Windows: whisper.cpp's builds (see BUILDS) ---
  const nativeFile = path.join(root, 'native.json');
  const nativeInfo = () => { try { return JSON.parse(fs.readFileSync(nativeFile, 'utf8')) || {}; } catch { return {}; } };
  const saveNative = change => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(nativeFile, JSON.stringify({ ...nativeInfo(), ...change })); };
  const serverExe = kind => { try { return findFile(path.join(root, kind), 'whisper-server.exe'); } catch { return null; } };
  // The NVIDIA card nvidia-smi reports, and the CUDA build its driver can run (CUDA 12.4 wants driver 551.61).
  let gpuFound = null, gpu = null;
  function nvidia() {
    gpuFound ||= new Promise(resolve => {
      if (!NATIVE) { resolve(null); return; }
      let out = ''; const child = spawn('nvidia-smi', ['--query-gpu=name,compute_cap,driver_version', '--format=csv,noheader'], { windowsHide: true });
      child.stdout.on('data', chunk => { out += chunk; }); child.once('error', () => resolve(null));
      child.once('close', code => {
        const [name, cap, driver] = (out.split('\n')[0] || '').split(',').map(value => value.trim());
        const c = parseFloat(cap), d = parseFloat(driver), kind = c >= 5 && d >= 551.61 ? 'cuda12' : c >= 3.5 && d >= 452.39 ? 'cuda11' : null;
        resolve(code === 0 && kind ? { name, driver: d, kind } : null);
      });
    }).then(found => { gpu = found; return found; });
    return gpuFound;
  }
  nvidia();
  // The builds to use, best first: the card's (unless it failed here with this driver), then the CPU's.
  const nativeKinds = () => [gpu && nativeInfo().broken?.[gpu.kind] !== gpu.driver ? gpu.kind : null, 'cpu'].filter(Boolean);
  const runtimeInstalled = () => NATIVE ? Boolean(serverExe('cpu')) : (() => { try { return JSON.parse(fs.readFileSync(marker, 'utf8')).package === PACKAGE && fs.existsSync(python); } catch { return false; } })();
  function engine() {
    if (!NATIVE) return 'CPU (whisper.cpp · Python)';
    const kind = nativeKinds().find(serverExe); return kind ? `${BUILDS[kind].label}${kind === 'cpu' && gpu ? ' · 그래픽카드 빌드를 받으면 더 빨라요' : ''}` : '';
  }
  function status() {
    const picked = settings().model;
    return {
      runtime: runtimeInstalled(), installing: Boolean(installing), model: MODELS.some(model => model.id === picked) ? picked : 'small', running: current?.key || null,
      native: NATIVE, gpu: gpu ? { name: gpu.name, label: BUILDS[gpu.kind].label, installed: Boolean(serverExe(gpu.kind)) } : null, engine: engine(),
      installSize: NATIVE ? (gpu && !serverExe(gpu.kind) ? 700e6 : serverExe('cpu') ? 0 : 10e6) : 100e6,
      models: MODELS.map(model => {
        let partial = 0; try { partial = fs.statSync(`${modelFile(model.id)}.part`).size; } catch { /* none */ }
        return { ...model, installed: modelInstalled(model.id), partial, downloading: downloads.has(model.id) };
      }),
    };
  }
  function select(id) {
    if (!MODELS.some(model => model.id === id)) throw new Error('지원하지 않는 Whisper 모델입니다.');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ ...settings(), model: id }));
    return status();
  }

  function run(command, args, { env = process.env } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
      const take = chunk => { output = (output + chunk.toString('utf8')).slice(-20000); };
      child.stdout.on('data', take); child.stderr.on('data', take);
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(output) : reject(new Error(output.trim().split('\n').slice(-4).join(' ').slice(-400) || `${path.basename(command)} ${code}`)));
    });
  }
  // Into target.part first; a download cut short goes on from there the next time (an HTTP range request).
  async function download(url, target, progress) {
    const partial = `${target}.part`; let have = 0; try { have = fs.statSync(partial).size; } catch { /* nothing yet */ }
    const response = await fetch(url, { headers: { 'User-Agent': 'LilacAnime-Desktop', ...(have ? { Range: `bytes=${have}-` } : {}) }, redirect: 'follow' });
    if (have && response.status === 416) { fs.rmSync(partial, { force: true }); return download(url, target, progress); }
    if (!response.ok || !response.body) throw new Error(`다운로드 HTTP ${response.status}`);
    if (response.status !== 206) have = 0;
    const total = (Number(response.headers.get('content-length')) || 0) + have;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = fs.createWriteStream(partial, { flags: have ? 'a' : 'w' }); let done = have, last = 0;
    try {
      for await (const chunk of response.body) {
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
        done += chunk.length; if (Date.now() - last > 400) { last = Date.now(); progress(total ? done / total : 0); }
      }
      await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
    } catch (error) { out.destroy(); throw error; }
    if (total > have && done !== total) throw new Error('다운로드가 중간에 끊겼습니다. 다시 받으면 이어서 받습니다.');
    fs.renameSync(partial, target); progress(1);
  }
  function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findFile(file, name); if (found) return found; } else if (entry.name === name) return file;
    }
    return null;
  }
  // Windows: the newest whisper.cpp release that has the builds, each unpacked next to its place and moved in whole.
  async function installNative(progress) {
    await nvidia();
    const kinds = nativeKinds().filter(kind => !serverExe(kind));
    if (!kinds.length) return;
    const releases = await (await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=8', { headers: { 'User-Agent': 'LilacAnime-Desktop', Accept: 'application/vnd.github+json' } })).json();
    const release = (Array.isArray(releases) ? releases : []).find(item => kinds.every(kind => (item.assets || []).some(asset => BUILDS[kind].asset.test(asset.name))));
    if (!release) throw new Error('whisper.cpp 실행 파일을 찾지 못했습니다.');
    const assets = kinds.map(kind => ({ kind, asset: release.assets.find(asset => BUILDS[kind].asset.test(asset.name)) })), total = assets.reduce((sum, item) => sum + item.asset.size, 0);
    let before = 0;
    for (const { kind, asset } of assets) {
      const zip = path.join(root, asset.name), target = path.join(root, kind), unpacked = `${target}.part`;
      await download(asset.browser_download_url, zip, done => progress(`whisper.cpp ${BUILDS[kind].label} 받는 중`, (before + done * asset.size) / total * 0.95));
      fs.rmSync(unpacked, { recursive: true, force: true }); fs.mkdirSync(unpacked, { recursive: true });
      progress(`whisper.cpp ${BUILDS[kind].label} 푸는 중`, (before + asset.size) / total * 0.95);
      try { await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', unpacked]); } finally { fs.rmSync(zip, { force: true }); }
      fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(unpacked, target);
      if (!serverExe(kind)) throw new Error('whisper.cpp 실행 파일을 풀지 못했습니다.');
      before += asset.size;
    }
    saveNative({ tag: release.tag_name, at: Date.now() });
  }
  // uv → its own Python 3.12 → a venv with pywhispercpp and numpy. uv and its download cache are removed afterwards.
  // On Windows the builds above instead (also the card's build when one is found after the CPU's was installed).
  function install(progress = () => {}) {
    if (NATIVE) {
      if (!installing) installing = installNative(progress).then(() => { progress('설치 완료', 1); return status(); }).finally(() => { installing = null; });
      return installing;
    }
    if (runtimeInstalled()) return Promise.resolve(status());
    if (!installing) installing = (async () => {
      fs.mkdirSync(root, { recursive: true });
      const asset = uvAsset(), archive = path.join(root, asset), unpacked = path.join(root, 'uv');
      progress('uv 받는 중', 0);
      await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`, archive, done => progress('uv 받는 중', done * 0.3));
      fs.rmSync(unpacked, { recursive: true, force: true }); fs.mkdirSync(unpacked, { recursive: true });
      const tar = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
      try { await run(tar, [WIN ? '-xf' : '-xzf', archive, '-C', unpacked]); } finally { fs.rmSync(archive, { force: true }); }
      const uv = findFile(unpacked, WIN ? 'uv.exe' : 'uv');
      if (!uv) throw new Error('uv 실행 파일을 찾지 못했습니다.');
      if (!WIN) fs.chmodSync(uv, 0o755);
      progress('Python 준비 중', 0.35);
      fs.rmSync(venv, { recursive: true, force: true });
      await run(uv, ['venv', '--python', PYTHON_VERSION, '--managed-python', venv], { env: uvEnv() });
      progress('whisper.cpp 설치 중', 0.6);
      await run(uv, ['pip', 'install', '--python', python, PACKAGE, 'numpy'], { env: uvEnv() });
      for (const dir of ['cache', 'uv']) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
      fs.writeFileSync(marker, JSON.stringify({ uv: UV_VERSION, package: PACKAGE, python: PYTHON_VERSION, at: Date.now() }));
      progress('설치 완료', 1);
      return status();
    })().finally(() => { installing = null; });
    return installing;
  }
  function downloadModel(id, progress = () => {}) {
    const model = MODELS.find(item => item.id === id);
    if (!model) throw new Error('지원하지 않는 Whisper 모델입니다.');
    if (modelInstalled(id)) return Promise.resolve(status());
    if (!downloads.has(id)) downloads.set(id, download(`${HF}${model.file}`, modelFile(id), done => progress(done)).then(status).finally(() => downloads.delete(id)));
    return downloads.get(id);
  }
  function removeModel(id) { for (const file of [modelFile(id), `${modelFile(id)}.part`]) fs.rmSync(file, { force: true }); return status(); }

  const fileFor = (key, model) => path.join(outDir, `${String(key).replace(/[^a-z0-9가-힣._-]+/gi, '_').slice(0, 120)}.${model}.vtt`);
  const result = (file, lines, complete) => ({ path: file, url: pathToFileURL(file).href, lines, complete });

  // One piece of the episode: FFmpeg from `from` (to `to`) into the worker's stdin; lines and progress as they come.
  function piece({ input, from, to, model, onLine, onAt, signal }) {
    return new Promise((resolve, reject) => {
      const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
      const py = spawn(python, [worker, modelFile(model), 'ja', threads, String(from)], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const ff = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...(from > 0 ? ['-ss', String(from)] : []), ...input.args, '-i', input.url, ...(to ? ['-t', String(Math.max(1, to - from))] : []),
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      ff.stdout.pipe(py.stdin); py.stdin.on('error', () => {});
      let rest = '', errors = '', ffErrors = '';
      py.stdout.on('data', chunk => {
        rest += chunk.toString('utf8'); const lines = rest.split('\n'); rest = lines.pop();
        for (const line of lines) { let value; try { value = JSON.parse(line); } catch { continue; } if (value.text) onLine(value); else if (Number.isFinite(value.at)) onAt(value.at); }
      });
      py.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
      ff.stderr.on('data', chunk => { ffErrors = (ffErrors + chunk).slice(-2000); });
      const stop = () => { ff.kill(); py.kill(); };
      signal.addEventListener('abort', stop, { once: true });
      let ffCode = null; ff.once('close', code => { ffCode = code; });
      ff.once('error', reject); py.once('error', reject);
      py.once('close', code => {
        signal.removeEventListener('abort', stop);
        if (signal.aborted) return reject(Object.assign(new Error('취소했습니다.'), { canceled: true }));
        if (code !== 0) return reject(new Error(`Whisper 음성 인식에 실패했습니다: ${errors.trim().split('\n').slice(-2).join(' ').slice(-300) || code}`));
        if (ffCode && ffCode !== 0) return reject(new Error(`영상 음성을 읽지 못했습니다: ${ffErrors.trim().slice(-300) || ffCode}`));
        resolve();
      });
    });
  }

  // --- Windows: whisper-server, one at a time for the model in use; stopped a minute after the last run ---
  let server = null, idleTimer = null, launching = null;
  function stopServer() { clearTimeout(idleTimer); launching = null; if (server && !server.child.killed) server.child.kill(); server = null; }
  const freePort = () => new Promise((resolve, reject) => { const probe = require('net').createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  async function launch(kind, model, status) {
    const port = await freePort(), threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
    // -mc 0: no text carried from one piece to the next (a wrong line otherwise repeats into the next pieces).
    const child = spawn(serverExe(kind), ['-m', modelFile(model), '--host', '127.0.0.1', '--port', String(port), '-l', 'ja', '-t', threads, '-mc', '0'], { windowsHide: true, cwd: path.dirname(serverExe(kind)) });
    let log = ''; const keep = chunk => { log = (log + chunk).slice(-6000); }; child.stdout.on('data', keep); child.stderr.on('data', keep);
    const exited = new Promise(resolve => child.once('exit', code => resolve(code ?? -1))); child.once('error', () => {});
    // A CUDA build turns its code for the card into the card's own the first time (28 s on a GTX 1050 Ti), so the card's
    // build is given 10 minutes the first time with a driver.
    const first = BUILDS[kind].gpu && nativeInfo().ran?.[kind] !== gpu?.driver, deadline = Date.now() + (first ? 600000 : 120000);
    if (first) status('그래픽카드 준비 중 (처음 한 번은 오래 걸려요)');
    for (;;) {
      const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(undefined), 400))]);
      if (code !== undefined) throw new Error(`whisper.cpp가 종료되었습니다: ${log.trim().split('\n').pop() || code}`);
      let ready = false; try { ready = (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* still loading */ }
      if (ready) break;
      if (Date.now() > deadline) { child.kill(); throw new Error('whisper.cpp가 응답하지 않습니다.'); }
    }
    // A card build that found no card would run on the CPU: given up for the CPU's own build.
    if (BUILDS[kind].gpu && !/using CUDA\d* backend/i.test(log)) { child.kill(); throw new Error('whisper.cpp가 그래픽카드를 쓰지 못했습니다.'); }
    if (first) saveNative({ ran: { ...nativeInfo().ran, [kind]: gpu?.driver } });
    return { kind, model, port, child };
  }
  // A server still starting is shared: a run stopped while it loaded (the episode changed) and the next run used to
  // start one each, and the one that finished first was left running with nothing to stop it. A start that a
  // stopServer() (another model, the idle timer) passed over stops its own server when it is up.
  async function serverFor(model, status) {
    clearTimeout(idleTimer);
    if (server && server.model === model && !server.child.killed && server.child.exitCode === null) return server;
    if (launching?.model === model) return launching.promise;
    stopServer();
    const promise = (async () => {
      let lastError = null;
      for (const kind of nativeKinds().filter(serverExe)) {
        let started;
        try { started = await launch(kind, model, status); }
        catch (error) { lastError = error; if (BUILDS[kind].gpu) saveNative({ broken: { ...nativeInfo().broken, [kind]: gpu?.driver } }); continue; }
        if (launching?.promise !== promise) { started.child.kill(); throw new Error('whisper.cpp 실행을 멈췄습니다.'); }
        server = started; return server;
      }
      throw lastError || new Error('whisper.cpp가 설치되지 않았습니다.');
    })();
    launching = { model, promise };
    try { return await promise; } finally { if (launching?.promise === promise) launching = null; }
  }
  // One piece of the episode through whisper-server: FFmpeg's audio collected and cut at quiet moments into pieces of at
  // most 30 s (Whisper's window; a cut in the middle of a word would lose it), each sent as WAV as soon as it is there.
  function nativePiece({ input, from, to, model, onLine, onAt, signal, status }) {
    return new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...(from > 0 ? ['-ss', String(from)] : []), ...input.args, '-i', input.url, ...(to ? ['-t', String(Math.max(1, to - from))] : []),
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let chunks = [], buffered = 0, ended = false, ffErrors = '', wake = () => {}, offset = from, failed = null;
      const recent = [];
      ff.stdout.on('data', chunk => { chunks.push(chunk); buffered += chunk.length; wake(); });
      ff.stderr.on('data', chunk => { ffErrors = (ffErrors + chunk).slice(-2000); });
      ff.once('close', code => { ended = true; if (code && !signal.aborted) failed = new Error(`영상 음성을 읽지 못했습니다: ${ffErrors.trim().slice(-300) || code}`); wake(); });
      ff.once('error', error => { failed = error; ended = true; wake(); });
      const stop = () => { ff.kill(); wake(); }; signal.addEventListener('abort', stop, { once: true });
      (async () => {
        const srv = await serverFor(model, status);
        for (;;) {
          while (!ended && buffered < RATE * 2 * 30 && !signal.aborted) await new Promise(resolve => { wake = resolve; });
          if (signal.aborted) throw Object.assign(new Error('취소했습니다.'), { canceled: true });
          if (failed && !buffered) throw failed;
          if (!buffered) break;
          const all = Buffer.concat(chunks), samples = new Int16Array(all.buffer, all.byteOffset, all.length >> 1);
          const cut = samples.length <= RATE * 30 ? samples.length : quietCut(samples, 18, 30), part = samples.subarray(0, cut);
          const rest = all.subarray(cut * 2); chunks = rest.length ? [Buffer.from(rest)] : []; buffered = rest.length;
          // A piece with next to no sound is left out: Whisper invents lines over silence.
          let energy = 0; for (let i = 0; i < part.length; i++) energy += (part[i] / 32768) ** 2;
          if (part.length && Math.sqrt(energy / part.length) >= 0.004) {
            const form = new FormData(); form.append('file', new Blob([wavOf(part)], { type: 'audio/wav' }), 'piece.wav'); form.append('response_format', 'verbose_json'); form.append('temperature', '0');
            const response = await fetch(`http://127.0.0.1:${srv.port}/inference`, { method: 'POST', body: form, signal });
            if (!response.ok) throw new Error(`Whisper 음성 인식에 실패했습니다 (HTTP ${response.status}).`);
            for (const seg of (await response.json()).segments || []) { const text = String(seg.text || '').trim(); if (keepLine(text, recent)) onLine({ start: Math.round((offset + seg.start) * 100) / 100, end: Math.round((offset + seg.end) * 100) / 100, text }); }
          }
          offset += cut / RATE; onAt(Math.round(offset * 100) / 100);
          if (ended && !buffered) break;
        }
      })().then(resolve, error => { ff.kill(); reject(signal.aborted ? Object.assign(new Error('취소했습니다.'), { canceled: true }) : error); }).finally(() => signal.removeEventListener('abort', stop));
    });
  }

  // request: {key (the episode), videoUrl, headers, startAt (where it is playing), duration}. events(value): {lines},
  // {at, done} (seconds transcribed, of duration), {partial} (the subtitle so far, rewritten after each piece for the
  // live translation), {status}. A finished episode is given back at once; one run at a time (a new episode stops the
  // one before). jump(seconds): the player moved to a part not transcribed yet: it is done from there next (as a
  // translation follows the player), the parts left behind afterwards.
  // background: the next episode made ready (다음 화 미리 준비): it waits for nothing and gives way to the episode on
  // screen ({busy: true} while that one runs; a run for it stops this one).
  async function transcribe({ key, videoUrl, headers = {}, startAt = 0, duration = 0, background = false }, events = () => {}) {
    if (background && current && !current.background) return { busy: true };
    if (!runtimeInstalled()) throw new Error('Whisper가 아직 설치되지 않았습니다. 설정 > 자막 > Whisper AI 자막에서 설치해 주세요.');
    const model = status().model;
    if (!modelInstalled(model)) throw new Error(`Whisper ${MODELS.find(item => item.id === model).label} 모델을 먼저 받아 주세요 (설정 > 자막 > Whisper AI 자막).`);
    if (!key || !videoUrl) throw new Error('재생 중인 영상이 없습니다.');
    const file = fileFor(key, model), doneFile = `${file}.done`;
    if (fs.existsSync(file) && fs.existsSync(doneFile)) return result(file, JSON.parse(fs.readFileSync(doneFile, 'utf8')).lines || 0, true);
    cancel();
    fs.mkdirSync(root, { recursive: true }); if (!NATIVE) fs.writeFileSync(worker, WORKER);
    const controller = new AbortController(), run = { key, controller, background }; current = run;
    const lines = [], add = line => { lines.push(line); events({ lines: [line] }); };
    const done = spans();
    // The subtitle so far, written where the finished one goes (the folder only now: the subtitle cleanup run a minute
    // after start removes empty folders).
    const writePartial = () => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(file, vttOf(lines)); events({ partial: file, count: lines.length }); };
    run.jump = time => {
      // Done already, or just ahead of where it is (it gets there in a moment): nothing to move.
      if (done.has(time) || (run.reached != null && time >= run.reached && time - run.reached < 45)) return;
      run.target = Math.max(0, time - 2); run.piece?.abort();
    };
    try {
      const url = /^https?:\/\//i.test(videoUrl) && !/^https?:\/\/127\.0\.0\.1[:/]/i.test(videoUrl) && /\.m3u8(?:$|\?)/i.test(videoUrl) ? await proxy(videoUrl, headers) : videoUrl;
      const local = /^file:/i.test(url), remoteHeaders = !local && !/^https?:\/\/127\.0\.0\.1[:/]/i.test(url) ? Object.entries(headers || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\r\n') : '';
      const input = { url: local ? fileURLToPath(url) : url, args: [...(remoteHeaders ? ['-headers', `${remoteHeaders}\r\n`] : []), ...(/^https?:/i.test(url) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : [])] };
      // From a little before where it is playing to the end, then what is left from the beginning; a jump moves it.
      let target = startAt > 60 ? Math.max(0, startAt - 5) : 0;
      for (;;) {
        const gap = done.gapFrom(target, duration) || done.gapFrom(0, duration);
        if (!gap) break;
        const [start, to] = gap, partController = new AbortController(), stopPart = () => partController.abort();
        controller.signal.addEventListener('abort', stopPart, { once: true });
        run.piece = partController; run.reached = start; let reached = start;
        try {
          await (NATIVE ? nativePiece : piece)({ input, from: start, to, model, signal: partController.signal, onLine: add, status: message => events({ status: message }),
            onAt: at => { done.add(reached, at); reached = run.reached = at; events({ at, done: done.length(duration), duration }); writePartial(); } });
          // Read to its end: the part is done to there (to the end of the episode when it had none).
          done.add(reached, to || Infinity); target = to || Infinity;
        } catch (error) {
          if (controller.signal.aborted || !partController.signal.aborted || run.target == null) throw error;
          target = run.target; run.target = null;
        } finally { controller.signal.removeEventListener('abort', stopPart); run.piece = null; }
      }
      fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(file, vttOf(lines)); fs.writeFileSync(doneFile, JSON.stringify({ lines: lines.length, model, at: Date.now() }));
      return result(file, lines.length, true);
    } catch (error) {
      // What was recognized before a stop stays (shown and saved), the run is not marked done.
      if (lines.length) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(file, vttOf(lines)); }
      throw error;
    } finally {
      if (current === run) current = null;
      // The server (and the model in the card's memory) goes a minute after the last run.
      clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!current) stopServer(); }, 60000); idleTimer.unref?.();
    }
  }
  function cancel() { current?.controller.abort(); current = null; return true; }
  function jump(seconds) { current?.jump?.(Number(seconds) || 0); return true; }

  return { status, select, install, downloadModel, removeModel, transcribe, cancel, jump, stop: () => { cancel(); stopServer(); }, MODELS };
}

module.exports = { createWhisper, vttOf, cueText, keepLine, quietCut, spans, WHISPER_MODELS: MODELS };
