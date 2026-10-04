// Local subtitle translation (설정 > 자막 자동 번역 > 로컬 AI), like Android's local AI: a GGUF translation model run by
// llama.cpp. llama.cpp's Windows server (the CUDA build on an NVIDIA card, otherwise the Vulkan build, which falls back
// to the CPU without a usable GPU) and the model are downloaded on first use into userData/local-ai; the server listens
// on 127.0.0.1 only while translating and is stopped half a minute after the last line (loading the model again takes
// a few seconds).
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { characterTerms, termsFor } = require('./anime-glossary.cjs');

// Best translation first, by Horimiya episode 1 on a GTX 1050 Ti + Ryzen 5 5600 + 32 GB (16 lines spread over the
// episode, against Gemini): Gemma 4 26B-A4B made no mistake there (12 min); Hy-MT2 7B (10 min) and Gemma 4 E4B (5 min)
// a few slips; Hy-MT2 30B-A3B (7 min) dropped names and used 존댓말 between friends; the 1.8B model (2 min) got about a
// third of the lines wrong. Gemma 4 E4B is the default: good and quick on a small card. Android's choices were HY-MT1.5
// (its default) and the Japanese -> Korean VN model it used before; Hy-MT2 (May 2026) replaced HY-MT1.5, which stays
// listed only where it was downloaded (legacy), so a PC using it keeps working.
const MODELS = [
  // Google's general models in its own 4-bit (QAT) files. The 26B mixture of experts works about 4B per word, so it runs
  // from memory on the processor; E4B fits a 4 GB card nearly whole (42 of 43 layers).
  { id: 'gemma-4-26b-a4b', label: 'Gemma 4 26B-A4B', note: '14.4GB · 가장 정확함 · 램 24GB 이상', repo: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf', file: 'gemma-4-26B_q4_0-it.gguf', size: 14440e6, ram: 24 },
  { id: 'hy-mt2-7b', label: 'Hy-MT2 7B', note: '4.6GB · 정확함 · 그래픽카드 메모리 6GB 이상이면 빠름', repo: 'tencent/Hy-MT2-7B-GGUF', file: 'Hy-MT2-7B-Q4_K_M.gguf', size: 4620e6 },
  { id: 'gemma-4-e4b', label: 'Gemma 4 E4B', note: '기본 · 5.2GB · 빠르고 정확함', repo: 'google/gemma-4-E4B-it-qat-q4_0-gguf', file: 'gemma-4-E4B_q4_0-it.gguf', size: 5150e6 },
  // A mixture of experts: 30B in all but about 3B worked per word, so it runs from memory on the processor.
  { id: 'hy-mt2-30b-a3b', label: 'Hy-MT2 30B-A3B', note: '18GB · 램 24GB 이상', repo: 'tencent/Hy-MT2-30B-A3B-GGUF', file: 'Hy-MT2-30B-A3B-Q4_K_M.gguf', size: 18240e6, ram: 24 },
  { id: 'ja-ko-vn-7b', label: 'ja-ko-vn 7B', note: '4.6GB · 일본어 → 한국어 특화', repo: 'hell0ks/ja-ko-vn-7b-v1-gguf', file: 'model-Q4_K_M.gguf', size: 4630e6 },
  { id: 'hy-mt2-1.8b', label: 'Hy-MT2 1.8B', note: '1.1GB · 가장 빠름 · 가끔 뜻을 틀림', repo: 'tencent/Hy-MT2-1.8B-GGUF', file: 'Hy-MT2-1.8B-Q4_K_M.gguf', size: 1133e6 },
  { id: 'hy-mt-7b', label: 'HY-MT1.5 7B', note: '이전 버전 · Hy-MT2 7B를 권장', repo: 'tencent/HY-MT1.5-7B-GGUF', file: 'HY-MT1.5-7B-Q4_K_M.gguf', size: 4620e6, legacy: true },
  { id: 'hy-mt-1.8b', label: 'HY-MT1.5 1.8B', note: '이전 버전 · Hy-MT2 1.8B를 권장', repo: 'tencent/HY-MT1.5-1.8B-GGUF', file: 'HY-MT1.5-1.8B-Q4_K_M.gguf', size: 1133e6, legacy: true }
];
// llama.cpp builds: Vulkan runs on any graphics card (and falls back to the CPU); the others are made for one maker's
// cards and tried first on them, Vulkan taking over when they do not start or find no card:
// - CUDA (NVIDIA): about 1.5 times faster (GTX 1050 Ti: Hy-MT2 30B-A3B 1.87 → 1.15 s a line, Hy-MT2 1.8B 0.30 →
//   0.20 s). CUDA 13 left out the cards before Turing (compute capability below 7.5) and needs driver 580; CUDA 12 runs
//   those from driver 551.61 but not the RTX 50 cards (12.0).
// - ROCm (AMD Radeon): AMD's HIP. The Windows build (b11375) has code for RDNA 1 to 4 (gfx1010-1012, 1030-1036,
//   1100-1103, 1150-1153, 1200-1201): RX 5000, 6000, 7000 and 9000 cards and the Ryzen graphics of that age (680M,
//   780M, 890M); not the older Polaris (RX 400 / 500) and Vega ones, which go to Vulkan.
// - SYCL, then OpenVINO (Intel Arc): Intel's oneAPI and OpenVINO. OpenVINO picks the processor unless told the card
//   (GGML_OPENVINO_DEVICE=GPU); on a Ryzen + GTX 1050 Ti PC it stopped while loading every model tried.
// device: the line a build prints when it uses its card. Without it a build ran on the processor alone (its library
// for the card did not load, or found no card) and is given up on.
const RUNTIMES = {
  vulkan: { dir: 'runtime', label: 'Vulkan', assets: [/^llama-b\d+-bin-win-vulkan-x64\.zip$/] },
  cuda12: { dir: 'runtime-cuda12', label: 'CUDA', device: /using device CUDA/i, assets: [/^llama-b\d+-bin-win-cuda-12\.[\d.]+-x64\.zip$/, /^cudart-llama-bin-win-cuda-12\.[\d.]+-x64\.zip$/] },
  cuda13: { dir: 'runtime-cuda13', label: 'CUDA', device: /using device CUDA/i, assets: [/^llama-b\d+-bin-win-cuda-13\.[\d.]+-x64\.zip$/, /^cudart-llama-bin-win-cuda-13\.[\d.]+-x64\.zip$/] },
  rocm: { dir: 'runtime-rocm', label: 'ROCm', device: /using device ROCm/i, assets: [/^llama-b\d+-bin-win-rocm-[\d.]+-x64\.zip$/] },
  sycl: { dir: 'runtime-sycl', label: 'SYCL', device: /using device SYCL/i, assets: [/^llama-b\d+-bin-win-sycl-x64\.zip$/] },
  openvino: { dir: 'runtime-openvino', label: 'OpenVINO', device: /using device OPENVINO\d+ \(GGML_OPENVINO_DEVICE=GPU/i, env: { GGML_OPENVINO_DEVICE: 'GPU' }, assets: [/^llama-b\d+-bin-win-openvino-[\d.]+-x64\.zip$/] }
};
const PARALLEL = 4, IDLE_STOP = 30 * 1000;
// One line at a time. HY-MT1.5 gets its own prompt and no previous lines (as context, Android's prompt or HY-MT1.5's
// contextual one, they made the 1.8B model translate the context instead of the line in about a third of short lines),
// but HY-MT's terminology list with the names and set phrases found in the line (anime-glossary): without it 真昼 came
// out as 정오 (noon), 周くん as 주군 and いただきます as 감사합니다. Its Chinese "translate into Korean" prompt left
// Japanese words in, so the English one follows the list. Other models get the list in English.
// Each model is asked the way its model card says:
// - HY-MT1.5: the prompt above, sampling 0.7 / top-p 0.6 / top-k 20 / repeat 1.05.
// - Hy-MT2: its own wording ("Translate the following text into …") and English terminology list; the 30B-A3B model
//   samples with top-p 1 and no top-k or repeat penalty. The 1.8B and 7B models also get the two lines before as
//   [Background Information] (Hy-MT2's contextual prompt): on Horimiya the 1.8B model then kept friends' talk in 반말
//   more often (polite endings 18 → 14 of 60 lines) for a quarter more time; the 30B-A3B model, already right without
//   it, only got slower (67 → 123 s), so it has none.
// - ja-ko-vn: trained on the Japanese line alone (no instruction: its chat template adds one), names as a system
//   message "岡部倫太郎=오카베 린타로,…" (the template turns it into a terminology turn), temperature 0.1, top-p 0.9.
// - Gemma 4: a general model, told what it does in a system message, with the terminology list and the two lines
//   before (as context only); its model card's sampling (temperature 1, top-p 0.95, top-k 64) and its thinking off
//   (Gemma 4's template turns it on with enable_thinking; Android's adapter keeps it off too).
// - Anything else (Qwen3 Instruct and other chat models): the instruction with the list in English, Qwen's sampling.
const INSTRUCTION = 'Translate the following segment into Korean, without additional explanation.';
const HY_MT2_INSTRUCTION = 'Translate the following text into Korean. Note that you should only output the translated result without any additional explanation:';
// cast: the work's main characters ("堀京子 = 호리 쿄코 (female)"), for Gemma, which can tell from them who says 형 or 오빠.
function request(source, terms, kind, before = [], cast = []) {
  const user = content => [{ role: 'user', content }];
  if (kind === 'jako') return { messages: [...(terms.length ? [{ role: 'system', content: terms.map(term => `${term.ja}=${term.ko}`).join(',') }] : []), { role: 'user', content: source }], temperature: 0.1, top_p: 0.9, repeat_penalty: 1.05 };
  if (kind === 'hy-mt2' || kind === 'hy-mt2-moe') {
    const sampling = kind === 'hy-mt2-moe' ? { temperature: 0.7, top_p: 1, top_k: 0, repeat_penalty: 1 } : { temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05 };
    const reference = terms.length ? `Reference the following translations:\n${terms.map(term => `${term.ja} translates to ${term.ko}`).join('\n')}\n\n` : '';
    if (kind === 'hy-mt2' && before.length) return { messages: user(`[Background Information]\n${before.join('\n')}\n\n${reference}Please translate the following text into Korean, taking the provided background information into consideration.\n\n[Source Text]\n${source}`), ...sampling };
    return { messages: user(`${reference}${HY_MT2_INSTRUCTION}\n\n${source}`), ...sampling };
  }
  if (kind === 'gemma') {
    const parts = [...(terms.length ? [`Names and terms (use these Korean spellings):\n${terms.map(term => `${term.ja} = ${term.ko}`).join('\n')}`] : []), ...(before.length ? [`Previous lines (context only, do not translate them):\n${before.join('\n')}`] : []), `Translate this line:\n${source}`];
    const system = [
      'You translate Japanese anime subtitles into natural spoken Korean, keeping each speaker\'s tone (반말 or 존댓말 as the scene calls for).',
      'Words for family follow the speaker: お兄ちゃん / 兄さん → 형 from a boy, 오빠 from a girl; お姉ちゃん / 姉さん → 누나 from a boy, 언니 from a girl.',
      'A speaker\'s name or a sound in brackets at the start stays in brackets, translated: （創太） → (소타), （ため息） → (한숨). Keep the line breaks.',
      ...(cast.length ? [`Main characters (Japanese name = Korean spelling, gender):\n${cast.join('\n')}`] : []),
      'Answer with the Korean line only: no notes, quotes or romanization.'
    ].join('\n');
    return { messages: [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }], temperature: 0.3, top_p: 0.95, top_k: 64, chat_template_kwargs: { enable_thinking: false } };
  }
  if (kind === 'hy-mt') return { messages: user(terms.length ? `参考下面的翻译：\n${terms.map(term => `${term.ja} 翻译成 ${term.ko}`).join('\n')}\n\n${INSTRUCTION}\n\n${source}` : `${INSTRUCTION}\n\n${source}`), temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05 };
  return { messages: user(terms.length ? `This is a line from a Japanese anime. Use these Korean translations:\n${terms.map(term => `${term.ja} = ${term.ko}`).join('\n')}\n\n${INSTRUCTION}\n\n${source}` : `${INSTRUCTION}\n\n${source}`), temperature: 0.7, top_p: 0.8, top_k: 20, repeat_penalty: 1.05 };
}
// Which way to ask: by the model's name, or for a file the user added (ja-ko-vn 12B ships as "model-Q4_K_M.gguf" too)
// by the chat template llama.cpp read from it.
function modelKind(model, template = '') {
  const name = `${model.id} ${model.file || ''} ${model.label}`;
  if (/ja-ko-vn|jako/i.test(name) || /일한 번역가|고유명사 및 용어 규칙/.test(template)) return 'jako';
  if (/gemma-?4/i.test(name) || /<\|turn>/.test(template)) return 'gemma';
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
  // ram: the memory (GB) a model needs, which is read into memory whole; lowMemory when this PC has less (the
  // settings warn before it is downloaded or used).
  const memory = Math.round(os.totalmem() / 2 ** 30);
  const models = () => {
    const ran = runs();
    return [...MODELS, ...added().map(item => ({ id: `file:${item.path}`, label: path.basename(item.path), note: '직접 추가한 파일', path: item.path, size: item.size }))]
      .map(model => ({ ...model, installed: fs.existsSync(modelPath(model)), downloading: downloads.has(model.id) ? { done: downloads.get(model.id).done, total: downloads.get(model.id).total } : null, partial: !model.path && !downloads.has(model.id) ? partialSize(model) : 0, run: ran[modelPath(model)] || null, ...(model.ram ? { memory, lowMemory: memory < model.ram } : {}) }))
      .filter(model => !model.legacy || model.installed);
  };
  const partialSize = model => { try { return fs.statSync(`${modelPath(model)}.part`).size; } catch { return 0; } };
  function addFile(file) {
    if (!/\.gguf$/i.test(file) || !fs.existsSync(file)) throw new Error('GGUF 파일을 골라 주세요.');
    const list = added().filter(item => item.path !== file); list.push({ path: file, size: fs.statSync(file).size });
    fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(addedFile, JSON.stringify(list)); return `file:${file}`;
  }
  const runtimeExe = kind => {
    const walk = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]); } catch { return []; } };
    return walk(path.join(root, RUNTIMES[kind].dir)).find(file => path.basename(file).toLowerCase() === 'llama-server.exe') || null;
  };
  // The builds for this PC, best first: CUDA for an NVIDIA card nvidia-smi reports (with a driver new enough for it),
  // ROCm for an AMD Radeon RX / PRO card, SYCL then OpenVINO for an Intel Arc one, Vulkan last; a build that failed here
  // with the same driver is left out (a newer driver gets another try).
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
  // The other cards Windows knows (name and driver version), for AMD and Intel.
  let cardsInfo = null;
  function videoCards() {
    cardsInfo ||= new Promise(resolve => {
      if (process.platform !== 'win32') { resolve([]); return; }
      let out = ''; const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress'], { windowsHide: true });
      child.stdout.on('data', chunk => { out += chunk; }); child.once('error', () => resolve([]));
      child.once('close', () => { try { const value = JSON.parse(out); resolve((Array.isArray(value) ? value : [value]).filter(Boolean).map(card => ({ name: String(card.Name || ''), driver: String(card.DriverVersion || '') }))); } catch { resolve([]); } });
    });
    return cardsInfo;
  }
  async function preferredRuntimes() {
    const gpu = await nvidiaGpu(), off = broken(), list = [];
    let driver = gpu?.driver;
    if (gpu) list.push(gpu.cap >= 7.5 && gpu.driver >= 580 ? 'cuda13' : gpu.cap >= 5 && gpu.cap < 10 && gpu.driver >= 551.61 ? 'cuda12' : null);
    else {
      const cards = await videoCards(), amd = cards.find(card => /radeon/i.test(card.name) && !/\brx\s*[45]\d0\b|vega|radeon vii|\br[579]\b|\bhd\s*\d/i.test(card.name)), arc = cards.find(card => /intel/i.test(card.name) && /\barc\b/i.test(card.name));
      if (amd) { list.push('rocm'); driver = amd.driver; } else if (arc) { list.push('sycl', 'openvino'); driver = arc.driver; }
    }
    // (A mark from before checks were counted (check 2) may be a CUDA build wrongly given up on a large model: not kept.)
    return [...list.filter(kind => kind && !(off[kind] && off[kind].driver === driver && off[kind].check === 2)), 'vulkan'];
  }
  async function cardDriver(kind) { return kind.startsWith('cuda') ? (await nvidiaGpu())?.driver || 0 : (await videoCards()).find(card => kind === 'rocm' ? /radeon/i.test(card.name) : /intel/i.test(card.name))?.driver || ''; }

  // Into target.part first: a download cut short (network, the app closed, cancelled) keeps what came and goes on
  // from there the next time (an HTTP range request); one that ends short of its length is not taken as the file.
  async function download(url, target, progress, signal = null) {
    const partial = `${target}.part`;
    let have = 0; try { have = fs.statSync(partial).size; } catch { /* nothing yet */ }
    const response = await fetch(url, { headers: { 'User-Agent': 'LilacAnime-Desktop', ...(have ? { Range: `bytes=${have}-` } : {}) }, redirect: 'follow', signal });
    // Nothing left to send for that range (the kept part is stale or already whole): it starts over.
    if (have && response.status === 416) { try { fs.unlinkSync(partial); } catch {} return download(url, target, progress, signal); }
    if (!response.ok || !response.body) throw new Error(`다운로드 HTTP ${response.status}`);
    if (response.status !== 206) have = 0;
    const total = (Number(response.headers.get('content-length')) || 0) + have;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = fs.createWriteStream(partial, { flags: have ? 'a' : 'w' }); let done = have, last = 0;
    try {
      for await (const chunk of response.body) {
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
        done += chunk.length; if (Date.now() - last > 500) { last = Date.now(); progress(done, total); }
      }
      await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
    } catch (error) { out.destroy(); throw error; }
    if (total > have && done !== total) throw new Error(`다운로드가 중간에 끊겼습니다 (${Math.round(done / total * 100)}%). 다시 받으면 이어서 받습니다.`);
    fs.renameSync(partial, target); progress(done, total || done);
  }
  // The newest llama.cpp release that has every file of the build (CUDA: the program and the CUDA runtime it needs),
  // unpacked into a folder next to the target and moved in once every file is there (a download cut short leaves no
  // half build behind). The release's tag and when it was checked are kept with the build.
  const buildFile = dir => path.join(dir, 'lilac-build.json');
  const buildOf = kind => { try { return JSON.parse(fs.readFileSync(buildFile(path.join(root, RUNTIMES[kind].dir)), 'utf8')) || {}; } catch { return {}; } };
  async function latestRuntime(kind) {
    const releases = await (await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8', { headers: { 'User-Agent': 'LilacAnime-Desktop', Accept: 'application/vnd.github+json' } })).json();
    for (const release of Array.isArray(releases) ? releases : []) {
      const assets = RUNTIMES[kind].assets.map(pattern => (release.assets || []).find(item => pattern.test(item.name)));
      if (assets.every(Boolean)) return { tag: release.tag_name, assets };
    }
    throw new Error('llama.cpp 실행 파일을 찾지 못했습니다.');
  }
  // Unpacked by Windows' own tar (bsdtar reads zip) in its own process: done here a build's 1 GB DLL (ROCm) kept the
  // app from answering for 5 seconds and more, long enough for Windows to call it not responding. adm-zip (here, in
  // one go) only where there is no tar.exe (Windows 10 before 1803).
  function unzip(zip, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (process.platform !== 'win32' || !fs.existsSync(tar)) return Promise.resolve().then(() => new AdmZip(zip).extractAllTo(dir, true));
    return new Promise((resolve, reject) => {
      let error = ''; const child = spawn(tar, ['-xf', zip, '-C', dir], { windowsHide: true });
      child.stderr.on('data', chunk => { error += chunk; }); child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`llama.cpp 압축을 풀지 못했습니다: ${error.trim().slice(0, 200) || code}`)));
    });
  }
  async function installRuntime(kind, target, progress = () => {}, latest = null) {
    const { tag, assets } = latest || await latestRuntime(kind);
    const total = assets.reduce((sum, asset) => sum + (asset.size || 0), 0), unpacked = `${target}.part`; let before = 0;
    fs.rmSync(unpacked, { recursive: true, force: true });
    for (const asset of assets) {
      const zip = path.join(root, asset.name);
      await download(asset.browser_download_url, zip, done => progress(before + done, total));
      try { await unzip(zip, unpacked); } finally { try { fs.unlinkSync(zip); } catch {} }
      before += asset.size || 0;
    }
    fs.writeFileSync(buildFile(unpacked), JSON.stringify({ tag, checked: Date.now() }));
    fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(unpacked, target);
  }
  const installing = new Map(); // build -> download
  function ensureRuntime(kind, progress = () => {}) {
    const existing = runtimeExe(kind); if (existing) return Promise.resolve(existing);
    if (!installing.has(kind)) installing.set(kind, (async () => {
      await installRuntime(kind, path.join(root, RUNTIMES[kind].dir), progress);
      const exe = runtimeExe(kind); if (!exe) throw new Error('llama.cpp 실행 파일을 풀지 못했습니다.'); return exe;
    })().finally(() => installing.delete(kind)));
    return installing.get(kind);
  }
  // A build is checked against the newest release once a month: a newer one is downloaded next to it in the
  // background (target.next) and put in place the next time llama.cpp starts, while it is not running (its files are
  // in use until then). update() does the same at once, for a model this build cannot read.
  const MONTH = 30 * 24 * 60 * 60 * 1000, updating = new Map();
  function update(kind, force = false) {
    const target = path.join(root, RUNTIMES[kind].dir), build = buildOf(kind);
    // A build from before builds were dated counts as checked now, rather than being downloaded again at once.
    if (!build.checked && !force) { try { fs.writeFileSync(buildFile(target), JSON.stringify({ checked: Date.now() })); } catch {} return Promise.resolve(); }
    if (!updating.has(kind) && (force || Date.now() - build.checked > MONTH)) updating.set(kind, (async () => {
      const latest = await latestRuntime(kind);
      try { fs.writeFileSync(buildFile(target), JSON.stringify({ ...buildOf(kind), checked: Date.now() })); } catch { /* checked again next time */ }
      if (latest.tag !== build.tag) await installRuntime(kind, `${target}.next`, () => {}, latest);
    })().catch(() => {}).finally(() => updating.delete(kind)));
    return updating.get(kind) || Promise.resolve();
  }
  function swapInUpdate(kind) {
    const target = path.join(root, RUNTIMES[kind].dir), next = `${target}.next`, old = `${target}.old`;
    if (!fs.existsSync(buildFile(next))) return false;
    try { fs.rmSync(old, { recursive: true, force: true }); fs.renameSync(target, old); } catch { return false; }
    try { fs.renameSync(next, target); } catch { try { fs.renameSync(old, target); } catch {} return false; }
    fs.rmSync(old, { recursive: true, force: true });
    return true;
  }
  // The build to start now: the best one for this PC when it is on disk. When it is not but the Vulkan build is, Vulkan
  // runs this time and the best one comes down meanwhile; with neither, the best one is downloaded first (the next one
  // if that fails).
  async function runtimeFor(status) {
    const percent = (done, total) => total ? Math.round(done / total * 100) : 0;
    for (const kind of await preferredRuntimes()) {
      swapInUpdate(kind);
      if (runtimeExe(kind)) { update(kind); return { kind, exe: runtimeExe(kind) }; }
      if (kind !== 'vulkan' && runtimeExe('vulkan')) {
        ensureRuntime(kind).catch(() => {});
        status(`다음 번역부터 쓸 llama.cpp(${RUNTIMES[kind].label})를 받는 중이라 이번엔 Vulkan으로 번역`);
        return { kind: 'vulkan', exe: runtimeExe('vulkan') };
      }
      try { return { kind, exe: await ensureRuntime(kind, (done, total) => status(`llama.cpp(${RUNTIMES[kind].label}) 받는 중 ${percent(done, total)}%`)) }; }
      catch (error) { if (kind === 'vulkan') throw error; }
    }
    throw new Error('llama.cpp 실행 파일을 찾지 못했습니다.');
  }
  async function installModel(id, progress = () => {}) {
    const model = MODELS.find(item => item.id === id); if (!model) throw new Error('모델을 찾지 못했습니다.');
    if (downloads.has(id)) throw new Error('이미 받는 중입니다.');
    const abort = new AbortController();
    downloads.set(id, { done: 0, total: model.size, abort });
    try {
      await download(`https://huggingface.co/${model.repo}/resolve/main/${encodeURIComponent(model.file)}?download=true`, modelPath(model), (done, total) => { downloads.set(id, { done, total: total || model.size, abort }); progress(done, total || model.size); }, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) throw Object.assign(new Error('받기를 멈췄습니다. 다시 받으면 이어서 받습니다.'), { cancelled: true });
      throw error;
    } finally { downloads.delete(id); }
  }
  // Stops a model download; what came stays for the next try.
  function cancelInstall(id) { downloads.get(id)?.abort.abort(); }
  function removeModel(id) {
    const model = models().find(item => item.id === id); if (!model) return;
    if (model.path) { fs.writeFileSync(addedFile, JSON.stringify(added().filter(item => item.path !== model.path))); return; }
    if (server?.model === modelPath(model)) stop();
    for (const file of [modelPath(model), `${modelPath(model)}.part`]) try { fs.unlinkSync(file); } catch {}
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
        const child = spawn(exe, ['-m', file, '--host', '127.0.0.1', '--port', String(port), '-c', '4096', '-np', String(PARALLEL), '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--fit-target', '512', ...extra, '--jinja', '--no-webui', '-lv', '4'], { cwd: path.dirname(exe), windowsHide: true, env: { ...process.env, LLAMA_ARG_LOAD_MODE: 'none', LLAMA_ARG_NO_MMAP: '1', ...RUNTIMES[kind].env } });
        try { fs.writeFileSync(pidFile, String(child.pid)); } catch {}
        // The model file is read rather than memory-mapped: on Windows a mapped file stays in RAM whole even with every
        // layer on the graphics card (1.4 GB for the 1.8B model, 0.3 GB read; 5.2 GB against 2.7 GB for ja-ko-vn on a
        // 4 GB card). Set through the environment, which a llama.cpp without the option (load mode is newer than
        // no-mmap) ignores instead of refusing to start.
        // The device and layer count are read as the model loads (-lv 4 prints them).
        // They are looked for in the output as it comes, before only its end is kept: a large model prints so much while it
        // loads that the device line is gone from the last 8000 characters by the time the server answers.
        let log = '', device = '', onCard = false, layers = 0, total = 0;
        const keep = chunk => {
          const text = log + chunk.toString();
          device ||= text.match(/using device \S+ \(([^)]+)\)/)?.[1] || '';
          onCard ||= Boolean(RUNTIMES[kind].device?.test(text));
          const offloaded = text.match(/offloaded (\d+)\/(\d+) layers to GPU/); if (offloaded) { layers = Number(offloaded[1]); total = Number(offloaded[2]); }
          log = text.slice(-8000);
        };
        child.stdout.on('data', keep); child.stderr.on('data', keep);
        const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
        // A maker's build turns its code for the card into the card's own the first time it runs (SYCL always, CUDA on
        // cards before the RTX 30), which the driver keeps for the next times; on a slow card it can take minutes. So
        // the first run of a build with a driver gets 15 minutes instead of 3 before it is given up (and marked).
        const driver = kind === 'vulkan' ? '' : String(await cardDriver(kind)), first = kind !== 'vulkan' && buildOf(kind).ran !== driver;
        const begun = Date.now(), deadline = begun + (first ? 900000 : 180000);
        let told = false;
        for (;;) {
          const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(undefined), 500))]);
          if (code !== undefined) {
            const memory = /OutOfDeviceMemory|unable to allocate|failed to allocate|out of memory/i.test(log);
            const error = new Error(memory ? '그래픽카드 메모리가 부족해 모델을 불러오지 못했습니다. 더 작은 모델(Hy-MT2 1.8B)을 써 보세요.' : `llama.cpp가 종료되었습니다: ${log.trim().split('\n').filter(line => / E /.test(line)).pop() || log.trim().split('\n').pop() || code}`);
            error.memory = memory; throw error;
          }
          let ready = false;
          try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* still loading */ }
          // Without a graphics card in use llama.cpp still reports the layers as offloaded, so they count only with a
          // device. A maker's build that found none (its library for the card did not load) would run on the CPU alone:
          // it is given up for the next build instead.
          if (ready && kind !== 'vulkan' && !onCard) { child.kill(); throw new Error(`llama.cpp(${RUNTIMES[kind].label})가 그래픽카드를 쓰지 못했습니다.`); }
          if (ready) {
            if (first) try { fs.writeFileSync(buildFile(path.join(root, RUNTIMES[kind].dir)), JSON.stringify({ ...buildOf(kind), ran: driver })); } catch {}
            return { child, port, device, layers: device ? layers : 0, total };
          }
          if (Date.now() > deadline) { child.kill(); throw new Error('모델을 불러오는 데 너무 오래 걸립니다.'); }
          if (first && !told && Date.now() - begun > 20000) { told = true; status(`llama.cpp(${RUNTIMES[kind].label})를 처음 실행해 그래픽카드에 맞게 준비하는 중 (몇 분 걸릴 수 있어요)`); }
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
      while (!started) {
        try { started = await load(); }
        catch (failure) {
          let error = failure;
          // A model newer than the build (an architecture it does not know): the newest build, then one more try.
          if (/unknown model architecture/i.test(error.message)) {
            status('이 모델을 읽으려면 llama.cpp 새 버전이 필요해 받는 중');
            await update(kind, true);
            if (swapInUpdate(kind)) { exe = runtimeExe(kind); try { started = await load(); error = null; } catch (again) { error = again; } }
          }
          if (!error) break;
          // A maker's build that does not start on this PC (a driver or card it does not support) is not tried again
          // with this driver; the next build for the PC takes over (Vulkan in the end).
          if (kind === 'vulkan' || error.memory) throw error;
          try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(brokenFile, JSON.stringify({ ...broken(), [kind]: { driver: await cardDriver(kind), check: 2, error: error.message.slice(0, 300) } })); } catch {}
          status(`llama.cpp(${RUNTIMES[kind].label})가 실행되지 않아 다른 판으로 다시 불러오는 중`);
          ({ kind, exe } = await runtimeFor(status));
        }
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
  // lines are left out, so the caller keeps the original text); onLine(index, text) hears each one as it is done.
  // context: the work's {characters} from AniList, for the names in the terminology list.
  async function translateLines(texts, { modelId, progress = () => {}, status = () => {}, onLine = () => {}, context = {}, signal = null } = {}) {
    const model = models().find(item => item.id === modelId) || models().find(item => item.installed);
    if (!model) throw new Error('로컬 AI 모델이 없습니다. 설정 > 자막 자동 번역에서 모델을 받아 주세요.');
    const { port, template } = await start(model, status);
    const names = characterTerms(context.characters || []), kind = modelKind(model, template);
    const cast = (context.characters || []).slice(0, 15).map(character => { const full = names.find(term => term.ja === String(character.native || '').trim()); return full ? `${full.ja} = ${full.ko}${/^(?:male|female)$/i.test(character.gender) ? ` (${character.gender.toLowerCase()})` : ''}` : ''; }).filter(Boolean);
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
      // A cancelled run takes no new line; the four being written finish (a few seconds).
      while (next < texts.length && !fatal && !signal?.aborted) {
        const index = next++, source = texts[index], body = request(source, termsFor(source, names), kind, texts.slice(Math.max(0, index - 2), index), cast);
        try {
          // A Japanese word left in the answer (えっ, 先輩) is asked again, twice at most. ja-ko-vn's temperature of 0.1
          // would give the same answer again, so its second and third tries are less certain.
          let text = '';
          for (let attempt = 0; attempt < 3; attempt++) { text = clean(await ask(attempt && kind === 'jako' ? { ...body, temperature: 0.5 } : body, source), source); if (text && !KANA.test(text)) break; }
          if (text) { result.set(index, text); onLine(index, text); }
        } catch (error) { if (!server) fatal = error; }
        touch(); progress(++done, texts.length);
      }
    }));
    if (fatal && !result.size) throw fatal;
    return { translations: result, model };
  }

  return { models, installModel, cancelInstall, removeModel, addFile, translateLines, stop, modelPath };
}

// The prompt a model is asked with, as part of the translation cache key (a changed prompt is not hidden behind
// translations made with the old one).
const promptVersion = model => !model ? '' : modelKind(model) === 'hy-mt2' ? '+context-1' : modelKind(model) === 'gemma' ? '+gemma-3' : '';

module.exports = { createLocalAi, LOCAL_AI_MODELS: MODELS, promptVersion };
