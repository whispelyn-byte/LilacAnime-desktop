const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createTmdbClient } = require('../electron/tmdb-client.cjs');

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const DAY = 86400000, RETRY = 60 * 1000;
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing section: ${start}`);
  return source.slice(first, last);
}
function setup({ items = [{ id: 'a', title: 'A' }], tried = {}, disk = new Map(), titles = new Map(), lookup = async () => [], realTitle, now = Date.now() } = {}) {
  const calls = [], statuses = [], timers = new Map(); let timerId = 0;
  if (!disk.has('reanime-index.json')) disk.set('reanime-index.json', JSON.stringify({ items, tried, metadataVersion: 1, updated: now }));
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ Date: Clock, DAY, CATALOGS: { reanime: { label: 'Re:Anime', title: realTitle }, linkkf: { korean: false } },
    activeCatalogSource: 'reanime', catalogIndexes: {}, catalogIndexRunning: false, catalogTitleRetryTimer: null,
    app: { getPath: () => '/cache' }, path,
    fs: { readFileSync(file) { const content = disk.get(path.basename(file)); if (content == null) throw Error('missing file'); return content; } },
    tmdbKey: () => 'stub-key', indexKorean: (_, item) => titles.get(item.id) || '', hasHangul: value => /[가-힣]/.test(value),
    tmdbKoreanTitles: async ([title]) => { calls.push(title); return lookup(title); },
    storeIndexKorean: (_, item, ko) => titles.set(item.id, ko), saveDisplayTitles() {}, saveCatalogIndex() {},
    saveCatalogTried(provider) { disk.set(`${provider}-tried.json`, JSON.stringify(context.catalogIndex(provider).tried)); },
    refreshCatalogList: async () => {},
    reportCatalogIndex(provider, status) { context.catalogIndex(provider).status = status; statuses.push([provider, status]); },
    setTimeout(fn, ms) {
      if (ms === 200) { queueMicrotask(fn); return; }
      const id = { id: ++timerId, unref() {} }; timers.set(id, { fn, ms }); return id;
    }, clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(section('function catalogIndex(provider)', '// The list (several MB)'), context);
  vm.runInContext(section('async function lookupCatalogKorean(provider)', '// Korean search over a whole catalog'), context);
  vm.runInContext(section('function catalogIndexState()', 'function reportCatalogIndex('), context);
  return { context, calls, statuses, timers, disk, titles, index: context.catalogIndex('reanime'), advance: ms => { now += ms; } };
}

test('request errors are not cached as completed searches and retain a retry status', async () => {
  for (const message of ['timeout', 'TMDB HTTP 401', 'TMDB HTTP 429', 'TMDB HTTP 503', 'invalid JSON']) {
    const h = setup({ lookup: async () => { throw Error(message); } });
    await h.context.buildCatalogIndexes();
    assert.equal(Object.keys(h.index.tried).length, 0, message);
    assert.equal(h.index.status, 'tmdb-error', message);
    assert.equal(h.timers.size, 1, message);
    assert.equal([...h.timers.values()][0].ms, RETRY);
  }
});

test('actual TMDB lookup propagates HTTP, transport and JSON failures to the retry path', async () => {
  for (const failure of [401, 429, 503, 'timeout', 'json']) {
    const h = setup(); let requests = 0;
    Object.assign(h.context, { URL, AbortSignal, titleCompareKey: value => String(value).toLowerCase(), fetch: async () => {
      requests++;
      if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
      return { ok: failure === 'json', status: failure, json: async () => { throw new SyntaxError('Invalid JSON'); } };
    } });
    let clock = Date.now();
    h.context.tmdbRequest = createTmdbClient({ fetch: h.context.fetch, interval: 0, now: () => clock, sleep: async ms => { clock += ms; } });
    vm.runInContext(section('async function tmdbFetch(', "// A work's story in Korean"), h.context);
    await h.context.buildCatalogIndexes();
    assert.equal(requests, failure === 401 ? 2 : 6); assert.equal(Object.keys(h.index.tried).length, 0);
    assert.equal(h.index.status, 'tmdb-error'); assert.equal(h.timers.size, 1);
    assert.equal(h.context.catalogIndexState().sources[0].error.code, failure === 401 ? 'auth' : failure === 429 ? 'rate-limit' : failure === 'json' ? 'response' : failure === 'timeout' ? 'timeout' : 'http');
  }
});

test('valid empty TMDB search responses are completed searches, not retry errors', async () => {
  const h = setup(); let requests = 0;
  Object.assign(h.context, { URL, AbortSignal, titleCompareKey: value => String(value).toLowerCase(), fetch: async () => {
    requests++; return { ok: true, json: async () => ({ results: [] }) };
  } });
  h.context.tmdbRequest = createTmdbClient({ fetch: h.context.fetch, interval: 0 });
  vm.runInContext(section('async function tmdbFetch(', "// A work's story in Korean"), h.context);
  await h.context.buildCatalogIndexes(); await h.context.buildCatalogIndexes();
  assert.equal(requests, 4); assert.equal(Object.keys(h.index.tried).length, 1);
  assert.equal(h.index.status, 'ready'); assert.equal(h.timers.size, 0);
});

test('an unavailable service stops after one batch and retries automatically after recovery', async () => {
  let unavailable = true;
  const items = Array.from({ length: 10 }, (_, id) => ({ id: String(id), title: `Show ${id}` }));
  const h = setup({ items, lookup: async () => { if (unavailable) throw Error('offline'); return ['한국어 제목']; } });
  await h.context.buildCatalogIndexes(); assert.equal(h.calls.length, 6);
  unavailable = false;
  const [id, timer] = [...h.timers][0]; h.timers.delete(id); await timer.fn();
  assert.equal(h.calls.length, 16); assert.equal(h.titles.size, 10); assert.equal(h.index.status, 'ready');
});

test('successful misses persist for 30 days while failed entries can retry on restart', async () => {
  const h = setup({ items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
    lookup: async title => { if (title === 'C') throw Error('offline'); return title === 'A' ? ['한국어 제목'] : []; } });
  await h.context.buildCatalogIndexes();
  assert.deepEqual(Object.keys(h.index.tried).sort(), ['a', 'b']);
  const restarted = setup({ disk: h.disk, titles: h.titles });
  await restarted.context.buildCatalogIndexes(); assert.deepEqual(restarted.calls, ['C']);
  await restarted.context.buildCatalogIndexes(); assert.equal(restarted.calls.length, 1);
  restarted.advance(30 * DAY + 1); await restarted.context.buildCatalogIndexes();
  assert.deepEqual(restarted.calls, ['C', 'B', 'C']);
  assert.equal(restarted.context.catalogIndexState().sources[0].korean, 1);
});

test('legacy marks are rechecked once without discarding existing Korean titles', async () => {
  const now = Date.now(), h = setup({ now, items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
    tried: { a: now, b: now, c: now }, titles: new Map([['a', '기존 제목']]) });
  await h.context.buildCatalogIndexes(); assert.deepEqual(h.calls, ['B', 'C']); assert.equal(h.titles.get('a'), '기존 제목');
  await h.context.buildCatalogIndexes(); assert.deepEqual(h.calls, ['B', 'C']);
});

test('failed series-page fetches do not cache a miss for an incomplete slug title', async () => {
  let unavailable = true;
  const h = setup({ items: [{ id: 'a', title: 'Lossy Slug', slugTitle: true }], realTitle: async item => {
    if (unavailable) throw Error('offline'); item.title = 'Real Title'; delete item.slugTitle;
  } });
  await h.context.buildCatalogIndexes(); assert.equal(Object.keys(h.index.tried).length, 0); assert.equal(h.calls.length, 0);
  unavailable = false; await h.context.buildCatalogIndexes(); assert.deepEqual(h.calls, ['Real Title']);
});

test('switching sources during failure does not schedule an inactive source or report it ready', async () => {
  let h; h = setup({ lookup: async () => { h.context.activeCatalogSource = 'linkkf'; throw Error('offline'); } });
  await h.context.buildCatalogIndexes();
  assert.equal(h.timers.size, 0); assert.equal(h.statuses.some(([provider, status]) => provider === 'reanime' && status === 'ready'), false);
  assert.equal(h.calls.length, 1);
});

test('settings show request failures separately from the Korean title count', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const first = appSource.indexOf('function renderCatalogIndex('), last = appSource.indexOf('window.lilac.onCatalogIndexState', first);
  const label = {}, context = vm.createContext({ $: () => label });
  vm.runInContext(appSource.slice(first, last), context);
  context.renderCatalogIndex({ tmdb: true, sources: [{ label: 'Re:Anime', korean: 10206, total: 20707, status: 'tmdb-error' }] });
  assert.match(label.textContent, /10,206/); assert.match(label.textContent, /20,707/);
  assert.match(label.textContent, /요청.*실패/); assert.match(label.textContent, /1분/);
  for (const [code, message] of [['auth', /키나 사용 권한/], ['rate-limit', /요청 제한/], ['timeout', /시간이 초과/], ['network', /연결하지 못/], ['response', /응답을 읽지 못/], ['source', /원본 작품 정보/], ['http', /HTTP 503/]]) {
    context.renderCatalogIndex({ tmdb: true, sources: [{ label: 'Re:Anime', korean: 10206, total: 20707, status: 'tmdb-error', error: { code, status: 503 } }] });
    assert.match(label.textContent, message);
    assert.equal(label.textContent.includes('다시 시도'), code !== 'auth');
  }
});

test('catalog retry respects a longer server cooldown and exposes no raw exception text', async () => {
  const h = setup({ lookup: async () => { throw Object.assign(Error('secret URL with API key'), { code: 'rate-limit', status: 429, retryAfterMs: 120000 }); } });
  await h.context.buildCatalogIndexes();
  assert.equal([...h.timers.values()][0].ms, 120000);
  assert.equal(JSON.stringify(h.context.catalogIndexState()).includes('secret'), false);
});
