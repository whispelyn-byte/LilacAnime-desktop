// Renders ASS/SSA subtitles with libass (JASSUB) over the player video, like the Android
// mpv engine: original position, colors, effects and fonts are preserved.
import JASSUB from './vendor/jassub/jassub.js';

let instance = null;

async function destroy() {
  const active = instance;
  instance = null;
  if (active) { try { await active.destroy(); } catch { /* already gone */ } }
}

// fonts: font file URLs shipped with the subtitle (e.g. from a fansub ZIP).
// defaultFont: Uint8Array of the fallback font (libass' bundled font has no Hangul).
async function attach(video, { subUrl, fonts = [], defaultFont = null, offsetMs = 0, visible = true } = {}) {
  await destroy();
  const created = new JASSUB({
    video,
    subUrl,
    fonts,
    availableFonts: defaultFont ? { 'lilac default': defaultFont } : undefined,
    defaultFont: defaultFont ? 'lilac default' : undefined,
    queryFonts: 'local'
  });
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
