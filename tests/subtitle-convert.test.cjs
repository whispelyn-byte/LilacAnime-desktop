const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
  return source.slice(first, last);
}
function converters() {
  const context = vm.createContext({ fs, path, TextDecoder });
  vm.runInContext(section('function readSubtitleText(', '// Android prepareSmiAsVttFile') + section('// Plain text as a VTT cue', '// Local audio analysis'), context);
  return context;
}
function fixture(t, name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-convert-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name); fs.writeFileSync(file, text); return file;
}
// Each cue's text as a VTT reader takes it: the lines after the timing up to the first blank line, references read.
function cues(vtt) {
  return fs.readFileSync(vtt, 'utf8').replace(/\r/g, '').trimEnd().split(/\n{2,}/).map(block => block.split('\n')).filter(lines => lines.some(line => line.includes('-->')))
    .map(lines => lines.slice(lines.findIndex(line => line.includes('-->')) + 1).join('\n'))
    .map(text => { assert.doesNotMatch(text, /<(?!\/?[a-z][^<>]*>)|-->/i, `a "<" or "-->" left in: ${text}`); return text.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); });
}

test('SMI: a <br> before a line break of the file keeps the next line, and references are kept as text', t => {
  const file = fixture(t, 'a.smi', '<SAMI><BODY>\r\n<SYNC Start=1000><P Class=KRCC>\r\n첫 줄<br>\r\n둘째 줄\r\n<SYNC Start=2000><P Class=KRCC>&nbsp;\r\n'
    + '<SYNC Start=3000><P Class=KRCC>가<br><br>나\r\n<SYNC Start=4000><P Class=KRCC>&lt;3 사랑해 &amp; a &lt; b<br>&#39;인용&#39; &#12354; --&gt; 끝\r\n'
    + '<SYNC Start=5000><P Class=KRCC><font color=pink>분홍<br></font>\r\n다음\r\n<SYNC Start=6000><P Class=KRCC>&nbsp;\r\n</BODY></SAMI>\r\n');
  assert.deepEqual(cues(converters().smiToVtt(file)), ['첫 줄\n둘째 줄', '가\n나', "<3 사랑해 & a < b\n'인용' あ → 끝", '분홍\n다음']);
});

test('SRT: <br> becomes a line break without a blank line, and a stray "<" or "-->" in the text does not hide it', t => {
  const file = fixture(t, 'a.srt', '1\r\n00:00:01,000 --> 00:00:02,000\r\n첫 줄<br>\r\n둘째 줄\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n<i>기울임</i><br><br>다음\r\n\r\n'
    + '3\r\n00:00:05,000 --> 00:00:06,000\r\n<3 사랑해 a < b\r\n<font color=red>빨강</font>\r\n\r\n4\r\n00:00:07,000 --> 00:00:08,000\r\n화살표 --> 끝\r\n\r\n');
  const vtt = converters().srtToVtt(file);
  assert.deepEqual(cues(vtt), ['첫 줄\n둘째 줄', '기울임\n다음', '<3 사랑해 a < b\n빨강', '화살표 → 끝']);
  assert.match(fs.readFileSync(vtt, 'utf8'), /00:00:07\.000 --> 00:00:08\.000/);
});

test('ASS shown as VTT: \\N\\N, "<" and "-->" keep their text, and a drawing is left out', t => {
  const file = fixture(t, 'a.ass', '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    + 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,첫 줄\\N\\N둘째 줄\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,<3 사랑해, a < b --> 끝\n'
    + 'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}글자만\n');
  assert.deepEqual(cues(converters().assToVtt(file)), ['첫 줄\n둘째 줄', '<3 사랑해, a < b → 끝', '글자만']);
});

test('a subtitle saved before the converter fix is converted again once from its original, a new one never', t => {
  const { SubtitleStore } = require('../electron/subtitle-store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-store-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = path.join(dir, 'old.vtt'), fresh = path.join(dir, 'new.vtt'); fs.writeFileSync(old, 'WEBVTT\n'); fs.writeFileSync(fresh, 'WEBVTT\n');
  fs.writeFileSync(path.join(dir, 'subtitle-store.json'), JSON.stringify({ ep: [{ id: 'a', source: 'kairan', label: 'Kairan', path: old }] }));
  const calls = [], app = { getPath: () => dir };
  const store = new SubtitleStore({ app, reconvert: file => calls.push(file) });
  store.save('ep', { source: 'csora', label: 'Csora', path: fresh });
  store.list('ep'); store.list('ep');
  assert.deepEqual(calls, [old]);
  assert.deepEqual(new SubtitleStore({ app, reconvert: file => calls.push(file) }).list('ep').map(entry => entry.converter), [2, 2]);
  assert.deepEqual(calls, [old], 'remembered after a restart');
});
