const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DownloadManager } = require('../electron/download-manager.cjs');

const own = { url: 'own-en', language: 'en', label: 'English' };
const otherKo = { url: 'other-ko', language: 'ko', label: 'Korean', crossSite: true, origin: 'reanime', referer: 'https://flixcloud.cc/e/x' };
const otherJa = { url: 'other-ja', language: 'ja', label: 'Japanese', crossSite: true, origin: 'miruro', referer: '' };
const otherEn = { url: 'other-en', language: 'en', label: 'English', crossSite: true, origin: 'reanime', referer: 'https://flixcloud.cc/e/x' };

function manager(t, { found = [otherKo, otherJa, otherEn], jimakuFound = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-other-tracks-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, '001화.mp4'); fs.writeFileSync(filePath, 'video');
  const calls = { saved: [], translated: [], asked: 0 };
  const job = { id: 'j', filePath, title: 'Show', episode: { number: 1 }, anime: {}, jimakuFound };
  const state = Object.assign(Object.create(DownloadManager.prototype), {
    jobs: [job], trackQueue: Promise.resolve(), save() {},
    otherSiteTracks: async () => { calls.asked++; return found; },
    saveTrack: async (url, referer) => { calls.saved.push(`${url}@${referer}`); const file = path.join(dir, `${url}.vtt`); fs.writeFileSync(file, 'WEBVTT'); return { path: file }; },
    translateTrack: async file => { calls.translated.push(path.basename(file)); const out = path.join(dir, 'ko.vtt'); fs.writeFileSync(out, 'WEBVTT'); return { path: out, engine: 'AI' }; },
    attachJimaku: async () => {}, jimakuTranslates: () => false
  });
  return { state, job, calls };
}

test('a site without tracks keeps all the other sites\' tracks; one with its own adds only a Korean one', async t => {
  const none = manager(t);
  assert.deepEqual((await none.state.withOtherSiteTracks(none.job, [])).map(track => track.url), ['other-ko', 'other-ja', 'other-en']);
  assert.deepEqual((await none.state.withOtherSiteTracks(none.job, [own])).map(track => track.url), ['own-en', 'other-ko']);
});

test('the other sites\' Korean tracks are added beside the site\'s Korean one too, and none when the setting was off', async t => {
  const state = manager(t);
  const own = { url: 'ko', language: 'ko', label: 'Korean' };
  assert.deepEqual((await state.state.withOtherSiteTracks(state.job, [own])).map(track => track.url), ['ko', 'other-ko']);
  assert.deepEqual(await state.state.withOtherSiteTracks({ ...state.job, otherSiteTracks: false }, []), []);
  assert.equal(state.calls.asked, 1);
});

test('saved tracks keep their site, and each file is fetched with its own Referer', async t => {
  const { state, job, calls } = manager(t);
  state.queueTracks(job, { subtitleTracks: [], referer: 'stream-referer' }); await state.trackQueue;
  assert.deepEqual(calls.saved, ['other-ko@https://flixcloud.cc/e/x', 'other-ja@stream-referer', 'other-en@https://flixcloud.cc/e/x']);
  assert.deepEqual(job.subtitleTracks.map(track => `${track.origin}:${track.crossSite}`), ['reanime:true', 'miruro:true', 'reanime:true']);
});

test('the translation takes the site\'s Japanese, then another site\'s Japanese before any English', async t => {
  const first = manager(t, { found: [otherEn, otherJa] });
  first.state.queueTracks(first.job, { subtitleTracks: [own] }); await first.state.trackQueue;
  // A site with its own tracks only gets another site's Korean one beside them: its own English is translated.
  assert.deepEqual(first.calls.translated, ['01_English.vtt']);
  const second = manager(t, { found: [otherEn, otherJa] });
  second.state.queueTracks(second.job, { subtitleTracks: [] }); await second.state.trackQueue;
  assert.equal(second.calls.translated.length, 1); assert.match(second.job.subtitleTracks.find(track => track.translatedPath).label, /Japanese/);
  const ownEnglish = manager(t, { found: [otherEn] });
  ownEnglish.state.queueTracks(ownEnglish.job, { subtitleTracks: [own] }); await ownEnglish.state.trackQueue;
  assert.match(ownEnglish.job.subtitleTracks.find(track => track.translatedPath).url, /^own-en$/);
});

test('nothing is translated for a video with Korean in the picture, though the tracks are kept', async t => {
  const { state, job, calls } = manager(t, { found: [otherJa] });
  job.burnedKorean = true;
  state.queueTracks(job, { subtitleTracks: [] }); await state.trackQueue;
  assert.equal(job.subtitleTracks.length, 1); assert.deepEqual(calls.translated, []);
});

test('a video with Korean in the picture is marked as such when its subtitle is checked', async t => {
  const { state, job } = manager(t);
  await state.attachSubtitle(job, { burnedKorean: true });
  assert.equal(job.burnedKorean, true); assert.equal(job.subtitleChecked, true);
});

test('another site\'s Korean track found for the download counts as the episode\'s Korean subtitle', async t => {
  const { state, job } = manager(t);
  Object.assign(state, { findSubtitle: async () => ({ source: 'reanime', korean: true, path: job.filePath, label: 'Re:Anime Korean 자막' }), copySubtitle() {} });
  await state.attachSubtitle(job, { subtitleTracks: [] });
  assert.equal(job.koreanSubtitle, true);
});
