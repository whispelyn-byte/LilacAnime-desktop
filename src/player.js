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
// The sheet is split into 재생 / 자막 / 자막 모양; the tab used last opens next time.
function showPlayerSettingsTab(name) {
  if (!$(`[data-ps-pane="${name}"]`)) name = 'play';
  $$('[data-ps-tab]').forEach(button => { const on = button.dataset.psTab === name; button.classList.toggle('selected', on); button.setAttribute('aria-selected', String(on)); });
  $$('[data-ps-pane]').forEach(pane => pane.classList.toggle('hidden', pane.dataset.psPane !== name));
  $('#playerSettings .ps-body').scrollTop = 0;
  try { localStorage.setItem('playerSettingsTab', name); } catch { /* the tab is only a convenience */ }
}
$$('[data-ps-tab]').forEach(button => button.onclick = () => showPlayerSettingsTab(button.dataset.psTab));
showPlayerSettingsTab((() => { try { return localStorage.getItem('playerSettingsTab'); } catch { return null; } })() || 'play');
function openPlayerSettings(open, focusSection = null) {
  const panel = $('#playerSettings');
  panel.classList.toggle('open', open); panel.setAttribute('aria-hidden', String(!open));
  $('#playerSettingsButton').setAttribute('aria-expanded', String(open));
  if (open) {
    syncPlayerSettingsUI();
    const focusPane = focusSection?.closest('[data-ps-pane]'); if (focusPane) showPlayerSettingsTab(focusPane.dataset.psPane);
    if (focusSection) focusSection.scrollIntoView({ block: 'start' });
    if (usingKeyboard) (focusSection?.querySelector('input,button') || panel.querySelector('.ps-tabs button.selected'))?.focus({ preventScroll: true });
  }
  showPlayerControls();
}

// Mirrors the settings page so both edit the same stored values.
function syncPlayerSettingsUI() {
  $('#psAutoPlay').checked = playerFlag('playerAutoPlay');
  $('#psSkipButton').checked = playerFlag('playerSkipButton');
  $('#psAutoSkip').checked = playerFlag('playerAutoSkip', false);
  $('#assEffectsHint').textContent = assEffectsEnabled() ? '노래 가사·간판 번역 등의 위치·색·움직임을 그대로 보여 줍니다' : '효과를 줄여 가볍게 보여 줍니다 (영상이 버벅일 때)';
  const source = localStorage.getItem('subtitleSource') || 'reanime';
  $$('#psSubtitleSources button').forEach(button => button.classList.toggle('selected', button.dataset.source === source));
  const size = Number(localStorage.getItem('subtitleSize') || 100), position = Number(localStorage.getItem('subtitlePosition') || 12), outline = Number(localStorage.getItem('vttOutline') || 2), sync = Number(localStorage.getItem('subtitleSync') || 0);
  $('#psSubtitleSize').value = String(size); $('#psSizeLabel').textContent = `${size}%`;
  $('#psSubtitlePosition').value = String(position); $('#psPositionLabel').textContent = `${position}%`;
  $('#psVttOutline').value = String(outline); $('#psOutlineLabel').textContent = `${outline.toFixed(1)}px`;
  $('#psSyncLabel').textContent = sync ? `${sync > 0 ? '+' : ''}${(sync / 1000).toFixed(2)}초 (${sync > 0 ? '늦게' : '빠르게'})` : '0초';
  $('#psVttStyle').checked = playerFlag('vttStyle');
  $('#psVttBold').checked = localStorage.getItem('vttBold') !== 'false';
  const fontFile = localStorage.getItem('subtitleFontPath') || '';
  $('#psFontName').textContent = fontFile ? fontFile.split(/[\\/]/).pop() : '기본 글꼴 사용 중';
  const speed = $('#video').playbackRate || 1;
  $('#psSpeedLabel').textContent = `${speed.toFixed(2)}x`;
  $$('#psSpeeds button').forEach(button => button.classList.toggle('selected', Number(button.dataset.speed) === speed));
  const seconds = Number(localStorage.getItem('seekSeconds') || 10);
  $('#psSeekNote').textContent = `뒤로/앞으로 버튼 이동: ${seconds}초`;
  renderQualityChoices();
  renderVideoServers();
  renderDiscoveredFonts();
  loadAnissiaMakers();
}

// Android "발견된 ASS 폰트": fonts shipped with the current Kairan/Csora/Anissia subtitle. The chosen one becomes the
// subtitle font (VTT text and the ASS fallback), like a custom font file; all of them stay available to the ASS script.
function fontPathOf(url) { try { return decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\'); } catch { return ''; } }
function renderDiscoveredFonts() {
  const fonts = [...new Set(currentSubtitle?.fonts || [])].map(url => ({ url, path: fontPathOf(url) })).filter(font => font.path);
  $('#psDiscoveredFonts').classList.toggle('hidden', !fonts.length);
  if (!fonts.length) { $('#psFontChips').replaceChildren(); return; }
  const chosen = localStorage.getItem('subtitleFontPath') || '', inList = fonts.some(font => font.path === chosen);
  const choose = path => { if (path) localStorage.setItem('subtitleFontPath', path); else localStorage.removeItem('subtitleFontPath'); subtitleFontChanged(); renderDiscoveredFonts(); syncPlayerSettingsUI(); };
  const chip = (label, path, selected) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.classList.toggle('selected', selected); button.onclick = () => choose(path); return button; };
  $('#psFontChips').replaceChildren(chip('기본', '', !inList), ...fonts.map(font => chip(font.path.split(/[\\/]/).pop().replace(/\.(ttf|otf|ttc|woff2?)$/i, ''), font.path, font.path === chosen)));
}

// Anissia makers of the playing anime: fansubs are timed for different releases, so another maker's subtitle
// may match the video better. Shown while Anissia is the chosen source or the playing subtitle; loaded once
// per title. Makers on blogs that cannot be read are shown disabled.
let anissiaMakerKey = null, anissiaMakerData = null;
const anissiaChosen = () => localStorage.getItem('subtitleSource') === 'anissia' || currentSubtitle?.source === 'anissia';
async function loadAnissiaMakers() {
  const title = $('#skipTitle').value.trim(), box = $('#anissiaMakers');
  if (!title || !anissiaChosen()) { box.classList.add('hidden'); return; }
  const key = `${title}|${currentPlaybackContext.anime?.id || ''}`;
  if (anissiaMakerKey !== key) {
    anissiaMakerKey = key; anissiaMakerData = null;
    box.classList.remove('hidden'); $('#anissiaMakerState').textContent = '불러오는 중…'; $('#anissiaMakerList').replaceChildren();
    const data = await window.lilac.anissiaMakers(title, subtitleSearchAnime()).catch(() => null);
    if (anissiaMakerKey !== key) return;
    anissiaMakerData = data || { makers: [] };
  }
  renderAnissiaMakers();
}
function renderAnissiaMakers() {
  const box = $('#anissiaMakers'), makers = anissiaMakerData?.makers || [];
  if (!anissiaMakerData) return;
  box.classList.toggle('hidden', !makers.length || !anissiaChosen());
  $('#anissiaMakerState').textContent = makers.length ? `${makers.length}명` : '';
  const current = currentSubtitle?.source === 'anissia' ? currentSubtitle.label : '';
  $('#anissiaMakerList').replaceChildren(...makers.map(maker => {
    const button = document.createElement('button'); button.type = 'button';
    const reason = maker.support === 'own-source' ? 'Kairan/Csora 소스에서 선택' : maker.support === 'unsupported' ? '지원하지 않는 블로그' : '';
    button.textContent = maker.name; button.title = reason || `${maker.episode}화까지`;
    button.disabled = maker.support !== 'ok'; button.classList.toggle('selected', current.includes(`· ${maker.name} `));
    button.onclick = () => selectAnissiaMaker(maker.name);
    return button;
  }));
}
async function selectAnissiaMaker(name) {
  const title = $('#skipTitle').value.trim(), episode = Number($('#skipEpisode').value) || 1, requestId = playbackRequestId;
  $('#subtitleState').textContent = `Anissia · ${name} 자막을 찾는 중...`;
  try {
    const result = await window.lilac.findSubtitle('anissia', title, episode, subtitleSearchAnime(), { maker: name });
    if (requestId !== playbackRequestId) return;
    currentSubtitlePath = result.path; attachSubtitle(result.url, communityLabel('anissia', result), { path: result.path, assUrl: result.assUrl, assPath: result.assPath, fonts: result.fonts, source: 'anissia' });
    renderAnissiaMakers();
  } catch { if (requestId === playbackRequestId) $('#subtitleState').textContent = `${name}의 ${episode}화 자막을 찾지 못했습니다.`; }
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
// Android's mpv placement: sub-pos = 100 − 자막 위치 (kept within 55–97), and mpv's 22-pixel bottom margin on a
// 720-line screen below that. Returns the cue's bottom edge in percent of the video height.
function vttBaseline() {
  const position = Number(localStorage.getItem('subtitlePosition') || 12);
  return Math.min(97, Math.max(55, Math.round(100 - position))) - 22 / 720 * 100;
}
// Cues sit on one line (below, or at the top for captions tagged {\an8}), so cues overlapping in time were drawn on
// top of each other (an ASS file's lines turned into VTT, a translation of one). They are flattened once, before any
// sync offset: each stretch of time gets one cue with all lines active then, the earlier line first.
function flattenVttCues(track) {
  const list = [...track.cues].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  if (track.lilacFlat || !list.length) return; track.lilacFlat = true;
  // ASS override tags left in SRT / VTT text (Jimaku files have {\an8} on captions, translations keep them) are not
  // shown: {\an7} {\an8} {\an9} put the cue at the top of the picture, the others are dropped.
  for (const cue of list) {
    if (!cue.text.includes('{\\')) continue;
    cue.lilacTop = /\{\\an[789]\}/.test(cue.text);
    cue.text = cue.text.replace(/\{\\[^}]*\}/g, '').replace(/^[ \t]+|[ \t]+$/gm, '').trim();
  }
  // Cues overlapping in time are merged, the top ones and the bottom ones each among themselves.
  const merge = group => {
    const times = [...new Set(group.flatMap(cue => [cue.startTime, cue.endTime]))].sort((a, b) => a - b), flat = [];
    for (let i = 0; i < times.length - 1; i++) {
      const start = times[i], stop = times[i + 1], lines = [];
      for (const cue of group) { if (cue.startTime > start + 1e-6) break; if (cue.endTime > start + 1e-6 && !lines.includes(cue.text)) lines.push(cue.text); }
      if (!lines.length) continue;
      const text = lines.join('\n'), last = flat[flat.length - 1];
      if (last && last.text === text && Math.abs(last.end - start) < 1e-6) last.end = stop; else flat.push({ start, end: stop, text });
    }
    return flat;
  };
  const overlaps = group => { let end = -1; for (const cue of group) { if (cue.startTime < end - 0.001) return true; end = Math.max(end, cue.endTime); } return false; };
  const groups = [list.filter(cue => !cue.lilacTop), list.filter(cue => cue.lilacTop)];
  if (!groups.some(overlaps)) return;
  for (const cue of [...track.cues]) track.removeCue(cue);
  groups.forEach((group, top) => { for (const item of merge(group)) { const cue = new VTTCue(item.start, item.end, item.text); cue.lilacTop = Boolean(top); track.addCue(cue); } });
}
function applyVttLayout() {
  const track = $('#video').textTracks[0]; if (!track?.cues) return;
  flattenVttCues(track);
  const line = vttBaseline(), offset = Number(localStorage.getItem('subtitleSync') || 0) / 1000;
  for (const cue of track.cues) {
    if (cue.lilacStart === undefined) { cue.lilacStart = cue.startTime; cue.lilacEnd = cue.endTime; }
    cue.startTime = Math.max(0, cue.lilacStart + offset); cue.endTime = Math.max(0, cue.lilacEnd + offset);
    // Top cues (captions, signs) keep a small margin from the top; the rest sit on the subtitle line.
    cue.snapToLines = false; cue.line = cue.lilacTop ? 5 : line; cue.lineAlign = cue.lilacTop ? 'start' : 'end';
  }
}

// Android subtitle source chips: switch to that source's subtitle for this episode.
async function selectSubtitleSource(source) {
  // Jimaku is picked by hand per episode (a list of files), so it is not kept as the default source.
  if (source === 'jimaku') { openJimaku(); return; }
  localStorage.setItem('subtitleSource', source);
  if ($('#subtitleSource')) { $('#subtitleSource').value = source; syncSettingChoices(); }
  syncPlayerSettingsUI();
  const key = subtitleStoreKey(), saved = key ? await window.lilac.savedSubtitles(key).catch(() => []) : [];
  const entry = saved.find(item => item.source === source);
  if (entry) { applySavedSubtitle(entry); return; }
  if (source === 'kairan' || source === 'csora' || source === 'anissia') {
    const title = $('#skipTitle').value.trim(), episode = Number($('#skipEpisode').value) || 1, requestId = playbackRequestId;
    $('#subtitleState').textContent = `${SUBTITLE_SOURCE_LABELS[source]} 자막을 찾는 중...`;
    try { const result = await window.lilac.findSubtitle(source, title, episode, subtitleSearchAnime()); if (requestId !== playbackRequestId) return; currentSubtitlePath = result.path; attachSubtitle(result.url, communityLabel(source, result), { path: result.path, assUrl: result.assUrl, assPath: result.assPath, fonts: result.fonts, source }); }
    catch { if (requestId === playbackRequestId) $('#subtitleState').textContent = `${SUBTITLE_SOURCE_LABELS[source]} 자막을 찾지 못했습니다.`; }
    return;
  }
  if (source === 'reanime') {
    const track = (currentPlaybackContext.subtitleTracks || []).find(isKoreanTrack) || (currentPlaybackContext.subtitleTracks || [])[0];
    if (track) selectSubtitleTrack(track); else $('#subtitleState').textContent = `${trackSourceLabel()} 자막 트랙이 없습니다.`;
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
// Animenosub / Miruro video servers ("SUB - Moon", "RAW - anikoto HD-2"…). 자동 = RAW under a Korean subtitle, else SUB;
// a picked server is kept for later episodes of that source. Changing it reloads the episode at the same point.
// Servers are grouped by kind (Miruro offers a dozen): 자동 and one chip per kind, and the servers of one kind under
// them, first the kind playing now. Names lose the kind prefix ("SUB - animepahe animepahe" -> animepahe).
const SERVER_KINDS = { sub: ['SUB · 영어 자막', '영어 자막이 영상에 박혀 있어요. 한국어 자막을 입히면 겹쳐 보여요.'], soft: ['SOFT · 자막 따로', '자막 없는 영상에 자막을 따로 입혀요. 자막 트랙을 바꾸거나 한국어로 번역할 수 있어요.'], raw: ['RAW · 자막 없음', '자막이 없는 원본이에요. 한국어 자막을 입혀 보기에 좋아요.'], dub: ['DUB · 영어 더빙', '영어 더빙이에요.'] };
let openServerKind = '';
const serverKind = server => String(server.kind || server.label.split(/\s*-\s*/)[0] || '').toLowerCase();
function serverName(server) {
  const name = server.label.replace(/^[A-Za-z]+\s*-\s*/, ''), words = name.split(/\s+/);
  return words.length === 2 && words[0].toLowerCase() === words[1].toLowerCase() ? words[0] : name;
}
function renderVideoServers() {
  const servers = currentPlaybackContext.videoServers || [], box = $('#psServers'), list = $('#psServerList');
  box.classList.toggle('hidden', servers.length < 2); if (servers.length < 2) { list.replaceChildren(); return; }
  const picked = localStorage.getItem(videoServerKey(currentPlaybackContext.episode?.provider)) || '', playing = currentPlaybackContext.videoServer || '';
  const kinds = [...new Set(servers.map(serverKind))].sort((a, b) => Object.keys(SERVER_KINDS).indexOf(a) - Object.keys(SERVER_KINDS).indexOf(b));
  if (!kinds.includes(openServerKind)) openServerKind = serverKind(servers.find(server => server.label === playing) || servers[0]);
  $('#psServerNote').textContent = `재생 중: ${playing || '-'}`;
  const chip = (text, className, onclick) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.className = className; button.onclick = onclick; return button; };
  const kindRow = document.createElement('div'); kindRow.className = 'ps-chips ps-server-kinds';
  kindRow.append(chip('자동 (추천)', picked ? '' : 'selected', () => selectVideoServer('')),
    ...kinds.map(kind => { const button = chip(SERVER_KINDS[kind]?.[0] || kind.toUpperCase(), kind === openServerKind ? 'open' : '', () => { openServerKind = kind; renderVideoServers(); }); button.setAttribute('aria-expanded', String(kind === openServerKind)); return button; }));
  const group = document.createElement('div'); group.className = 'ps-chips ps-server-group';
  group.append(...servers.filter(server => serverKind(server) === openServerKind).map(server => { const button = chip(serverName(server), [server.label === picked ? 'selected' : '', server.label === playing ? 'playing' : ''].join(' ').trim(), () => selectVideoServer(server.label)); button.title = server.label; return button; }));
  const note = document.createElement('small'); note.className = 'ps-note'; note.textContent = SERVER_KINDS[openServerKind]?.[1] || '';
  list.replaceChildren(kindRow, group, note);
}
function selectVideoServer(label) {
  const context = currentPlaybackContext, video = $('#video'), episode = context.episode, key = videoServerKey(episode?.provider);
  if (label) localStorage.setItem(key, label); else localStorage.removeItem(key);
  if (!episode || (label && label === context.videoServer)) { renderVideoServers(); return; }
  const duration = playbackDuration(), resumeProgress = duration ? Math.min(94, video.currentTime / duration * 100) : 0, title = context.subtitleTitle || $('#skipTitle').value.trim();
  const { videoServers, videoServer, resolving, currentUrl, ...keep } = context;
  resolveIntoPlayer(() => window.lilac.providerResolve(episode), `${title} · ${episode.name || episode.number}화`, { ...keep, resumeProgress }, title, Number($('#skipEpisode').value) || episode.number || 1);
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
// The playing episode in the list: by its own address first (url, Linkkf token, id), so a sub and a dub of one number stay
// apart, then by number (Linkkf episodes saved before they had one are numbered by name).
function episodeIndex(episodes, current) {
  const list = episodes || [], ref = current ? episodeRef(current) : '', number = episodeNumberOf(current);
  const index = ref ? list.findIndex(ep => episodeRef(ep) === ref) : -1;
  return index >= 0 || number == null ? index : list.findIndex(ep => episodeNumberOf(ep) === number && !ep.dub === !current.dub);
}
// Lists with a sub and a dub of each number (Animenosub) step to the next episode of the same kind.
function siblingEpisode(step) {
  const list = currentPlaybackContext.seriesEpisodes || [], current = currentPlaybackContext.episode, index = episodeIndex(list, current);
  if (index < 0) return null;
  for (let i = index + step; i >= 0 && i < list.length; i += step) if (!list[i].dub === !current.dub) return list[i];
  return null;
}
function updateEpisodeButtons() { $('#previousEpisode').disabled = !siblingEpisode(-1); $('#nextEpisode').disabled = !siblingEpisode(1); }
async function playSiblingEpisode(episode) {
  if (!episode) return;
  const episodes = currentPlaybackContext.seriesEpisodes || [], title = currentPlaybackContext.subtitleTitle || $('#playerTitle').textContent.split(' · ')[0];
  const context = { episode, subtitleTitle: title, image: currentPlaybackContext.image || '', seriesEpisodes: episodes, comparisonEpisodes: nearbyEpisodes(episodes, episode), resolveKind: currentPlaybackContext.resolveKind, anime: currentPlaybackContext.anime };
  $('#downloadStatus').textContent = `${episode.name || episode.number}화를 준비하는 중...`;
  await resolveIntoPlayer(() => context.resolveKind === 'linkkf' ? window.lilac.linkkfResolve(episode) : window.lilac.providerResolve(episode), `${title} · ${episode.name || episode.number}화`, context, title, episodeNumberOf(episode) || 1);
}

// Android auto skip: the skip pill stays visible for 2.5 s before an OP/ED is skipped automatically.
function updateSkipState(video) {
  const showButton = playerFlag('playerSkipButton');
  $('#skipNow').classList.toggle('hidden', !activeSkip || !showButton);
  if (!activeSkip) { autoSkipState.enteredKey = null; autoSkipState.skippedKey = null; return; }
  if (autoSkipState.enteredKey !== activeSkipKey) { autoSkipState.enteredKey = activeSkipKey; autoSkipState.enteredAt = Date.now(); autoSkipState.skippedKey = null; }
  if (playerFlag('playerAutoSkip', false) && autoSkipState.skippedKey !== activeSkipKey && Date.now() - autoSkipState.enteredAt >= 2500 && activeSkip.endTime > video.currentTime) {
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
// The window's minimize / maximize / close buttons follow the player's controls while it plays in a window: shown with
// them (white, on the video) and hidden with them; on a locked screen they come with the unlock button (a click shows
// it for a few seconds). Anywhere else they are the theme's.
let windowButtonsMode = '';
function syncWindowButtons() {
  const player = $('#immersivePlayer'), inPlayer = document.body.classList.contains('player-mode') && player.classList.contains('windowed');
  const mode = !inPlayer ? 'page' : (player.classList.contains('locked') ? !$('#unlockPlayer').classList.contains('hidden') : player.classList.contains('controls-visible')) ? 'player' : 'hidden';
  if (mode !== windowButtonsMode) { windowButtonsMode = mode; window.lilac.setWindowButtons?.(mode); }
}
new MutationObserver(syncWindowButtons).observe($('#immersivePlayer'), { attributes: true, attributeFilter: ['class'] });
new MutationObserver(syncWindowButtons).observe(document.body, { attributes: true, attributeFilter: ['class'] });
new MutationObserver(syncWindowButtons).observe($('#unlockPlayer'), { attributes: true, attributeFilter: ['class'] });
// Only a click brings the controls (and with them the window buttons) back; moving the mouse does not. While they are
// shown, a pointer moving over them (not over the bare video) keeps them from hiding under it. The cursor itself shows
// whenever the mouse moves and hides after two still seconds, controls or not. Only real movement counts: some mice
// report a move without moving.
let lastPointer = '', cursorTimer = null;
$('#immersivePlayer').addEventListener('mousemove', event => {
  const at = `${event.screenX},${event.screenY}`; if (at === lastPointer) return; lastPointer = at;
  const player = $('#immersivePlayer');
  player.classList.add('cursor-visible'); clearTimeout(cursorTimer); cursorTimer = setTimeout(() => player.classList.remove('cursor-visible'), 2000);
  if (!playerLocked && event.target !== $('#video') && player.classList.contains('controls-visible')) showPlayerControls();
}, { passive: true });

// --- Picture-in-picture ---------------------------------------------------------------------
// Chromium's picture-in-picture window shows a bare <video>: caption tracks and the libass canvas stay behind.
// So each frame is composed on a canvas (the picture, then the ASS canvas or the active VTT cues), streamed
// into a hidden video, and that video goes into picture-in-picture. Its play/pause and the real video's
// follow each other; the media session buttons (previous/next episode, seek) work there too.
const pip = { video: null, canvas: null, timer: 0 };
function pipSourceVideo() {
  if (pip.video) return pip.video;
  const video = document.createElement('video'), real = $('#video');
  video.className = 'pip-source'; video.muted = true; video.playsInline = true;
  video.addEventListener('pause', () => { if (document.pictureInPictureElement === video && !real.paused) real.pause(); });
  video.addEventListener('play', () => { if (document.pictureInPictureElement === video && real.paused) real.play().catch(() => {}); });
  video.addEventListener('leavepictureinpicture', stopPictureInPicture);
  real.addEventListener('pause', () => { if (document.pictureInPictureElement === video) video.pause(); });
  real.addEventListener('play', () => { if (document.pictureInPictureElement === video) video.play().catch(() => {}); });
  document.body.append(video);
  return pip.video = video;
}
function vttLines(ctx, text, maxWidth) {
  const plain = text.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return plain.split(/\r?\n/).flatMap(line => {
    const words = line.split(' '), lines = [];
    let current = '';
    for (const word of words) { const next = current ? `${current} ${word}` : word; if (current && ctx.measureText(next).width > maxWidth) { lines.push(current); current = word; } else current = next; }
    return current ? [...lines, current] : lines;
  });
}
// VTT cues drawn the way the player styles them: size, bold, outline and the raised baseline of "자막 위치".
function drawPipCues(ctx, width, height, video) {
  const track = video.textTracks[0], cues = track?.activeCues ? [...track.activeCues] : [];
  if (!cues.length) return;
  const size = Number(localStorage.getItem('subtitleSize') || 100) / 100, bold = localStorage.getItem('vttBold') !== 'false';
  const outline = Math.max(0, Number(localStorage.getItem('vttOutline') ?? 2)) * height / 720;
  const fontSize = Math.round(height * 0.05 * size), lineHeight = fontSize * 1.25;
  ctx.font = `${bold ? 700 : 400} ${fontSize}px LilacSubtitle, 'Malgun Gothic', sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.lineJoin = 'round';
  const lines = cues.flatMap(cue => vttLines(ctx, cue.text || '', width * 0.9));
  let y = height * vttBaseline() / 100 - (lines.length - 1) * lineHeight;
  for (const line of lines) {
    if (outline) { ctx.lineWidth = outline * 2; ctx.strokeStyle = '#000'; ctx.strokeText(line, width / 2, y); }
    ctx.fillStyle = '#fff'; ctx.fillText(line, width / 2, y);
    y += lineHeight;
  }
}
function drawPipFrame() {
  const video = $('#video'), canvas = pip.canvas, ctx = canvas.getContext('2d');
  const sourceWidth = video.videoWidth || 1280, sourceHeight = video.videoHeight || 720, scale = Math.min(1, 1280 / sourceWidth);
  const width = Math.round(sourceWidth * scale), height = Math.round(sourceHeight * scale);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
  if (video.readyState >= 2) ctx.drawImage(video, 0, 0, width, height);
  if (!$('#subtitleEnabled')?.checked) return;
  if (currentSubtitle?.assRendering) { const ass = window.LilacAss?.frame(video); if (ass?.width) ctx.drawImage(ass, 0, 0, width, height); }
  else drawPipCues(ctx, width, height, video);
}
function stopPictureInPicture() {
  clearInterval(pip.timer); pip.timer = 0;
  if (pip.video) { pip.video.srcObject?.getTracks().forEach(track => track.stop()); pip.video.srcObject = null; }
  $('#miniPlayer').classList.remove('active');
}
async function togglePictureInPicture() {
  if (document.pictureInPictureElement) { await document.exitPictureInPicture().catch(() => {}); return; }
  const real = $('#video');
  if (real.readyState < 2) { toast('먼저 영상을 재생하세요.'); return; }
  const video = pipSourceVideo();
  pip.canvas ||= document.createElement('canvas');
  drawPipFrame();
  // A timer rather than animation frames: those stop while the app window is minimized.
  clearInterval(pip.timer); pip.timer = setInterval(drawPipFrame, 1000 / 30);
  video.srcObject = pip.canvas.captureStream(30);
  try {
    await video.play();
    await video.requestPictureInPicture();
    if (real.paused) video.pause();
    $('#miniPlayer').classList.add('active');
  } catch (error) { stopPictureInPicture(); toast(`PIP를 열지 못했습니다: ${error.message}`); }
}

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
$('#playerBack').addEventListener('click', () => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } });
$('#unlockPlayer').onclick = event => { event.stopPropagation(); setPlayerLocked(false); };
// Settings stay open while the pointer is on them; a click on the video closes them (Android dropdown).
$('#playerSettings').addEventListener('pointerdown', event => event.stopPropagation());
$('#video').addEventListener('ratechange', () => { if (playerSettingsOpen()) syncPlayerSettingsUI(); });
syncPlayerSettingsUI();
