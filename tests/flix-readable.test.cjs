const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), crypto = require('node:crypto');
const { createFlixProxyUrl, closeFlixProxy, flixReadable } = require('../electron/flix-proxy.cjs');

// A CDN serving segments this decoder knows (an MPEG-TS stream behind a fake PNG header), and one serving bytes it does
// not: the stream of the second is reported unreadable.
test('a stream whose segments cannot be decoded is told apart before playback', async t => {
  const ts = Buffer.alloc(188 * 4); for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const upstream = http.createServer((req, res) => {
    if (req.url.endsWith('.m3u8')) res.end(`#EXTM3U\n#EXTINF:1,\n${req.url.startsWith('/good') ? 'good' : 'bad'}-0.png\n`);
    else if (req.url === '/good-0.png') res.end(Buffer.concat([png, ts]));
    else if (req.url === '/bad-0.png') res.end(crypto.randomBytes(4096));
    else res.writeHead(404).end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { closeFlixProxy(); upstream.close(); });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  assert.equal(await flixReadable(await createFlixProxyUrl(`${base}/good.m3u8`, '')), true);
  assert.equal(await flixReadable(await createFlixProxyUrl(`${base}/bad.m3u8`, '')), false);
});

test('AES-128 segments and key pass through for player decryption; METHOD=NONE restores validation', async t => {
  const key = crypto.randomBytes(16), iv = crypto.randomBytes(16);
  const ts = Buffer.alloc(188 * 4); for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(ts), cipher.final()]);
  const upstream = http.createServer((req, res) => {
    if (req.url === '/video.m3u8') res.end(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString('hex')}\n#EXTINF:1,\nencrypted.png\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nbad.png\n`);
    else if (req.url === '/key.bin') res.end(key);
    else if (req.url === '/encrypted.png') res.end(encrypted);
    else if (req.url === '/bad.png') res.end(Buffer.alloc(4096, 0x22));
    else res.writeHead(404).end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { closeFlixProxy(); upstream.close(); });
  const url = await createFlixProxyUrl(`http://127.0.0.1:${upstream.address().port}/video.m3u8`, '');
  assert.equal(await flixReadable(url), true);
  const manifest = await (await fetch(url)).text();
  const keyUrl = manifest.match(/URI="([^"]+)"/)[1];
  const segmentUrls = manifest.split('\n').filter(line => line.startsWith('http'));
  const receivedKey = Buffer.from(await (await fetch(keyUrl)).arrayBuffer());
  const response = await fetch(segmentUrls[0]);
  assert.equal(response.status, 200);
  const ciphertext = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(ciphertext, encrypted);
  const decipher = crypto.createDecipheriv('aes-128-cbc', receivedKey, iv);
  assert.deepEqual(Buffer.concat([decipher.update(ciphertext), decipher.final()]), ts);
  assert.equal((await fetch(segmentUrls[1])).status, 502);
});
