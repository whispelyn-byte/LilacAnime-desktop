// The whole source's filtered catalog, independent from the home rails and their pagination.
const catalogBrowser = (() => {
  let taxonomy = null, initializing = null, failed = false, filters = {}, page = null;
  const active = () => Object.values(filters).some(Boolean);
  const key = () => JSON.stringify([state.source, allSort(), filters]);
  const currentPage = () => { if (!page || page.key !== key()) page = { key: key(), items: [], offset: 0, done: false, loading: false, total: null }; return page; };
  const setOptions = (select, options, label) => { select.replaceChildren(new Option(label, ''), ...options.map(item => new Option(item.name, item.value))); };
  async function initialize(retry = false) {
    if (taxonomy || (failed && !retry)) return;
    if (initializing) return initializing;
    initializing = (async () => {
      $('#catalogFilterNote').textContent = '분류를 불러오는 중…';
      $$('#catalogFilters input, #catalogFilters select, #catalogFilters button').forEach(el => { el.disabled = true; });
      try {
        taxonomy = await window.lilac.catalogFacets(state.source); failed = false;
        setOptions($('#catalogGenre'), taxonomy.genres, '전체 장르'); setOptions($('#catalogFormat'), taxonomy.formats, '전체 형태');
        if (taxonomy.yearOptions.length) {
          const select = document.createElement('select'); select.id = 'catalogYear'; select.setAttribute('aria-label', '방영 연도');
          setOptions(select, taxonomy.yearOptions, '전체 연도'); $('#catalogYear').replaceWith(select);
        }
        for (const [name, supported] of [['Genre', taxonomy.genres.length], ['Format', taxonomy.formats.length], ['Year', taxonomy.year], ['Season', taxonomy.season]]) $(`#catalog${name}Field`).classList.toggle('hidden', !supported);
        $('#catalogFilterNote').textContent = taxonomy.note || '장르·형태·연도·분기를 함께 선택할 수 있습니다.';
      } catch (error) { failed = true; $('#catalogFilterNote').textContent = `분류를 불러오지 못했습니다. 필터 적용 버튼으로 다시 시도하세요. (${error.message})`; }
      finally { $$('#catalogFilters input, #catalogFilters select, #catalogFilters button').forEach(el => { el.disabled = false; }); }
    })();
    try { await initializing; } finally { initializing = null; }
  }
  function render() {
    const current = currentPage(), grid = $('#allGrid'), shown = [...grid.children].map(el => el.dataset.id);
    if (shown.length && shown.length <= current.items.length && shown.every((id, index) => id === String(current.items[index].mal_id))) grid.append(...current.items.slice(shown.length).map(card));
    else renderCards('#allGrid', current.items);
    $('#catalogEmpty').classList.toggle('hidden', current.loading || !current.done || Boolean(current.items.length));
    $('#catalogMore').classList.toggle('hidden', current.done); $('#catalogMore').disabled = current.loading;
  }
  async function load() {
    const current = currentPage(); if (current.loading || current.done) return;
    current.loading = true; render(); $('#allStatus').textContent = '선택한 조건의 작품을 불러오는 중…';
    try {
      const result = await window.lilac.catalogBrowse(state.source, { ...filters, offset: current.offset, sort: allSort() });
      if (current !== currentPage() || !active()) return;
      const before = current.items.length;
      current.items = [...new Map([...current.items, ...result.data].map(item => [String(item.mal_id), item])).values()];
      current.total = result.total ?? null;
      // A page can contain no matches when its source has no server-side format filter; keep its next page.
      current.done = Boolean(result.done) || result.nextOffset === current.offset || result.nextOffset == null || (result.data.length > 0 && current.items.length === before);
      current.offset = result.nextOffset;
      const genre = taxonomy.genres.find(item => item.value === filters.genre)?.name, format = taxonomy.formats.find(item => item.value === filters.format)?.name;
      const year = taxonomy.yearOptions.find(item => item.value === filters.year)?.name || (filters.year ? `${filters.year}년` : '');
      const season = filters.season ? `${['WINTER', 'SPRING', 'SUMMER', 'FALL'].indexOf(filters.season) + 1}분기` : '';
      $('#allStatus').textContent = `${[genre, format, year, season].filter(Boolean).join(' · ')} · ${current.items.length}${current.total != null ? ` / ${current.total}` : ''}개 작품`;
    } catch (error) { if (current === currentPage() && active()) $('#allStatus').textContent = `작품을 불러오지 못했습니다: ${error.message}`; }
    finally { current.loading = false; if (current === currentPage() && active()) render(); }
  }
  async function apply() {
    await initialize(true); if (!taxonomy) return;
    const next = { genre: $('#catalogGenre').value, format: $('#catalogFormat').value, year: taxonomy.year ? $('#catalogYear').value.trim() : '', season: taxonomy.season ? $('#catalogSeason').value : '' };
    if (next.season && !next.year) { next.year = String(new Date().getFullYear()); $('#catalogYear').value = next.year; }
    if (next.year && !/^\d+$/.test(next.year)) { $('#catalogYear').reportValidity(); return; }
    filters = next; page = null; $('#allGrid').replaceChildren(); $('#catalogEmpty').classList.add('hidden'); $('#catalogMore').classList.add('hidden');
    document.querySelector('main').scrollTo({ top: 0 }); await loadFullCatalog();
  }
  $('#catalogFilters').onsubmit = event => { event.preventDefault(); apply(); };
  $('#catalogFilterReset').onclick = () => { filters = {}; page = null; $('#catalogFilters').reset(); $('#catalogEmpty').classList.add('hidden'); $('#catalogMore').classList.add('hidden'); $('#allGrid').replaceChildren(); loadFullCatalog(); };
  $('#catalogMore').onclick = load;
  $('#catalogFilters').addEventListener('keydown', event => { if (event.target.matches('input, select') && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.stopPropagation(); });
  return { initialize, active, render, load, sortOptions: () => taxonomy?.sorts };
})();
