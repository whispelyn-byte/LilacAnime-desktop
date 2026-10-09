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
  const player = { classList: classList('controls-visible'), contains: () => false, clientWidth: 2100, clientHeight: 900,
    addEventListener: (name, fn) => { events[`player:${name}`] = fn; } };
  const video = { playbackRate: 1.5, paused: false, ended: false, style: {}, playCount: 0, pauseCount: 0,
    play() { this.paused = false; this.playCount++; return Promise.resolve(); },
    pause() { this.paused = true; this.pauseCount++; events['video:pause']?.(); },
    addEventListener: (name, fn) => { events[`video:${name}`] = fn; } };
  const indicator = { classList: classList('hidden') }, stage = { style: {} };
  for (const target of [video, player, stage]) {
    const captures = new Set();
    target.setPointerCapture = id => captures.add(id); target.hasPointerCapture = id => captures.has(id);
    target.releasePointerCapture = id => { captures.delete(id); events['player:lostpointercapture']?.({ pointerId: id }); };
  }
  const document = { body: { classList: classList('player-mode') }, activeElement: { tagName: 'BODY', matches: () => false }, addEventListener: (name, fn) => { events[name] = fn; } };
  const context = vm.createContext({ document, window: { addEventListener: (name, fn) => { events[name] = fn; } },
    $: selector => ({ '#video': video, '#immersivePlayer': player, '#playerSpeedBoost': indicator, '#videoStage': stage }[selector]), $$: () => [],
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    playerLocked: false, playerSettingsOpen: () => false, showPlayerControls: () => {},
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(section('// Delay the short-press', '// Outside the player'), context);
  const key = (repeat = false) => ({ key: ' ', code: 'Space', repeat, preventDefault() { this.prevented = true; } });
  const pointer = (overrides = {}) => ({ pointerType: 'mouse', pointerId: 7, button: 0, buttons: 1, isPrimary: true, target: video, detail: 1,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...overrides });
  const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  return { context, video, player, indicator, events, storage, stage, key, pointer, advance, document };
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

test('holding the left mouse button boosts on video and blank picture areas, then restores on release', () => {
  for (const targetName of ['video', 'stage', 'player']) {
    const h = setup(), event = h.pointer({ target: h[targetName] }); h.events['player:pointerdown'](event);
    assert.equal(h[targetName].hasPointerCapture(7), true); h.advance(399); assert.equal(h.video.playbackRate, 1.5);
    h.advance(1); assert.equal(h.video.playbackRate, 2); assert.equal(h.indicator.classList.contains('hidden'), false);
    h.events.pointerup(h.pointer({ target: {}, buttons: 0 }));
    assert.equal(h.video.playbackRate, 1.5); assert.equal(h.video.pauseCount, 0); assert.equal(h.storage.size, 0);
    assert.equal(h[targetName].hasPointerCapture(7), false); assert.equal(h.indicator.classList.contains('hidden'), true);
  }
});

test('short mouse clicks keep the existing controls toggle; long releases do not toggle it', () => {
  for (const duration of [100, 500]) {
    const h = setup(), appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
    h.context.controlsTimer = null; h.context.showPlayerControls = () => h.player.classList.add('controls-visible');
    const first = appSource.indexOf("$('#video').addEventListener('click'");
    vm.runInContext(appSource.slice(first, appSource.indexOf('\n', first)), h.context);
    h.events['player:pointerdown'](h.pointer()); h.advance(duration); h.events.pointerup(h.pointer({ buttons: 0 }));
    const click = h.pointer(); h.events['player:click'](click); if (!click.stopped) h.events['video:click'](click);
    assert.equal(h.player.classList.contains('controls-visible'), duration >= 400);
    assert.equal(h.video.pauseCount, 0); assert.equal(h.video.playbackRate, 1.5);
  }
});

test('controls, right click, touch, paused media, locks and open settings never start mouse boost', () => {
  for (const configure of [h => h.pointer({ target: {} }), h => h.pointer({ button: 2 }), h => h.pointer({ pointerType: 'touch' }),
    h => { h.video.paused = true; return h.pointer(); }, h => { h.context.playerLocked = true; return h.pointer(); },
    h => { h.context.playerSettingsOpen = () => true; return h.pointer(); }]) {
    const h = setup(); h.events['player:pointerdown'](configure(h)); h.advance(500);
    assert.equal(h.video.playbackRate, 1.5); assert.equal(h.video.hasPointerCapture(7), false);
  }
});

test('mouse hold restores on cancellation, capture loss, missing button, focus loss and media replacement', () => {
  for (const name of ['pointercancel', 'player:lostpointercapture', 'pointermove', 'blur', 'visibilitychange', 'video:pause', 'video:emptied']) {
    const h = setup(); h.events['player:pointerdown'](h.pointer()); h.advance(400); h.document.hidden = true;
    h.events[name](h.pointer({ buttons: 0 }));
    assert.equal(h.video.playbackRate, 1.5, name); assert.equal(h.indicator.classList.contains('hidden'), true, name);
    h.events.pointerup(h.pointer({ buttons: 0 })); assert.equal(h.video.pauseCount, 0);
  }
});

test('keyboard and mouse releases cannot end each other’s active hold', () => {
  const mouse = setup(); mouse.events['player:pointerdown'](mouse.pointer()); mouse.advance(400);
  mouse.context.handlePlayerKey(mouse.key()); mouse.events.keyup(mouse.key()); assert.equal(mouse.video.playbackRate, 2);
  mouse.events.pointerup(mouse.pointer({ pointerId: 8 })); assert.equal(mouse.video.playbackRate, 2);
  mouse.events.pointerup(mouse.pointer()); assert.equal(mouse.video.playbackRate, 1.5);
  const keyboard = setup(); keyboard.context.handlePlayerKey(keyboard.key()); keyboard.advance(400);
  keyboard.events['player:pointerdown'](keyboard.pointer()); keyboard.events.pointerup(keyboard.pointer()); assert.equal(keyboard.video.playbackRate, 2);
  keyboard.events.keyup(keyboard.key()); assert.equal(keyboard.video.playbackRate, 1.5);
});

test('a fresh click after a cancelled mouse hold works and a manually changed speed is kept', () => {
  const h = setup(); h.events['player:pointerdown'](h.pointer()); h.advance(400); h.video.playbackRate = 3;
  h.events.blur(); assert.equal(h.video.playbackRate, 3);
  h.events['player:pointerdown'](h.pointer()); h.advance(100); h.events.pointerup(h.pointer());
  const click = h.pointer(); h.events['player:click'](click); assert.equal(click.stopped, undefined); assert.equal(h.video.playbackRate, 3);
});

test('speed shortcuts reach 3x and 4x, respect the upper limit and step back', () => {
  const h = setup(), speed = { value: '2' }, originalSelect = h.context.$;
  h.context.$ = selector => selector === '#speed' ? speed : originalSelect(selector);
  h.context.toast = () => {};
  const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  vm.runInContext(appSource.match(/const SPEED_OPTIONS=\[[^\]]+\];/)[0], h.context);
  h.video.playbackRate = 2;
  for (const [key, expected] of [[']', 3], [']', 4], [']', 4], ['[', 3], ['[', 2]]) {
    h.context.handlePlayerKey({ key });
    assert.equal(h.video.playbackRate, expected); assert.equal(speed.value, String(expected));
  }
});

test('3x and 4x settings persist in the playback select and default slider', () => {
  const h = setup(), originalSelect = h.context.$;
  const $html = require('cheerio').load(fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8'));
  const buttons = $html('#psSpeeds button').map((_, node) => ({ dataset: { speed: $html(node).attr('data-speed') } })).get();
  const elements = { '#speed': { value: '1' }, '#defaultSpeed': { value: '4' }, '#speedLabel': { textContent: '' } };
  h.context.$ = selector => elements[selector] || originalSelect(selector);
  h.context.$$ = () => buttons; h.context.syncPlayerSettingsUI = () => {};
  const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  vm.runInContext(appSource.match(/const SPEED_OPTIONS=\[[^\]]+\];/)[0], h.context);
  vm.runInContext(section("$$('#psSpeeds button').forEach(button => button.onclick", "$('#previousEpisode').onclick"), h.context);
  for (const speed of [3, 4]) {
    buttons.find(button => Number(button.dataset.speed) === speed).onclick();
    assert.equal(h.video.playbackRate, speed); assert.equal(h.storage.get('defaultSpeed'), String(speed));
    assert.equal(elements['#speed'].value, String(speed)); assert.equal(elements['#speedLabel'].textContent, `${speed.toFixed(2)}x`);
    assert.ok($html(`#speed option[value="${speed}"]`).length);
    assert.ok(Number(elements['#defaultSpeed'].value) <= Number($html('#defaultSpeed').attr('max')));
    h.context.handlePlayerKey(h.key()); h.advance(400); h.events.keyup(h.key());
    assert.equal(h.video.playbackRate, speed); assert.equal(h.storage.get('defaultSpeed'), String(speed));
  }
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

test('VTT dialogue uses a full-width centered box and retains sync and top placement', () => {
  const h = setup(), cues = [{ startTime: 1, endTime: 3 }, { startTime: 2, endTime: 4, lilacTop: true }];
  h.video.textTracks = [{ cues }]; h.context.flattenVttCues = () => {}; h.context.vttBaseline = () => 85;
  vm.runInContext(section('function applyVttLayout()', '// Android subtitle source chips'), h.context);
  h.storage.set('subtitleSync', '500'); h.context.applyVttLayout(); h.context.applyVttLayout();
  for (const cue of cues) { assert.equal(cue.size, 100); assert.equal(cue.position, 50); assert.equal(cue.positionAlign, 'center'); assert.equal(cue.align, 'center'); }
  assert.equal(cues[0].startTime, 1.5); assert.equal(cues[0].line, 85); assert.equal(cues[0].lineAlign, 'end');
  assert.equal(cues[1].line, 5); assert.equal(cues[1].lineAlign, 'start');
});

test('subtitle sync accepts large positive and negative values without the old 5-second cap', () => {
  const h = setup(), offsets = [], cue = { startTime: 120, endTime: 125 };
  h.video.textTracks = [{ cues: [cue] }]; h.context.flattenVttCues = () => {}; h.context.vttBaseline = () => 85;
  h.context.setSubtitleSetting = (key, value) => h.storage.set(key, String(value));
  h.context.toast = () => {};
  h.context.window.LilacAss = { setOffset: value => offsets.push(value) };
  vm.runInContext(section('function applyVttLayout()', '// Android subtitle source chips'), h.context);
  vm.runInContext(section('function setSubtitleSync(', '// VTT placement and sync'), h.context);
  assert.equal(h.context.setSubtitleSync(90000), true); assert.equal(cue.startTime, 210); assert.equal(offsets.at(-1), 90000);
  assert.equal(h.context.setSubtitleSync(-90000), true); assert.equal(cue.startTime, 30); assert.equal(offsets.at(-1), -90000);
  assert.equal(h.context.setSubtitleSync(Infinity), false); assert.equal(h.context.setSubtitleSync(''), false); assert.equal(cue.startTime, 30);
  h.context.setSubtitleSync(5500);
  h.context.handlePlayerKey({ key: 'x', code: 'KeyX', preventDefault() {} });
  assert.equal(h.storage.get('subtitleSync'), '6000');
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
