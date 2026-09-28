// GitHub release based auto update (mirrors Android GithubReleaseChecker).
// Releases only need the NSIS installer asset (LilacAnime-Setup-x.y.z.exe).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const RELEASE_API = 'https://api.github.com/repos/whispelyn-byte/LilacAnime-desktop/releases/latest';

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
    this.state = { status: 'idle', current: app.getVersion() };
    this.downloading = null;
  }

  set(patch) { this.state = { ...this.state, ...patch }; this.broadcast('update:state', this.state); return this.state; }

  async check() {
    if (['checking', 'downloading'].includes(this.state.status)) return this.state;
    this.set({ status: 'checking', error: null });
    try {
      const response = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `LilacAnime-Desktop/${this.app.getVersion()}` } });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const release = await response.json();
      const latest = String(release.tag_name || release.name || '').replace(/^v/i, '');
      const asset = (release.assets || []).find(item => /\.exe$/i.test(item.name || '') && /setup/i.test(item.name || '')) || (release.assets || []).find(item => /\.exe$/i.test(item.name || ''));
      if (!latest || !isNewer(latest, this.app.getVersion())) return this.set({ status: 'latest', latest: latest || this.app.getVersion() });
      if (!asset) throw new Error('릴리스에 설치 파일(.exe)이 없습니다.');
      this.asset = asset;
      return this.set({ status: 'available', latest, notes: String(release.body || '').slice(0, 2000), url: release.html_url || '', size: Number(asset.size) || 0 });
    } catch (error) {
      return this.set({ status: 'error', error: error.message || '업데이트 확인 실패' });
    }
  }

  async download() {
    if (this.state.status === 'ready') return this.state;
    if (this.downloading) return this.downloading;
    if (!this.asset) await this.check();
    if (!this.asset) return this.state;
    this.downloading = (async () => {
      const dir = path.join(this.app.getPath('temp'), 'LilacAnime-update');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, path.basename(this.asset.name).replace(/[^\w.-]/g, '_'));
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

  install() {
    if (!this.installer || !fs.existsSync(this.installer)) throw new Error('다운로드된 설치 파일이 없습니다.');
    // NSIS assisted installer: /S installs silently into the existing directory, --updated relaunches.
    const child = spawn(this.installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => this.app.quit(), 300);
    return true;
  }
}

module.exports = { Updater, isNewer };
