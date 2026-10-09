const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const elements = new Map(), requests = [];
  function element(id) { const classes = new Set(); return { id, dataset: {}, textContent: '', items: [], classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) }, setAttribute() {}, replaceChildren() { this.items = []; }, closest() { return element('section'); } }; }
  for (const id of ['seasonTitle', 'homeOrderNote', 'seasonRail', 'libraryOrderNote', 'libraryGrid', 'seeAllSeason', 'catalogFilterReset']) elements.set(`#${id}`, element(id));
  const home = ['season', 'updated'].map(value => Object.assign(element(value), { dataset: { order: value } })), library = ['saved', 'updated'].map(value => Object.assign(element(value), { dataset: { order: value } }));
  elements.set('#homeOrder [data-order="updated"]', home[1]);
  const state = { source: 'reanime', season: [{ mal_id: 'season' }], current: [{ mal_id: 'season' }], library: [{ mal_id: 'saved-old', provider: 'reanime' }, { mal_id: 'saved-new', provider: 'reanime' }] };
  const context = vm.createContext({ state, SOURCE_LABELS: { reanime: 'RE:Anime' },
    $: selector => elements.get(selector), $$: selector => selector.startsWith('#homeOrder') ? home : library,
    renderCards: (selector, items) => { elements.get(selector).items = items; },
    window: { lilac: { catalogUpdates: (provider, offset) => new Promise((resolve, reject) => requests.push({ provider, offset, resolve, reject })) } },
    localStorage: { setItem() {} }, showHomeList() {}, switchView() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/catalog-updates.js'), 'utf8'), context);
  return { state, elements, requests, home, library };
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
