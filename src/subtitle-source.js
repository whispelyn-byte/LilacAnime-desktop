(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LilacSubtitleSource = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The best track of a language: dialogue ("Full", "Dialogue") before others, AI transcripts last, signs-only tracks
  // left out; the site's own tracks before another site's (crossSite: timed for that site's video).
  function track(tracks, language) {
    const label = item => `${item.label || ''} ${item.language || ''}`;
    const code = language === 'ja' ? /^(?:ja|jpn)(?:[-_]|$)/i : /^(?:en|eng)(?:[-_]|$)/i;
    const name = language === 'ja' ? /japanese|日本|일본/i : /english|영어/i;
    const rank = item => (item.crossSite ? 10 : 0) + (/dubtitle|\(ai\)|\bai\b/i.test(item.label || '') ? 2 : /dialogue|full/i.test(item.label || '') ? 0 : 1);
    return (tracks || []).filter(item => !/signs|songs|forced/i.test(item.label || '') && (code.test(item.language || '') || name.test(label(item))))
      .sort((a, b) => rank(a) - rank(b))[0] || null;
  }
  // The subtitle to translate from: the site's Japanese track, Jimaku's Japanese file, another site's Japanese track,
  // then the English tracks (the site's, another site's). tracks: the ones known now; laterTracks (optional): a promise
  // of the whole list once the ones still loading are in (another site's), waited for only after Jimaku.
  async function resolve({ tracks = [], laterTracks = null, getJimaku, readTrack, readJimaku, current = () => true }) {
    const tried = new Set();
    const attempt = async (read, value, source) => {
      if (!current() || !value || tried.has(value)) return null;
      tried.add(value);
      try { const file = await read(value); return file && current() ? { source, value, file } : null; } catch { return null; }
    };
    const own = list => (list || []).filter(item => !item.crossSite), other = list => (list || []).filter(item => item.crossSite);
    let found = await attempt(readTrack, track(own(tracks), 'ja'), 'track'); if (found || !current()) return found;
    const files = await Promise.resolve().then(getJimaku).catch(() => []);
    for (const file of files || []) {
      if (/(?:^|[. _-])(?:en|eng|english)(?:[. _-]|$)/i.test(file.name || '')) continue;
      found = await attempt(readJimaku, file, 'jimaku'); if (found || !current()) return found;
    }
    const all = laterTracks ? await Promise.resolve(laterTracks).catch(() => tracks) || tracks : tracks;
    if (!current()) return null;
    for (const pick of [track(own(all), 'ja'), track(other(all), 'ja'), track(own(all), 'en'), track(other(all), 'en')]) {
      found = await attempt(readTrack, pick, 'track'); if (found || !current()) return found;
    }
    return null;
  }
  return { track, resolve };
});
