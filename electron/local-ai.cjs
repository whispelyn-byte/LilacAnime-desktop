// Local subtitle translation (설정 > 자막 자동 번역 > 로컬 AI), like Android's local AI: a GGUF translation model run by
// llama.cpp. llama.cpp's Windows server (the Vulkan build, which falls back to the CPU without a usable GPU) and the
// model are downloaded on first use into userData/local-ai; the server listens on 127.0.0.1 only while translating
// and is stopped after a few idle minutes.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

// Android's choices: HY-MT1.5 (current default there) and the Japanese -> Korean VN model it used before.
const MODELS = [
  { id: 'hy-mt-1.8b', label: 'HY-MT1.5 1.8B', note: '기본 · 1.1GB · 빠름', repo: 'tencent/HY-MT1.5-1.8B-GGUF', file: 'HY-MT1.5-1.8B-Q4_K_M.gguf', size: 1133e6 },
  { id: 'hy-mt-7b', label: 'HY-MT1.5 7B', note: '4.6GB · 더 정확함', repo: 'tencent/HY-MT1.5-7B-GGUF', file: 'HY-MT1.5-7B-Q4_K_M.gguf', size: 4620e6 },
  { id: 'ja-ko-vn-7b', label: 'ja-ko-vn 7B', note: '4.6GB · 일본어 → 한국어 특화', repo: 'hell0ks/ja-ko-vn-7b-v1-gguf', file: 'model-Q4_K_M.gguf', size: 4630e6 }
];
const RUNTIME_ASSET = /^llama-b\d+-bin-win-vulkan-x64\.zip$/;
const PARALLEL = 4, IDLE_STOP = 5 * 60 * 1000;
// HY-MT's own prompt, one line at a time. Previous lines as context (Android's prompt, or HY-MT's contextual one) made
// the 1.8B model translate the context instead of the line in about a third of short lines, so none is sent.
const prompt = source => `Translate the following segment into Korean, without additional explanation.\n\n${source}`;

function createLocalAi(userData) {
  const root = path.join(userData, 'local-ai'), runtimeDir = path.join(root, 'runtime'), modelDir = path.join(root, 'models');
  let server = null, starting = null, idleTimer = null;
  const downloads = new Map(); // model id -> {done, total}

  const modelPath = model => model.path || path.join(modelDir, model.file.replace(/[^A-Za-z0-9._-]/g, '_'));
  // Presets plus GGUF files the user added (kept as-is where they are; listed from added.json).
  const addedFile = path.join(root, 'added.json');
  const added = () => { try { return JSON.parse(fs.readFileSync(addedFile, 'utf8')).filter(item => fs.existsSync(item.path)); } catch { return []; } };
  const models = () => [...MODELS, ...added().map(item => ({ id: `file:${item.path}`, label: path.basename(item.path), note: '직접 추가한 파일', path: item.path, size: item.size }))]
    .map(model => ({ ...model, installed: fs.existsSync(modelPath(model)), downloading: downloads.get(model.id) || null }));
  function addFile(file) {
    if (!/\.gguf$/i.test(file) || !fs.existsSync(file)) throw new Error('GGUF 파일을 골라 주세요.');
    const list = added().filter(item => item.path !== file); list.push({ path: file, size: fs.statSync(file).size });
    fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(addedFile, JSON.stringify(list)); return `file:${file}`;
  }
  const runtimeExe = () => {
    const walk = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]); } catch { return []; } };
    return walk(runtimeDir).find(file => path.basename(file).toLowerCase() === 'llama-server.exe') || null;
  };

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
  // The newest llama.cpp release that has the Windows Vulkan build.
  async function ensureRuntime(progress = () => {}) {
    const existing = runtimeExe(); if (existing) return existing;
    const releases = await (await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8', { headers: { 'User-Agent': 'LilacAnime-Desktop', Accept: 'application/vnd.github+json' } })).json();
    const asset = (Array.isArray(releases) ? releases : []).flatMap(release => release.assets || []).find(item => RUNTIME_ASSET.test(item.name));
    if (!asset) throw new Error('llama.cpp 실행 파일을 찾지 못했습니다.');
    const zip = path.join(root, asset.name);
    await download(asset.browser_download_url, zip, progress);
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); new AdmZip(zip).extractAllTo(runtimeDir, true); } finally { try { fs.unlinkSync(zip); } catch {} }
    const exe = runtimeExe(); if (!exe) throw new Error('llama.cpp 실행 파일을 풀지 못했습니다.'); return exe;
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
  function stop() { clearTimeout(idleTimer); if (server?.child && !server.child.killed) { server.child.kill(); try { fs.unlinkSync(pidFile); } catch {} } server = null; starting = null; }
  function touch() { clearTimeout(idleTimer); idleTimer = setTimeout(stop, IDLE_STOP); idleTimer.unref?.(); }
  // One server for the selected model; GPU layers are offloaded when the Vulkan build finds a device.
  async function start(model, status = () => {}) {
    const file = modelPath(model);
    if (server?.model === file && !server.child.killed) { touch(); return server; }
    if (starting?.model === file) return starting.promise;
    stop();
    const promise = (async () => {
      if (!fs.existsSync(file)) throw new Error(`${model.label} 모델을 먼저 받아 주세요 (설정 > 자막 자동 번역).`);
      status('llama.cpp 준비 중');
      const exe = await ensureRuntime((done, total) => status(`llama.cpp 받는 중 ${total ? Math.round(done / total * 100) : 0}%`));
      await stopLeftover();
      const port = await freePort();
      const child = spawn(exe, ['-m', file, '--host', '127.0.0.1', '--port', String(port), '-c', '8192', '-np', String(PARALLEL), '-ngl', '99', '--jinja', '--no-webui'], { cwd: path.dirname(exe), windowsHide: true });
      try { fs.writeFileSync(pidFile, String(child.pid)); } catch {}
      let log = ''; const keep = chunk => { log = (log + chunk.toString()).slice(-4000); };
      child.stdout.on('data', keep); child.stderr.on('data', keep);
      const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
      status('모델 불러오는 중');
      const deadline = Date.now() + 180000;
      for (;;) {
        const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(undefined), 500))]);
        if (code !== undefined) throw new Error(`llama.cpp가 종료되었습니다: ${(log.trim().split('\n').pop() || code)}`);
        try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }); if (response.ok) break; } catch { /* still loading */ }
        if (Date.now() > deadline) { child.kill(); throw new Error('모델을 불러오는 데 너무 오래 걸립니다.'); }
      }
      server = { child, port, model: file }; child.once('exit', () => { if (server?.child === child) server = null; }); touch();
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
  async function translateLines(texts, { modelId, progress = () => {}, status = () => {} } = {}) {
    const model = models().find(item => item.id === modelId) || models().find(item => item.installed);
    if (!model) throw new Error('로컬 AI 모델이 없습니다. 설정 > 자막 자동 번역에서 모델을 받아 주세요.');
    const { port } = await start(model, status);
    const result = new Map(); let next = 0, done = 0, fatal = null;
    progress(0, texts.length);
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (next < texts.length && !fatal) {
        const index = next++, source = texts[index];
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(120000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: prompt(source) }], temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05, max_tokens: 512, stream: false }) });
          if (!response.ok) throw new Error(`llama.cpp HTTP ${response.status}`);
          const text = clean((await response.json())?.choices?.[0]?.message?.content, source); if (text) result.set(index, text);
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
