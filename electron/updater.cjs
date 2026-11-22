// GitHub release based auto update (mirrors Android GithubReleaseChecker).
// Releases only need the NSIS installer asset (LilacAnime-Setup.exe; older releases have the version in the name), and
// for macOS a disk image per processor (LilacAnime-mac-arm64.dmg, LilacAnime-mac-x64.dmg), for Linux a .deb per
// processor (LilacAnime-linux-amd64.deb, LilacAnime-linux-arm64.deb).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { shell } = require('electron');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');

// The SHA-256 GitHub publishes for a release file ("sha256:<hex>", the asset's digest), or '' when it gives none.
function assetDigest(asset = {}) { return String(asset.digest || '').match(/^sha256:([0-9a-f]{64})$/i)?.[1].toLowerCase() || ''; }
async function fileSha256(file) { const hash = crypto.createHash('sha256'); await pipeline(fs.createReadStream(file), hash); return hash.digest('hex'); }

const RELEASES = 'https://api.github.com/repos/whispelyn-byte/LilacAnime-desktop/releases';
const RELEASE_API = `${RELEASES}/latest`;
const MAC = process.platform === 'darwin', LINUX = process.platform === 'linux';
// Linux: a .deb install (dpkg knows the package and the app runs from /opt) gets the new .deb installed through pkexec,
// which asks for the password. A build run some other way (v0.5.53's AppImage) is pointed to the .deb instead.
const DEB = LINUX && process.execPath.startsWith('/opt/') && fs.existsSync('/var/lib/dpkg/info/lilacanime-desktop.list');
// This build's installer among a release's files.
function installerAsset(assets = []) {
  const named = test => assets.find(item => test(String(item.name || '')));
  if (LINUX) return named(name => new RegExp(`-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}\\.deb$`, 'i').test(name));
  if (MAC) return named(name => new RegExp(`-mac-${process.arch}\\.dmg$`, 'i').test(name));
  return named(name => /\.exe$/i.test(name) && /setup/i.test(name)) || named(name => /\.exe$/i.test(name));
}

function parseVersion(value = '') {
  return String(value).trim().replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
}
function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

class Updater {
  constructor({ app, broadcast }) {
    this.app = app;
    this.broadcast = broadcast;
    this.state = { status: 'idle', current: app.getVersion(), auto: this.readAuto() };
    this.downloading = null;
    this.cleanup();
  }

  // Installers of earlier updates stayed in the temp folder for good, one per version (GitHub issue #28). At start the
  // ones this build no longer needs go: its own version's and older ones, and downloads cut short (.part). A newer one
  // (downloaded, not installed yet) stays. A file still in use (an installer running) is left for the next start.
  cleanup() {
    const dir = path.join(this.app.getPath('temp'), 'LilacAnime-update');
    let names = []; try { names = fs.readdirSync(dir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      const version = name.match(/^LilacAnime-Setup-(.+)\.(?:exe|dmg|deb)$/i)?.[1];
      if (!/\.part$/i.test(name) && !(version && !isNewer(version, this.app.getVersion()))) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { /* in use */ }
    }
    return removed;
  }

  // 자동 업데이트 (GitHub issue #28): on, the app looks for a new version by itself, downloads it, shows the banner and
  // installs it when closed. Off, nothing happens until 설정 > 업데이트 확인, and a downloaded installer waits for 지금 설치.
  get prefsFile() { return path.join(this.app.getPath('userData'), 'update-prefs.json'); }
  readAuto() { try { return JSON.parse(fs.readFileSync(this.prefsFile, 'utf8')).auto !== false; } catch { return true; } }
  get auto() { return this.state.auto !== false; }
  setAuto(value) {
    const auto = value !== false;
    try { fs.writeFileSync(this.prefsFile, JSON.stringify({ auto })); } catch { /* kept for this run */ }
    return this.set({ auto });
  }

  set(patch) { this.state = { ...this.state, ...patch }; this.broadcast('update:state', this.state); return this.state; }

  // scheduled: the app's own periodic check, skipped while 자동 업데이트 is off.
  async check({ scheduled = false } = {}) {
    if (scheduled && !this.auto) return this.state;
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    this.set({ status: 'checking', error: null });
    try {
      const response = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `LilacAnime-Desktop/${this.app.getVersion()}` } });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const release = await response.json();
      const latest = String(release.tag_name || release.name || '').replace(/^v/i, '');
      const asset = installerAsset(release.assets || []);
      // Whatever GitHub marks as Latest is installed when it differs from this build, even an older version
      // (a release can be rolled back by publishing it again).
      if (!latest || parseVersion(latest).join('.') === parseVersion(this.app.getVersion()).join('.')) return this.set({ status: 'latest', latest: latest || this.app.getVersion() });
      if (!asset) throw new Error(MAC ? '릴리스에 이 Mac용 설치 파일(.dmg)이 없습니다.' : LINUX ? '릴리스에 이 Linux용 설치 파일(.deb)이 없습니다.' : '릴리스에 설치 파일(.exe)이 없습니다.');
      if (LINUX && !DEB) throw new Error(`새 버전 v${latest}이 있습니다. Linux는 이제 .deb로 설치합니다. 릴리스 페이지에서 .deb를 받아 설치해 주세요.`);
      this.asset = asset;
      this.set({ status: 'available', latest, notes: String(release.body || '').slice(0, 20000), url: release.html_url || '', size: Number(asset.size) || 0 });
      // Downloaded right away when updates are automatic; installing still waits for the user (it restarts the app).
      if (this.auto) this.download();
      return this.state;
    } catch (error) {
      return this.set({ status: 'error', error: error.message || '업데이트 확인 실패' });
    }
  }

  async download() {
    if (this.state.status === 'ready') return this.state;
    if (this.downloading) return this.downloading;
    if (!this.asset) await this.check();
    // check() starts the download itself once it finds the release.
    if (this.downloading) return this.downloading;
    if (!this.asset) return this.state;
    this.downloading = (async () => {
      const dir = path.join(this.app.getPath('temp'), 'LilacAnime-update');
      fs.mkdirSync(dir, { recursive: true });
      // The asset is always "LilacAnime-Setup.exe" (or the Mac's .dmg); the saved copy is named by the release, so an
      // older one is never overwritten while it may still be open.
      const file = path.join(dir, `LilacAnime-Setup-${String(this.state.latest || 'update').replace(/[^\w.-]/g, '_')}${MAC ? '.dmg' : LINUX ? '.deb' : '.exe'}`);
      const partial = `${file}.part`;
      this.set({ status: 'downloading', percent: 0 });
      try {
        const response = await fetch(this.asset.browser_download_url, { headers: { 'User-Agent': `LilacAnime-Desktop/${this.app.getVersion()}`, Accept: 'application/octet-stream' } });
        if (!response.ok || !response.body) throw new Error(`다운로드 HTTP ${response.status}`);
        const total = Number(response.headers.get('content-length')) || Number(this.asset.size) || 0;
        let received = 0, lastPercent = -1;
        const stream = Readable.fromWeb(response.body);
        stream.on('data', chunk => {
          received += chunk.length;
          const percent = total ? Math.floor(received / total * 100) : null;
          if (percent !== lastPercent) { lastPercent = percent; this.set({ percent }); }
        });
        await pipeline(stream, fs.createWriteStream(partial));
        if (this.asset.size && fs.statSync(partial).size !== Number(this.asset.size)) throw new Error('설치 파일 크기가 릴리스와 다릅니다.');
        // The file is run as an installer (silently, when the app closes): it must be the one the release names, byte
        // for byte. Its size alone said nothing of its contents.
        const expected = assetDigest(this.asset);
        if (expected && await fileSha256(partial) !== expected) throw new Error('설치 파일이 릴리스의 것과 다릅니다 (SHA-256 불일치).');
        fs.renameSync(partial, file);
        this.installer = file;
        return this.set({ status: 'ready', percent: 100 });
      } catch (error) {
        try { fs.unlinkSync(partial); } catch {}
        return this.set({ status: 'error', error: error.message || '다운로드 실패' });
      } finally { this.downloading = null; }
    })();
    return this.downloading;
  }

  get notesFile() { return path.join(this.app.getPath('userData'), 'update-notes.json'); }

  install(relaunch = true) {
    if (!this.installer || !fs.existsSync(this.installer)) throw new Error('다운로드된 설치 파일이 없습니다.');
    if (this.installing) return true; this.installing = true;
    // The new version shows these notes on its first start, even offline.
    try { fs.writeFileSync(this.notesFile, JSON.stringify({ version: this.state.latest, notes: this.state.notes || '', url: this.state.url || '' })); } catch { /* fetched by tag instead */ }
    // macOS: an app that is not signed by Apple cannot replace itself, so the disk image is opened for the person to
    // drag the app into Applications, and the app closes so the old one is not in use.
    if (MAC) {
      shell.openPath(this.installer).then(error => { if (error) this.installing = false; else if (relaunch) setTimeout(() => this.app.quit(), 300); });
      return true;
    }
    // .deb: installed by apt (dpkg where there is no apt) as root through pkexec, which asks for the password in its own
    // window. The files under /opt are replaced while this one runs; it is started again once the install is done.
    if (DEB) {
      const apt = fs.existsSync('/usr/bin/apt-get'), child = spawn('pkexec', apt ? ['/usr/bin/apt-get', 'install', '-y', '--allow-downgrades', this.installer] : ['/usr/bin/dpkg', '-i', this.installer], { stdio: 'ignore' });
      const failed = message => { this.installing = false; this.set({ status: 'error', error: message }); };
      child.once('error', () => failed('pkexec이 없어 설치하지 못했습니다. 릴리스 페이지에서 .deb를 받아 설치해 주세요.'));
      child.once('close', code => {
        if (code !== 0) { failed(code === 126 || code === 127 ? '설치가 취소되었습니다.' : `설치하지 못했습니다 (코드 ${code}).`); return; }
        if (relaunch) this.app.relaunch(); this.app.quit();
      });
      return true;
    }
    // NSIS assisted installer: /S installs silently into the existing directory, --updated relaunches.
    // Windows security (Defender, Smart App Control) can refuse to start it (GitHub issue #31): then the app stays open
    // and says so, and the installer's folder opens so it can be run by hand (or allowed in Windows 보안) — instead of an
    // unhandled spawn error, or an app that closed with nothing installed.
    let child;
    try { child = spawn(this.installer, relaunch ? ['/S', '--updated', '--force-run'] : ['/S', '--updated'], { detached: true, stdio: 'ignore' }); }
    catch (error) { this.blocked(error); return false; }
    let quit = null;
    child.once('error', error => { if (quit) clearTimeout(quit); this.blocked(error); });
    child.unref();
    if (relaunch) quit = setTimeout(() => this.app.quit(), 1500);
    return true;
  }
  blocked(error) {
    this.installing = false;
    const refused = ['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code) || /virus|malware|blocked|operation did not complete/i.test(error?.message || '');
    this.set({ status: 'error', error: `${refused ? 'Windows 보안이 설치 파일 실행을 막았습니다' : '설치 파일을 실행하지 못했습니다'} (${error?.code || error?.message || '알 수 없음'}). 열린 폴더의 설치 파일을 직접 실행하거나 릴리스 페이지에서 받아 설치해 주세요.` });
    try { shell.showItemInFolder(this.installer); } catch { /* the message is enough */ }
  }
  // A downloaded update the user did not install is put in when the app is closed (silently, without opening it again).
  // (Not on macOS, where it takes the person, nor for a .deb, which asks for the password.)
  // Only with 자동 업데이트 on: off, closing the app never installs anything.
  installOnQuit() { if (!MAC && !DEB && this.auto && this.state.status === 'ready' && !this.installing) try { this.install(false); } catch { /* next start */ } }
}

// Release notes of this build: the ones saved when it was installed, else the GitHub release of its tag.
Updater.prototype.notes = async function notes() {
  const version = this.app.getVersion(), same = value => parseVersion(value).join('.') === parseVersion(version).join('.');
  try {
    const saved = JSON.parse(fs.readFileSync(this.notesFile, 'utf8'));
    fs.rmSync(this.notesFile, { force: true });
    if (same(saved.version) && saved.notes) return { version, notes: String(saved.notes), url: String(saved.url || '') };
  } catch { /* none saved */ }
  for (const tag of [`v${version}`, version]) {
    try {
      const response = await fetch(`${RELEASES}/tags/${encodeURIComponent(tag)}`, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': `LilacAnime-Desktop/${version}` } });
      if (!response.ok) continue;
      const release = await response.json();
      return { version, notes: String(release.body || '').slice(0, 20000), url: release.html_url || '' };
    } catch { /* next tag spelling */ }
  }
  return { version, notes: '', url: 'https://github.com/whispelyn-byte/LilacAnime-desktop/releases' };
};

module.exports = { Updater, isNewer, assetDigest, fileSha256 };
