const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const elements = new Map(), requests = [];
  function element(id) {
    const classes = new Set();
    return { id, value: '', children: [], disabled: false, textContent: '', dataset: {}, events: {},
      classList: { contains: name => classes.has(name), add: name => classes.add(name), toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
      replaceChildren(...children) { this.children = children; if (this.id !== 'allGrid') this.value = children[0]?.value || ''; },
      append(...children) { this.children.push(...children); }, addEventListener(name, fn) { this.events[name] = fn; },
      scrollTo() {}, reportValidity() {}, reset() { for (const name of ['catalogGenre', 'catalogFormat', 'catalogYear', 'catalogSeason']) elements.get(name).value = ''; }
    };
  }
  for (const id of ['catalogFilters', 'catalogFilterNote', 'catalogGenre', 'catalogFormat', 'catalogYear', 'catalogSeason', 'catalogGenreField', 'catalogFormatField', 'catalogYearField', 'catalogSeasonField', 'catalogEmpty', 'catalogMore', 'catalogFilterReset', 'allGrid', 'allStatus', 'main']) elements.set(id, element(id));
  const card = item => ({ dataset: { id: String(item.mal_id) }, title: item.title });
  const context = vm.createContext({ state: { source: 'reanime' }, allSort: () => 'popular', card,
    $: selector => elements.get(selector.slice(1)), $$: () => [...elements.values()],
    Option: function (name, value) { this.name = name; this.value = value; },
    document: { querySelector: () => elements.get('main') },
    renderCards: (selector, items) => elements.get(selector.slice(1)).replaceChildren(...items.map(card)),
    window: { lilac: {
      catalogFacets: async () => ({ genres: [{ value: 'Action', name: '액션' }, { value: 'Comedy', name: '코미디' }], formats: [{ value: 'TV', name: 'TV 애니' }], year: true, season: true, yearOptions: [], sorts: ['popular'], note: '' }),
      catalogBrowse: (_, filters) => new Promise(resolve => requests.push({ filters, resolve }))
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/catalog-browser.js'), 'utf8'), context);
  const browser = vm.runInContext('catalogBrowser', context);
  context.loadFullCatalog = async () => { if (browser.active()) await browser.load(); else elements.get('allGrid').replaceChildren(); };
  const submit = (genre, year = '2025', season = 'WINTER') => { elements.get('catalogGenre').value = genre; elements.get('catalogYear').value = year; elements.get('catalogSeason').value = season; elements.get('catalogFilters').onsubmit({ preventDefault() {} }); };
  return { elements, requests, browser, submit };
}

test('an older filter response cannot overwrite the newly selected category', async () => {
  const h = setup(); await h.browser.initialize(); h.submit('Action'); await tick();
  h.submit('Comedy', '2026', 'SPRING'); await tick(); assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ data: [{ mal_id: 'new', title: '새 분류' }], total: 1, nextOffset: 1, done: true }); await tick();
  h.requests[0].resolve({ data: [{ mal_id: 'old', title: '이전 분류' }], total: 1, nextOffset: 1, done: true }); await tick();
  assert.equal(h.elements.get('allGrid').children[0].dataset.id, 'new');
  assert.match(h.elements.get('allStatus').textContent, /코미디.*2026년.*2분기/);
});

test('empty filtered pages can advance, matching pages append, and duplicate pages finish', async () => {
  const h = setup(); await h.browser.initialize(); h.submit('Action'); await tick();
  h.requests[0].resolve({ data: [], nextOffset: 2, done: false }); await tick();
  assert.equal(h.elements.get('catalogMore').classList.contains('hidden'), false);
  const second = h.browser.load(); assert.equal(h.requests[1].filters.offset, 2);
  h.requests[1].resolve({ data: [{ mal_id: 'a', title: '액션' }], nextOffset: 3, done: false }); await second;
  const existingCard = h.elements.get('allGrid').children[0], third = h.browser.load();
  h.requests[2].resolve({ data: [{ mal_id: 'b', title: '다음 작품' }], nextOffset: 4, done: false }); await third;
  assert.equal(h.elements.get('allGrid').children[0], existingCard); assert.equal(h.elements.get('allGrid').children.length, 2);
  const fourth = h.browser.load(); h.requests[3].resolve({ data: [{ mal_id: 'b' }], nextOffset: 5, done: false }); await fourth;
  assert.equal(h.elements.get('catalogMore').classList.contains('hidden'), true);
});

test('resetting while a request is pending restores the unfiltered list', async () => {
  const h = setup(); await h.browser.initialize(); h.submit('Action'); await tick();
  h.elements.get('catalogFilterReset').onclick(); await tick();
  h.requests[0].resolve({ data: [{ mal_id: 'late' }], nextOffset: 1, done: true }); await tick();
  assert.equal(h.browser.active(), false); assert.equal(h.elements.get('allGrid').children.length, 0);
  assert.equal(h.elements.get('catalogGenre').value, ''); assert.equal(h.elements.get('catalogMore').classList.contains('hidden'), true);
});
