const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evenVideoDts } = require('../electron/flix-proxy.cjs');

// One TS packet per video frame: a PES header with a PTS, and a DTS when given (else the DTS is the PTS).
function time(prefix, value) {
  return [(prefix << 4) | ((Math.floor(value / 1073741824) & 7) << 1) | 1, Math.floor(value / 4194304) & 0xff, ((Math.floor(value / 32768) & 0x7f) << 1) | 1, Math.floor(value / 128) & 0xff, ((value & 0x7f) << 1) | 1];
}
function segment(frames) {
  return Buffer.concat(frames.map(([pts, dts]) => {
    const packet = Buffer.alloc(188, 0xff);
    const pes = dts == null ? [0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...time(2, pts)] : [0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10, ...time(3, pts), ...time(1, dts)];
    packet.set([0x47, 0x41, 0x00, 0x10, ...pes]);
    return packet;
  }));
}
function times(body) {
  const read = o => (body[o] & 0x0e) * 536870912 + body[o + 1] * 4194304 + (body[o + 2] & 0xfe) * 16384 + body[o + 3] * 128 + (body[o + 4] >> 1);
  const out = [];
  for (let o = 0; o < body.length; o += 188) out.push(body[o + 11] & 0x40 ? [read(o + 13), read(o + 18)] : [read(o + 13)]);
  return out;
}

// The end of 그랑블루 9화's fragment 41: two B frames a tick apart, so the last frame was a tick long and Chrome dropped
// the keyframe-less fragment after it.
test('the last frames of a segment a tick apart are spread over the usual frame interval', () => {
  const lead = Array.from({ length: 8 }, (_, i) => [15199416 + i * 3754]);
  const frames = [...lead, [15229441], [15244380, 15233130], [15240690], [15240691]];
  const out = times(evenVideoDts(segment(frames)));
  assert.deepEqual(out.slice(0, -1), frames.slice(0, -1));
  const last = out.at(-1)[0];
  assert.ok(last - 15240690 > 1500 && last < 15244380, `last frame at ${last}: about half a frame on, still shown before the next P frame`);
});

test('frames a tick apart inside a segment, and a frame whose DTS would pass its PTS, are left alone', () => {
  const inside = [[15251940], [15251941], [15255720, 15244380], [15259470]];
  assert.deepEqual(times(evenVideoDts(segment(inside))), inside);
  const own = [[15000000], [15003753], [15003754, 15003754]];
  assert.deepEqual(times(evenVideoDts(segment(own))), own);
});

test('a moved frame is never shown after a frame that came after it', () => {
  const frames = [[15229441], [15244380, 15233130], [15240690], [15240691]];
  assert.deepEqual(times(evenVideoDts(segment(frames))), frames, 'the usual interval (7560 here) would put it past 15244380');
});
