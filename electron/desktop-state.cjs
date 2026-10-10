const fs = require('fs');
const path = require('path');

class DesktopState {
  constructor({ app, screen, Tray, Menu, nativeImage, icon, show }) {
    Object.assign(this, { app, screen, Tray, Menu, nativeImage, icon, show });
    this.file = path.join(app.getPath('userData'), 'desktop-state.json');
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { this.state = {}; }
    this.quitting = false;
    if (this.state.trayEnabled) { try { this.createTray(); } catch { this.state.trayEnabled = false; } }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  bounds() {
    const displays = this.screen.getAllDisplays(), saved = this.state.bounds;
    const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]));
    const area = (valid && displays.find(({ workArea: a }) => saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y)?.workArea) || this.screen.getPrimaryDisplay().workArea;
    const minWidth = Math.min(980, area.width), minHeight = Math.min(680, area.height);
    const width = Math.min(area.width, Math.max(minWidth, valid ? saved.width : 1440));
    const height = Math.min(area.height, Math.max(minHeight, valid ? saved.height : 900));
    return { width, height, minWidth, minHeight, ...(valid ? { x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) } : {}) };
  }
  attach(win) {
    this.win = win;
    const remember = () => {
      if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
      this.state.bounds = win.getNormalBounds(); this.state.maximized = win.isMaximized(); this.save();
    };
    const schedule = () => { clearTimeout(this.timer); this.timer = setTimeout(remember, 200); };
    for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'leave-full-screen']) win.on(event, schedule);
    win.on('close', event => {
      clearTimeout(this.timer); remember();
      if (this.state.trayEnabled && this.tray && !this.quitting) { event.preventDefault(); win.hide(); }
    });
    win.on('closed', () => clearTimeout(this.timer));
    if (this.state.maximized) win.maximize();
  }
  createTray() {
    if (this.tray) return;
    let image = this.nativeImage.createFromPath(this.icon);
    if (process.platform === 'darwin') image = image.resize({ width: 20, height: 20 });
    const tray = new this.Tray(image);
    tray.setToolTip('LilacAnime');
    tray.setContextMenu(this.Menu.buildFromTemplate([
      { label: 'LilacAnime 열기', click: this.show }, { type: 'separator' },
      { label: '종료', click: () => this.app.quit() }
    ]));
    tray.on('click', this.show); tray.on('double-click', this.show);
    this.tray = tray;
  }
  settings() { return { trayEnabled: Boolean(this.state.trayEnabled) }; }
  setTray(enabled) {
    if (enabled) this.createTray();
    this.state.trayEnabled = Boolean(enabled); this.save();
    if (!enabled && this.tray) { this.show(); this.tray.destroy(); this.tray = null; }
    return this.settings();
  }
  beforeQuit() { this.quitting = true; clearTimeout(this.timer); }
}

module.exports = { DesktopState };
