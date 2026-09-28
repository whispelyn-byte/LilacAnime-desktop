// Renders ASS/SSA subtitles with libass (JASSUB) over the player video, like the Android
// mpv engine: original position, colors, effects and fonts are preserved.
import JASSUB from './vendor/jassub/jassub.js';

let instance = null;
let fontUrl = null;

async function destroy() {
  const active = instance;
  instance = null;
  if (fontUrl) { URL.revokeObjectURL(fontUrl); fontUrl = null; }
  if (active) { try { await active.destroy(); } catch { /* already gone */ } }
}

// fonts: font file URLs shipped with the subtitle (e.g. from a fansub ZIP).
// defaultFont: { family, data } of the 기본 자막 폰트. It becomes libass' fallback for styles
// whose font is not installed, which also supplies Hangul glyphs. libass matches the fallback
// by its real family name, and the font has to be handed over as a URL (a blob), not raw bytes.
async function attach(video, { subUrl, fonts = [], defaultFont = null, offsetMs = 0, visible = true } = {}) {
  await destroy();
  const options = { video, subUrl, fonts, queryFonts: 'local' };
  if (defaultFont?.data && defaultFont.family) {
    fontUrl = URL.createObjectURL(new Blob([defaultFont.data], { type: 'font/ttf' }));
    const family = defaultFont.family.trim().toLowerCase();
    options.availableFonts = { [family]: fontUrl };
    options.defaultFont = family;
  }
  const created = new JASSUB(options);
  instance = created;
  await created.ready;
  if (instance !== created) return false;
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
