const { test } = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../src/device-sync.js');

// The LilacAnime server's rules (lilacanimeserver/lib/sync.js): the later change of an item wins, every write gets the
// next revision, and an item sent older than the server's copy comes back as that copy.
function server() {
  const items = new Map(); let rev = 0;
  const member = item => `${item.collection}\n${item.id}`;
  return {
    items,
    async push(list) {
      const current = [];
      for (const item of list) {
        const seen = items.get(member(item));
        if (seen && seen.updated >= item.updated) { if (seen.updated !== item.updated || Boolean(seen.deleted) !== Boolean(item.deleted)) current.push(seen); continue; }
        items.set(member(item), { ...structuredClone(item), rev: ++rev });
      }
      return { rev, accepted: list.length - current.length, current: structuredClone(current) };
    },
    async pull(since) { return { items: structuredClone([...items.values()].filter(item => item.rev > since).sort((a, b) => a.rev - b.rev)), more: false, rev }; },
  };
}
// One app: its lists, its saved sync state and a clock.
function device(api, lists = {}) {
  const d = { lists: { library: [], history: [], ...lists }, saved: null, clock: 1000, writes: 0 };
  d.engine = sync.createSync({ api, read: () => structuredClone(d.lists), write: value => { d.lists = value; d.writes++; }, state: { get: () => d.saved, set: value => { d.saved = value; } },
    status: info => { if (info.state === 'error') throw info.error; }, now: () => d.clock });
  return d;
}
const anime = (id, extra = {}) => ({ mal_id: id, title: `작품 ${id}`, savedAt: 500, ...extra });
const watch = (key, progress, updated) => ({ key, name: `${key} · 1화`, progress, updated });

test('an anime saved or removed on one device follows on the other', async () => {
  const api = server(), a = device(api), b = device(api);
  a.lists.library.unshift(anime('reanime:x', { savedAt: 2000 })); a.clock = 2000; await a.engine.run();
  await b.engine.run();
  assert.deepEqual(b.lists.library.map(item => item.mal_id), ['reanime:x']);
  b.lists.library = []; b.clock = 3000; await b.engine.run();
  a.clock = 3500; await a.engine.run();
  assert.deepEqual(a.lists.library, []);
  const writes = a.writes; await a.engine.run(); assert.equal(a.writes, writes, 'nothing new: the lists are not written again');
});

test('history: the entry played last wins, and the newest come first', async () => {
  const api = server(), a = device(api, { history: [watch('ep1', 30, 1000), watch('ep0', 90, 500)] }), b = device(api, { history: [watch('ep1', 70, 2000)] });
  await a.engine.run(); await b.engine.run(); await a.engine.run();
  for (const d of [a, b]) assert.deepEqual(d.lists.history.map(item => [item.key, item.progress]), [['ep1', 70], ['ep0', 90]]);
});

test('connecting a device for the first time: what was removed elsewhere meanwhile stays removed', async () => {
  const api = server(), a = device(api, { library: [anime('keep'), anime('gone')] });
  await a.engine.run();
  a.lists.library = [anime('keep')]; a.clock = 5000; await a.engine.run();
  // b had both from before and connects now.
  const b = device(api, { library: [anime('keep'), anime('gone'), anime('mine', { savedAt: 6000 })] });
  b.clock = 6000; await b.engine.run();
  assert.deepEqual(b.lists.library.map(item => item.mal_id).sort(), ['keep', 'mine']);
  await a.engine.run();
  assert.deepEqual(a.lists.library.map(item => item.mal_id), ['mine', 'keep'], 'a new anime from the other device comes first');
});

test('a change made while the sync runs is kept and sent next time; files on this computer are not sent', async () => {
  const api = server(), a = device(api, { history: [watch('ep1', 10, 1000), watch('file:///D:/video.mp4', 50, 900)] });
  const pull = api.pull;
  api.pull = async since => { a.lists.history[0] = watch('ep1', 40, 1100); return pull(since); };
  await a.engine.run();
  assert.equal(a.lists.history[0].progress, 40, 'not put back to 10 by its own echo');
  assert.deepEqual([...api.items.keys()], ['history\nep1']);
  api.pull = pull; await a.engine.run();
  assert.equal(api.items.get('history\nep1').data.progress, 40);
  const b = device(api); await b.engine.run();
  assert.deepEqual(b.lists.history.map(item => [item.key, item.progress]), [['ep1', 40]]);
});

test('history beyond 300 entries is let go locally without removing it on the other devices', async () => {
  const api = server(), many = Array.from({ length: 310 }, (_, i) => watch(`e${i}`, 1, 10000 - i));
  const a = device(api, { history: many }); await a.engine.run();
  const b = device(api); await b.engine.run();
  assert.equal(b.lists.history.length, 300);
  b.clock = 20000; await b.engine.run();
  assert.equal([...api.items.values()].filter(item => item.deleted).length, 0);
});

test('a failed request is reported, and the next run starts from the same place', async () => {
  const api = server(), errors = [];
  const d = { lists: { library: [anime('x')], history: [] }, saved: null };
  const engine = sync.createSync({ api: { push: async () => { throw new Error('offline'); }, pull: api.pull }, read: () => structuredClone(d.lists), write: value => { d.lists = value; },
    state: { get: () => d.saved, set: value => { d.saved = value; } }, status: info => { if (info.state === 'error') errors.push(info.error.message); } });
  await engine.run();
  assert.deepEqual(errors, ['offline']); assert.equal(d.saved, null);
});

test('connecting: the address is checked to be a LilacAnime server, the token is kept and a refused one signs out', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { DeviceSync, serverAddress } = require('../electron/device-sync.cjs');
  assert.equal(serverAddress('my-server.vercel.app/'), 'https://my-server.vercel.app');
  assert.equal(serverAddress('localhost:3000'), 'http://localhost:3000');
  assert.throws(() => serverAddress('http://example.com'), /https/);
  assert.throws(() => serverAddress(''), /주소/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-device-sync-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = []; let ready = true, tokenOk = true;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, options) => {
    calls.push([options.method, url, options.headers.Authorization || '', options.body || '']);
    if (url.endsWith('/api/status')) return reply(200, { app: 'lilacanime-server', version: 1, ready, problems: ready ? [] : ['LILAC_PASSWORD를 설정하세요.'] });
    if (url.endsWith('/api/login')) return JSON.parse(options.body).password === 'secret pw' ? reply(200, { token: 'tok' }) : reply(401, { error: '비밀번호가 맞지 않습니다.' });
    if (url.includes('/api/sync')) return tokenOk ? reply(200, { rev: 0, items: [], more: false }) : reply(401, { error: '다시 로그인해 주세요.' });
    return reply(404, null);
  };
  const app = { getPath: () => dir }, client = new DeviceSync({ app, fetchImpl });
  ready = false; await assert.rejects(client.connect('my-server.vercel.app', 'secret pw'), /LILAC_PASSWORD/); ready = true;
  await assert.rejects(client.connect('my-server.vercel.app', 'wrong'), /비밀번호가 맞지 않습니다/);
  assert.deepEqual(await client.connect('my-server.vercel.app', 'secret pw'), { server: 'https://my-server.vercel.app', connected: true });
  assert.deepEqual(new DeviceSync({ app, fetchImpl }).status(), { server: 'https://my-server.vercel.app', connected: true }, 'kept for the next start');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'device-sync.json'), 'utf8'), /secret pw/, 'the password itself is not stored');
  await client.request('GET', '/api/sync?since=0');
  assert.deepEqual(calls.at(-1).slice(0, 3), ['GET', 'https://my-server.vercel.app/api/sync?since=0', 'Bearer tok']);
  await assert.rejects(client.request('GET', '/api/login'), /지원하지 않는/);
  tokenOk = false; await assert.rejects(client.request('POST', '/api/sync', { items: [] }), /다시 로그인/);
  assert.deepEqual(client.status(), { server: 'https://my-server.vercel.app', connected: false });
});
