const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const section = (start, end) => { const first = source.indexOf(start), last = source.indexOf(end, first); assert.ok(first >= 0 && last > first, `Missing: ${start}`); return source.slice(first, last); };
// The production chooser with its store and the online search stubbed.
// other: the other sites' tracks of the episode (RE:Anime's, Miruro's).
function chooser(saved, online = {}, other = []) {
  const searched = [];
  const make = new Function('subtitleStore', 'downloadSubtitleKey', 'communitySearch', 'otherSiteKoreanTrack', 'saveRemoteSubtitle', 'remoteTrackOptions', 'subtitleResult', 'fs', `${section('const COMMUNITY_SOURCES=', '\n', 0)}\n${section('const DOWNLOAD_KOREAN_SOURCES=', '\n')}\n${section('const findDownloadSubtitle=', "  // One online source's Korean subtitle")}\nreturn findDownloadSubtitle;`);
  const find = make({ list: () => saved }, () => 'key', () => async name => { searched.push(name); if (online[name]) return { source: name, path: online[name] }; throw new Error('none'); },
    async () => { searched.push('other sites'); return other.find(track => /ko/i.test(track.language)) || null; }, async url => `${url}.vtt`, () => ({}), file => ({ path: file, assPath: null }), { existsSync: () => false });
  return { find, searched };
}

test('another site\'s Korean track comes after the saved Korean subtitles and before the blogs', async () => {
  const korean = { url: 'ko', language: 'ko', label: 'Korean', origin: 'miruro' };
  const first = chooser([], { kairan: 'kairan.vtt' }, [{ url: 'en', language: 'en', label: 'English' }, korean]);
  assert.deepEqual(await first.find({ subtitleSource: 'reanime' }, {}), { source: 'reanime', korean: true, path: 'ko.vtt', assPath: null, fonts: [], label: 'Miruro Korean 자막' });
  assert.deepEqual(first.searched, ['other sites']);
  const saved = chooser([{ source: 'kairan', path: 'kairan.vtt' }], {}, [korean]);
  assert.equal((await saved.find({ subtitleSource: 'reanime' }, {})).source, 'kairan'); assert.deepEqual(saved.searched, []);
  const off = chooser([], { kairan: 'kairan.vtt' }, [korean]);
  assert.equal((await off.find({ subtitleSource: 'reanime', otherSiteTracks: false }, {})).source, 'kairan'); assert.deepEqual(off.searched, ['kairan']);
  const site = chooser([], {}, [korean]);
  assert.deepEqual(await site.find({ subtitleSource: 'reanime' }, { subtitleUrl: 'file:///linkkf.vtt' }), { stream: true });
});

test('a Korean fansub online comes before a saved English track, so the download is not translated', async () => {
  const { find, searched } = chooser([{ source: 'reanime', path: 'english.vtt', label: 'Re:Anime English 자막' }], { csora: 'csora.ass' });
  assert.deepEqual(await find({ subtitleSource: 'reanime' }, {}), { source: 'csora', path: 'csora.ass' });
  assert.deepEqual(searched, ['other sites', 'kairan', 'csora']);
});

test('the saved non-Korean subtitle is kept when no Korean one is found', async () => {
  const { find } = chooser([{ source: 'jimaku', path: 'jimaku.vtt', label: 'Jimaku 자막' }]);
  assert.equal((await find({ subtitleSource: 'reanime' }, {})).source, 'jimaku');
});

test('Korean subtitles saved for the episode and the site Korean track come first, without searching', async () => {
  const saved = [{ source: 'reanime', path: 'english.vtt' }, { source: 'kairan', path: 'kairan.vtt' }];
  const first = chooser(saved);
  assert.equal((await first.find({ subtitleSource: 'reanime' }, {})).source, 'kairan');
  assert.deepEqual(first.searched, []);
  const site = chooser([{ source: 'reanime', path: 'english.vtt' }]);
  assert.deepEqual(await site.find({ subtitleSource: 'reanime' }, { subtitleUrl: 'file:///korean.vtt' }), { stream: true });
  const translated = chooser([{ source: 'gemini', path: 'ai.vtt' }]);
  assert.equal((await translated.find({ subtitleSource: 'reanime' }, {})).source, 'gemini');
});
