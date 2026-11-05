const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib'), crypto = require('node:crypto'), net = require('node:net');
const { EventEmitter } = require('node:events');
const { createWireGuardProxy, sanitizeConf, decodeConfFile, wireproxyConfig, extractTarFile, lastHandshake, isDirectHost, ASSETS } = require('../electron/wireguard-proxy.cjs');

const CONF = `# from the VPN's site
[Interface]
PrivateKey = cPrivateKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
Address = 10.2.0.2/32, fd00::2/128
DNS = 10.2.0.1
PostUp = iptables -A FORWARD
Table = off

[Peer]
PublicKey = pPublicKeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
Endpoint = vpn.example.com:51820 # the server
PersistentKeepalive = 25

[Socks5]
BindAddress = 0.0.0.0:1080
`;

test('a .conf keeps its tunnel keys only, and one peer takes all traffic when it names none', () => {
  const result = sanitizeConf(CONF);
  assert.equal(result.endpoint, 'vpn.example.com:51820'); assert.equal(result.peers, 1);
  assert.deepEqual(result.dropped.sort(), ['PostUp', 'Table', '[Socks5]'].sort());
  assert.doesNotMatch(result.text, /PostUp|Table|Socks5|#/);
  assert.match(result.text, /Address = 10\.2\.0\.2\/32, fd00::2\/128/);
  assert.match(result.text, /AllowedIPs = 0\.0\.0\.0\/0, ::\/0/);
  assert.match(wireproxyConfig(result.text, 41234), /\[http\]\nBindAddress = 127\.0\.0\.1:41234\n$/);
});

test('files that are not a client .conf are refused with a reason', () => {
  assert.throws(() => sanitizeConf('hello'), /\[Interface\]/);
  assert.throws(() => sanitizeConf('[Interface]\nPrivateKey = x=\n[Peer]\nPublicKey = y=\nEndpoint = a:1'), /Address/);
  assert.throws(() => sanitizeConf('[Interface]\nPrivateKey = x=\nAddress = 10.0.0.2/32'), /\[Peer\]/);
  assert.throws(() => sanitizeConf('[Interface]\nPrivateKey = x=\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = y='), /Endpoint/);
});

test('this computer and the local network go direct, the internet through the tunnel', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '192.168.0.10', '10.1.2.3', '172.20.0.1', '169.254.1.1', 'nas.local', 'fd12::1']) assert.equal(isDirectHost(host), true, host);
  for (const host of ['linkani.tv', '172.32.0.1', '8.8.8.8', 'reanime.to', '2001:db8::1']) assert.equal(isDirectHost(host), false, host);
});

// A .tar.gz with the given files, as the release archives are.
function tarGz(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const header = Buffer.alloc(512); header.write(name, 0); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136); header.write('        ', 148); header.write('0', 156); header.write('ustar\0', 257);
    let sum = 0; for (const byte of header) sum += byte; header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test('the program is taken out of its .tar.gz, and handshakes are read from /metrics', () => {
  const archive = tarGz({ 'LICENSE': Buffer.from('ISC'), 'wireproxy.exe': Buffer.from('MZ program') });
  assert.equal(extractTarFile(archive, 'wireproxy.exe').toString(), 'MZ program');
  assert.equal(extractTarFile(archive, 'missing'), null);
  assert.equal(lastHandshake('public_key=ab\nlast_handshake_time_sec=1700000000\nlast_handshake_time_sec=1700000500\n'), 1700000500);
  assert.equal(lastHandshake('last_handshake_time_sec=0\n'), 0);
});

test('every platform build is pinned by its SHA-256', () => {
  for (const [platform, asset] of Object.entries(ASSETS)) { assert.match(asset.sha256, /^[0-9a-f]{64}$/, platform); assert.match(asset.name, /^wireproxy_.+\.tar\.gz$/, platform); }
});

function harness(t, { encryption = true, sha = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-wireguard-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const program = tarGz({ 'wireproxy.exe': Buffer.from('MZ program') }), calls = [], servers = [];
  t.after(() => servers.forEach(server => server.close()));
  const spawned = [];
  const proxy = createWireGuardProxy({
    app: { getPath: () => dir }, platform: 'win32', arch: 'x64',
    assets: { 'win32-x64': { name: 'wp.tar.gz', sha256: sha || crypto.createHash('sha256').update(program).digest('hex') } },
    safeStorage: { isEncryptionAvailable: () => encryption, encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`), decryptString: data => Buffer.from(String(data).replace(/^sealed:/, ''), 'base64').toString() },
    spawn: (exe, args) => {
      // wireproxy's proxy answers on the port of its [http] section, until it is stopped.
      const config = fs.readFileSync(args[args.indexOf('-c') + 1], 'utf8'), server = net.createServer(socket => socket.end()); servers.push(server);
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { calls.push('kill'); server.close(); setImmediate(() => child.emit('exit', 0)); } });
      spawned.push({ exe, args, config });
      server.listen(Number(config.match(/BindAddress = 127\.0\.0\.1:(\d+)/)[1]), '127.0.0.1');
      return child;
    },
    fetch: async url => { calls.push(String(url)); if (/\/metrics$/.test(url)) return { ok: true, text: async () => `last_handshake_time_sec=${Math.floor(Date.now() / 1000)}\n` }; return { ok: true, arrayBuffer: async () => program }; }
  });
  return { proxy, dir, calls, spawned };
}

test('a loaded .conf is kept encrypted, wireproxy is fetched once, checked, run and reports the tunnel up', async t => {
  const { proxy, dir, calls, spawned } = harness(t);
  let state = await proxy.load(CONF, 'C:/Users/me/vpn.conf');
  assert.equal(state.name, 'vpn.conf'); assert.equal(state.sealed, true); assert.equal(state.enabled, false); assert.equal(proxy.proxyUrl(), null);
  const saved = fs.readFileSync(path.join(dir, 'wireguard', 'settings.json'), 'utf8');
  assert.doesNotMatch(saved, /cPrivateKey/); // never in the clear on disk
  state = await proxy.setEnabled(true);
  assert.match(proxy.proxyUrl(), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(spawned.length, 1); assert.match(spawned[0].config, /PrivateKey = cPrivateKey/); assert.match(spawned[0].config, /\[http\]/);
  assert.ok(fs.existsSync(path.join(dir, 'wireguard', 'v1.1.3', 'wireproxy.exe')));
  assert.ok(!fs.existsSync(path.join(dir, 'wireguard', 'run.conf'))); // the key is not left on disk once read
  for (let i = 0; i < 20 && proxy.status().status !== 'connected'; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(proxy.status().status, 'connected');
  proxy.stop(); await proxy.setEnabled(false);
  assert.equal(proxy.proxyUrl(), null); assert.ok(calls.includes('kill'));
  await proxy.setEnabled(true); proxy.stop();
  assert.equal(calls.filter(call => /wp\.tar\.gz$/.test(call)).length, 1); // the program is fetched once
});

test('a download that does not match its pinned hash is not run, and turning on needs a .conf', async t => {
  const empty = harness(t);
  await assert.rejects(empty.proxy.setEnabled(true), /설정 파일을 불러와/);
  const bad = harness(t, { sha: '0'.repeat(64) });
  await bad.proxy.load(CONF, 'vpn.conf');
  const state = await bad.proxy.setEnabled(true);
  assert.equal(state.status, 'error'); assert.match(state.message, /검증 실패/); assert.equal(bad.spawned.length, 0);
  assert.match(bad.proxy.proxyUrl(), /^http:\/\/127\.0\.0\.1:/); // still on: nothing goes out directly
  const removed = bad.proxy.remove();
  assert.equal(removed.loaded, false); assert.equal(bad.proxy.proxyUrl(), null);
});

test('a .conf saved as UTF-16 (Notepad\'s "Unicode") or with a UTF-8 mark is read as text', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CONF, 'utf16le')]);
  const be = Buffer.from(le); be.swap16();
  for (const bytes of [le, be, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CONF)]), Buffer.from(CONF)])
    assert.equal(sanitizeConf(decodeConfFile(bytes)).endpoint, sanitizeConf(CONF).endpoint);
});
