const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

// The script resolveStreamPage runs in every frame of a player page (click play, read jwplayer, list media requests) is
// a template string. With single backslashes its regex reached the page as "(?:?|$)": the script never parsed, so a
// player waiting for a click (vidmoly, Moon) was never found (Animenosub timed out after 46 s).
test('the stream page probe parses as the page receives it and finds a playlist address', () => {
  const start = "frame.executeJavaScript(`", first = source.indexOf(`${start}(()=>{document.querySelectorAll('video')`);
  assert.ok(first >= 0, 'probe script not found');
  const end = source.indexOf('`,true)', first), sent = eval('`' + source.slice(first + start.length, end) + '`');
  assert.doesNotThrow(() => new Function(sent));
  const filter = new Function('u', `return ${sent.match(/filter\(u=>(\/.+?\/i\.test\(u\))&&/)[1]}`);
  assert.equal(filter('https://cdn.example/hls2/a_,n,l,.urlset/master.m3u8?t=abc&s=1'), true);
  assert.equal(filter('https://cdn.example/video.mp4'), true);
  assert.equal(filter('https://cdn.example/player.js'), false);
  assert.match(source.slice(first - 400, first), /mainFrame\.framesInSubtree/);
});
