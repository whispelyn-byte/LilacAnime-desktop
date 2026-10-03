// Local subtitle translation (설정 > 자막 자동 번역 > 로컬 AI), like Android's local AI: a GGUF translation model run by
// llama.cpp. llama.cpp's Windows server (the CUDA build on an NVIDIA card, otherwise the Vulkan build, which falls back
// to the CPU without a usable GPU) and the model are downloaded on first use into userData/local-ai; the server listens
// on 127.0.0.1 only while translating and is stopped half a minute after the last line (loading the model again takes
// a few seconds).
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { characterTerms, termsFor } = require('./anime-glossary.cjs');

// Android's choices: HY-MT1.5 (current default there) and the Japanese -> Korean VN model it used before, plus Hy-MT2.
const MODELS = [
  { id: 'hy-mt-1.8b', label: 'HY-MT1.5 1.8B', note: '기본 · 1.1GB · 빠름', repo: 'tencent/HY-MT1.5-1.8B-GGUF', file: 'HY-MT1.5-1.8B-Q4_K_M.gguf', size: 1133e6 },
  // Hy-MT2 (May 2026), HY-MT1.5's successor.
  { id: 'hy-mt2-1.8b', label: 'Hy-MT2 1.8B', note: '1.1GB · 빠름 · 최신 번역 모델', repo: 'tencent/Hy-MT2-1.8B-GGUF', file: 'Hy-MT2-1.8B-Q4_K_M.gguf', size: 1133e6 },
  // Hy-MT2's mixture of experts: 30B in all but about 3B worked per word, so it runs from memory on the processor.
  { id: 'hy-mt2-30b-a3b', label: 'Hy-MT2 30B-A3B', note: '18GB · 가장 정확함 · 램 24GB 이상', repo: 'tencent/Hy-MT2-30B-A3B-GGUF', file: 'Hy-MT2-30B-A3B-Q4_K_M.gguf', size: 18240e6 },
  { id: 'hy-mt-7b', label: 'HY-MT1.5 7B', note: '4.6GB · 더 정확함', repo: 'tencent/HY-MT1.5-7B-GGUF', file: 'HY-MT1.5-7B-Q4_K_M.gguf', size: 4620e6 },
  { id: 'ja-ko-vn-7b', label: 'ja-ko-vn 7B', note: '4.6GB · 일본어 → 한국어 특화', repo: 'hell0ks/ja-ko-vn-7b-v1-gguf', file: 'model-Q4_K_M.gguf', size: 4630e6 }
];
// llama.cpp builds: Vulkan runs on any graphics card (and falls back to the CPU); on an NVIDIA card the CUDA build is
// about 1.5 times faster (GTX 1050 Ti: Hy-MT2 30B-A3B 1.87 → 1.15 s a line, Hy-MT2 1.8B 0.30 → 0.20 s). CUDA 13 left
// out the cards before Turing (compute capability below 7.5) and needs driver 580; CUDA 12 runs those from driver 551.61
// but not the RTX 50 cards (12.0).
const RUNTIMES = {
  vulkan: { dir: 'runtime', label: 'Vulkan', assets: [/^llama-b\d+-bin-win-vulkan-x64\.zip$/] },
  cuda12: { dir: 'runtime-cuda12', label: 'CUDA', assets: [/^llama-b\d+-bin-win-cuda-12\.[\d.]+-x64\.zip$/, /^cudart-llama-bin-win-cuda-12\.[\d.]+-x64\.zip$/] },
  cuda13: { dir: 'runtime-cuda13', label: 'CUDA', assets: [/^llama-b\d+-bin-win-cuda-13\.[\d.]+-x64\.zip$/, /^cudart-llama-bin-win-cuda-13\.[\d.]+-x64\.zip$/] }
};
const PARALLEL = 4, IDLE_STOP = 30 * 1000;
// HY-MT's own prompt, one line at a time. Previous lines as context (Android's prompt, or HY-MT's contextual one) made
// the 1.8B model translate the context instead of the line in about a third of short lines, so none is sent. What it
// gets instead is HY-MT's terminology list with the names and set phrases found in the line (anime-glossary): without
// it 真昼 came out as 정오 (noon), 周くん as 주군 and いただきます as 감사합니다. Its Chinese "translate into Korean"
// prompt left Japanese words in, so the English one follows the list. Other models get the list in English.
// Each model is asked the way its model card says:
// - HY-MT1.5: the prompt above, sampling 0.7 / top-p 0.6 / top-k 20 / repeat 1.05.
// - Hy-MT2: its own wording ("Translate the following text into …") and English terminology list; the 30B-A3B model
//   samples with top-p 1 and no top-k or repeat penalty.
// - ja-ko-vn: trained on the Japanese line alone (no instruction: its chat template adds one), names as a system
//   message "岡部倫太郎=오카베 린타로,…" (the template turns it into a terminology turn), temperature 0.1, top-p 0.9.
// - Anything else (Qwen3 Instruct and other chat models): the instruction with the list in English, Qwen's sampling.
const INSTRUCTION = 'Translate the following segment into Korean, without additional explanation.';
const HY_MT2_INSTRUCTION = 'Translate the following text into Korean. Note that you should only output the translated result without any additional explanation:';
function request(source, terms, kind) {
  const user = content => [{ role: 'user', content }];
  if (kind === 'jako') return { messages: [...(terms.length ? [{ role: 'system', content: terms.map(term => `${term.ja}=${term.ko}`).join(',') }] : []), { role: 'user', content: source }], temperature: 0.1, top_p: 0.9, repeat_penalty: 1.05 };
  if (kind === 'hy-mt2' || kind === 'hy-mt2-moe') {
    const sampling = kind === 'hy-mt2-moe' ? { temperature: 0.7, top_p: 1, top_k: 0, repeat_penalty: 1 } : { temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05 };
    return { messages: user(terms.length ? `Reference the following translations:\n${terms.map(term => `${term.ja} translates to ${term.ko}`).join('\n')}\n\n${HY_MT2_INSTRUCTION}\n\n${source}` : `${HY_MT2_INSTRUCTION}\n\n${source}`), ...sampling };
  }
  if (kind === 'hy-mt') return { messages: user(terms.length ? `参考下面的翻译：\n${terms.map(term => `${term.ja} 翻译成 ${term.ko}`).join('\n')}\n\n${INSTRUCTION}\n\n${source}` : `${INSTRUCTION}\n\n${source}`), temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05 };
  return { messages: user(terms.length ? `This is a line from a Japanese anime. Use these Korean translations:\n${terms.map(term => `${term.ja} = ${term.ko}`).join('\n')}\n\n${INSTRUCTION}\n\n${source}` : `${INSTRUCTION}\n\n${source}`), temperature: 0.7, top_p: 0.8, top_k: 20, repeat_penalty: 1.05 };
}
// Which way to ask: by the model's name, or for a file the user added (ja-ko-vn 12B ships as "model-Q4_K_M.gguf" too)
// by the chat template llama.cpp read from it.
function modelKind(model, template = '') {
  const name = `${model.id} ${model.file || ''} ${model.label}`;
  if (/ja-ko-vn|jako/i.test(name) || /일한 번역가|고유명사 및 용어 규칙/.test(template)) return 'jako';
  if (/hy-mt2/i.test(name)) return /a3b|30b/i.test(name) ? 'hy-mt2-moe' : 'hy-mt2';
  return /hy-mt/i.test(name) ? 'hy-mt' : 'chat';
}
const KANA = /[぀-ゟ゠-ヺヽ-ヿ]/;

function createLocalAi(userData) {
  const root = path.join(userData, 'local-ai'), modelDir = path.join(root, 'models');
  let server = null, starting = null, idleTimer = null, busy = 0;
  const downloads = new Map(); // model id -> {done, total}

  const modelPath = model => model.path || path.join(modelDir, model.file.replace(/[^A-Za-z0-9._-]/g, '_'));
  // Presets plus GGUF files the user added (kept as-is where they are; listed from added.json).
  const addedFile = path.join(root, 'added.json');
  const added = () => { try { return JSON.parse(fs.readFileSync(addedFile, 'utf8')).filter(item => fs.existsSync(item.path)); } catch { return []; } };
  const models = () => [...MODELS, ...added().map(item => ({ id: `file:${item.path}`, label: path.basename(item.path), note: '직접 추가한 파일', path: item.path, size: item.size }))]
    .map(model => ({ ...model, installed: fs.existsSync(modelPath(model)), downloading: downloads.get(model.id) || null, run: runs()[modelPath(model)] || null }));
  function addFile(file) {
    if (!/\.gguf$/i.test(file) || !fs.existsSync(file)) throw new Error('GGUF 파일을 골라 주세요.');
    const list = added().filter(item => item.path !== file); list.push({ path: file, size: fs.statSync(file).size });
    fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(addedFile, JSON.stringify(list)); return `file:${file}`;
  }
  const runtimeExe = kind => {
    const walk = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]); } catch { return []; } };
    return walk(path.join(root, RUNTIMES[kind].dir)).find(file => path.basename(file).toLowerCase() === 'llama-server.exe') || null;
  };
  // The build for this PC: CUDA for an NVIDIA card nvidia-smi reports (with a driver new enough for it), unless that
  // build failed here with the same driver (a newer driver gets another try); Vulkan otherwise.
  const brokenFile = path.join(root, 'runtime-broken.json');
  const broken = () => { try { return JSON.parse(fs.readFileSync(brokenFile, 'utf8')) || {}; } catch { return {}; } };
  let gpuInfo = null;
  function nvidiaGpu() {
    gpuInfo ||= new Promise(resolve => {
      if (process.platform !== 'win32') { resolve(null); return; }
      let out = ''; const child = spawn('nvidia-smi', ['--query-gpu=compute_cap,driver_version', '--format=csv,noheader'], { windowsHide: true });
      child.stdout.on('data', chunk => { out += chunk; }); child.once('error', () => resolve(null));
      child.once('close', code => { const [cap, driver] = out.split('\n')[0]?.split(',').map(value => parseFloat(value)) || []; resolve(code === 0 && cap && driver ? { cap, driver } : null); });
    });
    return gpuInfo;
  }
  async function preferredRuntime() {
    const gpu = await nvidiaGpu(), off = broken();
    const kind = !gpu ? 'vulkan' : gpu.cap >= 7.5 && gpu.driver >= 580 ? 'cuda13' : gpu.cap >= 5 && gpu.cap < 10 && gpu.driver >= 551.61 ? 'cuda12' : 'vulkan';
    return off[kind] && off[kind].driver === gpu?.driver ? 'vulkan' : kind;
  }

  async function download(url, target, progress) {
    const response = await fetch(url, { headers: { 'User-Agent': 'LilacAnime-Desktop' }, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`다운로드 HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0, partial = `${target}.part`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = fs.createWriteStream(partial); let done = 0, last = 0;
    try {
      for await (const chunk of response.body) {
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
        done += chunk.length; if (Date.now() - last > 500) { last = Date.now(); progress(done, total); }
      }
      await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
    } catch (error) { out.destroy(); try { fs.unlinkSync(partial); } catch {} throw error; }
    fs.renameSync(partial, target); progress(done, total || done);
  }
  // The newest llama.cpp release that has every file of the build (CUDA: the program and the CUDA runtime it needs).
  const installing = new Map(); // build -> download
  function ensureRuntime(kind, progress = () => {}) {
    const existing = runtimeExe(kind); if (existing) return Promise.resolve(existing);
    if (!installing.has(kind)) installing.set(kind, (async () => {
      const { dir, assets: patterns } = RUNTIMES[kind], target = path.join(root, dir);
      const releases = await (await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8', { headers: { 'User-Agent': 'LilacAnime-Desktop', Accept: 'application/vnd.github+json' } })).json();
      const assets = (Array.isArray(releases) ? releases : []).map(release => patterns.map(pattern => (release.assets || []).find(item => pattern.test(item.name)))).find(found => found.every(Boolean));
      if (!assets) throw new Error('llama.cpp 실행 파일을 찾지 못했습니다.');
      // Unpacked next to the build's folder and moved in once every file is there, so a download cut short leaves
      // no half build behind.
      const total = assets.reduce((sum, asset) => sum + (asset.size || 0), 0), unpacked = `${target}.part`; let before = 0;
      fs.rmSync(unpacked, { recursive: true, force: true });
      for (const asset of assets) {
        const zip = path.join(root, asset.name);
        await download(asset.browser_download_url, zip, done => progress(before + done, total));
        try { new AdmZip(zip).extractAllTo(unpacked, true); } finally { try { fs.unlinkSync(zip); } catch {} }
        before += asset.size || 0;
      }
      fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(unpacked, target);
      const exe = runtimeExe(kind); if (!exe) throw new Error('llama.cpp 실행 파일을 풀지 못했습니다.'); return exe;
    })().finally(() => installing.delete(kind)));
    return installing.get(kind);
  }
  // The build to start now: the preferred one when it is on disk. When it is not but the Vulkan build is, Vulkan runs
  // this time and the preferred one comes down meanwhile; with neither, the preferred one is downloaded first (Vulkan
  // if that fails).
  async function runtimeFor(status) {
    const kind = await preferredRuntime(), percent = (done, total) => total ? Math.round(done / total * 100) : 0;
    if (runtimeExe(kind)) return { kind, exe: runtimeExe(kind) };
    if (kind !== 'vulkan' && runtimeExe('vulkan')) {
      ensureRuntime(kind).catch(() => {});
      status('다음 번역부터 쓸 NVIDIA용 llama.cpp(CUDA)를 받는 중이라 이번엔 Vulkan으로 번역');
      return { kind: 'vulkan', exe: runtimeExe('vulkan') };
    }
    try { return { kind, exe: await ensureRuntime(kind, (done, total) => status(`llama.cpp${kind === 'vulkan' ? '' : '(CUDA)'} 받는 중 ${percent(done, total)}%`)) }; }
    catch (error) { if (kind === 'vulkan') throw error; }
    return { kind: 'vulkan', exe: await ensureRuntime('vulkan', (done, total) => status(`llama.cpp 받는 중 ${percent(done, total)}%`)) };
  }
  async function installModel(id, progress = () => {}) {
    const model = MODELS.find(item => item.id === id); if (!model) throw new Error('모델을 찾지 못했습니다.');
    if (downloads.has(id)) throw new Error('이미 받는 중입니다.');
    downloads.set(id, { done: 0, total: model.size });
    try {
      await download(`https://huggingface.co/${model.repo}/resolve/main/${encodeURIComponent(model.file)}?download=true`, modelPath(model), (done, total) => { downloads.set(id, { done, total: total || model.size }); progress(done, total || model.size); });
    } finally { downloads.delete(id); }
  }
  function removeModel(id) {
    const model = models().find(item => item.id === id); if (!model) return;
    if (model.path) { fs.writeFileSync(addedFile, JSON.stringify(added().filter(item => item.path !== model.path))); return; }
    if (server?.model === modelPath(model)) stop();
    try { fs.unlinkSync(modelPath(model)); } catch {}
  }

  // A server left behind by an app that did not close normally is stopped before a new one starts (only when that
  // process id still belongs to llama-server).
  const pidFile = path.join(root, 'server.pid');
  function stopLeftover() {
    let pid = 0; try { pid = Number(fs.readFileSync(pidFile, 'utf8')) || 0; fs.unlinkSync(pidFile); } catch { return; }
    if (!pid || process.platform !== 'win32') return;
    const list = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true }); let out = '';
    list.stdout.on('data', chunk => { out += chunk; });
    return new Promise(resolve => list.once('close', () => { if (/llama-server\.exe/i.test(out)) try { process.kill(pid); } catch {} resolve(); }));
  }
  const freePort = () => new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  // Where each model last ran (graphics card and how many of its layers, or the CPU and why), shown under the model in
  // the settings so a slow translation can be told apart from one that never reached the card.
  const runsFile = path.join(root, 'runs.json');
  const runs = () => { try { return JSON.parse(fs.readFileSync(runsFile, 'utf8')) || {}; } catch { return {}; } };
  function saveRun(file, run) { try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(runsFile, JSON.stringify({ ...runs(), [file]: run })); } catch {} }
  function stop() { clearTimeout(idleTimer); if (server?.child && !server.child.killed) { server.child.kill(); try { fs.unlinkSync(pidFile); } catch {} } server = null; starting = null; }
  // Stopped half a minute after the last answer, never while one is being written: a line the model repeats
  // (バカ バカ バカ…) can keep all four slots busy for longer than that.
  function touch() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (busy) touch(); else stop(); }, IDLE_STOP); idleTimer.unref?.(); }
  // One server for the selected model; layers go to the graphics card when the build finds one.
  async function start(model, status = () => {}) {
    const file = modelPath(model);
    if (server?.model === file && !server.child.killed) { touch(); return server; }
    if (starting?.model === file) return starting.promise;
    stop();
    const promise = (async () => {
      if (!fs.existsSync(file)) throw new Error(`${model.label} 모델을 먼저 받아 주세요 (설정 > 자막 자동 번역).`);
      status('llama.cpp 준비 중');
      let { kind, exe } = await runtimeFor(status);
      await stopLeftover();
      // llama.cpp puts as many layers on the graphics card as fit in its free memory and runs the rest on the CPU, and
      // a layer left on the CPU makes the CPU set the pace. Forcing all of them (-ngl 99) stopped a 7B model (4.6 GB)
      // from loading on a 4 GB card. The context memory is kept small so that a 7B model fits an 8 GB card whole:
      // ja-ko-vn keeps 0.5 MB per token, so the 8192 tokens asked for before took 4 GB and pushed a third of the model
      // onto the CPU of an RX 6600. A subtitle line needs far less than the 1024 tokens each of the four slots now
      // gets, and 8-bit context memory halves it again. Should the card still fail to allocate, the model is loaded
      // with more room left on the card, then on the CPU alone.
      const launch = async extra => {
        const port = await freePort();
        const child = spawn(exe, ['-m', file, '--host', '127.0.0.1', '--port', String(port), '-c', '4096', '-np', String(PARALLEL), '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--fit-target', '512', ...extra, '--jinja', '--no-webui', '-lv', '4'], { cwd: path.dirname(exe), windowsHide: true, env: { ...process.env, LLAMA_ARG_LOAD_MODE: 'none', LLAMA_ARG_NO_MMAP: '1' } });
        try { fs.writeFileSync(pidFile, String(child.pid)); } catch {}
        // The model file is read rather than memory-mapped: on Windows a mapped file stays in RAM whole even with every
        // layer on the graphics card (1.4 GB for the 1.8B model, 0.3 GB read; 5.2 GB against 2.7 GB for ja-ko-vn on a
        // 4 GB card). Set through the environment, which a llama.cpp without the option (load mode is newer than
        // no-mmap) ignores instead of refusing to start.
        // The device and layer count are read as the model loads (-lv 4 prints them).
        let log = '', device = '', layers = 0, total = 0;
        const keep = chunk => {
          log = (log + chunk.toString()).slice(-8000);
          device ||= log.match(/using device \S+ \(([^)]+)\)/)?.[1] || '';
          const offloaded = log.match(/offloaded (\d+)\/(\d+) layers to GPU/); if (offloaded) { layers = Number(offloaded[1]); total = Number(offloaded[2]); }
        };
        child.stdout.on('data', keep); child.stderr.on('data', keep);
        const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
        const deadline = Date.now() + 180000;
        for (;;) {
          const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(undefined), 500))]);
          if (code !== undefined) {
            const memory = /OutOfDeviceMemory|unable to allocate|failed to allocate|out of memory/i.test(log);
            const error = new Error(memory ? '그래픽카드 메모리가 부족해 모델을 불러오지 못했습니다. 더 작은 모델(HY-MT1.5 1.8B)을 써 보세요.' : `llama.cpp가 종료되었습니다: ${log.trim().split('\n').filter(line => / E /.test(line)).pop() || log.trim().split('\n').pop() || code}`);
            error.memory = memory; throw error;
          }
          let ready = false;
          try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* still loading */ }
          // Without a graphics card in use llama.cpp still reports the layers as offloaded, so they count only with a
          // device. A CUDA build that found none (its CUDA library did not load) would run on the CPU alone: it is
          // given up for the Vulkan build instead.
          if (ready && kind !== 'vulkan' && !/using device CUDA/i.test(log)) { child.kill(); throw new Error('NVIDIA 그래픽카드를 쓰지 못했습니다.'); }
          if (ready) return { child, port, device, layers: device ? layers : 0, total };
          if (Date.now() > deadline) { child.kill(); throw new Error('모델을 불러오는 데 너무 오래 걸립니다.'); }
        }
      };
      status('모델 불러오는 중');
      let reason = '';
      const load = async () => {
        try { return await launch([]); }
        catch (error) {
          if (!error.memory) throw error;
          status('그래픽카드 메모리가 부족해 다시 불러오는 중');
          try { return await launch(['--fit-target', '2048']); }
          catch (retry) { if (!retry.memory) throw retry; reason = '그래픽카드 메모리 부족'; status('그래픽카드 메모리가 부족해 CPU로 불러오는 중'); return launch(['-ngl', '0']); }
        }
      };
      let started;
      try { started = await load(); }
      catch (error) {
        // A CUDA build that does not start on this PC (a driver or card it does not support) is not tried again here;
        // the Vulkan build takes over.
        if (kind === 'vulkan' || error.memory) throw error;
        try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(brokenFile, JSON.stringify({ ...broken(), [kind]: { driver: (await nvidiaGpu())?.driver || 0, error: error.message.slice(0, 300) } })); } catch {}
        status('NVIDIA용 llama.cpp가 실행되지 않아 Vulkan으로 다시 불러오는 중');
        kind = 'vulkan'; exe = await ensureRuntime('vulkan', (done, total) => status(`llama.cpp 받는 중 ${total ? Math.round(done / total * 100) : 0}%`));
        started = await load();
      }
      const { child, port, device, layers, total } = started;
      saveRun(file, { device: layers ? `${device} · ${RUNTIMES[kind].label}` : '', layers, total, reason: layers ? '' : reason || (device ? '' : '그래픽카드를 찾지 못함'), time: Date.now() });
      let template = '';
      try { template = String((await (await fetch(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(3000) })).json())?.chat_template || ''); } catch { /* asked by the model's name */ }
      server = { child, port, model: file, template }; child.once('exit', () => { if (server?.child === child) server = null; }); touch();
      return server;
    })();
    starting = { model: file, promise };
    try { return await promise; } finally { if (starting?.promise === promise) starting = null; }
  }

  // Android LocalAiTranslationRuntime.parseSingleOutput: the model's answer without wrappers. Small models sometimes
  // translate the context too, so only the last lines (as many as the source has) are kept.
  function clean(output, original) {
    let value = String(output || '').replace(/\r\n?/g, '\n').trim().replace(/^<target>|<\/target>$/g, '').trim();
    value = value.replace(/^```(?:text|plaintext|korean|ko)?\s*/i, '').replace(/\s*```$/, '').trim();
    const labelled = value.match(/<target>([\s\S]*?)<\/target>/i)?.[1]?.trim(); if (labelled) value = labelled;
    const lines = value.split('\n').map(line => line.trimEnd()).filter(Boolean), wanted = Math.max(1, original.split('\n').filter(Boolean).length);
    return lines.length ? lines.slice(-wanted).join('\n') : '';
  }
  // Every line once, four at a time. Returns translations by index (failed
  // lines are left out, so the caller keeps the original text).
  // context: the work's {characters} from AniList, for the names in the terminology list.
  async function translateLines(texts, { modelId, progress = () => {}, status = () => {}, context = {} } = {}) {
    const model = models().find(item => item.id === modelId) || models().find(item => item.installed);
    if (!model) throw new Error('로컬 AI 모델이 없습니다. 설정 > 자막 자동 번역에서 모델을 받아 주세요.');
    const { port, template } = await start(model, status);
    const names = characterTerms(context.characters || []), kind = modelKind(model, template);
    // An answer is cut off at a few times the line's length (a subtitle line never needs more), so a model stuck
    // repeating a word gives up its slot in seconds instead of writing 512 tokens.
    const ask = async (body, source) => {
      busy++;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(120000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, max_tokens: Math.min(512, 48 + source.length * 3), stream: false }) });
        if (!response.ok) throw new Error(`llama.cpp HTTP ${response.status}`);
        return (await response.json())?.choices?.[0]?.message?.content;
      } finally { busy--; }
    };
    const result = new Map(); let next = 0, done = 0, fatal = null;
    progress(0, texts.length);
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (next < texts.length && !fatal) {
        const index = next++, source = texts[index], body = request(source, termsFor(source, names), kind);
        try {
          // A Japanese word left in the answer (えっ, 先輩) is asked again, twice at most. ja-ko-vn's temperature of 0.1
          // would give the same answer again, so its second and third tries are less certain.
          let text = '';
          for (let attempt = 0; attempt < 3; attempt++) { text = clean(await ask(attempt && kind === 'jako' ? { ...body, temperature: 0.5 } : body, source), source); if (text && !KANA.test(text)) break; }
          if (text) result.set(index, text);
        } catch (error) { if (!server) fatal = error; }
        touch(); progress(++done, texts.length);
      }
    }));
    if (fatal && !result.size) throw fatal;
    return { translations: result, model };
  }

  return { models, installModel, removeModel, addFile, translateLines, stop, modelPath };
}

module.exports = { createLocalAi, LOCAL_AI_MODELS: MODELS };
