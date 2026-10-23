const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), crypto = require('node:crypto');
const { createFlixProxyUrl, closeFlixProxy, flixReadable } = require('../electron/flix-proxy.cjs');

// A CDN serving segments this decoder knows (an MPEG-TS stream behind a fake PNG header), and one serving bytes it does
// not (as vault-90.rundowncdn.top does behind RE:Anime's HD-1): the stream of the second is reported unreadable.
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
