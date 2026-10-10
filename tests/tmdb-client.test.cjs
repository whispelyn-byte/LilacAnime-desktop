const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTmdbClient } = require('../electron/tmdb-client.cjs');

const ok = () => ({ ok: true, json: async () => ({ results: [] }) });
const http = (status, retryAfter = null) => ({ ok: false, status, headers: { get: () => retryAfter } });
function harness(fetch) {
  let time = 1700000000000;
  const timers = [], starts = [];
  const request = createTmdbClient({ now: () => time, sleep: ms => new Promise(resolve => timers.push({ at: time + ms, resolve })),
    fetch: (...args) => { starts.push(time); return fetch(...args); } });
  async function run(promise) {
    let finished = false, result, error;
    promise.then(value => { finished = true; result = value; }, failure => { finished = true; error = failure; });
    for (let i = 0; i < 1000 && !finished; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (timers.length) {
        time = Math.max(time, Math.min(...timers.map(timer => timer.at)));
        for (let j = timers.length - 1; j >= 0; j--) if (timers[j].at <= time) timers.splice(j, 1)[0].resolve();
      }
    }
    assert.ok(finished, 'request did not settle');
    if (error) throw error;
    return result;
  }
  return { request, run, starts, advance: ms => { time += ms; } };
}

test('TMDB uses query authentication for v3 keys and bearer authentication for v4 tokens', async () => {
  const calls = [], h = harness(async (url, options) => { calls.push({ url, options }); return ok(); });
  await h.run(h.request('/search/tv', { query: 'One Piece', language: 'ko-KR' }, 'v3-key'));
  await h.run(h.request('/configuration', {}, 'v4.read.token'));
  assert.equal(calls[0].url.searchParams.get('api_key'), 'v3-key');
  assert.equal(calls[0].url.searchParams.get('query'), 'One Piece');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].url.searchParams.has('api_key'), false);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer v4.read.token');
});

test('concurrent catalog and foreground requests share start spacing', async () => {
  const h = harness(async () => ok());
  await h.run(Promise.all(Array.from({ length: 12 }, () => h.request('/search/tv', {}, 'key'))));
  assert.equal(h.starts.length, 12);
  for (let i = 1; i < h.starts.length; i++) assert.ok(h.starts[i] - h.starts[i - 1] >= 150);
});

test('temporary HTTP, network, timeout and JSON errors recover within the same request', async () => {
  for (const failure of [408, 500, 502, 503, 504, 'network', 'timeout', 'json']) {
    let calls = 0;
    const h = harness(async () => {
      if (++calls > 1) return ok();
      if (failure === 'network') throw new TypeError('fetch failed: secret-key');
      if (failure === 'timeout') throw new DOMException('expired', 'TimeoutError');
      if (failure === 'json') return { ok: true, json: async () => { throw new SyntaxError('bad JSON'); } };
      return http(failure);
    });
    assert.deepEqual(await h.run(h.request('/search/tv', {}, 'key')), { results: [] });
    assert.equal(calls, 2, String(failure)); assert.ok(h.starts[1] - h.starts[0] >= 1000);
  }
});

test('persistent errors have bounded retries and sanitized diagnostics', async () => {
  const h = harness(async () => { throw new TypeError('https://example/?api_key=secret-key'); });
  await assert.rejects(h.run(h.request('/search/tv', {}, 'key')), error => {
    assert.equal(error.code, 'network'); assert.equal(error.message.includes('secret-key'), false); return true;
  });
  assert.equal(h.starts.length, 3);
  assert.ok(h.starts[2] - h.starts[1] >= 2000);
});

test('authentication and permanent HTTP errors are not retried', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const h = harness(async () => http(status));
    await assert.rejects(h.run(h.request('/configuration', {}, 'key')), error => error.status === status && error.code === ([401, 403].includes(status) ? 'auth' : 'http'));
    assert.equal(h.starts.length, 1);
  }
  const h = harness(async () => ok());
  await assert.rejects(h.run(h.request('/configuration')), { code: 'auth' });
  assert.equal(h.starts.length, 0);
});

test('a 429 cooldown applies to queued requests as well as the failed request', async () => {
  let calls = 0;
  const h = harness(async () => ++calls === 1 ? http(429, '3') : ok());
  await h.run(Promise.all([h.request('/search/tv', {}, 'key'), h.request('/search/movie', {}, 'key')]));
  assert.equal(calls, 3);
  assert.ok(h.starts[1] - h.starts[0] >= 3000);
  assert.ok(h.starts[2] - h.starts[1] >= 150);
});

test('Retry-After HTTP dates and long cooldowns are respected without holding requests open', async () => {
  const date = new Date(1700000005000).toUTCString(); let calls = 0;
  const h = harness(async () => ++calls === 1 ? http(429, date) : ok());
  await h.run(h.request('/search/tv', {}, 'key'));
  assert.ok(h.starts[1] - h.starts[0] >= 5000);
  const long = harness(async () => http(429, '120'));
  await assert.rejects(long.run(long.request('/search/tv', {}, 'key')), { code: 'rate-limit', retryAfterMs: 120000 });
  await assert.rejects(long.run(long.request('/search/movie', {}, 'key')), { code: 'rate-limit', retryAfterMs: 120000 });
  assert.equal(long.starts.length, 1);
  long.advance(120000);
  await assert.rejects(long.run(long.request('/search/tv', {}, 'key')), { code: 'rate-limit' });
  assert.equal(long.starts.length, 2);
});
