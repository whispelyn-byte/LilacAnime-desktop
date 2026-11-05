// 설정 > 연결 > 이 앱만 WireGuard로 연결: this app's traffic alone goes through a WireGuard tunnel, with no system VPN,
// driver or admin rights. wireproxy (userspace WireGuard, github.com/windtf/wireproxy, ISC) runs the tunnel and opens
// an HTTP proxy on 127.0.0.1; main.cjs points Chromium's sessions, Node's fetch and child processes (ffmpeg, uv) at it,
// local and LAN addresses (the app's own servers, device sync) going direct.
// While it is on the proxy address is used whether or not the tunnel is up: a tunnel that is down stops the app's
// traffic instead of letting it out directly. The .conf holds a private key: it is kept encrypted (safeStorage) and
// written out only for wireproxy to read at its start, then deleted.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const netModule = require('net');

const WIREPROXY_VERSION = 'v1.1.3';
// The release files, pinned by their SHA-256 (the release's checksums.txt).
const ASSETS = {
  'win32-x64': { name: 'wireproxy_windows_amd64.tar.gz', sha256: 'bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f' },
  'darwin-x64': { name: 'wireproxy_darwin_amd64.tar.gz', sha256: '5d89742a0f381d9508d3ad828a0d300dceee24fa49015427eaff42a23f7a50bd' },
  'darwin-arm64': { name: 'wireproxy_darwin_arm64.tar.gz', sha256: '28d34342c48c309b628d9c06ab4efc05b82fba49821f360605c02139c02547a5' },
  'linux-x64': { name: 'wireproxy_linux_amd64.tar.gz', sha256: 'e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c' },
  'linux-arm64': { name: 'wireproxy_linux_arm64.tar.gz', sha256: '370e00bd2167960d1ecd1c3c1439715bbaa94a0a110a2040468670c9af6021b6' }
};
// The keys wireproxy reads; the others of a wg-quick file (PostUp, Table, SaveConfig, …) are left out.
const INTERFACE_KEYS = ['PrivateKey', 'Address', 'DNS', 'MTU', 'ListenPort'];
const PEER_KEYS = ['PublicKey', 'PresharedKey', 'Endpoint', 'AllowedIPs', 'PersistentKeepalive'];

// A WireGuard .conf as wireproxy takes it: its [Interface] and [Peer] sections with their known keys, comments and
// anything else left out. Throws (in Korean, for the settings page) when it is not a usable client file.
function sanitizeConf(text) {
  const sections = [], dropped = new Set();
  let current = null;
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (header) { current = /^interface$/i.test(header[1]) ? { kind: 'Interface', keys: [] } : /^peer$/i.test(header[1]) ? { kind: 'Peer', keys: [] } : null; if (current) sections.push(current); else dropped.add(`[${header[1]}]`); continue; }
    const pair = line.match(/^([A-Za-z]+)\s*=\s*(.+)$/);
    if (!pair || !current) continue;
    const known = (current.kind === 'Interface' ? INTERFACE_KEYS : PEER_KEYS).find(key => key.toLowerCase() === pair[1].toLowerCase());
    if (known) current.keys.push([known, pair[2].trim()]); else dropped.add(pair[1]);
  }
  const value = (section, key) => section.keys.find(([name]) => name === key)?.[1] || '';
  const interfaces = sections.filter(section => section.kind === 'Interface'), peers = sections.filter(section => section.kind === 'Peer');
  if (interfaces.length !== 1) throw new Error('WireGuard 설정 파일이 아닙니다. [Interface] 부분이 하나 있어야 해요.');
  if (!value(interfaces[0], 'PrivateKey') || !value(interfaces[0], 'Address')) throw new Error('설정 파일의 [Interface]에 PrivateKey와 Address가 있어야 해요.');
  if (!peers.length) throw new Error('설정 파일에 [Peer]가 없어요.');
  for (const peer of peers) {
    if (!value(peer, 'PublicKey') || !value(peer, 'Endpoint')) throw new Error('설정 파일의 [Peer]에 PublicKey와 Endpoint가 있어야 해요.');
    // One peer takes all traffic when the file does not say which.
    if (!value(peer, 'AllowedIPs') && peers.length === 1) peer.keys.push(['AllowedIPs', '0.0.0.0/0, ::/0']);
  }
  const out = sections.map(section => `[${section.kind}]\n${section.keys.map(([key, val]) => `${key} = ${val}`).join('\n')}`).join('\n\n');
  return { text: `${out}\n`, peers: peers.length, endpoint: value(peers[0], 'Endpoint'), dropped: [...dropped] };
}
// The text of a picked file. A .conf saved again in Windows Notepad as "Unicode" is UTF-16 (with its byte order mark);
// read as UTF-8 it had no [Interface] at all.
function decodeConfFile(buffer) {
  const bytes = Buffer.from(buffer || []);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) { const swapped = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2))); swapped.swap16(); return swapped.toString('utf16le'); }
  return bytes.toString('utf8');
}
// wireproxy's own file: the tunnel, and its HTTP proxy on the loopback address.
function wireproxyConfig(sanitized, port) {
  return `${sanitized.trimEnd()}\n\n[http]\nBindAddress = 127.0.0.1:${Number(port)}\n`;
}

// A file of a .tar.gz by its base name (the release archives hold the program alone).
function extractTarFile(gz, name) {
  const tar = zlib.gunzipSync(gz);
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) break;
    const entry = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''), prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8), type = String.fromCharCode(header[156] || 48);
    const file = path.posix.basename(prefix ? `${prefix}/${entry}` : entry);
    if ((type === '0' || type === '\0') && file === name) return tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

// The newest handshake (seconds since 1970) in wireproxy's /metrics (WireGuard's own "last_handshake_time_sec=" lines), 0
// without one.
function lastHandshake(metrics) {
  return Math.max(0, ...[...String(metrics || '').matchAll(/last_handshake_time_sec=(\d+)/g)].map(match => Number(match[1]) || 0));
}

// Addresses that never go through the tunnel: this computer (the app's own servers) and the local network (device sync).
function isDirectHost(hostname = '') {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const ip = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
// The same list for Chromium (proxyBypassRules) and child processes (NO_PROXY, which knows no address ranges).
const CHROMIUM_BYPASS = '<local>;localhost;127.0.0.1;[::1];*.local;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16;169.254.0.0/16';
const NO_PROXY = 'localhost,127.0.0.1,::1,.local';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = netModule.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
function portOpen(port, timeout = 1000) {
  return new Promise(resolve => {
    const socket = netModule.connect({ host: '127.0.0.1', port }); const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
}

// deps: app (userData), safeStorage, spawn, fetch (a direct one: the tunnel is not up while wireproxy is fetched), now;
// assets: the release files by platform (ASSETS; tests give their own).
function createWireGuardProxy({ app, safeStorage, spawn, fetch, now = Date.now, platform = process.platform, arch = process.arch, assets = ASSETS }) {
  const dir = () => path.join(app.getPath('userData'), 'wireguard');
  const settingsFile = () => path.join(dir(), 'settings.json');
  const listeners = new Set();
  let settings = null, child = null, checkTimer = null, restartTimer = null, stopping = false, installing = null;
  let state = { status: 'off', message: '', handshake: 0 };

  function read() {
    if (settings) return settings;
    try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { settings = {}; }
    return settings;
  }
  function write(next) {
    settings = next; fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
  }
  const encrypted = () => Boolean(safeStorage?.isEncryptionAvailable?.());
  function sealConf(text) { return encrypted() ? { conf: safeStorage.encryptString(text).toString('base64'), sealed: true } : { conf: Buffer.from(text, 'utf8').toString('base64'), sealed: false }; }
  function openConf() {
    const saved = read(); if (!saved.conf) return '';
    const data = Buffer.from(saved.conf, 'base64');
    return saved.sealed ? safeStorage.decryptString(data) : data.toString('utf8');
  }
  function set(change) { state = { ...state, ...change }; const value = status(); for (const listener of listeners) { try { listener(value); } catch { /* a closed window */ } } }
  function status() {
    const saved = read();
    return { ...state, enabled: Boolean(saved.enabled), name: saved.name || '', endpoint: saved.endpoint || '', loaded: Boolean(saved.conf), sealed: saved.conf ? Boolean(saved.sealed) : encrypted(), proxy: proxyUrl(), dropped: saved.dropped || [] };
  }
  // The proxy every request goes to while the setting is on (also before or without the tunnel: see the top).
  function proxyUrl() { const saved = read(); return saved.enabled && saved.conf && saved.port ? `http://127.0.0.1:${saved.port}` : null; }

  const exeName = platform === 'win32' ? 'wireproxy.exe' : 'wireproxy';
  const exePath = () => path.join(dir(), WIREPROXY_VERSION, exeName);
  async function install() {
    if (fs.existsSync(exePath())) return exePath();
    const asset = assets[`${platform}-${arch}`];
    if (!asset) throw new Error(`이 컴퓨터(${platform} ${arch})에서 쓸 수 있는 wireproxy가 없어요.`);
    installing ||= (async () => {
      set({ status: 'installing', message: 'wireproxy를 받는 중...' });
      const response = await fetch(`https://github.com/windtf/wireproxy/releases/download/${WIREPROXY_VERSION}/${asset.name}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`wireproxy를 받지 못했어요 (HTTP ${response.status}).`);
      const data = Buffer.from(await response.arrayBuffer());
      if (crypto.createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error('받은 wireproxy 파일이 올바르지 않아요 (검증 실패).');
      const program = extractTarFile(data, exeName);
      if (!program?.length) throw new Error('wireproxy 압축 파일에 실행 파일이 없어요.');
      fs.mkdirSync(path.dirname(exePath()), { recursive: true });
      const partial = `${exePath()}.part`; fs.writeFileSync(partial, program, { mode: 0o755 }); fs.renameSync(partial, exePath());
      return exePath();
    })().finally(() => { installing = null; });
    return installing;
  }

  async function checkTunnel(infoPort) {
    try {
      const response = await fetch(`http://127.0.0.1:${infoPort}/metrics`, { signal: AbortSignal.timeout(3000) });
      const handshake = lastHandshake(await response.text()), fresh = handshake && now() / 1000 - handshake < 180;
      set(fresh ? { status: 'connected', message: '', handshake } : { status: 'connecting', message: 'VPN 서버의 응답을 기다리는 중... (계속되면 설정 파일의 서버 주소나 키를 확인해 주세요)', handshake });
    } catch { /* the next check */ }
  }
  async function start() {
    clearTimeout(restartTimer); stopping = false;
    const saved = read(); if (!saved.enabled || !saved.conf) return status();
    if (child) return status();
    try {
      const exe = await install(); if (!read().enabled || stopping) return status();
      set({ status: 'starting', message: 'WireGuard 터널을 여는 중...' });
      const infoPort = await freePort(), runFile = path.join(dir(), 'run.conf');
      fs.writeFileSync(runFile, wireproxyConfig(openConf(), saved.port), { encoding: 'utf8', mode: 0o600 });
      let output = '';
      const proc = spawn(exe, ['-c', runFile, '-i', `127.0.0.1:${infoPort}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child = proc;
      const keep = chunk => { output = (output + chunk.toString()).slice(-2000); };
      proc.stdout?.on('data', keep); proc.stderr?.on('data', keep);
      proc.once('exit', code => {
        try { fs.unlinkSync(runFile); } catch { /* deleted already */ }
        if (child === proc) child = null;
        clearInterval(checkTimer);
        if (stopping || !read().enabled) { set({ status: 'off', message: '' }); return; }
        const detail = output.trim().split(/\r?\n/).filter(Boolean).pop() || `종료 코드 ${code}`;
        set({ status: 'error', message: `WireGuard 터널이 멈췄어요: ${detail}. 5초 뒤 다시 시도합니다.` });
        restartTimer = setTimeout(() => { start().catch(() => {}); }, 5000);
      });
      proc.once('error', error => set({ status: 'error', message: `wireproxy를 실행하지 못했어요: ${error.message}` }));
      // Its proxy port answers once it has read the file, which is not kept on disk after that.
      for (let tries = 0; tries < 40 && child === proc && !(await portOpen(saved.port, 250)); tries++) await new Promise(resolve => setTimeout(resolve, 250));
      try { fs.unlinkSync(runFile); } catch { /* the process removed it or never read it */ }
      if (child !== proc) return status();
      set({ status: 'connecting', message: 'VPN 서버에 연결하는 중...' });
      clearInterval(checkTimer); checkTimer = setInterval(() => checkTunnel(infoPort), 5000); checkTunnel(infoPort);
    } catch (error) {
      set({ status: 'error', message: error.message });
    }
    return status();
  }
  function stop() {
    stopping = true; clearTimeout(restartTimer); clearInterval(checkTimer);
    if (child) { const proc = child; child = null; try { proc.kill(); } catch { /* gone already */ } }
    set({ status: 'off', message: '', handshake: 0 });
  }
  // A .conf picked in 설정 (its text and file name): checked, kept encrypted, and used at once when the setting is on.
  async function load(text, name = '') {
    const sanitized = sanitizeConf(text), saved = read();
    write({ ...saved, ...sealConf(sanitized.text), name: path.basename(String(name || 'wireguard.conf')), endpoint: sanitized.endpoint, dropped: sanitized.dropped, port: saved.port || await freePort() });
    if (read().enabled) { stop(); await start(); } else set({});
    return status();
  }
  async function setEnabled(on) {
    const saved = read();
    if (on && !saved.conf) throw new Error('먼저 WireGuard 설정 파일을 불러와 주세요.');
    write({ ...saved, enabled: Boolean(on), port: saved.port || await freePort() });
    if (on) await start(); else stop();
    return status();
  }
  function remove() {
    stop(); write({});
    try { fs.unlinkSync(settingsFile()); } catch { /* none */ }
    set({});
    return status();
  }
  return { status, proxyUrl, load, setEnabled, remove, start, stop, onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
}

module.exports = { createWireGuardProxy, sanitizeConf, decodeConfFile,wireproxyConfig, extractTarFile, lastHandshake, isDirectHost, CHROMIUM_BYPASS, NO_PROXY, ASSETS, WIREPROXY_VERSION };
