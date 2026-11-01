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

// Every script the main process runs in a page, as the page receives it: it parses, and no regex escape was eaten by
// the template (a single "\d" in a template string reaches the page as "d", which still parses).
test('every script run in a page parses and keeps its regex escapes', () => {
  const dir = path.join(__dirname, '../electron'), problems = [];let count = 0;
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.cjs'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8'), opening = /executeJavaScript\(\s*`/g;let match;
    while ((match = opening.exec(text))) {
      let at = match.index + match[0].length, depth = 0, raw = '';
      for (; at < text.length; at++) {
        const char = text[at];
        if (char === '\\') { raw += char + text[at + 1]; at++; continue; }
        if (!depth && char === '`') break;
        if (char === '$' && text[at + 1] === '{') { depth++; raw += '${'; at++; continue; }
        if (depth && char === '}') { depth--; raw += '}'; continue; }
        raw += char;
      }
      count++;
      const where = `${name}:${text.slice(0, match.index).split('\n').length}`;
      const eaten = raw.match(/(?<!\\)\\[dDsSwWbB.?*+()[\]{}|/^]/g);
      if (eaten) problems.push(`${where} loses ${[...new Set(eaten)].join(' ')}`);
      const sent = eval('`' + raw.replace(/\$\{[^}]*\}/g, '"x"') + '`');
      try { new Function(sent); } catch (error) { try { new Function(`return (${sent})`); } catch { problems.push(`${where} does not parse: ${error.message}`); } }
    }
  }
  assert.ok(count >= 5, `found ${count} scripts`);
  assert.deepEqual(problems, []);
});
