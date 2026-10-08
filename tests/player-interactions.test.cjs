const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/player.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing player section: ${start}`);
  return source.slice(first, last);
}
function classList(...initial) {
  const values = new Set(initial);
  return { contains: value => values.has(value), add: value => values.add(value), remove: value => values.delete(value), toggle(value, on) { on ? values.add(value) : values.delete(value); } };
}
function setup() {
  const events = {}, timers = new Map(), storage = new Map();
  let timerId = 0, now = 0;
  const player = { classList: classList('controls-visible'), contains: () => false, clientWidth: 2100, clientHeight: 900 };
  const video = { playbackRate: 1.5, paused: false, ended: false, style: {}, playCount: 0, pauseCount: 0,
    play() { this.paused = false; this.playCount++; return Promise.resolve(); },
    pause() { this.paused = true; this.pauseCount++; events['video:pause']?.(); },
    addEventListener: (name, fn) => { events[`video:${name}`] = fn; } };
  const indicator = { classList: classList('hidden') }, stage = { style: {} };
  const document = { body: { classList: classList('player-mode') }, activeElement: { tagName: 'BODY', matches: () => false }, addEventListener: (name, fn) => { events[name] = fn; } };
  const context = vm.createContext({ document, window: { addEventListener: (name, fn) => { events[name] = fn; } },
    $: selector => ({ '#video': video, '#immersivePlayer': player, '#playerSpeedBoost': indicator, '#videoStage': stage }[selector]), $$: () => [],
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    playerLocked: false, playerSettingsOpen: () => false, showPlayerControls: () => {},
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(section('// Delay the short-press', '// Outside the player'), context);
  const key = (repeat = false) => ({ key: ' ', code: 'Space', repeat, preventDefault() { this.prevented = true; } });
  const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  return { context, video, player, indicator, events, storage, stage, key, advance, document };
}

test('short Space press toggles once on release despite repeated keydown', () => {
  const h = setup(); h.context.handlePlayerKey(h.key());
  h.advance(100); h.context.handlePlayerKey(h.key(true));
  assert.equal(h.video.pauseCount, 0);
  h.events.keyup(h.key()); h.events.keyup(h.key());
  assert.equal(h.video.pauseCount, 1);
  h.context.handlePlayerKey(h.key()); h.advance(100); h.events.keyup(h.key());
  assert.equal(h.video.playCount, 1);
});

test('holding Space boosts to 2x and restores the previous rate without pausing or saving it', () => {
  const h = setup(); h.context.handlePlayerKey(h.key()); h.advance(399);
  assert.equal(h.video.playbackRate, 1.5);
  h.advance(1); h.context.handlePlayerKey(h.key(true));
  assert.equal(h.video.playbackRate, 2);
  assert.equal(h.indicator.classList.contains('hidden'), false);
  h.events.keyup(h.key());
  assert.equal(h.video.playbackRate, 1.5); assert.equal(h.video.pauseCount, 0);
  assert.equal(h.indicator.classList.contains('hidden'), true); assert.equal(h.storage.size, 0);
});

test('focus loss, hidden window, pause and media replacement cancel a hold', () => {
  for (const name of ['blur', 'visibilitychange', 'video:pause', 'video:ended', 'video:emptied', 'video:loadstart']) {
    const h = setup(); h.context.handlePlayerKey(h.key()); h.advance(400); h.document.hidden = true;
    h.events[name](); h.events.keyup(h.key());
    assert.equal(h.video.playbackRate, 1.5, name); assert.equal(h.video.pauseCount, 0, name);
  }
  const h = setup(); h.context.handlePlayerKey(h.key()); h.events.blur(); h.advance(500);
  assert.equal(h.video.playbackRate, 1.5); h.events.keyup(h.key()); assert.equal(h.video.pauseCount, 0);
});

test('settings, text inputs and modified Space retain their native behavior', () => {
  for (const configure of [h => { h.context.playerSettingsOpen = () => true; }, h => { h.document.activeElement = { tagName: 'INPUT', type: 'text' }; }, h => { h.document.activeElement.isContentEditable = true; }]) {
    const h = setup(); configure(h); const event = h.key(); h.context.handlePlayerKey(event); h.advance(500); h.events.keyup(event);
    assert.equal(event.prevented, undefined); assert.equal(h.video.playbackRate, 1.5); assert.equal(h.video.pauseCount, 0);
  }
  const h = setup(), event = { ...h.key(), ctrlKey: true }; h.context.handlePlayerKey(event); h.advance(500);
  assert.equal(event.prevented, undefined); assert.equal(h.video.playbackRate, 1.5);
});

test('a manually selected speed during a boost is kept', () => {
  const h = setup(); h.context.handlePlayerKey(h.key()); h.advance(400); h.video.playbackRate = 1.25; h.events.keyup(h.key());
  assert.equal(h.video.playbackRate, 1.25);
});

test('aspect presets stretch within their ratio; fill uses all of an ultrawide window', () => {
  const h = setup(); vm.runInContext(section('const PLAYER_ASPECTS', 'new ResizeObserver(applyPlayerAspect)'), h.context);
  for (const [aspect, width, height, fit] of [['original', 2100, 900, 'contain'], ['21:9', 2100, 900, 'fill'], ['16:9', 1600, 900, 'fill'], ['4:3', 1200, 900, 'fill'], ['fill', 2100, 900, 'fill'], ['invalid', 2100, 900, 'contain']]) {
    h.storage.set('playerAspect', aspect); h.context.applyPlayerAspect();
    assert.ok(Math.abs(parseFloat(h.stage.style.width) - width) < 0.001); assert.ok(Math.abs(parseFloat(h.stage.style.height) - height) < 0.001);
    assert.equal(parseFloat(h.stage.style.left), (2100 - width) / 2); assert.equal(h.video.style.objectFit, fit);
  }
  h.storage.set('playerAspect', '21:9'); h.player.clientWidth = 600; h.player.clientHeight = 500; h.context.applyPlayerAspect();
  assert.equal(parseFloat(h.stage.style.width), 600); assert.ok(Math.abs(parseFloat(h.stage.style.height) - 600 * 9 / 21) < 0.001);
});

test('VTT dialogue stays centered within a safe width and retains sync and top placement', () => {
  const h = setup(), cues = [{ startTime: 1, endTime: 3 }, { startTime: 2, endTime: 4, lilacTop: true }];
  h.video.textTracks = [{ cues }]; h.context.flattenVttCues = () => {}; h.context.vttBaseline = () => 85;
  vm.runInContext(section('function applyVttLayout()', '// Android subtitle source chips'), h.context);
  h.storage.set('subtitleSync', '500'); h.context.applyVttLayout(); h.context.applyVttLayout();
  for (const cue of cues) { assert.equal(cue.size, 90); assert.equal(cue.position, 50); assert.equal(cue.positionAlign, 'center'); assert.equal(cue.align, 'center'); }
  assert.equal(cues[0].startTime, 1.5); assert.equal(cues[0].line, 85); assert.equal(cues[0].lineAlign, 'end');
  assert.equal(cues[1].line, 5); assert.equal(cues[1].lineAlign, 'start');
});

test('PIP wraps long Korean and unspaced Japanese text, including explicit newlines', () => {
  const h = setup(); vm.runInContext(section('function vttLines(', '// VTT cues drawn'), h.context);
  const ctx = { measureText: value => ({ width: [...value].length * 10 }) };
  for (const text of ['아주 긴 대사가 창 너비를 넘어도 잘리지 않습니다', '空白のないとても長い字幕も折り返します', '<i>첫째 줄</i>\n둘째 줄 &amp; 마지막']) {
    const lines = h.context.vttLines(ctx, text, 80);
    assert.ok(lines.length > 1); assert.ok(lines.every(line => ctx.measureText(line).width <= 80));
  }
});

test('ASS canvas follows stretched video bounds and returns to the original bounds', async () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../src/ass-renderer.js'), 'utf8').replace(/^import JASSUB[^\n]*\n/m, '');
  const created = [], video = { style: { objectFit: 'fill' }, clientWidth: 2100, clientHeight: 900, offsetLeft: 0, offsetTop: 0 };
  class Renderer {
    constructor() { this.ready = Promise.resolve(); this._canvas = { style: {} }; created.push(this); }
    _getElementBoundingBox() { return { x: 250, y: 0, width: 1600, height: 900 }; }
    async resize() { this.bounds = this._getElementBoundingBox(video, 1920, 1080); }
    async destroy() { this.destroyed = true; }
  }
  const window = { dispatchEvent() {} }, context = vm.createContext({ window, JASSUB: Renderer, Event, URL, Blob });
  vm.runInContext(rendererSource, context);
  assert.equal(await window.LilacAss.attach(video, { subUrl: 'subtitle.ass' }), true);
  assert.equal(created[0].bounds.width, 2100); assert.equal(created[0].bounds.height, 900); assert.equal(created[0].bounds.x, 0);
  video.style.objectFit = 'contain'; window.LilacAss.resize(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(created[0].bounds.width, 1600); assert.equal(created[0].bounds.x, 250);
  await window.LilacAss.destroy(); assert.equal(window.LilacAss.active, false);
});
