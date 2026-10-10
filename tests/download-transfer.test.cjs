const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { downloadFile } = require('../electron/download-transfer.cjs');
const payload = Buffer.from('0123456789abcdefghijklmnopqrstuv');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-transfer-test-')), file = path.join(dir, 'video.source');
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  return file;
}
function response(data, { status = 200, headers = {} } = {}) {
  let at = 0;
  return new Response(new ReadableStream({ pull(controller) { if (at >= data.length) controller.close(); else { controller.enqueue(data.subarray(at, at + 4)); at += 4; } } }),
    { status, headers: { 'content-length': String(data.length), etag: '"v1"', ...headers } });
}
async function interrupt(file, extra = {}) {
  const controller = new AbortController();
  await assert.rejects(downloadFile({ url: 'https://example/video', file, signal: controller.signal,
    fetch: async () => response(payload, extra), progress(received) { if (received >= 4) controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(fs.readFileSync(file), payload.subarray(0, 4));
}

test('a new process resumes a partial HTTP payload with Range and If-Range', async t => {
  const file = fixture(t); await interrupt(file); let calls = 0;
  await downloadFile({ url: 'https://example/video', file, fetch: async (_, { headers }) => {
    calls++; assert.equal(headers.Range, 'bytes=4-'); assert.equal(headers['If-Range'], '"v1"');
    return response(payload.subarray(4), { status: 206, headers: { 'content-range': `bytes 4-${payload.length - 1}/${payload.length}` } });
  } });
  assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(file), payload);
});

test('servers ignoring Range safely replace the old payload', async t => {
  const file = fixture(t); await interrupt(file);
  await downloadFile({ url: 'https://example/video', file, fetch: async () => response(payload) });
  assert.deepEqual(fs.readFileSync(file), payload);
});

test('changed validators and invalid partial responses fall back to a fresh payload without mixing bytes', async t => {
  for (const changed of [true, false]) {
    const file = fixture(t); await interrupt(file); let calls = 0;
    await downloadFile({ url: 'https://example/video', file, fetch: async (_, { headers }) => {
      if (++calls === 1) return response(payload.subarray(4), { status: 206, headers: { etag: changed ? '"v2"' : '"v1"', 'content-range': `bytes ${changed ? 4 : 3}-${payload.length - 1}/${payload.length}` } });
      assert.equal(headers.Range, undefined); return response(payload, { headers: { etag: '"v2"' } });
    } });
    assert.equal(calls, 2); assert.deepEqual(fs.readFileSync(file), payload);
  }
});

test('a completed payload is reused for remuxing, but a different video identity starts fresh', async t => {
  const file = fixture(t);
  await downloadFile({ url: 'https://example/video', file, fetch: async () => response(payload) });
  await downloadFile({ url: 'https://example/video', file, fetch: async () => assert.fail('completed payload must be reused') });
  await downloadFile({ url: 'https://example/other', file, fetch: async (_, { headers }) => { assert.equal(headers.Range, undefined); return response(Buffer.from('new')); } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('without a strong validator, partial content is replaced instead of risking a mixed video', async t => {
  const file = fixture(t); await interrupt(file, { headers: { etag: 'W/"weak"' } });
  await downloadFile({ url: 'https://example/video', file, fetch: async (_, { headers }) => { assert.equal(headers.Range, undefined); return response(payload); } });
  assert.deepEqual(fs.readFileSync(file), payload);
});
