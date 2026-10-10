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

const PLAYER_ASPECTS = { original: 0, '16:9': 16 / 9, '21:9': 21 / 9, '4:3': 4 / 3, fill: 0 };
function playerAspect() {
  const value = localStorage.getItem('playerAspect') || 'original';
  return Object.hasOwn(PLAYER_ASPECTS, value) ? value : 'original';
}
function applyPlayerAspect() {
  const player = $('#immersivePlayer'), stage = $('#videoStage'), aspect = playerAspect();
  const ratio = PLAYER_ASPECTS[aspect], width = player.clientWidth, height = player.clientHeight;
  const fittedWidth = ratio ? Math.min(width, height * ratio) : width;
  const fittedHeight = ratio ? fittedWidth / ratio : height;
  stage.style.width = `${fittedWidth}px`; stage.style.height = `${fittedHeight}px`;
  stage.style.left = `${(width - fittedWidth) / 2}px`; stage.style.top = `${(height - fittedHeight) / 2}px`;
  $('#video').style.objectFit = aspect === 'original' ? 'contain' : 'fill';
  $$('#psAspects button').forEach(button => { const selected = button.dataset.aspect === aspect; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  window.LilacAss?.resize();
}
new ResizeObserver(applyPlayerAspect).observe($('#immersivePlayer'));
$('#video').addEventListener('loadedmetadata', applyPlayerAspect);

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
  if (open) finishSpaceHold(false);
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
  $$('#psSubtitleSources button').forEach(button => button.classList.toggle('selected', button.dataset.source === activeSubtitleSource()));
  const size = Number(localStorage.getItem('subtitleSize') || 100), position = Number(localStorage.getItem('subtitlePosition') || 12), outline = Number(localStorage.getItem('vttOutline') || 2), sync = Number(localStorage.getItem('subtitleSync') || 0);
  $('#psSubtitleSize').value = String(size); $('#psSizeLabel').textContent = `${size}%`;
  $('#psSubtitlePosition').value = String(position); $('#psPositionLabel').textContent = `${position}%`;
  $('#psVttOutline').value = String(outline); $('#psOutlineLabel').textContent = `${outline.toFixed(1)}px`;
  $('#psSyncLabel').textContent = sync ? `${sync > 0 ? '+' : ''}${(sync / 1000).toFixed(2)}초 (${sync > 0 ? '늦게' : '빠르게'})` : '0초';
  $('#psSubtitleSync').value = String(sync);
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
const anissiaChosen = () => openSheet() === 'anissia';
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
  const title = $('#skipTitle').value.trim(), episode = Number($('#skipEpisode').value) || 1, requestId = playbackRequestId, searchId = ++subtitleSearchId;
  const current = () => requestId === playbackRequestId && searchId === subtitleSearchId;
  $('#subtitleState').textContent = `Anissia · ${name} 자막을 찾는 중...`;
  try {
    const result = await window.lilac.findSubtitle('anissia', title, episode, subtitleSearchAnime(), { maker: name });
    if (!current()) return;
    currentSubtitlePath = result.path; attachSubtitle(result.url, communityLabel('anissia', result), { path: result.path, assUrl: result.assUrl, assPath: result.assPath, fonts: result.fonts, source: 'anissia' });
    renderAnissiaMakers();
  } catch { if (current()) $('#subtitleState').textContent = `${name}의 ${episode}화 자막을 찾지 못했습니다.`; }
}

// Writes one subtitle setting and keeps the settings page controls in step.
function setSubtitleSetting(key, value) {
  localStorage.setItem(key, String(value));
  const page = { subtitleSize: ['#subtitleSize', '#subtitleSizeLabel', v => `${v}%`], subtitlePosition: ['#subtitlePosition', '#positionLabel', v => `${v}%`], vttOutline: ['#vttOutline', '#outlineLabel', v => Number(v).toFixed(1)], subtitleSync: ['#subtitleSync', '#subtitleSyncLabel', v => `${v} ms`] }[key];
  if (page) { const [input, label, format] = page; if ($(input)) $(input).value = String(value); if ($(label)) $(label).textContent = format(value); }
  if (key === 'vttBold' && $('#vttBold')) $('#vttBold').checked = Boolean(value);
  syncPlayerSettingsUI();
}
function setSubtitleSync(value) {
  if (String(value).trim() === '' || !Number.isFinite(Number(value))) return false;
  const milliseconds = Math.round(Number(value));
  setSubtitleSetting('subtitleSync', milliseconds);
  window.LilacAss?.setOffset(milliseconds); applyVttLayout();
  return true;
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
  if (track.lilacFlat || !track.cues.length) return; track.lilacFlat = true;
  setVttCues(track, flatVttLines([...track.cues].map(cue => ({ start: cue.startTime, end: cue.endTime, text: cue.text }))));
}
// lines: [{start, end, text}] → [{start, end, text, top}] as they are shown.
function flatVttLines(lines) {
  // ASS override tags left in SRT / VTT text (Jimaku files have {\an8} on captions, translations keep them) are not
  // shown: {\an7} {\an8} {\an9} put the cue at the top of the picture, the others are dropped.
  const list = lines.map(({ start, end, text }) => text.includes('{\\')
    ? { start, end, top: /\{\\an[789]\}/.test(text), text: text.replace(/\{\\[^}]*\}/g, '').replace(/^[ \t]+|[ \t]+$/gm, '').trim() }
    : { start, end, top: false, text }).sort((a, b) => a.start - b.start || a.end - b.end);
  // Cues overlapping in time are merged, the top ones and the bottom ones each among themselves.
  const merge = group => {
    const times = [...new Set(group.flatMap(cue => [cue.start, cue.end]))].sort((a, b) => a - b), flat = [];
    for (let i = 0; i < times.length - 1; i++) {
      const start = times[i], stop = times[i + 1], lines = [];
      for (const cue of group) { if (cue.start > start + 1e-6) break; if (cue.end > start + 1e-6 && !lines.includes(cue.text)) lines.push(cue.text); }
      if (!lines.length) continue;
      const text = lines.join('\n'), last = flat[flat.length - 1];
      if (last && last.text === text && Math.abs(last.end - start) < 1e-6) last.end = stop; else flat.push({ start, end: stop, text });
    }
    return flat;
  };
  const overlaps = group => { let end = -1; for (const cue of group) { if (cue.start < end - 0.001) return true; end = Math.max(end, cue.end); } return false; };
  const groups = [list.filter(cue => !cue.top), list.filter(cue => cue.top)];
  if (!groups.some(overlaps)) return list;
  return groups.flatMap((group, top) => merge(group).map(item => ({ ...item, top: Boolean(top) })));
}
// Puts these lines on the track, touching only the cues that differ: a cue that stays (the one on screen while lines
// of a translation come in) is not removed and drawn again. Cues are matched by their times before the sync offset.
function setVttCues(track, lines) {
  const key = (start, end, top, text) => `${start}|${end}|${top ? 1 : 0}|${text}`, wanted = new Map();
  for (const line of lines) if (line.text) wanted.set(key(line.start, line.end, line.top, line.text), line);
  for (const cue of [...track.cues]) { const at = key(cue.lilacStart ?? cue.startTime, cue.lilacEnd ?? cue.endTime, cue.lilacTop, cue.text); if (wanted.has(at)) wanted.delete(at); else track.removeCue(cue); }
  for (const line of wanted.values()) { const cue = new VTTCue(line.start, line.end, line.text); cue.lilacTop = line.top; track.addCue(cue); }
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
    // Chromium translates percentage-positioned cues horizontally again when size < 100,
    // shifting a 90% cue 4.5% to the left. Keep the box full-width; CSS supplies safe text margins.
    cue.size = 100; cue.position = 50; cue.positionAlign = 'center'; cue.align = 'center';
  }
}

// Android subtitle source chips: switch to that source's subtitle for this episode. A chip whose subtitle was not found
// goes dark again (the one on screen is lit); a chip with a list to pick from (Jimaku, Re:Anime tracks, Anissia makers)
// stays lit while its list is open.
async function selectSubtitleSource(source) {
  await switchSubtitleSource(source);
  const context = currentPlaybackContext;
  if (context.pressedSource === source && context.pressedFor === currentSubtitle && !['jimaku', 'reanime', 'anissia'].includes(source)) { context.pressedSource = null; renderSubtitleSheet(); }
}
// Each chip press or Anissia maker pick starts a new search: a slower earlier search (Kairan, then Csora at once) must
// not put its subtitle over the one asked for last.
let subtitleSearchId = 0;
async function switchSubtitleSource(source) {
  ++subtitleSearchId;
  // Jimaku is picked by hand per episode (a list of files), so it is not kept as the default source.
  if (source === 'jimaku') { openJimaku(); return; }
  // AI 번역: the episode's machine translation, else one made now from the best source (Jimaku, then the site's Japanese
  // and English tracks), with the side 자막 자동 번역 picks or whichever is set up; the series goes on in it. Not kept as
  // the default source (each episode's translation is looked for first anyway).
  if (source === 'ai') {
    const key = subtitleStoreKey(), requestId = playbackRequestId; currentPlaybackContext.sheetSource = null; pressSubtitleSource('ai'); preferAiSubtitle(true); renderSubtitleSheet();
    const translated = (key ? await window.lilac.savedSubtitles(key).catch(() => []) : []).find(item => item.source === 'gemini');
    if (translated) { applySavedSubtitle(translated); return; }
    translationSettings = await window.lilac.geminiSettings().catch(() => translationSettings);
    const provider = autoTranslateProvider() || autoProvider();
    if (!provider) { toast('설정 > 자막 자동 번역에서 번역 API 키나 로컬 AI 모델을 먼저 준비해 주세요.'); return; }
    if (!await autoTranslate(() => requestId !== playbackRequestId, true, provider) && requestId === playbackRequestId) $('#subtitleState').textContent = '번역할 자막(Jimaku, 일본어·영어 트랙)이 없습니다.';
    return;
  }
  // The list of a source with several to pick from opens under the chips.
  currentPlaybackContext.sheetSource = ['reanime', 'anissia'].includes(source) ? source : null; pressSubtitleSource(source); renderSubtitleSheet();
  if (KOREAN_SOURCES.includes(source)) preferAiSubtitle(false); // back to a Korean subtitle (see prefersAiSubtitle)
  localStorage.setItem('subtitleSource', source);
  if ($('#subtitleSource')) { $('#subtitleSource').value = source; syncSettingChoices(); }
  syncPlayerSettingsUI();
  const key = subtitleStoreKey(), saved = key ? await window.lilac.savedSubtitles(key).catch(() => []) : [], requestId = playbackRequestId;
  // Re:Anime / Miruro: the site's Korean track; without one the episode's machine translation, the one already made
  // (from whichever source) or one made now from the best source as the automatic translation picks it (Jimaku, then
  // the site's Japanese and English tracks); with 자막 자동 번역 off or not set up, the track that would be translated.
  if (source === 'reanime') {
    const tracks = currentPlaybackContext.subtitleTracks || [], korean = tracks.find(isKoreanTrack);
    if (korean) { selectSubtitleTrack(korean); return; }
    const translated = saved.find(item => item.source === 'gemini');
    if (translated) { applySavedSubtitle(translated); return; }
    if (await autoTranslate(() => requestId !== playbackRequestId, true) || requestId !== playbackRequestId) return;
    const track = translationSourceTrack() || tracks[0];
    if (track) selectSubtitleTrack(track); else $('#subtitleState').textContent = `${trackSourceLabel()} 자막 트랙이 없습니다.`;
    return;
  }
  const entry = saved.find(item => item.source === source);
  if (entry) { applySavedSubtitle(entry); return; }
  if (source === 'kairan' || source === 'csora' || source === 'anissia') {
    const title = $('#skipTitle').value.trim(), episode = Number($('#skipEpisode').value) || 1, requestId = playbackRequestId, searchId = subtitleSearchId;
    const current = () => requestId === playbackRequestId && searchId === subtitleSearchId;
    $('#subtitleState').textContent = `${SUBTITLE_SOURCE_LABELS[source]} 자막을 찾는 중...`;
    try { const result = await window.lilac.findSubtitle(source, title, episode, subtitleSearchAnime()); if (!current()) return; currentSubtitlePath = result.path; attachSubtitle(result.url, communityLabel(source, result), { path: result.path, assUrl: result.assUrl, assPath: result.assPath, fonts: result.fonts, source }); }
    catch { if (current()) $('#subtitleState').textContent = `${SUBTITLE_SOURCE_LABELS[source]} 자막을 찾지 못했습니다.`; }
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
  if (locked) finishSpaceHold(false);
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
  // Off the player, a dark page shows them clear over the OTT header and hero.
  const mode = !inPlayer ? (document.body.classList.contains('light') ? 'page' : 'player') : (player.classList.contains('locked') ? !$('#unlockPlayer').classList.contains('hidden') : player.classList.contains('controls-visible')) ? 'player' : 'hidden';
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
  // Character references as the player shows them (&#39; and &quot; too, which SRT files carry).
  const char = code => { try { return String.fromCodePoint(code); } catch { return ''; } };
  const plain = text.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lrm;|&rlm;/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => char(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => char(Number(dec))).replace(/&amp;/g, '&');
  return plain.split(/\r?\n/).flatMap(line => {
    const words = line.split(' '), lines = [];
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) { current = next; continue; }
      if (current) { lines.push(current); current = ''; }
      // Long words and Japanese lines without spaces also need to fit.
      for (const character of word) {
        if (current && ctx.measureText(current + character).width > maxWidth) { lines.push(current); current = ''; }
        current += character;
      }
    }
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
  const sourceWidth = video.videoWidth || 1280, sourceHeight = video.videoHeight || 720;
  const aspect = playerAspect(), player = $('#immersivePlayer');
  const ratio = PLAYER_ASPECTS[aspect] || (aspect === 'fill' && player.clientHeight ? player.clientWidth / player.clientHeight : sourceWidth / sourceHeight);
  const width = Math.min(sourceWidth, 1280), height = Math.max(1, Math.round(width / ratio));
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

// Delay the short-press action until release so a hold never pauses the video first.
let spaceHold = null, heldMouseClick = null;
function startSpeedHold(source, pointer = null) {
  if (spaceHold) return;
  const video = $('#video'), hold = { source, pointer, boosted: false, rate: video.playbackRate, timer: null };
  spaceHold = hold;
  hold.timer = setTimeout(() => {
    if (spaceHold !== hold || video.paused || video.ended || playerLocked || playerSettingsOpen() || !document.body.classList.contains('player-mode')) return;
    hold.boosted = true; video.playbackRate = 2;
    $('#playerSpeedBoost').classList.remove('hidden');
  }, 400);
}
function startSpaceHold(event) {
  event.preventDefault();
  if (!event.repeat) startSpeedHold('keyboard');
}
function finishSpaceHold(toggle = false) {
  const hold = spaceHold; if (!hold) return;
  spaceHold = null; clearTimeout(hold.timer);
  const video = $('#video');
  $('#playerSpeedBoost').classList.add('hidden');
  if (hold.source === 'mouse') {
    heldMouseClick = hold.boosted ? { pointerId: hold.pointer.id, until: Date.now() + 1000 } : null;
    if (hold.pointer.target.hasPointerCapture?.(hold.pointer.id)) hold.pointer.target.releasePointerCapture(hold.pointer.id);
  }
  if (hold.boosted) {
    // A speed selected during a hold takes precedence over the temporary boost.
    if (video.playbackRate === 2) video.playbackRate = hold.rate;
  } else if (toggle && hold.source === 'keyboard' && !playerLocked && document.body.classList.contains('player-mode')) {
    video.paused ? video.play().catch(() => {}) : video.pause(); showPlayerControls();
  }
}
window.addEventListener('keyup', event => {
  if ((event.code === 'Space' || event.key === ' ') && spaceHold?.source === 'keyboard') { event.preventDefault(); finishSpaceHold(true); }
});
$('#immersivePlayer').addEventListener('pointerdown', event => {
  if (event.pointerType !== 'mouse' || event.button !== 0 || event.isPrimary === false) return;
  // A new click always retains its normal action, even just after a cancelled hold.
  heldMouseClick = null;
  if (spaceHold || playerLocked || playerSettingsOpen() || !document.body.classList.contains('player-mode')) return;
  const video = $('#video');
  if (video.paused || video.ended || ![video, $('#videoStage'), $('#immersivePlayer')].includes(event.target)) return;
  startSpeedHold('mouse', { id: event.pointerId, target: event.target });
  // Capture releases outside the picture too; buttons and settings never enter this path.
  event.target.setPointerCapture?.(event.pointerId);
});
function finishMouseHold(event) {
  if (spaceHold?.source === 'mouse' && event.pointerId === spaceHold.pointer.id) finishSpaceHold(false);
}
window.addEventListener('pointerup', finishMouseHold, true);
window.addEventListener('pointercancel', finishMouseHold, true);
$('#immersivePlayer').addEventListener('lostpointercapture', finishMouseHold);
window.addEventListener('pointermove', event => {
  if (spaceHold?.source === 'mouse' && event.buttons != null && !(event.buttons & 1)) finishMouseHold(event);
}, true);
$('#immersivePlayer').addEventListener('click', event => {
  if (!heldMouseClick || Date.now() > heldMouseClick.until || event.detail === 0 || event.button !== 0) return;
  if (event.pointerId != null && event.pointerId !== heldMouseClick.pointerId) return;
  heldMouseClick = null; event.preventDefault(); event.stopImmediatePropagation();
}, true);
window.addEventListener('blur', () => finishSpaceHold(false));
document.addEventListener('visibilitychange', () => { if (document.hidden) finishSpaceHold(false); });
for (const name of ['pause', 'ended', 'emptied', 'loadstart']) $('#video').addEventListener(name, () => finishSpaceHold(false));

function handlePlayerKey(event) {
  const video = $('#video'), key = event.key, player = $('#immersivePlayer');
  if (playerLocked) { event.preventDefault(); flashUnlockButton(); return; }
  const focusInPlayer = player.contains(document.activeElement) && document.activeElement !== video;
  const typing = document.activeElement?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !['checkbox', 'range'].includes(document.activeElement?.type);
  if (key === 'Escape' || key === 'BrowserBack' || key === 'GoBack') {
    finishSpaceHold(false);
    event.preventDefault();
    // Esc steps back one level: the settings sheet, then full screen (to the window), then out of the player. The mouse's
    // back button goes straight out.
    if (playerSettingsOpen()) { openPlayerSettings(false); $('#playerSettingsButton').focus(); }
    else if (document.fullscreenElement) document.exitFullscreen();
    else if (key === 'Escape' && playerWindowFullscreen) $('#fullscreenPlayer').click();
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
  if (event.code === 'Space' || key === ' ') {
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    // Settings controls keep their normal keyboard activation.
    if (playerSettingsOpen() || document.activeElement?.matches('input, select, textarea, [contenteditable]')) return;
    startSpaceHold(event); return;
  }
  if (key === 'MediaPlayPause' || ((key === 'Enter') && !focusInPlayer)) { event.preventDefault(); if (!event.repeat) { video.paused ? video.play() : video.pause(); showPlayerControls(); } return; }
  // Letter keys by where they are on the keyboard (event.code), not the character: with the Korean input on, C gives
  // 'ㅊ' and F 'ㄹ', and the shortcuts did nothing.
  const letter = event.ctrlKey || event.altKey || event.metaKey ? '' : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : /^(?:Digit|Numpad)[0-9]$/.test(event.code) ? event.code.slice(-1) : event.code === 'BracketLeft' ? '[' : event.code === 'BracketRight' ? ']' : key.toLowerCase();
  if (letter === 'f') { $('#fullscreenPlayer').click(); showPlayerControls(); return; }
  if (letter === 'm') { $('#mutePlayer').click(); showPlayerControls(); return; }
  // C: subtitles on / off; Z / X: subtitles half a second earlier / later (the 자막 싱크 setting); S: skip the opening or
  // ending on screen; 0-9: to that tenth of the episode; [ / ]: slower / faster. Each says what it did. (Up and down stay
  // for moving the focus with a remote.)
  if (letter === 'c') { const box = $('#subtitleEnabled'); box.checked = !box.checked; box.dispatchEvent(new Event('change')); toast(box.checked ? '자막을 켰어요' : '자막을 껐어요'); return; }
  if (letter === 'z' || letter === 'x') {
    const next = Number(localStorage.getItem('subtitleSync') || 0) + (letter === 'z' ? -500 : 500);
    setSubtitleSync(next);
    toast(`자막 싱크 ${next > 0 ? '+' : ''}${(next / 1000).toFixed(1)}초 (${next < 0 ? '자막이 빨리 나옴' : next > 0 ? '자막이 늦게 나옴' : '원래대로'})`); return;
  }
  if (letter === 's') { const skip = $('#skipNow'); if (skip && !skip.classList.contains('hidden')) skip.click(); else toast('지금은 건너뛸 OP/ED 구간이 아니에요'); return; }
  if (/^[0-9]$/.test(letter) && video.duration) { video.currentTime = video.duration * Number(letter) / 10; showPlayerControls(); return; }
  if (letter === '[' || letter === ']') {
    finishSpaceHold(false);
    const at = SPEED_OPTIONS.indexOf(video.playbackRate), next = SPEED_OPTIONS[Math.max(0, Math.min(SPEED_OPTIONS.length - 1, (at < 0 ? SPEED_OPTIONS.indexOf(1) : at) + (letter === ']' ? 1 : -1)))];
    video.playbackRate = next; $('#speed').value = String(next); if (playerSettingsOpen()) syncPlayerSettingsUI(); toast(`재생 속도 ${next.toFixed(2)}x`); return;
  }
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
$('#psSubtitleSync').onchange = event => { setSubtitleSync(event.target.value); syncPlayerSettingsUI(); };
$('#psSubtitleSize').oninput = event => { setSubtitleSetting('subtitleSize', event.target.value); applyCueStyle(); };
$('#psSubtitlePosition').oninput = event => { setSubtitleSetting('subtitlePosition', event.target.value); applyVttLayout(); };
$$('[data-ps-sync]').forEach(button => button.onclick = () => {
  const delta = Number(button.dataset.psSync), current = Number(localStorage.getItem('subtitleSync') || 0);
  setSubtitleSync(delta === 0 ? 0 : current + delta);
});
$('#psVttStyle').onchange = event => { localStorage.setItem('vttStyle', String(event.target.checked)); applyCueStyle(); };
$('#psVttBold').onchange = event => { setSubtitleSetting('vttBold', event.target.checked); applyCueStyle(); };
$('#psVttOutline').oninput = event => { setSubtitleSetting('vttOutline', event.target.value); applyCueStyle(); };
$('#psChooseFont').onclick = () => $('#chooseSubtitleFont').click();
$$('#psSpeeds button').forEach(button => button.onclick = () => {
  finishSpaceHold(false);
  const speed = Number(button.dataset.speed), video = $('#video');
  video.playbackRate = speed; $('#speed').value = String(speed); localStorage.setItem('defaultSpeed', String(speed));
  const index = SPEED_OPTIONS.indexOf(speed); if (index >= 0 && $('#defaultSpeed')) { $('#defaultSpeed').value = String(index); $('#speedLabel').textContent = `${speed.toFixed(2)}x`; }
  syncPlayerSettingsUI();
});
$('#previousEpisode').onclick = () => playSiblingEpisode(siblingEpisode(-1));
$('#nextEpisode').onclick = () => playSiblingEpisode(siblingEpisode(1));
$('#lockPlayer').onclick = () => setPlayerLocked(true);
$('#playerBack').addEventListener('click', () => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } });
$('#playerBack').addEventListener('click', () => finishSpaceHold(false));
$$('#psAspects button').forEach(button => button.onclick = () => { localStorage.setItem('playerAspect', button.dataset.aspect); applyPlayerAspect(); });
$('#unlockPlayer').onclick = event => { event.stopPropagation(); setPlayerLocked(false); };
// Settings stay open while the pointer is on them; a click on the video closes them (Android dropdown).
$('#playerSettings').addEventListener('pointerdown', event => event.stopPropagation());
$('#video').addEventListener('ratechange', () => { if (playerSettingsOpen()) syncPlayerSettingsUI(); });
syncPlayerSettingsUI();
applyPlayerAspect();
