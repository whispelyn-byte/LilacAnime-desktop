// 이어서 보기 미리보기: resting the pointer on a card of 이어서 보기 plays the episode, muted, in the card's picture from
// where it was left (as Netflix's rows do). A downloaded episode plays from its file at once; an online one has its
// stream found first (as 다음 화 미리 준비 finds the next episode's), and that stream is kept for the click that follows,
// so the episode then opens without being looked for again.
// - Only after the pointer has rested on the card (REST ms): sweeping across the row asks no site for anything.
// - Never while the player is open or a video is playing, and one card at a time.
// - Miruro's and 애니24's streams need their own request headers, which the main process holds for one stream at a time
//   (the player's): they are previewed only while the player has nothing loaded.
// - Off with 설정 > 이어서 보기 미리보기 (localStorage continuePreview = 'false').
const continuePreview = (() => {
  const REST = 600, KEEP = 10 * 60000, LONGEST = 120000;
  const streams = new Map();
  let active = null;
  const enabled = () => { try { return localStorage.getItem('continuePreview') !== 'false'; } catch { return true; } };
  const playerBusy = () => { const video = $('#video'); return $('.view.active')?.id === 'playerView' || Boolean(video && video.currentSrc && !video.paused && !video.ended); };
  const playerLoaded = () => Boolean((typeof hlsPlayer !== 'undefined' && hlsPlayer) || $('#video')?.currentSrc);
  const isHls = stream => /\.m3u8(?:$|\?)/i.test(stream.url) || /\/__flix\//i.test(stream.url) || Boolean(stream.hls);
  // Where the episode was left, in seconds of a video this long (from the start once it is nearly over, as play() does).
  function resumeAt(item, duration) {
    const progress = Number(item.progress) || 0;
    return Number.isFinite(duration) && duration > 0 && progress > 0 && progress < 95 ? Math.max(0, duration * progress / 100 - 1) : 0;
  }
  // The stream of a history entry: {url, hls?, headers?, own?} or null when it has no address to play (an entry from
  // the phone without one). own: a file on this PC or a plain address, nothing was asked of a site.
  async function streamFor(item) {
    const key = item.key || item.src, kept = streams.get(key);
    if (kept && Date.now() - kept.time < KEEP) return kept.stream;
    const episode = item.episode; let stream = null;
    if (!episode) { if (/^(?:file|https?):/i.test(item.src || '')) stream = { url: item.src, own: true }; }
    else {
      const job = jobByRef(episodeRef(episode));
      if (job?.status === 'completed' && !job.missing) stream = { ...await window.lilac.playDownload(job.id), own: true };
      else if (episode.url || episode.token) {
        if (['miruro', 'ohli24'].includes(episode.provider) && playerLoaded()) return null;
        const linkkf = (item.resolveKind || (item.anime?.provider === 'linkkf' ? 'linkkf' : '')) === 'linkkf';
        stream = await window.lilac.prepareEpisodeStream(linkkf ? { ...episode, resolveKind: 'linkkf' } : episode);
        // Kept for the player (resolveIntoPlayer plays a stream made ready when it still answers). Animenosub and Miruro
        // pick their video server by the subtitle found when the episode is played, so theirs is found again then.
        if (stream?.url && !['animenosub', 'miruro'].includes(episode.provider)) preparedStreams.set(episodeRef(episode), stream);
      }
    }
    if (!stream?.url) return null;
    streams.set(key, { time: Date.now(), stream }); if (streams.size > 12) streams.delete(streams.keys().next().value);
    return stream;
  }
  function stop() {
    const preview = active; if (!preview) return; active = null;
    clearTimeout(preview.timer); clearTimeout(preview.limit);
    preview.hls?.destroy();
    if (preview.video) { preview.video.pause(); preview.video.removeAttribute('src'); preview.video.load(); preview.video.remove(); }
    preview.card.classList.remove('previewing', 'preview-loading');
  }
  function show(preview, item, stream) {
    const thumb = preview.card.querySelector('.continue-thumb'); if (!thumb) return stop();
    const video = preview.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, preload: 'auto', disablePictureInPicture: true });
    video.className = 'continue-preview'; video.setAttribute('aria-hidden', 'true'); video.tabIndex = -1;
    const mine = () => active === preview;
    video.addEventListener('loadedmetadata', () => { if (!mine()) return; const at = resumeAt(item, video.duration); if (at > 0) video.currentTime = at; video.play().catch(() => {}); }, { once: true });
    video.addEventListener('playing', () => { if (mine()) { preview.card.classList.remove('preview-loading'); preview.card.classList.add('previewing'); } }, { once: true });
    video.addEventListener('error', () => { if (mine()) stop(); });
    video.addEventListener('ended', () => { if (mine()) stop(); });
    thumb.prepend(video);
    if (isHls(stream) && window.Hls?.isSupported()) {
      const hls = preview.hls = new Hls({
        enableWorker: true, capLevelToPlayerSize: true, startLevel: 0, maxBufferLength: 10, maxMaxBufferLength: 15, backBufferLength: 0, maxBufferSize: 24 * 1024 * 1024,
        manifestLoadingTimeOut: 15000, levelLoadingTimeOut: 15000, fragLoadingTimeOut: 20000, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2,
        // The local proxy is told this is a preview, as for the seek bar's pictures: it does not fetch ahead for it.
        xhrSetup: (xhr, url) => { if (/^http:\/\/127\.0\.0\.1:\d+\/__flix\//i.test(url)) xhr.open('GET', `${url}${url.includes('?') ? '&' : '?'}lilac-preview=1`, true); }
      });
      let recovered = false;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal || !mine()) return;
        // A segment that does not start on a keyframe can refuse to play from the middle: once from the start instead.
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); if (video.currentTime > 0) video.currentTime = 0; return; }
        stop();
      });
      hls.loadSource(stream.url); hls.attachMedia(video);
    } else video.src = stream.url;
    // Not left running for good on a card the pointer was parked on.
    preview.limit = setTimeout(() => { if (mine()) stop(); }, LONGEST);
  }
  function rest(card, item) {
    if (!enabled() || playerBusy() || active?.card === card) return;
    stop();
    const preview = active = { card, video: null, hls: null, timer: 0, limit: 0 };
    preview.timer = setTimeout(async () => {
      if (active !== preview || playerBusy() || !card.isConnected) return stop();
      card.classList.add('preview-loading');
      let stream = null; try { stream = await streamFor(item); } catch { stream = null; }
      if (active !== preview) return;
      if (!stream || playerBusy() || !card.isConnected) return stop();
      // Miruro's and 애니24's headers go with the stream now (nothing else is loaded, see streamFor).
      if (!stream.own && ['miruro', 'ohli24'].includes(item.episode?.provider)) { await window.lilac.useEpisodeStream(item.episode, stream).catch(() => {}); if (active !== preview) return; }
      show(preview, item, stream);
    }, REST);
  }
  function attach(card, item) {
    card.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') rest(card, item); });
    card.addEventListener('pointerleave', () => { if (active?.card === card) stop(); });
    // Playing the episode (or opening its episode list) ends the preview first; its stream stays for the player.
    card.addEventListener('click', () => { if (active?.card === card) stop(); }, true);
  }
  // Whatever takes the page elsewhere ends it: another view, the window hidden, the player starting.
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('blur', stop);
  document.querySelector('#video')?.addEventListener('play', stop);
  // The pointer anywhere but on the card (the page changed under it, a dialog opened) ends it as leaving the card does.
  document.addEventListener('pointermove', event => { if (active && !active.card.contains(event.target)) stop(); });
  // 설정 > 이어서 보기 미리보기
  const toggle = document.querySelector('#continuePreview');
  if (toggle) { toggle.checked = enabled(); toggle.addEventListener('change', () => { try { localStorage.setItem('continuePreview', String(toggle.checked)); } catch {} if (!toggle.checked) stop(); }); }
  return { attach, stop, resumeAt, enabled };
})();
