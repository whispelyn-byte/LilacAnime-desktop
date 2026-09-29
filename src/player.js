// Android PlayerScreen port: in-player settings menu, previous/next episode buttons, screen lock,
// OP/ED auto skip, autoplay toggle and remote-style (TV) keyboard control. Loaded after app.js and
// shares its globals ($, currentPlaybackContext, hlsPlayer, ...).

// Android PlayerSettings defaults: autoPlay, showChapterSkipButton, autoSkip and vttStyleEnabled are on.
function playerFlag(key, fallback = true) { const value = localStorage.getItem(key); return value === null ? fallback : value !== 'false'; }
let playerLocked = false, unlockTimer = null, usingKeyboard = false;
// Focus is only moved into menus for keyboard/remote users; mouse users would just see a stray focus ring.
window.addEventListener('keydown', () => { usingKeyboard = true; }, true);
window.addEventListener('pointerdown', () => { usingKeyboard = false; }, true);
const autoSkipState = { enteredKey: null, enteredAt: 0, skippedKey: null };

function playerSettingsOpen() { return $('#playerSettings').classList.contains('open'); }
function openPlayerSettings(open, focusSection = null) {
  const panel = $('#playerSettings');
  panel.classList.toggle('open', open); panel.setAttribute('aria-hidden', String(!open));
  $('#playerSettingsButton').setAttribute('aria-expanded', String(open));
  if (open) {
    syncPlayerSettingsUI();
    if (focusSection) focusSection.scrollIntoView({ block: 'start' });
    if (usingKeyboard) (focusSection?.querySelector('input,button') || panel.querySelector('.ps-body input,.ps-body button'))?.focus({ preventScroll: true });
  }
  showPlayerControls();
}

// Mirrors the settings page so both edit the same stored values.
function syncPlayerSettingsUI() {
  $('#psAutoPlay').checked = playerFlag('playerAutoPlay');
  $('#psSkipButton').checked = playerFlag('playerSkipButton');
  $('#psAutoSkip').checked = playerFlag('playerAutoSkip');
  $('#assEffectsHint').textContent = assEffectsEnabled() ? '원본 위치·색상·효과를 유지합니다' : '효과를 단순화해 성능을 우선합니다';
  const source = localStorage.getItem('subtitleSource') || 'linkkf';
  $$('#psSubtitleSources button').forEach(button => button.classList.toggle('selected', button.dataset.source === source));
  const size = Number(localStorage.getItem('subtitleSize') || 100), position = Number(localStorage.getItem('subtitlePosition') || 10), outline = Number(localStorage.getItem('vttOutline') || 2), sync = Number(localStorage.getItem('subtitleSync') || 0);
  $('#psSubtitleSize').value = String(size); $('#psSizeLabel').textContent = `${size}%`;
  $('#psSubtitlePosition').value = String(position); $('#psPositionLabel').textContent = `${position}%`;
  $('#psVttOutline').value = String(outline); $('#psOutlineLabel').textContent = `${outline.toFixed(1)}px`;
  $('#psSyncLabel').textContent = `${sync}ms`;
  $('#psVttStyle').checked = playerFlag('vttStyle');
  $('#psVttBold').checked = localStorage.getItem('vttBold') !== 'false';
  const fontFile = localStorage.getItem('subtitleFontPath') || '';
  $('#psFontName').textContent = fontFile ? fontFile.split(/[\\/]/).pop() : '기본 폰트 사용 중';
  const speed = $('#video').playbackRate || 1;
  $('#psSpeedLabel').textContent = `${speed.toFixed(2)}x`;
  $$('#psSpeeds button').forEach(button => button.classList.toggle('selected', Number(button.dataset.speed) === speed));
  const seconds = Number(localStorage.getItem('seekSeconds') || 10);
  $('#psSeekNote').textContent = `뒤로/앞으로 버튼 이동: ${seconds}초`;
  renderQualityChoices();
}

// Writes one subtitle setting and keeps the settings page controls in step.
function setSubtitleSetting(key, value) {
  localStorage.setItem(key, String(value));
  const page = { subtitleSize: ['#subtitleSize', '#subtitleSizeLabel', v => `${v}%`], subtitlePosition: ['#subtitlePosition', '#positionLabel', v => `${v}%`], vttOutline: ['#vttOutline', '#outlineLabel', v => Number(v).toFixed(1)], subtitleSync: ['#subtitleSync', '#subtitleSyncLabel', v => `${v} ms`] }[key];
  if (page) { const [input, label, format] = page; if ($(input)) $(input).value = String(value); if ($(label)) $(label).textContent = format(value); }
  if (key === 'vttBold' && $('#vttBold')) $('#vttBold').checked = Boolean(value);
  syncPlayerSettingsUI();
}

// VTT placement and sync. Android moves the cue baseline up by "자막 위치" percent and shifts every cue by the
// sync offset; the original cue times are kept so repeated changes do not accumulate.
function applyVttLayout() {
  const track = $('#video').textTracks[0]; if (!track?.cues) return;
  const position = Number(localStorage.getItem('subtitlePosition') || 10), offset = Number(localStorage.getItem('subtitleSync') || 0) / 1000;
  for (const cue of track.cues) {
    if (cue.lilacStart === undefined) { cue.lilacStart = cue.startTime; cue.lilacEnd = cue.endTime; }
    cue.startTime = Math.max(0, cue.lilacStart + offset); cue.endTime = Math.max(0, cue.lilacEnd + offset);
    cue.snapToLines = false; cue.line = 100 - position; cue.lineAlign = 'end';
  }
}

// Android subtitle source chips: switch to that source's subtitle for this episode.
async function selectSubtitleSource(source) {
  localStorage.setItem('subtitleSource', source);
  if ($('#subtitleSource')) { $('#subtitleSource').value = source; syncSettingChoices(); }
  syncPlayerSettingsUI();
  const key = subtitleStoreKey(), saved = key ? await window.lilac.savedSubtitles(key).catch(() => []) : [];
  const entry = saved.find(item => item.source === source);
  if (entry) { applySavedSubtitle(entry); return; }
  if (source === 'kairan' || source === 'csora') {
    const title = $('#skipTitle').value.trim(), episode = Number($('#skipEpisode').value) || 1, requestId = playbackRequestId;
    $('#subtitleState').textContent = `${source === 'kairan' ? 'Kairan' : 'Csora'} 자막을 찾는 중...`;
    try { const result = await window.lilac.findSubtitle(source, title, episode, subtitleSearchAnime()); if (requestId !== playbackRequestId) return; currentSubtitlePath = result.path; attachSubtitle(result.url, `${source === 'kairan' ? 'Kairan' : 'Csora'} 자막`, { path: result.path, assUrl: result.assUrl, assPath: result.assPath, fonts: result.fonts, source }); }
    catch { if (requestId === playbackRequestId) $('#subtitleState').textContent = `${source === 'kairan' ? 'Kairan' : 'Csora'} 자막을 찾지 못했습니다.`; }
    return;
  }
  if (source === 'reanime') {
    const track = (currentPlaybackContext.subtitleTracks || []).find(isKoreanTrack) || (currentPlaybackContext.subtitleTracks || [])[0];
    if (track) selectSubtitleTrack(track); else $('#subtitleState').textContent = 'Re:Anime 자막 트랙이 없습니다.';
    return;
  }
  const own = currentPlaybackContext.streamSubtitle;
  if (source === 'linkkf' && own) { attachSubtitle(own.src, own.label, { ...own.options, saved: true }); return; }
  if (source === 'user') { $('#openSubtitle').click(); return; }
  $('#subtitleState').textContent = '이 소스로 저장된 자막이 없습니다.';
}

// Quality: the HLS variants of the current stream (Android lists the parsed stream qualities).
function qualityLabel(level) { return level?.height ? `${level.height}p` : level?.bitrate ? `${Math.round(level.bitrate / 1000)}kbps` : '화질'; }
function applyDefaultQuality() {
  if (!hlsPlayer?.levels?.length) return;
  const wanted = parseInt(localStorage.getItem('defaultQuality') || '1080p', 10);
  if (!wanted) { hlsPlayer.currentLevel = -1; return; }
  const levels = hlsPlayer.levels.map((level, index) => ({ index, height: level.height || 0 }));
  const exact = levels.find(level => level.height === wanted);
  const below = levels.filter(level => level.height && level.height <= wanted).sort((a, b) => b.height - a.height)[0];
  const choice = exact || below;
  if (choice) hlsPlayer.currentLevel = choice.index;
}
function renderQualityChoices() {
  const levels = hlsPlayer?.levels || [], box = $('#psQuality'), list = $('#psQualityList');
  box.classList.toggle('hidden', levels.length < 2); if (levels.length < 2) { list.replaceChildren(); return; }
  const current = hlsPlayer.manualLevel ?? hlsPlayer.currentLevel;
  const options = [{ index: -1, label: 'Auto' }, ...levels.map((level, index) => ({ index, label: qualityLabel(level), height: level.height || 0 })).sort((a, b) => b.height - a.height)];
  list.replaceChildren(...options.map(option => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = option.label;
    button.classList.toggle('selected', option.index === current || (option.index === -1 && hlsPlayer.autoLevelEnabled));
    button.onclick = () => {
      hlsPlayer.currentLevel = option.index;
      localStorage.setItem('defaultQuality', option.index === -1 ? 'Auto' : option.label);
      if ($('#defaultQuality') && [...$('#defaultQuality').options].some(item => item.value === localStorage.getItem('defaultQuality'))) { $('#defaultQuality').value = localStorage.getItem('defaultQuality'); syncSettingChoices(); }
      renderQualityChoices();
    };
    return button;
  }));
}

// Previous / next episode (Android switchEpisode). Autoplay uses the same path.
function episodeIndex(episodes, current) { return (episodes || []).findIndex(ep => (current?.url && ep.url === current.url) || (current?.id && String(ep.id) === String(current.id)) || (Number.isFinite(Number(current?.number)) && Number(ep.number) === Number(current.number))); }
function siblingEpisode(step) { const list = currentPlaybackContext.seriesEpisodes || [], index = episodeIndex(list, currentPlaybackContext.episode); return index >= 0 ? list[index + step] || null : null; }
function updateEpisodeButtons() { $('#previousEpisode').disabled = !siblingEpisode(-1); $('#nextEpisode').disabled = !siblingEpisode(1); }
async function playSiblingEpisode(episode) {
  if (!episode) return;
  const episodes = currentPlaybackContext.seriesEpisodes || [], title = currentPlaybackContext.subtitleTitle || $('#playerTitle').textContent.split(' · ')[0];
  const context = { episode, subtitleTitle: title, image: currentPlaybackContext.image || '', seriesEpisodes: episodes, comparisonEpisodes: nearbyEpisodes(episodes, episode), resolveKind: currentPlaybackContext.resolveKind, anime: currentPlaybackContext.anime };
  $('#downloadStatus').textContent = `${episode.name || episode.number}화를 준비하는 중...`;
  await resolveIntoPlayer(() => context.resolveKind === 'linkkf' ? window.lilac.linkkfResolve(episode) : window.lilac.providerResolve(episode), `${title} · ${episode.name || episode.number}화`, context, title, episode.number || 1);
}

// Android auto skip: the skip pill stays visible for 2.5 s before an OP/ED is skipped automatically.
function updateSkipState(video) {
  const showButton = playerFlag('playerSkipButton');
  $('#skipNow').classList.toggle('hidden', !activeSkip || !showButton);
  if (!activeSkip) { autoSkipState.enteredKey = null; autoSkipState.skippedKey = null; return; }
  if (autoSkipState.enteredKey !== activeSkipKey) { autoSkipState.enteredKey = activeSkipKey; autoSkipState.enteredAt = Date.now(); autoSkipState.skippedKey = null; }
  if (playerFlag('playerAutoSkip') && autoSkipState.skippedKey !== activeSkipKey && Date.now() - autoSkipState.enteredAt >= 2500 && activeSkip.endTime > video.currentTime) {
    autoSkipState.skippedKey = activeSkipKey; video.currentTime = activeSkip.endTime;
  }
}

function setPlayerLocked(locked) {
  playerLocked = locked; clearTimeout(unlockTimer);
  $('#immersivePlayer').classList.toggle('locked', locked);
  $('#unlockPlayer').classList.add('hidden');
  if (locked) { openPlayerSettings(false); $('#immersivePlayer').classList.remove('controls-visible'); $('#video').focus?.(); }
  else showPlayerControls();
}
function flashUnlockButton() { $('#unlockPlayer').classList.remove('hidden'); clearTimeout(unlockTimer); unlockTimer = setTimeout(() => $('#unlockPlayer').classList.add('hidden'), 3000); }

function setPlayerWindowed() { $('#immersivePlayer').classList.toggle('windowed', !playerWindowFullscreen); }

// --- Media controls (Android MediaSession) ---------------------------------------------------
// Windows shows these in the media flyout, on the lock screen and on hardware media keys.
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const episode = currentPlaybackContext.episode, title = $('#playerTitle').textContent;
  const image = currentPlaybackContext.image || currentPlaybackContext.anime?.images?.webp?.large_image_url || '';
  navigator.mediaSession.metadata = new MediaMetadata({ title: episode ? `${episode.name || episode.number}화` : title, artist: currentPlaybackContext.subtitleTitle || title.split(' · ')[0], album: 'LilacAnime', artwork: /^https?:/i.test(image) ? [{ src: image, sizes: '512x512' }] : [] });
  navigator.mediaSession.setActionHandler('previoustrack', siblingEpisode(-1) ? () => playSiblingEpisode(siblingEpisode(-1)) : null);
  navigator.mediaSession.setActionHandler('nexttrack', siblingEpisode(1) ? () => playSiblingEpisode(siblingEpisode(1)) : null);
}
function updateMediaPosition() {
  const video = $('#video'), duration = playbackDuration();
  if (!('mediaSession' in navigator) || !duration || !Number.isFinite(video.currentTime)) return;
  try { navigator.mediaSession.setPositionState({ duration, position: Math.min(video.currentTime, duration), playbackRate: video.playbackRate || 1 }); } catch { /* duration not known yet */ }
}
if ('mediaSession' in navigator) {
  const video = $('#video'), seconds = () => Number(localStorage.getItem('seekSeconds') || 10);
  navigator.mediaSession.setActionHandler('play', () => video.play());
  navigator.mediaSession.setActionHandler('pause', () => video.pause());
  navigator.mediaSession.setActionHandler('stop', () => video.pause());
  navigator.mediaSession.setActionHandler('seekbackward', details => { video.currentTime = Math.max(0, video.currentTime - (details.seekOffset || seconds())); });
  navigator.mediaSession.setActionHandler('seekforward', details => { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + (details.seekOffset || seconds())); });
  navigator.mediaSession.setActionHandler('seekto', details => { if (Number.isFinite(details.seekTime)) video.currentTime = details.seekTime; });
  video.addEventListener('playing', () => { navigator.mediaSession.playbackState = 'playing'; updateMediaSession(); updateMediaPosition(); });
  video.addEventListener('pause', () => { navigator.mediaSession.playbackState = 'paused'; updateMediaPosition(); });
  video.addEventListener('durationchange', updateMediaPosition);
  video.addEventListener('seeked', updateMediaPosition);
  video.addEventListener('ratechange', updateMediaPosition);
}

// --- TV / remote-style keyboard control -------------------------------------------------------
// Arrow keys move focus to the nearest visible control in that direction; Enter activates it.
function focusableIn(root) {
  return [...root.querySelectorAll('button:not(:disabled), [href], input:not([type=hidden]):not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(el => { const rect = el.getBoundingClientRect(), style = getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && !el.closest('[aria-hidden="true"], .hidden, .player-utilities') && Number(style.opacity) > .05; });
}
function moveFocus(direction, root = document.body) {
  const current = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const items = focusableIn(root); if (!items.length) return false;
  if (!current || !root.contains(current)) {
    // Start in the visible page's content rather than the navigation bar.
    const first = items.find(item => item.closest('.view.active, dialog[open], .player-settings.open')) || items[0];
    first.focus(); first.scrollIntoView({ block: 'nearest' }); return true;
  }
  const from = current.getBoundingClientRect(), cx = from.left + from.width / 2, cy = from.top + from.height / 2;
  let best = null, bestScore = Infinity;
  for (const item of items) {
    if (item === current) continue;
    const rect = item.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2, dx = x - cx, dy = y - cy;
    const forward = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
    const side = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (forward <= 1) continue;
    const score = forward + side * 2;
    if (score < bestScore) { bestScore = score; best = item; }
  }
  if (!best) return false;
  best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true;
}

function handlePlayerKey(event) {
  const video = $('#video'), key = event.key, player = $('#immersivePlayer');
  if (playerLocked) { event.preventDefault(); flashUnlockButton(); return; }
  const focusInPlayer = player.contains(document.activeElement) && document.activeElement !== video;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !['checkbox', 'range'].includes(document.activeElement?.type);
  if (key === 'Escape' || key === 'BrowserBack' || key === 'GoBack') {
    event.preventDefault();
    if (playerSettingsOpen()) { openPlayerSettings(false); $('#playerSettingsButton').focus(); }
    else if (document.fullscreenElement) document.exitFullscreen();
    else $('#playerBack').click();
    return;
  }
  if (typing) return;
  const controlsShown = player.classList.contains('controls-visible');
  const arrow = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[key];
  if (arrow && focusInPlayer && (controlsShown || playerSettingsOpen())) {
    // Range inputs keep their own left/right handling.
    if (document.activeElement?.type === 'range' && (arrow === 'left' || arrow === 'right')) { showPlayerControls(); return; }
    event.preventDefault(); moveFocus(arrow, playerSettingsOpen() ? $('#playerSettings') : player); showPlayerControls(); return;
  }
  if (arrow === 'left' || arrow === 'right') {
    event.preventDefault();
    const seconds = Number(localStorage.getItem('seekSeconds') || 10) * (arrow === 'left' ? -1 : 1);
    video.currentTime = Math.min(video.duration || Infinity, Math.max(0, video.currentTime + seconds)); showPlayerControls(); return;
  }
  if (arrow) { event.preventDefault(); showPlayerControls(); $('#togglePlayer').focus(); return; }
  if (key === ' ' || key === 'MediaPlayPause' || ((key === 'Enter') && !focusInPlayer)) { event.preventDefault(); video.paused ? video.play() : video.pause(); showPlayerControls(); return; }
  if (key.toLowerCase() === 'f') { $('#fullscreenPlayer').click(); showPlayerControls(); return; }
  if (key.toLowerCase() === 'm') { $('#mutePlayer').click(); showPlayerControls(); return; }
  if (key === 'MediaTrackNext' || key === 'PageDown') { event.preventDefault(); playSiblingEpisode(siblingEpisode(1)); return; }
  if (key === 'MediaTrackPrevious' || key === 'PageUp') { event.preventDefault(); playSiblingEpisode(siblingEpisode(-1)); return; }
  showPlayerControls();
}

// Outside the player the same keys drive focus between cards, tabs and buttons.
function handleAppKey(event) {
  const active = document.activeElement, tag = active?.tagName;
  const dialog = $('#detailDialog').open ? $('#detailDialog') : null;
  const arrow = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[event.key];
  // Text fields keep left/right for the caret; up/down still leave them.
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !['checkbox', 'radio', 'range', 'button'].includes(active.type)) {
    if ((arrow === 'up' || arrow === 'down') && tag !== 'TEXTAREA' && moveFocus(arrow, dialog || document.body)) event.preventDefault();
    return;
  }
  if (arrow) { if (active?.type === 'range' && (arrow === 'left' || arrow === 'right')) return; if (moveFocus(arrow, dialog || document.body)) event.preventDefault(); return; }
  if (event.key === 'Enter' && active && active !== document.body && active.matches('[data-remote-card]')) { event.preventDefault(); active.click(); return; }
  if ((event.key === 'Escape' || event.key === 'BrowserBack' || event.key === 'GoBack') && dialog) { event.preventDefault(); dialog.close(); }
}

window.addEventListener('keydown', event => {
  if (event.defaultPrevented) return;
  if (document.body.classList.contains('player-mode')) handlePlayerKey(event); else handleAppKey(event);
});

// Cards are plain elements; make them reachable with a remote and announce them as buttons.
function makeRemoteFocusable(root = document) {
  root.querySelectorAll('.anime-card, .continue-card, .history-card, .download-card, .episode-row, .schedule-card, article[data-id]').forEach(el => {
    if (el.hasAttribute('data-remote-card')) return;
    el.setAttribute('data-remote-card', ''); if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  });
}
new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) makeRemoteFocusable(node.parentElement || node); }).observe(document.body, { childList: true, subtree: true });
makeRemoteFocusable();

// --- wiring ------------------------------------------------------------------------------------
$('#playerSettingsButton').onclick = () => openPlayerSettings(!playerSettingsOpen());
$('#closePlayerSettings').onclick = () => { openPlayerSettings(false); $('#playerSettingsButton').focus(); };
$('#psAutoPlay').onchange = event => localStorage.setItem('playerAutoPlay', String(event.target.checked));
$('#psSkipButton').onchange = event => { localStorage.setItem('playerSkipButton', String(event.target.checked)); updateSkipState($('#video')); };
$('#psAutoSkip').onchange = event => localStorage.setItem('playerAutoSkip', String(event.target.checked));
$$('#psSubtitleSources button').forEach(button => button.onclick = () => selectSubtitleSource(button.dataset.source));
$('#psSubtitleSize').oninput = event => { setSubtitleSetting('subtitleSize', event.target.value); applyCueStyle(); };
$('#psSubtitlePosition').oninput = event => { setSubtitleSetting('subtitlePosition', event.target.value); applyVttLayout(); };
$$('[data-ps-sync]').forEach(button => button.onclick = () => {
  const delta = Number(button.dataset.psSync), current = Number(localStorage.getItem('subtitleSync') || 0), next = delta === 0 ? 0 : Math.max(-5000, Math.min(5000, current + delta));
  setSubtitleSetting('subtitleSync', next); window.LilacAss?.setOffset(next); applyVttLayout();
});
$('#psVttStyle').onchange = event => { localStorage.setItem('vttStyle', String(event.target.checked)); applyCueStyle(); };
$('#psVttBold').onchange = event => { setSubtitleSetting('vttBold', event.target.checked); applyCueStyle(); };
$('#psVttOutline').oninput = event => { setSubtitleSetting('vttOutline', event.target.value); applyCueStyle(); };
$('#psChooseFont').onclick = () => $('#chooseSubtitleFont').click();
$$('#psSpeeds button').forEach(button => button.onclick = () => {
  const speed = Number(button.dataset.speed), video = $('#video');
  video.playbackRate = speed; $('#speed').value = String(speed); localStorage.setItem('defaultSpeed', String(speed));
  const index = SPEED_OPTIONS.indexOf(speed); if (index >= 0 && $('#defaultSpeed')) { $('#defaultSpeed').value = String(index); $('#speedLabel').textContent = `${speed.toFixed(2)}x`; }
  syncPlayerSettingsUI();
});
$('#previousEpisode').onclick = () => playSiblingEpisode(siblingEpisode(-1));
$('#nextEpisode').onclick = () => playSiblingEpisode(siblingEpisode(1));
$('#lockPlayer').onclick = () => setPlayerLocked(true);
$('#playerBack').addEventListener('click', () => { if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } });
$('#unlockPlayer').onclick = event => { event.stopPropagation(); setPlayerLocked(false); };
// Settings stay open while the pointer is on them; a click on the video closes them (Android dropdown).
$('#playerSettings').addEventListener('pointerdown', event => event.stopPropagation());
$('#video').addEventListener('ratechange', () => { if (playerSettingsOpen()) syncPlayerSettingsUI(); });
syncPlayerSettingsUI();
