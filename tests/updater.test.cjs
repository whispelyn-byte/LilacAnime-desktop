const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Module = require('node:module');

// updater.cjs asks Electron for `shell` only; a stand-in lets it load under plain Node.
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? { shell: { openPath: async () => '' } } : load.call(this, request, ...rest); };
const { Updater, assetDigest, fileSha256 } = require('../electron/updater.cjs');
Module._load = load;

function fixture(t, version = '0.5.63') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-updater-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const app = { getVersion: () => version, getPath: () => temp };
  return { temp, app, dir: path.join(temp, 'LilacAnime-update') };
}

test('installers of this version and older ones are removed at start; a newer one stays (issue #28)', t => {
  const { app, dir } = fixture(t); fs.mkdirSync(dir);
  for (const name of ['LilacAnime-Setup-0.5.50.exe', 'LilacAnime-Setup-0.5.63.exe', 'LilacAnime-Setup-0.5.64.exe', 'LilacAnime-Setup-0.5.64.exe.part', 'notes.txt']) fs.writeFileSync(path.join(dir, name), 'x');
  new Updater({ app, broadcast() {} });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['LilacAnime-Setup-0.5.64.exe', 'notes.txt']);
});

test('a downloaded installer must match the SHA-256 the release gives', async t => {
  const { app, dir } = fixture(t), data = Buffer.from('installer bytes'), sha = crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(assetDigest({ digest: `sha256:${sha.toUpperCase()}` }), sha); assert.equal(assetDigest({ digest: 'md5:abc' }), ''); assert.equal(assetDigest({}), '');
  const file = path.join(app.getPath(), 'file.bin'); fs.writeFileSync(file, data); assert.equal(await fileSha256(file), sha);
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response(data, { headers: { 'content-length': String(data.length) } });
  const download = async digest => {
    const updater = new Updater({ app, broadcast() {} });
    updater.asset = { browser_download_url: 'https://example.test/LilacAnime-Setup.exe', size: data.length, ...(digest ? { digest } : {}) }; updater.state.latest = '0.5.64';
    return updater.download();
  };
  const wrong = await download(`sha256:${'0'.repeat(64)}`);
  assert.equal(wrong.status, 'error'); assert.match(wrong.error, /SHA-256/); assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal((await download(`sha256:${sha}`)).status, 'ready');
  // A release without a digest (an older one) is still taken by its size.
  assert.equal((await download('')).status, 'ready');
});
