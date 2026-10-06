// Renders ASS/SSA subtitles with libass (JASSUB) over the player video, like the Android
// mpv engine: original position, colors, effects and fonts are preserved.
import JASSUB from './vendor/jassub/jassub.js';

let instance = null;
let fontUrl = null;
// Every attach/destroy bumps this. An attach that finishes after a newer call (a new episode, another
// subtitle, clearing) throws its instance away instead of leaving the old subtitle on screen.
let generation = 0;

async function release(active, url) {
  if (url) URL.revokeObjectURL(url);
  if (active) { try { await active.destroy(); } catch { /* already gone */ } }
}

async function destroy() {
  generation++;
  const active = instance, url = fontUrl;
  instance = null; fontUrl = null;
  await release(active, url);
}

// fonts: font file URLs shipped with the subtitle (e.g. from a fansub ZIP).
// defaultFont: { family, data } of the 기본 자막 폰트. It becomes libass' fallback for styles
// whose font is not installed, which also supplies Hangul glyphs. libass matches the fallback
// by its real family name, and the font has to be handed over as a URL (a blob), not raw bytes.
async function attach(video, { subUrl, fonts = [], defaultFont = null, offsetMs = 0, visible = true } = {}) {
  await destroy();
  const token = generation;
  const options = { video, subUrl, fonts, queryFonts: 'local' };
  let url = null;
  if (defaultFont?.data && defaultFont.family) {
    url = URL.createObjectURL(new Blob([defaultFont.data], { type: 'font/ttf' }));
    const family = defaultFont.family.trim().toLowerCase();
    options.availableFonts = { [family]: url };
    options.defaultFont = family;
  }
  const created = new JASSUB(options);
  instance = created; fontUrl = url;
  try { await created.ready; } catch (error) { if (token === generation) { instance = null; fontUrl = null; } await release(created, url); throw error; }
  if (token !== generation) { await release(created, url); return false; }
  setOffset(offsetMs);
  setVisible(visible);
  return true;
}

function setVisible(visible) {
  const canvas = instance?._canvas;
  if (canvas) canvas.style.visibility = visible ? 'visible' : 'hidden';
}

// Positive offset delays the subtitles, matching the VTT sync setting.
function setOffset(offsetMs) {
  if (instance) instance.timeOffset = -(Number(offsetMs) || 0) / 1000;
}

// The libass canvas at the video's current time, for the picture-in-picture composer. libass renders on video
// frame callbacks, which stop while the app window is minimized, so a stale frame is rendered here instead.
function frame(video) {
  if (!instance?._canvas || instance._canvas.style.visibility === 'hidden') return null;
  const last = instance._lastDemandTime?.mediaTime;
  if (video.videoWidth && (last === undefined || Math.abs(last - video.currentTime) > 0.25)) instance.manualRender({ mediaTime: video.currentTime, width: video.videoWidth, height: video.videoHeight, expectedDisplayTime: performance.now() }).catch(() => {});
  return instance._canvas;
}

// A Dialogue line's words as its VTT copy has them (main's assToVtt, then the translator's plain), and the words put in
// a Dialogue line (the translator's translatedAss does the same to the file).
const assWords = text => text.replace(/\{[^}]*}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').trim()
  .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const assLead = text => text.match(/^(?:\{[^}]*\})*/)[0].replace(/\\[kK][fo]?\d+/g, '').replace(/\{\}/g, '');
const dialogueText = cue => cue.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\{\\[^}]*\}/g, '')
  .replace(/^[ \t]+|[ \t]+$/gm, '').trim().replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, '\\N');

// Lines of the subtitle on screen in other words while libass draws it (a translation coming in): only the events whose
// words changed are set again, one by one as libass takes them, not the whole file. lines: Map of a line's words (as
// the VTT copy has them) → its new words as a VTT cue ('' hides the line). An event keeps its override tags at the
// start; a drawing (\p1) stays as it is.
async function setLines(lines) {
  const active = instance; if (!active) return;
  active.lilacEvents ??= active.renderer.getEvents().then(events => {
    const byWords = new Map();
    events.forEach((event, index) => { const words = assWords(event.Text || ''); if (words && !/\\p[1-9]/.test(event.Text)) byWords.set(words, [...(byWords.get(words) || []), index]); });
    return { events, byWords, shown: new Map() };
  });
  const { events, byWords, shown } = await active.lilacEvents; if (active !== instance) return;
  const changes = [];
  for (const [raw, text] of lines) {
    if (shown.get(raw) === text || !byWords.has(raw)) continue; shown.set(raw, text);
    const words = dialogueText(text);
    for (const index of byWords.get(raw)) { const event = events[index], lead = assLead(event.Text); changes.push(active.renderer.setEvent({ ...event, Text: words ? lead + words : '' }, index)); }
  }
  if (!changes.length) return;
  await Promise.all(changes);
  // Playing, the next frame draws them; paused, the picture is drawn again now.
  if (active === instance && active._video?.paused) active._demandRender(true).catch(() => {});
}

window.LilacAss = { attach, destroy, setVisible, setOffset, setLines, frame, get active() { return Boolean(instance); } };
window.dispatchEvent(new Event('lilac-ass-ready'));
