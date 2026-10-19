// Subtitle sync to the episode's audio. sync(): ffsubsync over the whole episode (the player runs it for every
// subtitle put on, and for its button); the offset it finds is then applied to the VTT and the ASS beside it, so
// styles, fonts and effects stay as they are. ffsubsync runs in its own Python, installed once under userData/tools by uv.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fileURLToPath, pathToFileURL } = require('url');
const { dropCaptions } = require('./subtitle-translator.cjs');

const UV_VERSION = '0.13.1', FFSUBSYNC_VERSION = '0.5.1', PYTHON_VERSION = '3.12';
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';

function uvAsset() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return MAC ? `uv-${arch}-apple-darwin.tar.gz` : WIN ? `uv-${arch}-pc-windows-msvc.zip` : `uv-${arch}-unknown-linux-gnu.tar.gz`;
}

// A file: URL is given to FFmpeg as its path; the headers go only to a remote stream (the local proxy needs none).
function ffmpegInput(url, headers = {}) {
  if (/^file:/i.test(url)) return { input: fileURLToPath(url), args: [] };
  const args = [], lines = /^https?:\/\/127\.0\.0\.1:/i.test(url) ? '' : Object.entries(headers || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  if (lines) args.push('-headers', `${lines}\r\n`);
  if (/^https?:/i.test(url)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  return { input: url, args };
}

function seconds(stamp) {
  const parts = String(stamp).trim().replace(',', '.').split(':').map(Number);
  return parts.reduce((sum, value) => sum * 60 + value, 0);
}
function vttStamp(value) {
  const ms = Math.max(0, Math.round(value * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
function assStamp(value) {
  const cs = Math.max(0, Math.round(value * 100)), h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

// The cues' [start, end] of a VTT, in seconds.
function vttCues(text) {
  const cues = [], pattern = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/gm;
  for (let match; (match = pattern.exec(text));) { const start = seconds(match[1]), end = seconds(match[2]); if (end > start) cues.push([start, end]); }
  return cues;
}

// The cues ffsubsync is matched with: dialogue only. Sound captions and speaker-only lines（拍手）, song lyrics (♪) and
// signs at the top ({\an8}) are on screen while nobody talks; they are left out (all cues are kept when that would
// leave fewer than 20, or under a third of them).
function dialogueVtt(text) {
  const blocks = String(text).replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/), cues = [];
  for (const block of blocks) {
    const lines = block.split('\n'), at = lines.findIndex(line => line.includes('-->'));
    if (at < 0) continue;
    const body = lines.slice(at + 1).join('\n'), plain = body.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '');
    cues.push({ timing: lines[at], body, dialogue: !/\{\\an[789]\}/.test(body) && !/[♪♫]/.test(plain) && Boolean(dropCaptions(plain)) });
  }
  const dialogue = cues.filter(cue => cue.dialogue), use = dialogue.length >= 20 && dialogue.length >= cues.length / 3 ? dialogue : cues;
  return `WEBVTT\n\n${use.map(cue => `${cue.timing}\n${cue.body || 'x'}\n`).join('\n')}`;
}

// Style names that say a line is not speech: opening and ending songs (a fansub's "OP Romaji", "ED English"), signs,
// songs, karaoke, titles, notes. Names differ from one fansub to the next ("neo OE", "iFanzSigns", "SS_ED1",
// "RESURECTION" for an insert song), so a style is also judged by its lines (see speechStyles).
const NOT_SPEECH_STYLE = /(^|[^a-z])(op|ed)([^a-z]|$)|opening|ending|sign|song|karaoke|kara([^a-z]|$)|lyric|title|insert|logo|eyecatch|preview|note|kfx/i;
// Tags of lines placed, drawn or sung on the picture: signs and karaoke, not speech.
const PLACED = /\\(pos|move|an[789]|p[1-9]|i?clip|org|k[fo]?\d|K\d)/;
// An ASS file's lines: [{style, start, end, text, words}].
function assLines(text) {
  let fields = null, events = false; const rows = [];
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^\[events\]/i.test(line)) { events = true; continue; }
    if (/^\[/.test(line)) { events = false; continue; }
    if (!events) continue;
    if (/^format:/i.test(line)) { fields = line.slice(line.indexOf(':') + 1).split(',').map(field => field.trim().toLowerCase()); continue; }
    if (!/^dialogue:/i.test(line) || !fields) continue;
    const parts = line.slice(line.indexOf(':') + 1).split(','), row = {};
    fields.forEach((field, i) => { row[field] = i === fields.length - 1 ? parts.slice(i).join(',') : (parts[i] || '').trim(); });
    const start = seconds(String(row.start || '').replace(/:(\d+)$/, '.$1')), end = seconds(String(row.end || '').replace(/:(\d+)$/, '.$1'));
    const words = String(row.text || '').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, ' ').replace(/\\h/g, ' ').trim();
    if (end > start) rows.push({ style: String(row.style || ''), start, end, text: String(row.text || ''), words });
  }
  return rows;
}
// The styles that hold the speech: not named as signs or songs, few lines placed or sung on the picture (under 30%),
// and spread over the episode (a third of it at least: an opening's lyrics sit in a minute and a half). When none
// is, the style with the most plain lines.
function speechStyles(rows) {
  const styles = new Map();
  for (const row of rows) { const s = styles.get(row.style) || { lines: 0, placed: 0, first: Infinity, last: -Infinity }; s.lines++; if (PLACED.test(row.text)) s.placed++; s.first = Math.min(s.first, row.start); s.last = Math.max(s.last, row.start); styles.set(row.style, s); }
  const starts = rows.map(row => row.start), span = Math.max(...starts) - Math.min(...starts);
  const speech = [...styles].filter(([name, s]) => !NOT_SPEECH_STYLE.test(name) && s.lines >= 5 && s.placed / s.lines < 0.3 && s.last - s.first >= span / 3).map(([name]) => name);
  if (speech.length) return new Set(speech);
  const plain = [...styles].sort((a, b) => (b[1].lines - b[1].placed) - (a[1].lines - a[1].placed))[0];
  return new Set(plain ? [plain[0]] : []);
}
// An ASS file's spoken lines as [start, end, words]: the speech styles' lines not placed on the picture, each once
// (typesetting repeats a line in layers).
function assSpeech(text) {
  const rows = assLines(text);
  if (!rows.length) return [];
  const styles = speechStyles(rows), seen = new Set(), cues = [];
  for (const row of rows) {
    const key = `${row.start}|${row.end}|${row.words}`;
    if (!styles.has(row.style) || PLACED.test(row.text) || !row.words || seen.has(key)) continue;
    seen.add(key); cues.push([row.start, row.end, row.words]);
  }
  return cues.sort((a, b) => a[0] - b[0]);
}
// An ASS file's spoken lines as a VTT for ffsubsync; null when it has fewer than 20.
function assDialogueVtt(text) {
  const cues = assSpeech(text);
  return cues.length >= 20 ? `WEBVTT\n\n${cues.map(([start, end, words]) => `${vttStamp(start)} --> ${vttStamp(end)}\n${words}\n`).join('\n')}` : null;
}
// The spoken lines of a subtitle: from the ASS beside it when there is one (its styles tell), else from the VTT.
function spokenVtt(vttPath, assPath = null) {
  const ass = assPath && fs.existsSync(assPath) ? assPath : vttPath.replace(/\.vtt$/i, '.ass');
  if (ass !== vttPath && fs.existsSync(ass)) { const found = assDialogueVtt(fs.readFileSync(ass, 'utf8')); if (found) return found; }
  return dialogueVtt(fs.readFileSync(vttPath, 'utf8'));
}

// How much a line moves: one offset (and scale) for the whole file, or by segments [{from, shift}] in the file's own
// time (a site's video with an opening the subtitle's release has not): a line takes the shift of the segment its
// start is in, and its end moves with it.
const shiftAt = (segments, time) => { let shift = segments[0].shift; for (const segment of segments) { if (segment.from <= time + 1e-6) shift = segment.shift; else break; } return shift; };
const mover = (offset, scale, segments) => segments?.length > 1 ? (time, start) => time + shiftAt(segments, start) : time => time * scale + offset;
// time → time * scale + offset (ffsubsync's order: the scale first, then the offset), on the timing lines only.
function retimeVtt(text, offset, scale = 1, segments = null) {
  const move = mover(offset, scale, segments), stamp = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/g;
  return text.split('\n').map(line => {
    if (!line.includes('-->')) return line;
    const start = seconds(line.match(stamp)?.[0] || '0');
    return line.replace(stamp, value => vttStamp(move(seconds(value), start)));
  }).join('\n');
}
function retimeAss(text, offset, scale = 1, segments = null) {
  const move = mover(offset, scale, segments), time = value => seconds(value.replace(/:(\d+)$/, '.$1'));
  return text.replace(/^((?:Dialogue|Comment):\s*[^,\r\n]*,)(\d+:\d{2}:\d{2}[.:]\d{1,3}),(\d+:\d{2}:\d{2}[.:]\d{1,3})/gim,
    (_, head, start, end) => `${head}${assStamp(move(time(start), time(start)))},${assStamp(move(time(end), time(start)))}`);
}
// Speech intervals [start, end], sorted and merged.
function merged(intervals) {
  const out = [];
  for (const [start, end] of [...intervals].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else out.push([start, end]);
  }
  return out;
}
// How well a subtitle fits the reference speech: the share of its lines' time that falls on speech (a site track's
// dialogue lines, or the speech found in the audio), with its lines moved as a candidate says (move(time, start)).
// The same measure for every candidate (no change, one shift, segments, another frame rate), so they can be compared.
function fitScore(cues, speech, move = time => time) {
  let total = 0, hit = 0;
  for (const [start, end] of cues) {
    const from = move(start, start), to = move(end, start);
    if (to <= from) continue;
    total += to - from;
    let low = 0, high = speech.length;
    while (low < high) { const mid = (low + high) >> 1; if (speech[mid][1] <= from) low = mid + 1; else high = mid; }
    for (let i = low; i < speech.length && speech[i][0] < to; i++) hit += Math.max(0, Math.min(to, speech[i][1]) - Math.max(from, speech[i][0]));
  }
  return total ? hit / total : 0;
}
// Two parts from two shifts already found: the lines before one line take shift `a`, that line and the rest `b`, at
// the line where the fit is best (each line's speech under either shift, summed up to it). An episode's head may keep
// its timing while the rest moves: a TV-made subtitle has the sponsor card after the opening (提供, ~10 s) the web video
// has not (Heroine? Saint? No, I'm an All-Works Maid 4 and 5: the part before the opening right, the rest 10.1 s late).
// Each part's rules are keptSegments'. null when no line gives a better fit than either shift alone.
function twoParts(lines, speech, a, b) {
  const cues = lines.slice().sort((x, y) => x[0] - y[0]);
  const hits = shift => cues.map(cue => fitScore([cue], speech, time => time + shift) * (cue[1] - cue[0]));
  const before = hits(a), after = hits(b);
  let head = 0, tail = after.reduce((sum, hit) => sum + hit, 0), end = -Infinity, best = null;
  for (let k = 1; k < cues.length; k++) {
    head += before[k - 1]; tail -= after[k - 1]; end = Math.max(end, cues[k - 1][1]);
    // Only where the lines stay in order (as keptSegments asks): the first line moved by b not before the last by a.
    if (cues[k][0] + b < end + a - 1) continue;
    if (head + tail > (best?.hit ?? Math.max(before.reduce((s, h) => s + h, 0), after.reduce((s, h) => s + h, 0)))) best = { hit: head + tail, k };
  }
  return best ? [{ from: cues[0][0], shift: a }, { from: cues[best.k][0], shift: b }] : null;
}
// The share of the lines whose start, moved, falls within 0.3 s of a start in the reference (sorted): a TV-made
// subtitle's lines start within 0.3 s of the site track's for 58-64%, a web one's for 70-90% (All-Works Maid, Frieren,
// Horimiya), and a wrong shift puts few there.
function startScore(lines, starts, move = time => time) {
  let hit = 0;
  for (const [start] of lines) {
    const time = move(start, start); let low = 0, high = starts.length;
    while (low < high) { const mid = (low + high) >> 1; if (starts[mid] < time - 0.3) low = mid + 1; else high = mid; }
    if (low < starts.length && starts[low] <= time + 0.3) hit++;
  }
  return lines.length ? hit / lines.length : 0;
}
// The seconds of speech (merged, in order) within from..to.
function speechHit(speech, from, to) {
  let low = 0, high = speech.length, hit = 0;
  while (low < high) { const mid = (low + high) >> 1; if (speech[mid][1] <= from) low = mid + 1; else high = mid; }
  for (let i = low; i < speech.length && speech[i][0] < to; i++) hit += Math.max(0, Math.min(to, speech[i][1]) - Math.max(from, speech[i][0]));
  return hit;
}
// The shifts along a whole episode against a site track, found directly (dynamic programming over its lines) instead
// of by ffsubsync's split, which found nothing on All-Works Maid 5 and stray blocks on Horimiya 1: each line takes one of
// the shifts within ±reach (0.1 s apart); keeping the shift of the line before costs nothing, changing it costs
// `penalty` seconds of speech (what the change must win back), and no change moves a line before the end of the lines
// before it. Any number of parts, where the speech asks for them. One result per penalty (the same table of each
// line's speech at each shift serves them all); each part's shift is then refined to 0.01 s on its own lines. The
// results are candidates like the others: keptSegments, the fit and the gain on the lines moved differently judge them.
function alignedParts(lines, speech, { reach = 300, penalties = [3, 6, 12] } = {}) {
  const cues = lines.slice().sort((x, y) => x[0] - y[0]).filter(([start, end]) => end > start), n = cues.length, step = 0.1;
  if (n < 2 || !speech.length) return [];
  const count = Math.round(2 * reach / step) + 1, shiftOf = j => Math.round((j * step - reach) * 100) / 100;
  const hits = new Float32Array(n * count);
  for (let i = 0; i < n; i++) for (let j = 0; j < count; j++) hits[i * count + j] = speechHit(speech, cues[i][0] + shiftOf(j), cues[i][1] + shiftOf(j));
  const linesHit = (from, to, shift) => { let hit = 0; for (let i = from; i < to; i++) hit += speechHit(speech, cues[i][0] + shift, cues[i][1] + shift); return hit; };
  return penalties.map(penalty => {
    let prev = new Float64Array(count), next = new Float64Array(count);
    const switched = new Uint8Array(n * count), source = new Uint16Array(n * count), best = new Float64Array(count), arg = new Uint16Array(count);
    for (let j = 0; j < count; j++) prev[j] = hits[j];
    let end = cues[0][1];
    for (let i = 1; i < n; i++) {
      for (let j = 0; j < count; j++) if (!j || prev[j] > best[j - 1]) { best[j] = prev[j]; arg[j] = j; } else { best[j] = best[j - 1]; arg[j] = arg[j - 1]; }
      // From shift a to b at this line: its start moved by b not before the end so far moved by a (1 s of overlap
      // allowed, as keptSegments), so a ≤ b + gap + 1: the best of the shifts up to that one.
      const gap = cues[i][0] - end;
      for (let j = 0; j < count; j++) {
        const limit = Math.min(count - 1, Math.floor((shiftOf(j) + gap + 1 + reach) / step + 1e-6));
        let value = prev[j];
        if (limit >= 0 && best[limit] - penalty > value) { value = best[limit] - penalty; switched[i * count + j] = 1; source[i * count + j] = arg[limit]; }
        next[j] = value + hits[i * count + j];
      }
      end = Math.max(end, cues[i][1]);
      [prev, next] = [next, prev];
    }
    let j = 0; for (let k = 1; k < count; k++) if (prev[k] > prev[j]) j = k;
    const taken = new Array(n);
    for (let i = n - 1; i >= 0; i--) { taken[i] = j; if (i && switched[i * count + j]) j = source[i * count + j]; }
    const parts = [];
    for (let i = 0; i < n; i++) if (!i || taken[i] !== taken[i - 1]) parts.push({ index: i, shift: shiftOf(taken[i]) });
    return parts.map((part, k) => {
      const to = k + 1 < parts.length ? parts[k + 1].index : n;
      let shift = part.shift, top = -1;
      for (let d = -10; d <= 10; d++) { const value = Math.round((part.shift + d / 100) * 100) / 100, hit = linesHit(part.index, to, value); if (hit > top) { top = hit; shift = value; } }
      return { from: cues[part.index][0], shift };
    });
  });
}
// Segments a candidate may keep: each with 8 lines of the subtitle at least (and 45 s, against the audio: against a site
// track a short part is judged by its own fit, as All-Works Maid 6's 26 s before the opening), never moving a line before the
// end of the segment before it (lines stay in order), and, against the audio, each new segment starting at an opening
// or ending (chapters: AniSkip times in the video) within 20 s, as the audio alone split Oshi no Ko 1 at -102 s and
// +129 s. ffsubsync's split puts stray segments between the right ones: in Horimiya 1 two blocks of a minute changed
// places (+143.89 s, then -139.74 s) between 0 and +2.83 s. So while a segment breaks a rule, one segment is let go
// (its lines take the shift of the one before it; the first, of the one after), the one whose going leaves the best
// fit (score(parts)), and neighbours within 0.3 s become one. null when nothing is left to split.
function keptSegments(segments, cues, chapters = null, score = () => 0) {
  const edges = chapters ? chapters.flatMap(chapter => [Number(chapter.startTime), Number(chapter.endTime)]).filter(Number.isFinite) : null;
  const join = parts => { const out = []; for (const segment of parts) { const last = out[out.length - 1]; if (!last || Math.abs(last.shift - segment.shift) > 0.3) out.push(segment); } return out; };
  const linesOf = (parts, i) => cues.filter(([start]) => start >= (i ? parts[i].from : -Infinity) && (i + 1 >= parts.length || start < parts[i + 1].from));
  const broken = parts => parts.some((_, i) => {
    const lines = linesOf(parts, i);
    if (lines.length < 8 || (edges && lines[lines.length - 1][0] - lines[0][0] < 45)) return true;
    if (!i) return false;
    const before = linesOf(parts, i - 1), endBefore = Math.max(...before.map(([, end]) => end)) + parts[i - 1].shift, startHere = lines[0][0] + parts[i].shift;
    if (startHere < endBefore - 1) return true;
    return Boolean(edges && !edges.some(edge => Math.abs(edge - startHere) <= 20 || Math.abs(edge - endBefore) <= 20));
  });
  let parts = join(segments.map(segment => ({ ...segment })));
  for (let guard = 0; parts.length > 1 && broken(parts) && guard < 30; guard++) {
    const options = parts.map((_, i) => join(i ? parts.filter((__, k) => k !== i) : [{ ...parts[1], from: parts[0].from }, ...parts.slice(2)]));
    parts = options.map(option => ({ option, fit: score(option) })).sort((a, b) => b.fit - a.fit)[0].option;
  }
  return parts.length > 1 && !broken(parts) ? parts : null;
}
// The segments ffsubsync's split alignment made: each line of the file it was given against the same line in what it
// wrote, a new segment where the shift changes by more than 0.2 s.
function segmentsOf(before, after) {
  const read = text => String(text).replace(/\r/g, '').split(/\n{2,}/).map(block => {
    const lines = block.split('\n'), at = lines.findIndex(line => line.includes('-->'));
    return at < 0 ? null : { start: seconds(lines[at].split('-->')[0]), text: lines.slice(at + 1).join('\n').trim() };
  }).filter(Boolean);
  const a = read(before), b = read(after), segments = [], taken = new Set();
  for (const [i, line] of a.entries()) {
    const k = b[i]?.text === line.text && !taken.has(i) ? i : b.findIndex((other, j) => !taken.has(j) && other.text === line.text);
    if (k < 0) continue;
    taken.add(k);
    const shift = Math.round((b[k].start - line.start) * 100) / 100;
    if (!segments.length || Math.abs(shift - segments[segments.length - 1].shift) > 0.2) segments.push({ from: line.start, shift });
  }
  return segments;
}
// The file's bytes are kept: UTF-16 is read as such, anything else byte for byte (the times are ASCII), so a CP949
// or Shift-JIS ASS comes out in its own encoding.
function rewrite(source, target, change) {
  const raw = fs.readFileSync(source), utf16 = raw[0] === 0xff && raw[1] === 0xfe, encoding = utf16 ? 'utf16le' : 'latin1';
  fs.writeFileSync(target, Buffer.from(change(raw.toString(encoding)), encoding));
}

// ffsubsync's "offset seconds: -3.090" and "framerate scale factor: 1.000" (rich may break a log line: it is joined
// first).
function parseResult(output) {
  const flat = String(output).replace(/\r/g, '').replace(/\s*\n\s*/g, ' ');
  const offset = flat.match(/offset seconds:\s*(-?\d+(?:\.\d+)?)/i), scale = flat.match(/framerate scale factor:\s*(\d+(?:\.\d+)?)/i), score = flat.match(/score:\s*(-?\d+(?:\.\d+)?)/i);
  return offset ? { offset: Number(offset[1]), scale: scale ? Number(scale[1]) : 1, score: score ? Number(score[1]) : null } : null;
}

function createSubtitleSync({ userData, ffmpegPath, managedRoot }) {
  const root = path.join(userData, 'tools', 'ffsubsync'), marker = path.join(root, 'installed.json');
  const venv = path.join(root, 'venv'), exe = path.join(venv, WIN ? 'Scripts' : 'bin', WIN ? 'ffsubsync.exe' : 'ffsubsync');
  const uvEnv = () => ({ ...process.env, UV_CACHE_DIR: path.join(root, 'cache'), UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_NO_PROGRESS: '1' });
  const children = new Set();
  let installing = null, running = null; const waiting = []; // [{resolve, background}]

  function installed() {
    try { return JSON.parse(fs.readFileSync(marker, 'utf8')).ffsubsync === FFSUBSYNC_VERSION && fs.existsSync(exe); } catch { return false; }
  }
  // quiet: ms without any output after which the program is taken as stuck and stopped (FFmpeg reading a stream
  // reports its progress every half second; a stream that stops sending would leave it waiting for ever).
  function run(command, args, { env = process.env, signal = null, onOutput = () => {}, stdout = 'pipe', quiet = 0 } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error('취소했습니다.'), { canceled: true }));
      const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', stdout, 'pipe'] }); children.add(child);
      let output = '', heard = Date.now(), stuck = false;
      const take = chunk => { heard = Date.now(); const text = chunk.toString('utf8'); output = (output + text).slice(-20000); onOutput(text); };
      child.stderr.on('data', take); if (stdout === 'pipe') child.stdout.on('data', take);
      const watch = quiet ? setInterval(() => { if (Date.now() - heard > quiet) { stuck = true; child.kill(); } }, Math.min(quiet, 5000)) : null;
      const abort = () => child.kill();
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', error => { clearInterval(watch); children.delete(child); reject(error); });
      child.once('close', code => {
        clearInterval(watch); children.delete(child); signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(Object.assign(new Error('취소했습니다.'), { canceled: true }));
        else if (stuck) reject(new Error('영상 음성을 받다가 멈췄어요 (스트림 연결이 끊긴 것 같아요).'));
        else if (code === 0) resolve(output);
        else reject(new Error(output.trim().split('\n').slice(-4).join(' ').slice(-400) || `${path.basename(command)} ${code}`));
      });
    });
  }
  async function download(url, target, progress) {
    const response = await fetch(url, { headers: { 'User-Agent': 'LilacAnime-Desktop' }, redirect: 'follow' });
    if (!response.ok) throw new Error(`uv를 받지 못했습니다 (${response.status})`);
    const total = Number(response.headers.get('content-length')) || 0, out = fs.createWriteStream(target); let done = 0;
    for await (const chunk of response.body) { done += chunk.length; if (!out.write(chunk)) await new Promise(r => out.once('drain', r)); if (total) progress(done / total); }
    await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
  }
  function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findFile(file, name); if (found) return found; } else if (entry.name === name) return file;
    }
    return null;
  }
  // uv (one program) → its own Python 3.12 → a venv with ffsubsync. Its download cache is removed afterwards.
  function install(status = () => {}) {
    if (installed()) return Promise.resolve();
    if (!installing) installing = (async () => {
      fs.mkdirSync(root, { recursive: true });
      const asset = uvAsset(), archive = path.join(root, asset), unpacked = path.join(root, 'uv');
      status('uv 받는 중', 0);
      await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`, archive, done => status('uv 받는 중', done * 0.3));
      fs.rmSync(unpacked, { recursive: true, force: true }); fs.mkdirSync(unpacked, { recursive: true });
      const tar = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
      try { await run(tar, [WIN ? '-xf' : '-xzf', archive, '-C', unpacked]); } finally { fs.rmSync(archive, { force: true }); }
      const uv = findFile(unpacked, WIN ? 'uv.exe' : 'uv');
      if (!uv) throw new Error('uv 실행 파일을 찾지 못했습니다.');
      if (!WIN) fs.chmodSync(uv, 0o755);
      status('Python 준비 중', 0.35);
      fs.rmSync(venv, { recursive: true, force: true });
      await run(uv, ['venv', '--python', PYTHON_VERSION, '--managed-python', venv], { env: uvEnv() });
      status('ffsubsync 설치 중', 0.6);
      await run(uv, ['pip', 'install', '--python', path.join(venv, WIN ? 'Scripts/python.exe' : 'bin/python'), `ffsubsync==${FFSUBSYNC_VERSION}`], { env: uvEnv() });
      if (!fs.existsSync(exe)) throw new Error('ffsubsync 설치를 마치지 못했습니다.');
      // uv itself is not needed to run ffsubsync (its Python stays: the venv runs on it).
      for (const dir of ['cache', 'uv']) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
      fs.writeFileSync(marker, JSON.stringify({ uv: UV_VERSION, ffsubsync: FFSUBSYNC_VERSION, python: PYTHON_VERSION, at: Date.now() }));
      status('ffsubsync 설치 완료', 1);
    })().finally(() => { installing = null; });
    return installing;
  }

  // The episode's audio as 16 kHz stereo WAV (the centre is taken from it, see sync); progress from FFmpeg's time=
  // against the duration.
  async function extractAudio(videoUrl, headers, duration, target, status, signal) {
    const { input, args } = ffmpegInput(videoUrl, headers);
    await run(ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args, '-i', input, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '16000', '-c:a', 'pcm_s16le', target], {
      signal, quiet: 90000, onOutput: text => { const time = text.match(/time=(\d+:\d{2}:\d{2}(?:\.\d+)?)/g)?.pop(); if (time && duration > 0) status('영상 음성 읽는 중', Math.min(1, seconds(time.slice(5)) / duration)); },
    });
  }

  // Where the synced copy goes: beside its original when that is the app's own (an ASS keeps the folder with its
  // fonts), else under subtitles/synced. ".sync-<time>" makes a new name each run, so the player does not show a
  // cached copy; earlier runs are left for 자막 정리.
  function syncedName(file) {
    const own = path.resolve(file).startsWith(path.resolve(managedRoot) + path.sep);
    const dir = own ? path.dirname(file) : path.join(managedRoot, 'synced'), ext = path.extname(file);
    const base = path.basename(file, ext).replace(/\.sync-[a-z0-9]+$/i, '');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${base}.sync-${Date.now().toString(36)}${ext}`);
  }

  // The speech found in an audio file (16 kHz mono WAV) by WebRTC's voice detector, as [start, end] intervals: the
  // reference the candidates are scored against when there is no site track (ffsubsync's own Python runs it).
  async function speechIn(wav, signal) {
    const script = path.join(path.dirname(wav), 'speech.py'), python = path.join(venv, WIN ? 'Scripts/python.exe' : 'bin/python');
    fs.writeFileSync(script, [
      'import sys, json, wave, webrtcvad',
      'w = wave.open(sys.argv[1], "rb"); rate = w.getframerate(); vad = webrtcvad.Vad(2)',
      'step = int(rate * 0.03); data = w.readframes(w.getnframes()); out = []; start = None',
      'for i in range(0, len(data) // 2 - step + 1, step):',
      '    t = i / rate; speech = vad.is_speech(data[i * 2:(i + step) * 2], rate)',
      '    if speech and start is None: start = t',
      '    if not speech and start is not None: out.append([round(start, 2), round(t, 2)]); start = None',
      'if start is not None: out.append([round(start, 2), round(len(data) / 2 / rate, 2)])',
      'print(json.dumps(out))',
    ].join('\n'));
    const output = await run(python, [script, wav], { signal, env: { ...process.env, PYTHONUTF8: '1' } });
    return merged(JSON.parse(output.trim().split('\n').pop()));
  }

  // subtitlePath: the VTT on screen; assPath: its ASS, retimed the same way; timingPath: the file a translation was made
  // from (its Japanese lines tell dialogue from captions better; the times are the same). references: the site's own
  // tracks ([{path, assPath}], Re:Anime / Miruro, timed to this video), of which the one with the most spoken lines is
  // the reference; without one, the audio (videoUrl). chapters: the episode's opening and ending (AniSkip), where the
  // audio may split.
  //
  // Candidates are found by ffsubsync and then scored the same way (fitScore: the share of the subtitle's dialogue
  // that falls on the reference's speech), and the best one is used only when it is clearly better than leaving the
  // subtitle as it is. What was learned on real episodes:
  // - The frame rate is not changed blindly: on Toradora! 1 ffsubsync's 1.042 correction moved the lines 28 s the
  //   wrong way. A changed frame rate is one candidate among the others, against a site track only.
  // - A subtitle's own captions, lyrics and signs, and a site track's opening, ending and sign lines (see speechStyles),
  //   are left out: nobody speaks in them.
  // - The shift may change along the episode (Toradora! 1: an 89 s opening in the video the Netflix-made subtitle has
  //   not; Horimiya 1: 2.8 s more after its middle), so segments are a candidate too (--split-penalty), kept only as
  //   keptSegments allows.
  // - How far to look is not one number: an intro may be longer than any limit, but one search over the whole episode
  //   gave The Apothecary Diaries 1 -1251 s (every line off the picture). So one shift is looked for within 60 s, 5
  //   minutes and the whole episode, and the scores choose.
  // - Against the audio, the centre of the stereo mix (where dialogue sits) is heard: the whole mix swung Toradora! 1
  //   between -1.3 and +44 s.
  // Thresholds from 8 episodes against their site tracks: a right shift raised the score by 0.06 to 0.17 (to 0.89 and
  // over), a subtitle already right by under 0.003. Each part of segments must gain as much as a right shift does
  // (0.06) on its own lines, by the overlap and by the starts. Checked on 66 subtitles of 31 episodes (12 titles, web and
  // TV-made Jimaku files): the right parts gained 0.10 to 0.63 by both, the wrong ones lost 0.43 and 0.50 by the starts,
  // and no subtitle right with one shift was split; the 120 s windows left off after a sync went from 16 to 6, those
  // six where the site track has no lines (All-Works Maid 3 from 14:53 to 15:53) or both of an episode's files agree.
  const FIT = { track: { margin: 0.03, floor: 0.6, split: 0.06 }, audio: { margin: 0.03, floor: 0.3, split: 0.06 } };
  async function sync({ videoUrl, headers = {}, subtitlePath, assPath = null, timingPath = null, references = [], referencePath = null, referenceAssPath = null, chapters = [], duration = 0, background = false, status = () => {} }) {
    if (!subtitlePath || !fs.existsSync(subtitlePath)) throw new Error('자막 파일이 없습니다.');
    const tracks = [...(references || []), ...(referencePath ? [{ path: referencePath, assPath: referenceAssPath }] : [])].filter(track => track?.path && fs.existsSync(track.path));
    // The track with the most spoken lines (by content: a "S&S" track has none).
    const best = tracks.map(track => ({ track, vtt: spokenVtt(track.path, track.assPath) })).map(item => ({ ...item, lines: vttCues(item.vtt).length })).sort((a, b) => b.lines - a.lines)[0];
    const byTrack = Boolean(best && best.lines >= 20);
    if (!byTrack && !/^(https?|file):/i.test(videoUrl || '')) throw new Error('이 영상은 자동 싱크를 쓸 수 없습니다.');
    // One at a time: a later one waits for the one running, and the player's go before the ones made ready ahead for
    // the next episode (background).
    while (running) await new Promise(resolve => waiting.push({ resolve, background }));
    const abort = new AbortController(), work = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-sync-'));
    running = abort;
    const stopped = () => { if (abort.signal.aborted) throw Object.assign(new Error('취소했습니다.'), { canceled: true }); };
    try {
      if (!installed()) { status('ffsubsync 설치 준비 중 (처음 한 번)', 0); await install((message, progress) => status(`${message} (처음 한 번)`, progress)); }
      stopped();
      const timing = path.join(work, 'dialogue.vtt'), wav = path.join(work, 'audio.wav'), center = path.join(work, 'center.wav'), reference = path.join(work, 'reference.vtt');
      const fromTiming = timingPath && fs.existsSync(timingPath);
      fs.writeFileSync(timing, spokenVtt(fromTiming ? timingPath : subtitlePath, fromTiming ? null : assPath));
      const cues = vttCues(fs.readFileSync(timing, 'utf8'));
      let against = reference, speech;
      if (byTrack) {
        fs.writeFileSync(reference, best.vtt);
        speech = merged(vttCues(best.vtt));
        status('사이트 자막 트랙에 맞추는 중', null);
      } else {
        status('영상 음성 읽는 중', 0);
        await extractAudio(videoUrl, headers, Number(duration) || 0, wav, status, abort.signal);
        status('ffsubsync로 대사 위치 맞추는 중', null);
        against = center;
        try { await run(ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-i', wav, '-af', 'dialoguenhance=original=0:enhance=3,pan=mono|c0=FC', '-ar', '16000', '-c:a', 'pcm_s16le', center], { signal: abort.signal }); } catch (error) { stopped(); against = wav; }
        if (against === wav) { await run(ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', center], { signal: abort.signal }); against = center; }
        speech = await speechIn(center, abort.signal);
      }
      stopped();
      const length = Math.ceil(Math.max(Number(duration) || 0, ...speech.map(([, end]) => end), ...cues.map(([, end]) => end))) + 30;
      // One ffsubsync run: a candidate, or null when it found none (or one at the edge of where it looked).
      let runs = 0;
      const ask = async ({ lines = timing, reach, split = false, frameRate = false }) => {
        const out = path.join(work, `out-${++runs}.vtt`);
        let output;
        try {
          output = await run(exe, [against, '-i', lines, '-o', out, '--ffmpeg-path', path.dirname(ffmpegPath), '--skip-sync-on-low-quality', '--max-offset-seconds', String(reach), '--quality-max-offset-seconds', String(reach + 1),
            ...(frameRate ? [] : ['--no-fix-framerate']), ...(split ? ['--split-penalty'] : [])], { signal: abort.signal, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', COLUMNS: '400', NO_COLOR: '1', TERM: 'dumb' } });
        } catch (error) { stopped(); return null; }
        if (/leaving subtitles unmodified/i.test(output.replace(/\s+/g, ' '))) return null;
        const found = parseResult(output);
        if (!found || Math.abs(found.offset) >= reach - 1) return null;
        if (!split) return { offset: found.offset, scale: found.scale || 1, segments: null };
        const segments = fs.existsSync(out) ? segmentsOf(fs.readFileSync(lines, 'utf8'), fs.readFileSync(out, 'utf8')) : [];
        const kept = segments.length > 1 ? keptSegments(segments, cues, byTrack ? null : chapters || [], parts => fitScore(cues, speech, mover(0, 1, parts))) : null;
        return kept && kept.length > 1 ? { offset: found.offset, scale: 1, segments: kept } : null;
      };
      const reaches = [...new Set([60, 300, length].filter(reach => reach <= length))];
      const asks = [...reaches.map(reach => ({ reach })), { lines: subtitlePath, reach: Math.min(300, length) }, ...[150, 300].filter(reach => reach <= length).map(reach => ({ reach, split: true })), ...(byTrack ? [{ reach: Math.min(150, length), frameRate: true }] : [])];
      const candidates = [{ kind: 'none', offset: 0, scale: 1, segments: null }];
      for (const [i, request] of asks.entries()) {
        status(`${byTrack ? '사이트 자막 트랙' : '음성'}에 맞추는 중`, i / asks.length);
        const found = await ask(request);
        if (found) candidates.push({ kind: request.split ? 'segments' : request.frameRate ? 'frame-rate' : 'shift', ...found });
        stopped();
      }
      // Against a site track, the shifts found directly along the episode (alignedParts), one candidate per penalty.
      if (byTrack) for (const parts of alignedParts(cues, speech, { reach: Math.min(300, length) })) {
        if (parts.length === 1) { candidates.push({ kind: 'aligned', offset: parts[0].shift, scale: 1, segments: null }); continue; }
        const kept = keptSegments(parts, cues, null, option => fitScore(cues, speech, mover(0, 1, option)));
        if (kept?.length > 1) candidates.push({ kind: 'aligned', offset: kept[0].shift, scale: 1, segments: kept });
        else if (kept?.length === 1) candidates.push({ kind: 'aligned', offset: kept[0].shift, scale: 1, segments: null });
      }
      // Two parts of the shifts found (no change among them), which ffsubsync's split may not find (All-Works Maid 5).
      const shifts = [...new Set(candidates.filter(candidate => !candidate.segments && candidate.scale === 1).map(candidate => candidate.offset))];
      for (const a of shifts) for (const b of shifts) {
        const parts = a !== b ? twoParts(cues, speech, a, b) : null, kept = parts && keptSegments(parts, cues, byTrack ? null : chapters || []);
        if (kept?.length > 1) candidates.push({ kind: 'two-part', offset: b, scale: 1, segments: kept });
      }
      for (const candidate of candidates) candidate.score = fitScore(cues, speech, mover(candidate.offset, candidate.scale, candidate.segments));
      const none = candidates[0], ranked = candidates.slice(1).sort((a, b) => b.score - a.score);
      const fit = FIT[byTrack ? 'track' : 'audio'], method = byTrack ? 'track' : 'audio';
      // Segments only when each part they move differently from the best single shift (which is the more precise) fits
      // its own lines clearly better: a head of a few minutes right is a small part of the whole episode's score
      // (All-Works Maid 4: 0.783 against 0.773, its first 3:37 at 0.91 against 0.77). Against a site track a part must
      // also put more of its lines' starts on the track's (startScore): in fast dialogue a wrong shift can cover as much
      // speech as the right one, but its starts fall between the track's (All-Works Maid 3: a part at -19.83 s gaining
      // 0.03 by the overlap and losing 0.43 by the starts; every right part gained 0.10 or more by both).
      const single = ranked.find(candidate => !candidate.segments), move = candidate => mover(candidate.offset, candidate.scale, candidate.segments);
      const starts = byTrack ? [...new Set(vttCues(best.vtt).map(([start]) => start))].sort((a, b) => a - b) : null;
      for (const candidate of single ? ranked.filter(item => item.segments) : []) {
        const gains = candidate.segments.map((part, i) => {
          const lines = cues.filter(([start]) => start >= (i ? part.from : -Infinity) && (i + 1 >= candidate.segments.length || start < candidate.segments[i + 1].from));
          if (!lines.length || lines.every(([start]) => Math.abs(move(candidate)(start, start) - move(single)(start, start)) <= 0.3)) return null;
          const overlap = fitScore(lines, speech, move(candidate)) - fitScore(lines, speech, move(single));
          return starts ? Math.min(overlap, startScore(lines, starts, move(candidate)) - startScore(lines, starts, move(single))) : overlap;
        }).filter(gain => gain != null);
        candidate.gain = gains.length ? Math.min(...gains) : 0;
      }
      let chosen = ranked.find(candidate => !candidate.segments || candidate.gain >= fit.split);
      const summary = { none: Math.round(none.score * 1000) / 1000, chosen: chosen ? Math.round(chosen.score * 1000) / 1000 : null, tried: candidates.map(c => ({ kind: c.kind, offset: c.offset, scale: c.scale, segments: c.segments, score: Math.round(c.score * 1000) / 1000, ...(c.gain != null ? { gain: Math.round(c.gain * 1000) / 1000 } : {}) })) };
      if (!chosen || chosen.score < fit.floor) {
        if (none.score >= fit.floor) return { offset: 0, scale: 1, segments: null, method, scores: summary, unchanged: true };
        throw Object.assign(new Error('이 자막이 영상과 맞는 위치를 찾지 못해 그대로 뒀어요 (다른 판본이나 다른 회차의 자막일 수 있어요).'), { uncertain: true, scores: summary });
      }
      if (chosen.score < none.score + fit.margin) return { offset: 0, scale: 1, segments: null, method, scores: summary, unchanged: true };
      const segments = chosen.segments ? chosen.segments.map(segment => ({ from: Math.round(segment.from * 100) / 100, shift: segment.shift })) : null;
      // The shift most lines take (the one said).
      const count = new Map(); for (const [start] of cues) { const shift = segments ? shiftAt(segments, start) : chosen.offset; count.set(shift, (count.get(shift) || 0) + 1); }
      const offset = segments ? [...count].sort((a, b) => b[1] - a[1])[0][0] : chosen.offset;
      const result = { offset, scale: segments ? 1 : chosen.scale, segments, method, scores: summary };
      return { ...result, ...retime({ subtitlePath, assPath, ...result }) };
    } finally {
      running = null;
      const next = waiting.findIndex(item => !item.background);
      (next >= 0 ? waiting.splice(next, 1)[0] : waiting.shift())?.resolve();
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  // A retimed copy of a subtitle (and its ASS) by an offset and scale found before: a translation finished after its
  // source was synced gets the same fix without running ffsubsync again.
  function retime({ subtitlePath, assPath = null, offset = 0, scale = 1, segments = null }) {
    if (!subtitlePath || !fs.existsSync(subtitlePath) || !Number.isFinite(offset) || !(scale > 0)) throw new Error('자막 파일이 없습니다.');
    const parts = Array.isArray(segments) && segments.length > 1 && segments.every(segment => Number.isFinite(segment?.from) && Number.isFinite(segment?.shift)) ? segments : null;
    const vtt = syncedName(subtitlePath);
    rewrite(subtitlePath, vtt, text => retimeVtt(text, offset, scale, parts));
    let ass = null;
    if (assPath && fs.existsSync(assPath)) { ass = syncedName(assPath); rewrite(assPath, ass, text => retimeAss(text, offset, scale, parts)); }
    return { path: vtt, url: pathToFileURL(vtt).href, assPath: ass, assUrl: ass ? pathToFileURL(ass).href : null };
  }

  function cancel() { running?.abort(); }
  function stop() { cancel(); for (const child of children) child.kill(); }
  return { installed, install, sync, retime, cancel, stop, running: () => Boolean(running) };
}

module.exports = { createSubtitleSync, retimeVtt, retimeAss, parseResult, vttCues, dialogueVtt, assDialogueVtt, assSpeech, segmentsOf, keptSegments, twoParts, alignedParts, startScore, shiftAt, mover, merged, fitScore, spokenVtt };
