const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup({ library = null, refresh = null, stored = null } = {}) {
  const elements = new Map(), requests = [], saved = new Map(stored ? [['libraryFacts', JSON.stringify(stored)]] : []);
  function element(id) { const classes = new Set(); return { id, dataset: {}, textContent: '', items: [], classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) }, setAttribute() {}, replaceChildren() { this.items = []; }, closest() { return element('section'); } }; }
  for (const id of ['seasonTitle', 'homeOrderNote', 'seasonRail', 'libraryOrderNote', 'libraryGrid', 'seeAllSeason', 'catalogFilterReset']) elements.set(`#${id}`, element(id));
  const home = ['season', 'updated'].map(value => Object.assign(element(value), { dataset: { order: value } })), buttons = ['saved', 'updated'].map(value => Object.assign(element(value), { dataset: { order: value } }));
  elements.set('#homeOrder [data-order="updated"]', home[1]);
  const state = { source: 'reanime', season: [{ mal_id: 'season' }], current: [{ mal_id: 'season' }], library: library || [{ mal_id: 'saved-old', provider: 'reanime' }, { mal_id: 'saved-new', provider: 'reanime' }] };
  const context = vm.createContext({ state, SOURCE_LABELS: { reanime: 'RE:Anime' },
    $: selector => elements.get(selector), $$: selector => selector.startsWith('#homeOrder') ? home : buttons,
    renderCards: (selector, items) => { elements.get(selector).items = items; },
    window: { lilac: { catalogUpdates: (provider, offset) => new Promise((resolve, reject) => requests.push({ provider, offset, resolve, reject })), ...(refresh ? { libraryRefresh: refresh } : {}) } },
    localStorage: { setItem: (key, value) => saved.set(key, value), getItem: key => saved.get(key) ?? null }, showHomeList() {}, switchView() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/catalog-updates.js'), 'utf8'), context);
  return { state, elements, requests, home, library: buttons, saved };
}

test('recent home feed cannot overwrite a later selection of the season list', async () => {
  const h = setup(), pending = h.home[1].onclick(); await tick(); h.home[0].onclick();
  h.requests[0].resolve({ data: [{ mal_id: 'update' }], done: true }); await pending;
  assert.equal(h.elements.get('#seasonRail').items[0].mal_id, 'season'); assert.equal(h.elements.get('#seasonTitle').textContent, '이번 시즌 신작');
});

test('library updates only reorder saved shows and refresh their episode metadata', async () => {
  const h = setup(), pending = h.library[1].onclick(); await tick();
  h.requests[0].resolve({ data: [{ mal_id: 'unrelated', provider: 'reanime' }, { mal_id: 'saved-new', provider: 'reanime', availableEpisodes: 2, totalEpisodes: 12 }], done: true }); await pending;
  const displayed = h.elements.get('#libraryGrid').items;
  assert.deepEqual(Array.from(displayed, item => item.mal_id), ['saved-new', 'saved-old']); assert.equal(displayed[0].availableEpisodes, 2);
  assert.deepEqual(h.state.library.map(item => item.mal_id), ['saved-old', 'saved-new']);
  await h.library[0].onclick(); assert.deepEqual(Array.from(h.elements.get('#libraryGrid').items, item => item.mal_id), ['saved-old', 'saved-new']);
});

test('switching back to saved order ignores a pending response; failed feeds leave saved shows visible', async () => {
  const h = setup(), pending = h.library[1].onclick(); await tick(); await h.library[0].onclick();
  h.requests[0].resolve({ data: [{ mal_id: 'saved-new', provider: 'reanime' }], done: true }); await pending;
  assert.deepEqual(Array.from(h.elements.get('#libraryGrid').items, item => item.mal_id), ['saved-old', 'saved-new']);
  const second = setup(), fail = second.library[1].onclick(); await tick(); second.requests[0].reject(Error('offline')); await fail;
  assert.equal(second.elements.get('#libraryGrid').items.length, 2); assert.match(second.elements.get('#libraryOrderNote').textContent, /불러오지 못했습니다/);
});

// GitHub issue #28: works of several sources, some dated only by their own page, in one order by their latest episode.
test('최근 업데이트순 orders every source by the day of its latest episode', async () => {
  const day = n => new Date(Date.UTC(2026, 10, n)).toISOString();
  const library = [
    { mal_id: 'reanime:a', provider: 'reanime', availableEpisodes: 3 }, { mal_id: 'animenosub:b', provider: 'animenosub', availableEpisodes: 3 },
    { mal_id: 'ohli24:c', provider: 'ohli24', availableEpisodes: 3 }, { mal_id: 'linkkf:d', provider: 'linkkf' }, { mal_id: 'miruro:e', provider: 'miruro' }];
  const asked = [];
  const pages = { 'animenosub:b': { availableEpisodes: 7, totalEpisodes: 12, updatedAt: day(9) }, 'ohli24:c': { availableEpisodes: 6, updatedAt: day(10) }, 'miruro:e': { availableEpisodes: 2, updatedAt: day(6) } };
  const h = setup({ library, refresh: async list => { asked.push(list.map(item => item.mal_id)); return list.filter(item => pages[item.mal_id]).map(item => ({ mal_id: item.mal_id, ...pages[item.mal_id] })); } });
  const pending = h.library[1].onclick(); await tick();
  // The sources' recent lists: RE:Anime dates its work, the others answer nothing of use.
  for (const request of h.requests) request.resolve(request.provider === 'reanime' ? { data: [{ mal_id: 'reanime:a', provider: 'reanime', availableEpisodes: 5, updatedAt: day(8) }], done: true } : { data: [], done: true });
  await pending;
  const shown = Array.from(h.elements.get('#libraryGrid').items);
  assert.deepEqual(shown.map(item => item.mal_id), ['ohli24:c', 'animenosub:b', 'reanime:a', 'miruro:e', 'linkkf:d']);
  // The counts are today's, not those of the day the work was saved; the saved cards themselves are untouched.
  assert.deepEqual(shown.slice(0, 3).map(item => item.availableEpisodes), [6, 7, 5]); assert.equal(h.state.library[1].availableEpisodes, 3);
  // RE:Anime's list settled its work; the pages of the others were read (never Linkkf's: no update dates there).
  assert.deepEqual(asked.flat().sort(), ['animenosub:b', 'miruro:e', 'ohli24:c']);
  assert.equal(JSON.parse(h.saved.get('libraryFacts'))['animenosub:b'].availableEpisodes, 7);
});

test('저장순 also shows the counts of now, and a work looked at lately is not read again', async () => {
  const library = [{ mal_id: 'animenosub:b', provider: 'animenosub', availableEpisodes: 3 }, { mal_id: 'reanime:a', provider: 'reanime', availableEpisodes: 1 }];
  let calls = 0;
  const h = setup({ library, stored: { 'reanime:a': { availableEpisodes: 4, checkedAt: Date.now() } }, refresh: async list => { calls++; return list.map(item => ({ mal_id: item.mal_id, availableEpisodes: 9, updatedAt: '2026-11-10T00:00:00.000Z' })); } });
  await h.library[0].onclick();
  const shown = Array.from(h.elements.get('#libraryGrid').items);
  assert.deepEqual(shown.map(item => [item.mal_id, item.availableEpisodes]), [['animenosub:b', 9], ['reanime:a', 4]]);
  await h.library[0].onclick(); assert.equal(calls, 1);
});
