// Manual native smoke check: node node_modules/electron/cli.js tests/issue7.electron.cjs
const { app, BrowserWindow, screen, Tray, Menu, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DesktopState } = require('../electron/desktop-state.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-issue7-electron-'));
app.setPath('userData', dir);
let state, win;
const icon=path.join(__dirname,'../build',process.platform==='win32'?'icon.ico':'icon.png');
const cleanup = () => { state?.beforeQuit(); if(state?.tray&&!state.tray.isDestroyed())state.tray.destroy();if(win&&!win.isDestroyed())win.destroy(); };
process.on('uncaughtException', error => { console.error(error.stack); cleanup(); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error.stack); cleanup(); app.exit(1); });
app.whenReady().then(async () => {
  state = new DesktopState({ app, screen, Tray, Menu, nativeImage, icon, show() {} });
  win = new BrowserWindow({ ...state.bounds(), show: false, webPreferences: { contextIsolation: false } }); state.attach(win);
  await win.loadURL('about:blank');
  const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  win.webContents.on('console-message', event => { if(event.level==='error')console.error(event.message); });
  const section = (start, end) => {const first=source.indexOf(start),last=source.indexOf(end,first);assert.ok(first>=0&&last>first,`Missing section: ${start}`);return source.slice(first,last)};
  const css = ['styles.css', 'download-port.css'].map(name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')).join('\n');
  const result = await win.webContents.executeJavaScript(`(async()=>{
    document.head.innerHTML='<style>'+${JSON.stringify(css)}+'</style>';document.body.innerHTML='<div id="groups" style="padding:20px"></div>';
    let calls=[],toggles=0,confirmation=false;
    const escapeHtml=value=>String(value).replace(/[<>&"]/g,'_'),storedTitle=job=>job.title,titleAttr=()=>'',renderDownloads=()=>{toggles++},toast=value=>{throw Error(value)},ipcMessage=error=>error.message;
    window.lilac={controlDownloads:async(action,ids)=>calls.push({action,ids})};window.confirm=()=>confirmation;
    const removeDownload=async job=>calls.push({action:'remove',id:job.id});
    ${section('function downloadIcon(', 'function updateLibraryButton(')}
    ${section('const openDownloadGroups=', 'function renderDownloads(')}
    const jobs=[{id:'active',title:'작품별 다운로드 검증용 긴 제목',episodeNumber:1,status:'downloading',progress:35},{id:'paused',title:'작품별 다운로드 검증용 긴 제목',episodeNumber:2,status:'paused',progress:60},{id:'done',title:'작품별 다운로드 검증용 긴 제목',episodeNumber:3,status:'completed'}];
    const group=downloadGroupCard('series',jobs);document.querySelector('#groups').append(group);
    group.querySelector('[data-group-action="cancel"]').click();await new Promise(resolve=>setTimeout(resolve,0));
    group.querySelector('[data-group-action="resume"]').click();await new Promise(resolve=>setTimeout(resolve,0));
    group.querySelector('[data-group-action="remove"]').click();await new Promise(resolve=>setTimeout(resolve,0));
    const cancelledDelete=calls.length===2;confirmation=true;group.querySelector('[data-group-action="remove"]').click();await new Promise(resolve=>setTimeout(resolve,0));
    const buttons=[...group.querySelectorAll('button')].map(button=>({text:button.textContent.trim(),right:button.getBoundingClientRect().right}));
    return {calls,toggles,cancelledDelete,buttons,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};
  })()`);
  assert.deepEqual(result.calls.slice(0, 2), [{ action: 'cancel', ids: ['active'] }, { action: 'resume', ids: ['paused'] }]);
  assert.equal(result.calls.filter(call => call.action === 'remove').length, 3);
  assert.equal(result.toggles, 0); assert.equal(result.cancelledDelete, true); assert.equal(result.overflow, false);
  const normal = win.getNormalBounds(); state.setTray(true); win.close();
  assert.equal(win.isDestroyed(), false); assert.equal(win.isVisible(), false);
  const restored=new DesktopState({ app, screen, Tray, Menu, nativeImage, icon, show() {} });
  assert.equal(restored.bounds().width, normal.width);restored.beforeQuit();restored.tray.destroy();
  // Save only the settings with tray disabled before constructing another state in future checks.
  state.setTray(false);
  fs.mkdirSync(path.join(__dirname,'../dist'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../dist/issue7-downloads.png'),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ ok: true, trayClose: true, windowBounds: normal, groupActions: result.calls, overflow: result.overflow }));
  cleanup(); app.exit(0);
});
