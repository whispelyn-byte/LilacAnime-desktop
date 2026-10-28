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

test('an error from Vercel itself (no such function, a crash) is shown as words, not [object Object]', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { DeviceSync } = require('../electron/device-sync.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-device-sync-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let reply;
  const client = new DeviceSync({ app: { getPath: () => dir }, fetchImpl: async () => reply });
  reply = { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: 'The page could not be found' } }) };
  await assert.rejects(client.connect('my-server.vercel.app', 'pw'), error => /LilacAnime 서버가 없습니다/.test(error.message));
  reply = { ok: false, status: 500, json: async () => ({ error: { code: 'FUNCTION_INVOCATION_FAILED', message: 'A server error has occurred' } }) };
  await assert.rejects(client.connect('my-server.vercel.app', 'pw'), error => /FUNCTION_INVOCATION_FAILED/.test(error.message) && /Logs/.test(error.message));
  reply = { ok: false, status: 502, json: async () => { throw new Error('not JSON'); } };
  await assert.rejects(client.connect('my-server.vercel.app', 'pw'), error => /HTTP 502/.test(error.message));
});

test('a deployment behind Vercel Authentication says how to reach it', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { DeviceSync } = require('../electron/device-sync.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-device-sync-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new DeviceSync({ app: { getPath: () => dir }, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Protected by Vercel Authentication', error: { message: 'Protected deployment', code: '401' }, protection: { vercel_auth_enabled: true } }) }) });
  await assert.rejects(client.connect('test-2j058o2n4-team.vercel.app', 'pw'), error => /Deployment Protection/.test(error.message) && /Production/.test(error.message));
});

// One history entry past the server's 512-character id refused every sync ("items[14]: id는 512자 이하의 문자열이어야
// 합니다"): an 애니24 address with a long Korean title is sent decoded, or else hashed as the iOS app does.
test('long episode addresses are sent with ids the server takes, named as the iOS app names them', async () => {
  const title = '아주긴제목'.repeat(12), url = `https://ani.ohli24.com/e/${encodeURIComponent(`${title} 3화`)}`;
  assert.ok(`ohli24:${url}`.length > 512);
  assert.equal(sync.fitId(`ohli24:${url}`), `ohli24:https://ani.ohli24.com/e/${title} 3화`);
  const longer = sync.fitId(`ohli24:${'가'.repeat(600)}`);
  assert.match(longer, /^ohli24:#[0-9a-z]+$/);
  // FNV-1a (32-bit) of the UTF-8 bytes, in base 36: "a" is 0xe40c292c.
  const fnv = text => { let h = 0x811c9dc5; for (const byte of Buffer.from(text, 'utf8')) { h ^= byte; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
  assert.equal(fnv('a'), (0xe40c292c).toString(36));
  assert.equal(longer, `ohli24:#${fnv(`ohli24:${'가'.repeat(600)}`)}`);
  assert.equal(sync.fitId('reanime:x'), 'reanime:x');

  const api = server(), push = api.push;
  api.push = list => { for (const item of list) if (item.id.length > 512 || item.id.includes('\n')) throw new Error('id는 512자 이하의 문자열이어야 합니다.'); return push(list); };
  const a = device(api, { history: [watch(`ohli24:${url}`, 40, 2000), watch('reanime:1', 10, 1500)] }), b = device(api);
  await a.engine.run(); await b.engine.run();
  assert.deepEqual(b.lists.history.map(item => item.key).sort(), [`ohli24:${url}`, 'reanime:1'].sort());
  // The phone's copy of the entry (its key the decoded address) is the same entry here, not a second one.
  b.lists.history[0] = { ...b.lists.history.find(item => item.key.startsWith('ohli24:')), key: sync.fitId(`ohli24:${url}`), progress: 80, updated: 3000 };
  b.lists.history = b.lists.history.filter((item, at) => at === 0 || !item.key.startsWith('ohli24:'));
  b.clock = 3000; await b.engine.run(); await a.engine.run();
  assert.equal(a.lists.history.filter(item => item.key.startsWith('ohli24:')).length, 1);
  assert.equal(a.lists.history.find(item => item.key.startsWith('ohli24:')).progress, 80);
});

// The iOS app escapes ( ) ! ' * in an 애니24 address (Ktor's encodeURLParameter) and this app does not
// (encodeURIComponent): the same episode of "슬라임 (3기)" was two history entries.
test('an address with ( ) ! \' * escaped is the same entry as one without', () => {
  const slug = "전생했더니 슬라임이었던 건에 대하여 (3기) 5화!'*", desktop = `ohli24:https://ani.ohli24.com/e/${encodeURIComponent(slug)}`;
  const ios = desktop.replace(/[!'()*]/g, mark => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`);
  assert.notEqual(ios, desktop);
  assert.equal(sync.fitId(ios), sync.fitId(desktop));
  assert.equal(sync.fitId(desktop), desktop);
  assert.equal(sync.fitId(ios.replace('%28', '%28'.toLowerCase())), desktop);
  // An escaped % stays escaped: "%2528" is a literal "%28" in the address, not a "(".
  assert.equal(sync.fitId('reanime:a%2528b'), 'reanime:a%2528b');
  const long = `ohli24:https://ani.ohli24.com/e/${encodeURIComponent('가'.repeat(520) + ' (2기) 1화')}`;
  assert.equal(sync.fitId(long.replace(/[()]/g, mark => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`)), sync.fitId(long));
});

// The Android app (DeviceSyncMapping.kt) sends history in this app's shape; where it cannot tell an episode's address
// it keys it by its own episode id.
const nosub = (number, progress, updated) => ({ key: `animenosub:https://animenosub.to/bleach-tybw-episode-${number}/`, src: '', name: `Bleach · ${number}화`, episode: { provider: 'animenosub', number, name: String(number), url: `https://animenosub.to/bleach-tybw-episode-${number}/`, dub: false }, anime: { provider: 'animenosub', id: 'bleach', mal_id: 'animenosub:bleach', title: 'Bleach' }, progress, updated });
const fromPhone = (number, progress, updated) => ({ collection: 'history', id: `animenosub:bleach:animenosub:bleach_ep_${number}`, updated,
  data: { key: `animenosub:bleach:animenosub:bleach_ep_${number}`, src: '', name: `Bleach · ${number}화`, anime: { provider: 'animenosub', id: 'bleach', mal_id: 'animenosub:bleach', url: 'https://animenosub.to/anime/bleach/', title: 'Bleach' },
    episode: { provider: 'animenosub', number, name: String(number), key: `animenosub:bleach_ep_${number}` }, progress, updated, androidAnimeId: 'animenosub:bleach', androidEpisodeKey: `animenosub:bleach_ep_${number}`, episodeNumber: number } });

test('each source\'s episode has the Android app\'s key', () => {
  assert.equal(sync.androidEpisodeKey(nosub(5, 0, 1)), 'animenosub:bleach:animenosub:bleach_ep_5');
  assert.equal(sync.androidEpisodeKey({ ...nosub(5, 0, 1), episode: { ...nosub(5, 0, 1).episode, dub: true } }), 'animenosub:bleach:animenosub:bleach_dub_ep_5');
  assert.equal(sync.androidEpisodeKey({ anime: { provider: 'reanime', id: 'kaguya' }, episode: { number: 2, name: '2', url: 'x' } }), 'reanime:kaguya:reanime:kaguya:ep-2');
  assert.equal(sync.androidEpisodeKey({ anime: { provider: 'miruro', id: 123 }, episode: { number: 4, name: '4', url: 'x' } }), 'miruro:123:miruro:123:4');
  assert.equal(sync.androidEpisodeKey({ anime: { provider: 'linkani', id: '19848' }, episode: { number: 3, name: '3', url: 'https://linkani.tv/watch/19848/a1/k3/' } }), '19848:19848_ep_3');
  assert.equal(sync.androidEpisodeKey({ anime: { provider: 'ohli24', id: '슬라임' }, episode: { number: 5, name: '5', url: `https://ani.ohli24.com/e/${encodeURIComponent('슬라임 5화')}` } }), 'ohli24:슬라임:ohli24:슬라임:슬라임 5화');
});

test('an Animenosub episode watched on the phone is this side\'s entry for it', async () => {
  const api = server(), pc = device(api, { history: [nosub(5, 20, 2000)] });
  await pc.engine.run();
  await api.push([fromPhone(5, 70, 5000)]);
  pc.clock = 6000; await pc.engine.run();
  assert.equal(pc.lists.history.length, 1);
  assert.equal(pc.lists.history[0].key, nosub(5, 0, 0).key);
  assert.equal(pc.lists.history[0].progress, 70);
  assert.equal(pc.lists.history[0].episode.url, nosub(5, 0, 0).episode.url);
  // Its removal on the phone removes it here.
  await api.push([{ collection: 'history', id: 'animenosub:bleach:animenosub:bleach_ep_5', updated: 7000, deleted: true }]);
  pc.clock = 8000; await pc.engine.run();
  assert.equal(pc.lists.history.length, 0);
});

test('an episode only the phone watched comes as it is, to play by its number', async () => {
  const api = server(), pc = device(api, { history: [nosub(5, 20, 2000)] });
  await api.push([fromPhone(6, 30, 3000)]);
  await pc.engine.run();
  const six = pc.lists.history.find(item => item.episode.number === 6);
  assert.equal(six.key, 'animenosub:bleach:animenosub:bleach_ep_6');
  assert.equal(six.anime.provider, 'animenosub');
  assert.equal(pc.lists.history.length, 2);
});
