const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnilistClient } = require('../electron/anilist-client.cjs');

const headers = values => ({ get: name => values[name.toLowerCase()] ?? null });
const answer = (data, extra = {}) => ({ ok: true, status: 200, headers: headers(extra), json: async () => ({ data }) });
const refused = (status, extra = {}) => ({ ok: false, status, headers: headers(extra), body: { cancel: async () => {} } });
// A clock the client's waits move forward, so no test really waits.
function clock() { let time = 1000; return { now: () => time, sleep: async ms => { time += ms; }, waits: [] }; }

test('the same question asked twice is one request, and its answer is kept', async () => {
  const time = clock(); let calls = 0;
  const anilist = createAnilistClient({ ...time, fetch: async () => { calls++; return answer({ Media: { id: 1 } }); } });
  const [a, b] = await Promise.all([anilist('q', { id: 1 }), anilist('q', { id: 1 })]);
  assert.equal(a.Media.id, 1); assert.equal(b, a); assert.equal(calls, 1);
  await anilist('q', { id: 1 }); assert.equal(calls, 1);
  await anilist('q', { id: 2 }); assert.equal(calls, 2);
});

test('a 429 is waited out by Retry-After and asked again', async () => {
  const time = clock(); const starts = [];
  const replies = [refused(429, { 'retry-after': '7' }), answer({ Page: { media: [] } })];
  const anilist = createAnilistClient({ ...time, fetch: async () => { starts.push(time.now()); return replies.shift(); } });
  assert.deepEqual(await anilist('q'), { Page: { media: [] } });
  assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 7000);
});

test('a limit that lasts longer than the caller can wait fails as rate-limit, not as an empty answer', async () => {
  const time = clock();
  const anilist = createAnilistClient({ ...time, maxWait: 20000, fetch: async () => refused(429, { 'retry-after': '60' }) });
  await assert.rejects(anilist('q'), error => error.code === 'rate-limit');
  // Others asking meanwhile fail at once too, without a request of their own.
  await assert.rejects(anilist('other'), error => error.code === 'rate-limit');
});

test('no requests left in the minute: the next one waits for the reset the server names', async () => {
  const time = clock(); const starts = [], reset = Math.ceil((time.now() + 9000) / 1000);
  const anilist = createAnilistClient({ ...time, fetch: async () => { starts.push(time.now()); return answer({ ok: starts.length }, { 'x-ratelimit-remaining': starts.length === 1 ? '0' : '20', 'x-ratelimit-reset': String(reset) }); } });
  await anilist('a'); await anilist('b');
  assert.ok(starts[1] >= reset * 1000);
});

test('"not found" is an answer; a failure throws and is not kept', async () => {
  const time = clock(); let calls = 0;
  const anilist = createAnilistClient({ ...time, fetch: async () => { calls++; return refused(404); } });
  assert.deepEqual(await anilist('q'), {});
  const failing = createAnilistClient({ ...time, fetch: async () => { calls++; throw new TypeError('fetch failed'); } });
  calls = 0; await assert.rejects(failing('q'), error => error.code === 'network'); assert.equal(calls, 3);
  await assert.rejects(failing('q'), error => error.code === 'network'); assert.equal(calls, 6);
  const broken = createAnilistClient({ ...time, fetch: async () => ({ ok: true, status: 200, headers: headers({}), json: async () => ({ errors: [{ status: 400, message: 'bad' }] }) }) });
  await assert.rejects(broken('q'), error => error.code === 'graphql');
});
