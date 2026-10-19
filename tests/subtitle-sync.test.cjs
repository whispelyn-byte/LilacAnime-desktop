const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retimeVtt, retimeAss, parseResult, vttCues } = require('../electron/subtitle-sync.cjs');

test('VTT: only the timing lines move, by the scale first and then the offset, and never below zero', () => {
  const vtt = 'WEBVTT\n\n1\n00:00:04.000 --> 00:00:07.500 line:85%\n12:00 시에\n\n00:01.000 --> 00:02.000\n둘째\n';
  assert.equal(retimeVtt(vtt, -3.09), 'WEBVTT\n\n1\n00:00:00.910 --> 00:00:04.410 line:85%\n12:00 시에\n\n00:00:00.000 --> 00:00:00.000\n둘째\n');
  assert.match(retimeVtt('00:00:10.000 --> 00:00:20.000\nx', 1, 1.001), /^00:00:11\.010 --> 00:00:21\.020/);
});

test('ASS: Dialogue and Comment times move, everything else (styles, tags, text with commas) stays', () => {
  const ass = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    + 'Dialogue: 0,0:00:07.20,0:00:10.64,Default,,0,0,0,,{\\an8}안녕, 0:00:01.00\nComment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,메모\nStyle: Default,Arial,60\n';
  const out = retimeAss(ass, -3.2);
  assert.match(out, /Dialogue: 0,0:00:04\.00,0:00:07\.44,Default,,0,0,0,,\{\\an8\}안녕, 0:00:01\.00\n/);
  assert.match(out, /Comment: 0,0:00:00\.00,0:00:00\.00,/);
  assert.match(out, /Style: Default,Arial,60\n$/);
});

test('ffsubsync output: offset and scale are read, also when its log line is broken', () => {
  assert.deepEqual(parseResult('INFO score: 12863.000\nINFO offset seconds: -3.090   ffsubsync.py:256\nINFO framerate scale factor: 1.000'), { offset: -3.09, scale: 1, score: 12863 });
  assert.equal(parseResult('INFO offset\n   seconds: 2.5').offset, 2.5);
  assert.equal(parseResult('error'), null);
});

test('VTT cues are read with hours or without', () => {
  assert.deepEqual(vttCues('WEBVTT\n\n00:01.500 --> 00:02.000\na\n\n01:00:00.000 --> 01:00:01,250\nb\n'), [[1.5, 2], [3600, 3601.25]]);
});

test('retime: a translation finished later gets the fix found for its source, as new files beside it', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createSubtitleSync } = require('../electron/subtitle-sync.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-retime-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const managedRoot = path.join(dir, 'subtitles'), translated = path.join(managedRoot, 'translated', 'abc.vtt');
  fs.mkdirSync(path.dirname(translated), { recursive: true }); fs.writeFileSync(translated, 'WEBVTT\n\n00:00:07.200 --> 00:00:10.640\n안녕\n');
  const sync = createSubtitleSync({ userData: dir, ffmpegPath: 'ffmpeg', managedRoot });
  const out = sync.retime({ subtitlePath: translated, offset: -3.2, scale: 1 });
  assert.equal(path.dirname(out.path), path.dirname(translated));
  assert.match(path.basename(out.path), /^abc\.sync-[a-z0-9]+\.vtt$/);
  assert.equal(fs.readFileSync(out.path, 'utf8'), 'WEBVTT\n\n00:00:04.000 --> 00:00:07.440\n안녕\n');
  assert.equal(fs.readFileSync(translated, 'utf8'), 'WEBVTT\n\n00:00:07.200 --> 00:00:10.640\n안녕\n');
  assert.throws(() => sync.retime({ subtitlePath: path.join(dir, 'missing.vtt'), offset: 1 }));
});

test('ffsubsync is matched with the dialogue lines only: captions, lyrics and signs are left out', () => {
  const { dialogueVtt } = require('../electron/subtitle-sync.cjs');
  const stamp = i => `00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000`;
  const lines = Array.from({ length: 60 }, (_, i) => `${stamp(i * 2)} --> ${stamp(i * 2 + 1)}\n${['（竜児）こんなもん…', 'つっかまえた～', '（拍手）', '♪ 歌詞', '{\\an8}看板', 'ハァ…'][i % 6]}`);
  const out = dialogueVtt(`WEBVTT\n\n${lines.join('\n\n')}\n`);
  const kept = out.split('\n').filter(line => !line.includes('-->') && line && line !== 'WEBVTT');
  assert.ok(kept.every(line => /こんなもん|つっかまえた/.test(line)), kept.join(' | '));
  assert.equal((out.match(/-->/g) || []).length, 20);
  // Too few dialogue lines: every line is kept.
  assert.equal((dialogueVtt(`WEBVTT\n\n${lines.slice(0, 6).join('\n\n')}\n`).match(/-->/g) || []).length, 6);
});

test('a site track ASS gives only its spoken lines: opening, ending and sign styles and placed lines are left out', () => {
  const { assDialogueVtt } = require('../electron/subtitle-sync.cjs');
  const time = t => `0:${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.00`;
  const row = (i, style, text) => `Dialogue: 0,${time(10 + i * 2)},${time(11 + i * 2)},${style},,0,0,0,,${text}`;
  // "Typeset": a sign style whose name says nothing, told by its placed lines.
  const styles = ['Default', 'OP Romaji', 'ED English-furigana', 'Signs', 'Default-Alt', 'Typeset'];
  const lines = Array.from({ length: 60 }, (_, i) => row(i, styles[i % 6], i % 6 === 5 ? '{\\pos(10,10)}Sign text' : `line ${i}`));
  const out = assDialogueVtt(`[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`);
  const kept = out.split('\n').filter(line => /^line /.test(line)).map(line => Number(line.slice(5)));
  assert.ok(kept.length === 20 && kept.every(i => i % 6 === 0 || i % 6 === 4), kept.join(','));
  // Fewer than 20 spoken lines: the VTT is used instead.
  assert.equal(assDialogueVtt(`[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.slice(0, 12).join('\n')}\n`), null);
});

test('segments: a line moves by the shift of the segment its start is in, its end with it', () => {
  const { retimeVtt, retimeAss, segmentsOf, shiftAt } = require('../electron/subtitle-sync.cjs');
  const segments = [{ from: 0, shift: -1 }, { from: 90, shift: 89.25 }];
  assert.equal(shiftAt(segments, 89.9), -1); assert.equal(shiftAt(segments, 90), 89.25);
  const vtt = 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\na\n\n00:01:58.500 --> 00:02:00.000\nb\n';
  assert.equal(retimeVtt(vtt, 89.25, 1, segments), 'WEBVTT\n\n00:00:09.000 --> 00:00:11.000\na\n\n00:03:27.750 --> 00:03:29.250\nb\n');
  assert.match(retimeAss('Dialogue: 0,0:01:58.50,0:02:00.00,Default,,0,0,0,,b', 0, 1, segments), /0:03:27\.75,0:03:29\.25/);
  const before = 'WEBVTT\n\n00:00:10.000 --> 00:00:11.000\na\n\n00:00:20.000 --> 00:00:21.000\nb\n\n00:02:00.000 --> 00:02:01.000\nc\n';
  const after = 'WEBVTT\n\n00:00:09.000 --> 00:00:10.000\na\n\n00:00:19.000 --> 00:00:20.000\nb\n\n00:03:29.250 --> 00:03:30.250\nc\n';
  assert.deepEqual(segmentsOf(before, after), [{ from: 10, shift: -1 }, { from: 120, shift: 89.25 }]);
});

test('fit score: the share of the lines that falls on the reference speech, moved as a candidate says', () => {
  const { fitScore, merged, mover } = require('../electron/subtitle-sync.cjs');
  const speech = merged([[10, 12], [11, 13], [20, 22]]);
  assert.deepEqual(speech, [[10, 13], [20, 22]]);
  const cues = [[9, 11], [19, 21]];
  assert.equal(fitScore(cues, speech), 0.5);
  assert.equal(fitScore(cues, speech, mover(1, 1)), 1);
  assert.equal(fitScore(cues, speech, mover(500, 1)), 0);
});

test('segments: stray blocks between the right ones are let go by the fit, short or out-of-order ones are not kept', () => {
  const { keptSegments, fitScore, mover } = require('../electron/subtitle-sync.cjs');
  // Lines at uneven times over 20 minutes (as speech is: an even rhythm would fit any shift of its step); the right
  // answer: 0 s, then +3 s from the first line at 600 s or after.
  let seed = 11; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cues = []; for (let t = 1; t < 1200; t += 2 + random() * 6) cues.push([t, t + 1 + random() * 2]);
  const turn = cues.find(([start]) => start >= 600)[0];
  const truth = [{ from: 0, shift: 0 }, { from: turn, shift: 3 }];
  const speech = cues.map(([s, e]) => [s + (s >= 600 ? 3 : 0), e + (s >= 600 ? 3 : 0)]);
  const score = parts => fitScore(cues, speech, mover(0, 1, parts));
  // Two blocks of a minute changing places, as ffsubsync's split did on Horimiya 1.
  const stray = [{ from: 0, shift: 0 }, { from: 300, shift: 60 }, { from: 360, shift: -60 }, { from: 420, shift: 0.1 }, { from: turn, shift: 3 }];
  assert.deepEqual(keptSegments(stray, cues, null, score), truth);
  // Against the audio a segment must start at an opening or ending: none near 600 s, so nothing is kept.
  assert.equal(keptSegments(truth, cues, [{ startTime: 90, endTime: 180 }], score), null);
  assert.deepEqual(keptSegments(truth, cues, [{ startTime: 510, endTime: 598 }], score), truth);
});

test('two parts: the head keeps its timing and the rest moves, at the line that fits best with the lines in order', () => {
  const { twoParts, fitScore, mover } = require('../electron/subtitle-sync.cjs');
  // A TV-made subtitle: right up to the opening (lines until 60 s), then 10 s late from the first line after it
  // (a sponsor card the web video has not), as All-Works Maid 5.
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cues = []; for (let t = 2; t < 1300; t += 2 + random() * 6) if (t < 60 || t > 170) cues.push([t, t + 1 + random() * 2]);
  const speech = cues.map(([s, e]) => s < 60 ? [s, e] : [s - 10, e - 10]);
  const parts = twoParts(cues, speech, 0, -10);
  assert.deepEqual(parts, [{ from: cues[0][0], shift: 0 }, { from: cues.find(([start]) => start > 170)[0], shift: -10 }]);
  assert.ok(fitScore(cues, speech, mover(0, 1, parts)) > fitScore(cues, speech, mover(-10, 1)));
  // A subtitle late all through: no line gives a better fit than the one shift.
  assert.equal(twoParts(cues, cues.map(([s, e]) => [s - 10, e - 10]), 0, -10), null);
});

test('aligned parts: any number of parts where the speech asks for them, and none where one shift fits', () => {
  const { alignedParts, merged } = require('../electron/subtitle-sync.cjs');
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cues = []; for (let t = 2; t < 1300; t += 2 + random() * 6) if (t < 60 || t > 170) cues.push([t, t + 1 + random() * 2]);
  // Right up to the opening, 10 s late after it, 13.5 s late from 800 s (a second card in the middle).
  const late = s => s < 60 ? 0 : s < 800 ? 10 : 13.5;
  const found = alignedParts(cues, merged(cues.map(([s, e]) => [s - late(s), e - late(s)])), { reach: 300, penalties: [6] })[0];
  assert.deepEqual(found.map(part => part.shift), [0, -10, -13.5]);
  assert.equal(found[1].from, cues.find(([start]) => start > 170)[0]);
  assert.equal(found[2].from, cues.find(([start]) => start >= 800)[0]);
  // Late 4 s all through: one part.
  assert.deepEqual(alignedParts(cues, merged(cues.map(([s, e]) => [s + 4, e + 4])), { reach: 300, penalties: [6] })[0].map(part => part.shift), [4]);
});

test('start score: the share of the lines starting within 0.3 s of a reference start, moved as a candidate says', () => {
  const { startScore } = require('../electron/subtitle-sync.cjs');
  const lines = [[10, 12], [20, 22], [30, 31], [40, 42]], starts = [10.2, 19.5, 30.25, 50];
  assert.equal(startScore(lines, starts), 0.5);
  assert.equal(startScore(lines, starts, time => time + 10), 0.5);
  assert.equal(startScore(lines, starts, time => time + 5), 0);
  assert.equal(startScore([], starts), 0);
});
