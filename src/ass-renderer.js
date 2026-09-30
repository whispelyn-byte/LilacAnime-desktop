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

window.LilacAss = { attach, destroy, setVisible, setOffset, get active() { return Boolean(instance); } };
window.dispatchEvent(new Event('lilac-ass-ready'));
