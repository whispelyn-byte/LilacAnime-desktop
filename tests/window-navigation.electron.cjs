// The main window's guards, as main.cjs sets them (read from its source): the page cannot be taken to another address
// and cannot open windows. Run: npx electron tests/window-navigation.electron.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-nav-')), 'profile')); app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  const from = main.indexOf('  const ownPage = '), to = main.indexOf('  desktopState.attach(win);', from);
  assert.ok(from > 0 && to > from, 'the guards are in createWindow');
  const external = [], shell = { openExternal: url => { external.push(url); } };
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  // main.cjs's own lines, with its __dirname (electron/).
  new Function('win', 'shell', 'path', 'pathToFileURL', '__dirname', main.slice(from, to))(win, shell, path, pathToFileURL, path.join(root, 'electron'));
  const page = path.join(root, 'src', 'index.html');
  await win.loadFile(page); await delay(300);
  const own = win.webContents.getURL();
  await win.webContents.executeJavaScript(`location.href='https://example.com/'; void 0;`); await delay(1200);
  assert.equal(win.webContents.getURL(), own, 'the window stays on the app page');
  await win.webContents.executeJavaScript(`window.open('https://example.com/popup'); window.open('file:///C:/Windows/win.ini'); void 0;`); await delay(500);
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'no window is opened');
  assert.deepEqual(external, ['https://example.com/popup']);
  await win.webContents.executeJavaScript(`location.hash='#x'; void 0;`); await delay(200);
  assert.equal(win.webContents.getURL(), `${own}#x`);
  console.log('WINDOW_NAVIGATION_OK');
}).then(() => app.exit(0), error => { console.error('WINDOW_NAVIGATION_FAILED', error.stack || error); app.exit(1); });
