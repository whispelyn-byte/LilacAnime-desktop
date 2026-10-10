// 기기 동기화: the connection to the owner's LilacAnime server (lilacanimeserver on Vercel). Kept here, in the main
// process: the token stays out of the page, and the requests are not cross-origin ones. The page decides what to sync
// (src/device-sync.js) and asks through request().
const fs = require('fs');
const path = require('path');

const TIMEOUT = 20000;

// "my-server.vercel.app", "https://my-server.vercel.app/" → https://my-server.vercel.app (http only for this computer).
function serverAddress(value) {
  let text = String(value || '').trim();
  if (!text) throw new Error('서버 주소를 입력하세요.');
  if (!/^https?:\/\//i.test(text)) text = `${/^(?:localhost|127\.0\.0\.1)(?::|$)/i.test(text) ? 'http' : 'https'}://${text}`;
  let url; try { url = new URL(text); } catch { throw new Error('서버 주소가 올바르지 않습니다.'); }
  if (url.protocol === 'http:' && !/^(?:localhost|127\.0\.0\.1)$/i.test(url.hostname)) throw new Error('서버 주소는 https://로 시작해야 합니다.');
  return url.origin;
}

class DeviceSync {
  constructor({ app, fetchImpl = globalThis.fetch }) {
    this.file = path.join(app.getPath('userData'), 'device-sync.json');
    this.fetch = fetchImpl;
    try { this.config = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { this.config = {}; }
  }

  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.config, null, 1), 'utf8'); }

  status() { return { server: this.config.server || '', connected: Boolean(this.config.server && this.config.token) }; }

  async call(server, pathname, { method = 'GET', body, token } = {}) {
    let response;
    try {
      response = await this.fetch(`${server}${pathname}`, { method, signal: AbortSignal.timeout(TIMEOUT),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch (error) { throw new Error(error?.name === 'TimeoutError' ? '서버가 응답하지 않습니다.' : '서버에 연결하지 못했습니다. 주소와 인터넷 연결을 확인하세요.'); }
    let data = null; try { data = await response.json(); } catch { /* not JSON: not a LilacAnime server */ }
    if (!response.ok) throw Object.assign(new Error(data?.error || `서버 오류 (HTTP ${response.status})`), { status: response.status });
    if (!data) throw new Error('LilacAnime 서버가 아닌 것 같습니다. 주소를 확인하세요.');
    return data;
  }

  // Checks that the address is a LilacAnime server set up to work, signs in and keeps the token.
  async connect(address, password) {
    const server = serverAddress(address);
    const state = await this.call(server, '/api/status').catch(error => { throw error.status === 404 ? new Error('LilacAnime 서버가 아닌 것 같습니다. 주소를 확인하세요.') : error; });
    if (state.app !== 'lilacanime-server') throw new Error('LilacAnime 서버가 아닌 것 같습니다. 주소를 확인하세요.');
    if (!state.ready) throw new Error(`서버 설정이 끝나지 않았습니다. ${(state.problems || []).join(' ')}`);
    if (!String(password || '')) throw new Error('비밀번호를 입력하세요.');
    const { token } = await this.call(server, '/api/login', { method: 'POST', body: { password: String(password) } });
    // Another server: what was synced with the old one says nothing about this one (the page starts over, see server).
    this.config = { server, token };
    this.save();
    return this.status();
  }

  disconnect() { this.config = { server: this.config.server || '' }; this.save(); return this.status(); }

  // The page's sync requests. A token the server no longer takes (the password was changed) signs this computer out.
  async request(method, pathname, body) {
    if (!['GET', 'POST'].includes(method) || !/^\/api\/sync(?:\?since=\d+)?$/.test(pathname)) throw new Error('지원하지 않는 요청입니다.');
    if (!this.config.server || !this.config.token) throw Object.assign(new Error('기기 동기화가 연결되어 있지 않습니다.'), { status: 401 });
    try { return await this.call(this.config.server, pathname, { method, body, token: this.config.token }); }
    catch (error) { if (error.status === 401) this.disconnect(); throw error; }
  }
}

module.exports = { DeviceSync, serverAddress };
