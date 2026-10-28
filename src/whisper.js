// Whisper AI 자막 (Android playbackAiMode "whisper"): the episode's Japanese speech recognized on this PC (electron/whisper.cjs)
// when it has no subtitle to show or translate. The lines appear as they are recognized (the part from where it is
// playing comes first); the finished subtitle is saved with the episode and, when a translation side is set up,
// translated into Korean by the existing translation (자막 자동 번역).
// Loaded after app.js and player.js and shares their globals.
let whisperState = null, whisperRunId = 0;
// On unless turned off: an episode with no subtitle to show or translate gets one from its speech.
const whisperAuto = () => localStorage.getItem('whisperAuto') !== 'false';

// The settings pane: the runtime, the models and the automatic switch.
const whisperModelProgress = {};
let whisperInstallMessage = '';
async function renderWhisperSettings(value) {
  value ||= await window.lilac.whisperStatus().catch(() => null); if (!value || !$('#whisperModelList')) return;
  whisperState = value;
  // Windows: whisper.cpp's builds, the NVIDIA card's when there is one (it can also come after the CPU's); elsewhere Python.
  const size = value.installSize >= 1e8 ? `약 ${Math.round(value.installSize / 1e8) * 100}MB` : `약 ${Math.max(1, Math.round(value.installSize / 1e6))}MB`, gpuMissing = value.native && value.gpu && !value.gpu.installed;
  $('#whisperRuntimeState').textContent = value.installing ? (whisperInstallMessage || '설치하는 중…')
    : value.runtime ? `설치됨 · ${value.engine}로 음성을 인식합니다.${gpuMissing ? ` ${value.gpu.name}용 빌드(${size})를 받으면 몇 배 빨라져요.` : ''}`
    : value.native ? `아직 설치하지 않았어요. 처음 한 번 whisper.cpp(${value.gpu ? `${value.gpu.name}용 그래픽카드 빌드 포함, ` : ''}${size})를 받습니다.` : `아직 설치하지 않았어요. 처음 한 번 Python과 whisper.cpp(${size})를 받습니다.`;
  const install = $('#whisperInstall'); install.classList.toggle('hidden', value.runtime && !gpuMissing); install.disabled = value.installing;
  install.textContent = value.installing ? '설치하는 중…' : value.runtime ? `그래픽카드 빌드 받기 · ${size}` : `설치 · ${size}`;
  $('#whisperModelList').replaceChildren(...value.models.map(model => {
    const row = document.createElement('div'), progress = whisperModelProgress[model.id], selected = model.installed && model.id === value.model;
    row.className = `local-model${selected ? ' selected' : ''}`;
    const state = selected ? '사용 중' : model.installed ? '받음 · 눌러서 사용' : progress != null ? '받는 중' : model.id === value.model ? '선택됨 · 받아야 써요' : '받지 않음';
    row.innerHTML = `<button type="button" class="local-model-pick"><b>${escapeHtml(model.label)}</b><small>${escapeHtml(model.note)}</small></button><span class="local-model-state">${state}</span><button type="button" class="local-model-action"></button>`;
    const pick = row.querySelector('.local-model-pick'), action = row.querySelector('.local-model-action');
    pick.disabled = selected; pick.onclick = async () => renderWhisperSettings(await window.lilac.whisperSelect(model.id));
    if (progress != null) { action.textContent = `받는 중 ${progress}%`; action.disabled = true; }
    else if (model.installed) { action.textContent = '삭제'; action.onclick = async () => { if (await askConfirm(`Whisper ${model.label} 모델을 삭제할까요?`, { ok: '삭제', danger: true })) renderWhisperSettings(await window.lilac.whisperRemove(model.id)); }; }
    else {
      action.textContent = model.partial ? `이어 받기 · ${Math.round(model.partial / model.size * 100)}% 받음` : `받기 · ${model.size >= 1e9 ? `${(model.size / 1e9).toFixed(1)}GB` : `${Math.round(model.size / 1e6)}MB`}`;
      action.onclick = () => downloadWhisperModel(model.id);
    }
    return row;
  }));
  $('#whisperAuto').checked = whisperAuto();
}
async function downloadWhisperModel(id) {
  whisperModelProgress[id] = 0; renderWhisperSettings(whisperState);
  try { await window.lilac.whisperSelect(id); await window.lilac.whisperDownload(id); toast('Whisper 모델을 받았어요.'); }
  catch (error) { toast(`Whisper 모델을 받지 못했습니다: ${ipcMessage(error)}`); }
  finally { delete whisperModelProgress[id]; renderWhisperSettings(); }
}
$('#whisperInstall').onclick = async () => {
  whisperInstallMessage = '설치를 시작하는 중…'; renderWhisperSettings({ ...(whisperState || {}), installing: true, models: whisperState?.models || [] });
  try { await window.lilac.whisperInstall(); toast('Whisper를 설치했어요.'); }
  catch (error) { toast(`Whisper를 설치하지 못했습니다: ${ipcMessage(error)}`); }
  finally { whisperInstallMessage = ''; renderWhisperSettings(); }
};
$('#whisperAuto').onchange = event => { localStorage.setItem('whisperAuto', String(event.target.checked)); };

// A run for the episode on screen: its lines are put on a live subtitle as they come.
let whisperRun = null;
const whisperRunning = () => whisperRun && whisperRun.requestId === playbackRequestId;
function whisperChip() { return $('#psSubtitleSources [data-source="whisper"] small'); }
function showWhisperProgress(text) {
  const chip = whisperChip(); if (chip) chip.textContent = text || '음성 인식';
  if (whisperRunning() && text) $('#subtitleState').textContent = `Whisper ${text}`;
}
// A line as cue text, as electron/whisper.cjs writes it in the file (and the translator reads it back).
const whisperCueText = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Each live cue's own line (its text changes to the translation).
const whisperCueRaw = new WeakMap();
// The recognized lines so far, as a subtitle on screen; later lines go into its track as cues (in Korean when their
// translation is already in).
function showWhisperLines(run, lines) {
  if (!lines.length || run !== whisperRun || !whisperRunning()) return;
  run.lines.push(...lines);
  const track = currentSubtitle?.whisperLive === run ? $('#video').textTracks[0] : null;
  if (track) {
    for (const line of lines) {
      const raw = whisperCueText(line.text);
      try { const cue = new VTTCue(line.start, Math.max(line.end, line.start + 0.5), run.translated.get(raw) ?? raw); whisperCueRaw.set(cue, raw); track.addCue(cue); } catch { /* a cue the browser refuses is left out */ }
    }
    return;
  }
  // Another subtitle on screen stays: one there when Whisper started by itself, or one picked since the lines went up.
  if (currentSubtitle && !currentSubtitle.whisperLive && (run.yielded || run.shown)) return;
  run.shown = true;
  const stamp = value => new Date(Math.max(0, value) * 1000).toISOString().slice(11, 23);
  const vtt = `WEBVTT\n\n${run.lines.map(line => { const raw = whisperCueText(line.text); return `${stamp(line.start)} --> ${stamp(Math.max(line.end, line.start + 0.5))}\n${run.translated.get(raw) || raw}\n`; }).join('\n')}`;
  attachSubtitle(URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })), 'Whisper 일본어 자막 (인식 중)', { whisperLive: run, notice: run.live?.provider ? 'Whisper가 인식한 대사를 띄웠어요. 번역되는 대로 한국어로 바뀌어요.' : 'Whisper가 인식한 일본어 대사를 띄웠어요.' });
}

// 실시간 번역: the subtitle Whisper writes as it goes is translated as it grows, by the same translation as any other
// subtitle (its lines kept under the file's path, so each run only sends the new ones), with the side 자막 자동 번역
// picks. How much is sent at a time follows the side: the local AI translates line by line anyway and the paid APIs
// answer small requests quickly, so they get each piece Whisper finishes (5 to 15 lines, every few seconds on a
// graphics card); Gemini's free tier allows about 20 requests a model a day, so it gets 40 lines at a time (the size of
// a translation's first batch), about ten requests an episode. Recognition runs ahead of playback, so the lines are
// mostly in Korean by the time they are on screen.
const whisperLiveRuns = new Map(); let whisperLiveId = 1e6;
function translateWhisperLive(run) {
  const live = run.live; if (!live?.provider || !live.path || run !== whisperRun) return;
  if (live.busy) { live.dirty = true; return; }
  const added = run.lines.length - live.sent, gemini = live.provider !== 'local' && translationSettings?.cloud === 'gemini';
  if (added <= 0 || (gemini && added < 40)) return;
  const id = ++whisperLiveId; live.busy = true; live.id = id; live.sent = run.lines.length; whisperLiveRuns.set(id, run);
  window.lilac.translateSubtitle({ path: live.path, title: currentPlaybackContext.subtitleTitle || '', id, provider: live.provider, anime: subtitleSearchAnime(), playing: $('#video').currentTime || 0, linesKey: live.path, partial: true, anySide: !run.manual })
    .catch(error => {
      if (/번역을 취소했습니다/.test(ipcMessage(error)) || run !== whisperRun) return;
      // An error every request would hit (no key, the allowance used up): the live translation stops, the whole file is
      // still translated at the end.
      if (++live.failures >= 2) { live.provider = null; toast(`실시간 번역을 멈췄어요: ${ipcMessage(error)}`); }
    })
    .finally(() => { whisperLiveRuns.delete(id); live.busy = false; live.id = null; if (live.dirty) { live.dirty = false; translateWhisperLive(run); } });
}
// The live cues take their translations as they come.
function applyWhisperTranslations(run) {
  const track = currentSubtitle?.whisperLive === run ? $('#video').textTracks[0] : null;
  for (const cue of track?.cues || []) {
    if (!whisperCueRaw.has(cue)) whisperCueRaw.set(cue, cue.text);
    const text = run.translated.get(whisperCueRaw.get(cue));
    if (text != null && cue.text !== text) cue.text = text;
  }
}
window.lilac.onTranslateProgress(({ id, lines }) => {
  const run = whisperLiveRuns.get(id); if (!run || !lines) return;
  for (const { raw, text } of lines) run.translated.set(raw, text);
  applyWhisperTranslations(run);
});
function stopWhisperLive(run) { const live = run?.live; if (!live) return; live.provider = null; if (live.id) window.lilac.cancelTranslation(live.id).catch(() => {}); }
// The player moved: recognition (and the live translation) go on from there when it is a part not done yet.
$('#video').addEventListener('seeked', () => {
  if (!whisperRunning()) return;
  const time = $('#video').currentTime || 0; window.lilac.whisperJump(time);
  if (whisperRun.live?.id) window.lilac.jumpTranslation(whisperRun.live.id, time).catch(() => {});
});
window.lilac.onWhisperProgress(value => {
  if (value.kind === 'install') { whisperInstallMessage = `${value.message}${value.progress != null ? ` (${Math.round(value.progress * 100)}%)` : ''}`; if (whisperState) $('#whisperRuntimeState').textContent = whisperInstallMessage; return; }
  if (value.kind === 'model') { whisperModelProgress[value.id] = Math.round((value.progress || 0) * 100); if (whisperState) renderWhisperSettings(whisperState); return; }
  if (value.kind !== 'run' || value.id !== whisperRun?.id) return;
  if (value.lines) showWhisperLines(whisperRun, value.lines);
  if (value.partial && whisperRun.live) { whisperRun.live.path = value.partial; translateWhisperLive(whisperRun); }
  if (value.status) showWhisperProgress(value.status);
  if (Number.isFinite(value.done)) showWhisperProgress(value.duration > 0 ? `음성 인식 중 ${Math.min(99, Math.round(value.done / value.duration * 100))}%` : '음성 인식 중…');
});

// manual: the chip pressed (a second press stops a run). Returns whether a Whisper subtitle is on or on its way.
async function startWhisper(manual = false) {
  if (whisperRunning()) { if (manual) { window.lilac.whisperCancel(); toast('Whisper 음성 인식을 멈췄어요.'); } return true; }
  const key = subtitleStoreKey(), requestId = playbackRequestId, context = currentPlaybackContext;
  const status = await window.lilac.whisperStatus().catch(() => null);
  const model = status?.models.find(item => item.id === status.model);
  if (!status?.runtime || !model?.installed) {
    if (manual) { toast(!status?.runtime ? '설정 > Whisper AI 자막에서 먼저 설치해 주세요.' : `설정 > Whisper AI 자막에서 ${model?.label || ''} 모델을 먼저 받아 주세요.`); window.showSettingsPane?.('whisper'); }
    return false;
  }
  if (!key || !context.currentUrl) { if (manual) toast('재생 중인 영상이 없습니다.'); return false; }
  // The episode's saved Whisper subtitle (or its translation) is put on instead of recognizing it again.
  const saved = (await window.lilac.savedSubtitles(key).catch(() => [])).find(item => item.source === 'whisper');
  if (requestId !== playbackRequestId) return false;
  if (saved) { applySavedSubtitle(saved); translateWhisper(saved.path, manual); prepareWhisperNext(); return true; }
  const run = whisperRun = { id: ++whisperRunId, requestId, key, manual, lines: [], translated: new Map(), yielded: !manual && Boolean(currentSubtitle) };
  pressSubtitleSource('whisper'); renderSubtitleSheet(); showWhisperProgress('음성 인식 준비 중…');
  // The live translation's side: 자막 자동 번역's, or (pressed by hand) whichever is set up; none: Japanese only.
  translationSettings = await window.lilac.geminiSettings().catch(() => translationSettings);
  run.live = { provider: autoTranslateProvider() || (manual ? autoProvider() : null), path: '', sent: 0, busy: false, dirty: false, failures: 0, id: null };
  try {
    const result = await window.lilac.whisperTranscribe({ id: run.id, key, videoUrl: context.currentUrl, headers: context.streamHeaders || {}, startAt: $('#video').currentTime || 0, duration: playbackDuration() });
    // The live translation gives way to the whole file's (which takes up the lines it kept).
    stopWhisperLive(run);
    if (result?.canceled || run !== whisperRun || requestId !== playbackRequestId) return true;
    if (!result.lines) { $('#subtitleState').textContent = 'Whisper가 이 회차에서 대사를 찾지 못했어요.'; return false; }
    // The finished file takes the live subtitle's place (or is only saved, when another subtitle was put on meanwhile).
    if (!currentSubtitle || currentSubtitle.whisperLive) { currentSubtitlePath = result.path; attachSubtitle(result.url, 'Whisper 일본어 자막', { path: result.path, source: 'whisper', notice: `Whisper가 대사 ${result.lines}줄을 인식했어요.` }); }
    else window.lilac.saveSubtitle(key, { source: 'whisper', label: 'Whisper 일본어 자막', path: result.path }).catch(() => {});
    translateWhisper(result.path, manual);
    prepareWhisperNext();
    return true;
  } catch (error) {
    if (run === whisperRun && requestId === playbackRequestId) { $('#subtitleState').textContent = 'Whisper 음성 인식에 실패했습니다.'; toast(`Whisper 실패: ${ipcMessage(error)}`); }
    return false;
  } finally { stopWhisperLive(run); if (run === whisperRun) { whisperRun = null; showWhisperProgress(''); renderSubtitleSheet(); } }
}
// Into Korean with the side 자막 자동 번역 picks (or whichever is set up), as a Jimaku file is.
async function translateWhisper(path, manual) {
  translationSettings = await window.lilac.geminiSettings().catch(() => translationSettings);
  const provider = autoTranslateProvider() || (manual ? autoProvider() : null);
  if (!provider || currentSubtitle?.source !== 'whisper') return;
  runTranslation({ file: async () => ({ path }), name: 'Whisper', button: provider === 'local' ? $('#translateNowLocal') : $('#translateNow'), provider, manual, linesKey: path });
}
// 다음 화 미리 준비 > Whisper 자막: while a series is watched with Whisper's subtitles, the next episode is recognized in
// the background once this one's is done (and translated, with AI 번역 on), and saved with it, so it opens with its
// subtitle at once. It gives way to the episode on screen (whisper.cjs runs one at a time); an episode that has a
// subtitle of its own already is left alone.
let whisperNextRef = '';
async function prepareWhisperNext() {
  const next = typeof siblingEpisode === 'function' ? siblingEpisode(1) : null, context = currentPlaybackContext;
  if (!playerFlag('prepareNextWhisper') || !next) return;
  const ref = episodeRef(next); if (whisperNextRef === ref) return; whisperNextRef = ref;
  const saved = await window.lilac.savedSubtitles(ref).catch(() => []);
  if (saved.some(item => ['whisper', 'gemini', 'kairan', 'csora', 'anissia', 'linkkf'].includes(item.source))) return;
  let stream = preparedStreams.get(ref);
  try {
    if (!stream && jobByRef(ref)?.status === 'completed') stream = await window.lilac.playDownload(jobByRef(ref).id);
    if (!stream) stream = ['animenosub', 'miruro'].includes(next.provider) ? await resolveWithVideoServer(next, Promise.resolve(null), context.anime, [], episode => window.lilac.prepareEpisodeStream(episode))
      : await window.lilac.prepareEpisodeStream(context.resolveKind === 'linkkf' ? { ...next, resolveKind: 'linkkf' } : next);
  } catch { whisperNextRef = ''; return; }
  if (!stream?.url) return;
  const result = await window.lilac.whisperTranscribe({ id: ++whisperLiveId, key: ref, videoUrl: stream.url, headers: stream.headers || {}, background: true }).catch(() => null);
  // Given way to the episode on screen (or stopped): tried again after that one's run.
  if (!result?.path || !result.lines) { if (result?.busy || !result) whisperNextRef = ''; return; }
  await window.lilac.saveSubtitle(ref, { source: 'whisper', label: 'Whisper 일본어 자막', path: result.path }).catch(() => {});
  if (!playerFlag('prepareNextTranslation')) return;
  translationSettings = await window.lilac.geminiSettings().catch(() => translationSettings);
  const provider = autoTranslateProvider() || autoProvider(); if (!provider) return;
  const translated = await window.lilac.translateSubtitle({ path: result.path, title: context.subtitleTitle || '', id: ++whisperLiveId, provider, anime: subtitleSearchAnime(), linesKey: result.path, anySide: true }).catch(() => null);
  if (translated?.path) window.lilac.saveSubtitle(ref, { source: 'gemini', label: translatedLabel(translated, 'Whisper'), path: translated.path, from: result.path, fromName: 'Whisper' }).catch(() => {});
}
// No subtitle anywhere and 자막이 없으면 자동으로 만들기 on.
async function whisperWhenNoSubtitle() { return whisperAuto() && startWhisper(false); }
document.querySelector('[data-settings-tab="whisper"]')?.addEventListener('click', () => renderWhisperSettings());
renderWhisperSettings();
