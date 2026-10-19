// The media element keeps playback, audio and native captions; only its picture is replaced.
(() => {
  const modes = {
    off: '끄기', light: '가볍게', a: 'A · 선명하게', b: 'B · 부드럽게', c: 'C · 노이즈 제거',
    aa: 'A+A · 더 선명하게', bb: 'B+B · 더 부드럽게', ca: 'C+A · 노이즈 제거 후 선명하게', hq: '고화질 (고사양)'
  };
  let video, stage, getAspect, notify, library, renderer, canvas, gl, dimensions;
  let frameId = null, frameKind = null, revision = 0, blocked = false, message = '';
  const mode = () => Object.hasOwn(modes, localStorage.getItem('playerAnime4k')) ? localStorage.getItem('playerAnime4k') : 'off';
  const visible = () => document.body.classList.contains('player-mode');
  function syncUI() {
    document.querySelectorAll('[data-anime4k]').forEach(button => {
      const selected = button.dataset.anime4k === mode();
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    });
    document.querySelector('#psAnime4kStatus').textContent = message || (mode() === 'off' ? '원본 영상으로 재생합니다.' : '영상이 준비되면 적용합니다.');
  }
  function cancelFrame() {
    if (frameId !== null) {
      if (frameKind === 'video') video.cancelVideoFrameCallback(frameId);
      else cancelAnimationFrame(frameId);
    }
    frameId = null;
  }
  function release() {
    revision++; cancelFrame(); stage.classList.remove('anime4k-active');
    try { renderer?.detachSource(); } catch { /* A lost context is already unusable. */ }
    renderer = null; dimensions = null;
    const oldCanvas = canvas, oldGl = gl;
    canvas = null; gl = null;
    oldCanvas?.remove();
    oldGl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  function fail(error) {
    console.warn('Anime4K:', error); blocked = true; release();
    message = 'Anime4K를 적용할 수 없어 원본으로 재생합니다. 다른 모드를 선택해 다시 시도할 수 있어요.';
    syncUI(); notify('Anime4K를 적용하지 못해 원본 영상으로 돌아왔어요.');
  }
  function layout() {
    if (!canvas || !video.videoWidth) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
    const original = getAspect() === 'original';
    const w = original ? video.videoWidth * scale : width, h = original ? video.videoHeight * scale : height;
    Object.assign(canvas.style, { width: `${w}px`, height: `${h}px`, left: `${(width - w) / 2}px`, top: `${(height - h) / 2}px` });
  }
  function createRenderer() {
    canvas = document.createElement('canvas'); canvas.className = 'anime4k-canvas'; canvas.setAttribute('aria-hidden', 'true');
    stage.append(canvas);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault(); if (event.target === canvas) fail(new Error('WebGL context lost'));
    });
    // Preserve the last completed frame for paused playback, PIP and screenshots.
    gl = canvas.getContext('webgl', { premultipliedAlpha: false, stencil: false, depth: false, preserveDrawingBuffer: true });
    if (!gl || !gl.getExtension('OES_texture_float') || !gl.getExtension('OES_texture_float_linear')) throw new Error('Unsupported GPU');
    gl.getExtension('EXT_color_buffer_half_float');
    const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    if (video.videoWidth * 2 > max || video.videoHeight * 2 > max) throw new Error('Video exceeds GPU limits');
    renderer = new library.ImageUpscaler(library.profiles[mode()]);
    renderer.attachSource(video, canvas);
    dimensions = `${video.videoWidth}:${video.videoHeight}`;
    layout();
  }
  function draw() {
    if (!renderer || video.readyState < 2) return false;
    renderer.upscale();
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR || canvas.style.visibility !== 'visible') throw new Error('Unable to render frame');
    stage.classList.add('anime4k-active');
    const status = `${modes[mode()]} 적용 중 · ${canvas.width} × ${canvas.height}`;
    if (message !== status) { message = status; syncUI(); }
    return true;
  }
  function schedule() {
    if (frameId !== null || video.paused || video.ended || !visible() || blocked || mode() === 'off') return;
    const next = () => { frameId = null; refresh(); };
    if (video.requestVideoFrameCallback) { frameKind = 'video'; frameId = video.requestVideoFrameCallback(next); }
    else { frameKind = 'animation'; frameId = requestAnimationFrame(next); }
  }
  async function refresh() {
    if (mode() === 'off' || blocked || !visible() || video.readyState < 2 || !video.videoWidth) return;
    let current = ++revision;
    try {
      library ||= import('./vendor/anime4k/anime4k.mjs');
      const loaded = await library;
      if (current !== revision) return;
      library = loaded;
      if (renderer && dimensions !== `${video.videoWidth}:${video.videoHeight}`) { release(); current = revision; }
      if (!renderer) createRenderer();
      draw(); schedule();
    } catch (error) { if (current === revision) fail(error); }
  }
  function select(value) {
    if (!Object.hasOwn(modes, value)) return;
    release(); blocked = false; message = ''; localStorage.setItem('playerAnime4k', value);
    syncUI(); refresh();
  }
  function frame() {
    if (!renderer || blocked || mode() === 'off') return null;
    try { return draw() ? canvas : null; } catch (error) { fail(error); return null; }
  }
  function init(options) {
    video = document.querySelector('#video'); stage = document.querySelector('#videoStage');
    getAspect = options.getAspect; notify = options.notify;
    document.querySelectorAll('[data-anime4k]').forEach(button => button.addEventListener('click', () => select(button.dataset.anime4k)));
    for (const event of ['loadeddata', 'playing', 'seeked', 'resize']) video.addEventListener(event, refresh);
    for (const event of ['pause', 'ended']) video.addEventListener(event, cancelFrame);
    video.addEventListener('emptied', () => { release(); blocked = false; message = ''; syncUI(); });
    new ResizeObserver(layout).observe(stage);
    new MutationObserver(() => { if (visible()) refresh(); else release(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('pagehide', release);
    syncUI(); refresh();
  }
  window.LilacAnime4K = { init, select, mode, frame, layout, syncUI };
})();
