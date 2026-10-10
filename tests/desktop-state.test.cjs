const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { DesktopState } = require('../electron/desktop-state.cjs');

function setup(t, saved = {}, areas = [{ x: 0, y: 0, width: 1920, height: 1040 }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-desktop-test-'));
  fs.writeFileSync(path.join(dir, 'desktop-state.json'), JSON.stringify(saved));
  let shown = 0, quit = 0;
  class Tray extends EventEmitter { setToolTip() {} setContextMenu(menu) { this.menu = menu; } destroy() { this.destroyed = true; } }
  const options = { app: { getPath: () => dir, quit: () => { quit++; } },
    screen: { getAllDisplays: () => areas.map(workArea => ({ workArea })), getPrimaryDisplay: () => ({ workArea: areas[0] }) },
    Tray, Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath: () => ({ resize() { return this; } }) }, show: () => { shown++; } };
  const state = new DesktopState(options);
  t.after(() => { state.beforeQuit(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const win = new EventEmitter();
  Object.assign(win, { normal: { x: 140, y: 90, width: 1200, height: 760 }, maximized: false, full: false, minimized: false,
    isDestroyed: () => false, isFullScreen: () => win.full, isMinimized: () => win.minimized, isMaximized: () => win.maximized,
    getNormalBounds: () => win.normal, maximize: () => { win.maximized = true; }, hide: () => { win.hidden = true; } });
  return { state, win, options, dir, shown: () => shown, quit: () => quit };
}

test('normal bounds and maximization survive a new application instance', t => {
  const h = setup(t); h.state.attach(h.win); h.win.maximized = true;
  h.win.emit('close', { preventDefault() { assert.fail('tray is disabled'); } });
  const restored = new DesktopState(h.options); t.after(() => restored.beforeQuit());
  assert.deepEqual(restored.bounds(), { ...h.win.normal, minWidth: 980, minHeight: 680 });
  h.win.maximized = false; restored.attach(h.win); assert.equal(h.win.maximized, true);
});

test('tray close keeps the window alive; open, disable, and actual quit remain available', t => {
  const h = setup(t); h.state.attach(h.win); h.state.setTray(true);
  let prevented = 0; h.win.emit('close', { preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.equal(h.win.hidden, true);
  const tray = h.state.tray; tray.emit('click'); assert.equal(h.shown(), 1);
  tray.menu[2].click(); assert.equal(h.quit(), 1);
  h.state.beforeQuit(); h.win.emit('close', { preventDefault() { assert.fail('quit must bypass tray hiding'); } });
  h.state.setTray(false); assert.equal(tray.destroyed, true); assert.equal(h.shown(), 2);
  assert.equal(new DesktopState(h.options).settings().trayEnabled, false);
});

test('tray preference persists and fullscreen/minimized geometry never replaces normal bounds', t => {
  const h = setup(t); h.state.attach(h.win); h.win.emit('close', {}); h.state.setTray(true);
  h.win.normal = { x: 0, y: 0, width: 3840, height: 2160 }; h.win.full = true;
  h.win.emit('close', { preventDefault() {} });
  h.win.full = false; h.win.minimized = true; h.win.emit('close', { preventDefault() {} });
  const restored = new DesktopState(h.options); t.after(() => restored.beforeQuit());
  assert.equal(restored.settings().trayEnabled, true); assert.equal(restored.bounds().width, 1200);
  restored.tray.destroy();
});

test('disconnected monitors, negative coordinates, and small screens restore to visible work areas', t => {
  const h = setup(t, { bounds: { x: 4000, y: -500, width: 3000, height: 2000 } }, [{ x: 0, y: 0, width: 1280, height: 720 }]);
  assert.deepEqual(h.state.bounds(), { x: 0, y: 0, width: 1280, height: 720, minWidth: 980, minHeight: 680 });
  h.state.state.bounds = { x: -1800, y: 80, width: 1200, height: 800 };
  h.options.screen.getAllDisplays = () => [{ workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }];
  assert.equal(h.state.bounds().x, -1800);
  h.state.state.bounds = { x: 0, y: 0, width: 'bad', height: 1 };
  assert.equal(h.state.bounds().width, 1280);
});
