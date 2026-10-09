const catalogUpdateUI = (() => {
  const supported = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'];
  const cache = new Map(); let homeOrder = 'season', libraryOrder = 'saved', homeRequest = 0, libraryRequest = 0;
  function select(container, value) {
    $$(`${container} button`).forEach(button => { const selected = button.dataset.order === value; button.classList.toggle('selected', selected); button.setAttribute('aria-checked', String(selected)); });
  }
  function note(selector, text) { $(selector).textContent = text; $(selector).classList.toggle('hidden', !text); }
  async function recent(provider, pages = 1) {
    const key = `${provider}:${pages}`, previous = cache.get(key);
    if (previous && Date.now() - previous.time < 5 * 60000) return previous.promise;
    const promise = (async () => {
      const items = new Map(); let offset = 0, message = '';
      for (let page = 0; page < pages; page++) {
        const result = await window.lilac.catalogUpdates(provider, offset); message = result.note || '';
        const before = items.size;
        for (const item of result.data) if (!items.has(String(item.mal_id))) items.set(String(item.mal_id), item);
        if (result.done || result.nextOffset == null || result.nextOffset === offset || items.size === before) break;
        offset = result.nextOffset;
      }
      return { items: [...items.values()], note: message };
    })();
    const entry = { time: Date.now(), promise }; cache.set(key, entry);
    try { return await promise; } catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
  }
  async function renderHome() {
    const request = ++homeRequest;
    select('#homeOrder', homeOrder);
    if (homeOrder === 'season') {
      $('#seasonTitle').textContent = '이번 시즌 신작'; note('#homeOrderNote', '');
      const items = state.current || state.season;
      $('#seasonRail').closest('.content-section').classList.toggle('hidden', !items.length);
      renderCards('#seasonRail', items.slice(0, 30)); return;
    }
    $('#seasonTitle').textContent = '최근 업데이트'; note('#homeOrderNote', '새 회차 목록을 불러오는 중…');
    $('#seasonRail').closest('.content-section').classList.remove('hidden'); $('#seasonRail').replaceChildren();
    try {
      const result = await recent(state.source);
      if (request !== homeRequest || homeOrder !== 'updated') return;
      renderCards('#seasonRail', result.items.slice(0, 30)); note('#homeOrderNote', result.items.length ? result.note : '최근 업데이트된 회차가 없습니다.');
    } catch (error) { if (request === homeRequest) note('#homeOrderNote', `목록을 불러오지 못했습니다: ${error.message}`); }
  }
  let libraryItems = new Map();
  function drawLibrary() {
    const list = state.library.map((saved, index) => {
      const fresh = libraryItems.get(String(saved.mal_id));
      return { item: fresh ? { ...saved, ...fresh.item } : saved, index, fresh };
    });
    if (libraryOrder === 'updated') list.sort((a, b) => {
      if (Boolean(a.fresh) !== Boolean(b.fresh)) return a.fresh ? -1 : 1;
      if (!a.fresh) return a.index - b.index;
      const timeA = Date.parse(a.item.updatedAt), timeB = Date.parse(b.item.updatedAt);
      if (Number.isFinite(timeA) !== Number.isFinite(timeB)) return Number.isFinite(timeA) ? -1 : 1;
      if (Number.isFinite(timeA)) return timeB - timeA || a.index - b.index;
      // Sources without timestamps preserve their own feed order; don't invent cross-source dates.
      if (a.item.provider !== b.item.provider) return a.item.provider.localeCompare(b.item.provider);
      return a.fresh.rank - b.fresh.rank || a.index - b.index;
    });
    renderCards('#libraryGrid', list.map(entry => entry.item));
  }
  async function renderLibrary() {
    const request = ++libraryRequest; select('#libraryOrder', libraryOrder); drawLibrary();
    if (libraryOrder !== 'updated') { note('#libraryOrderNote', ''); return; }
    const providers = [...new Set(state.library.map(item => item.provider))], available = providers.filter(provider => supported.includes(provider));
    if (!state.library.length) { note('#libraryOrderNote', ''); return; }
    note('#libraryOrderNote', '저장한 작품의 최근 회차 목록을 확인하는 중…');
    const results = await Promise.allSettled(available.map(async provider => ({ provider, ...(await recent(provider, 8)) })));
    if (request !== libraryRequest || libraryOrder !== 'updated') return;
    libraryItems = new Map(); const failures = [];
    results.forEach((result, at) => {
      if (result.status === 'rejected') failures.push(SOURCE_LABELS[available[at]] || available[at]);
      else result.value.items.forEach((item, rank) => libraryItems.set(String(item.mal_id), { item, rank }));
    });
    drawLibrary();
    const unsupported = providers.filter(provider => !supported.includes(provider)).map(provider => SOURCE_LABELS[provider] || '기타 소스');
    note('#libraryOrderNote', `소스별 최근 회차 목록에 있는 작품을 먼저 표시합니다. 목록 밖 작품은 저장순을 유지합니다.${unsupported.length ? ` ${unsupported.join('·')}: 업데이트순 미지원.` : ''}${failures.length ? ` ${failures.join('·')}: 목록을 불러오지 못했습니다.` : ''}`);
  }
  $$('#homeOrder button').forEach(button => button.onclick = () => { homeOrder = button.dataset.order; return renderHome(); });
  $$('#libraryOrder button').forEach(button => button.onclick = () => { libraryOrder = button.dataset.order; return renderLibrary(); });
  $('#homeOrder [data-order="updated"]').classList.toggle('hidden', !supported.includes(state.source));
  async function seeAllHome() {
    if (homeOrder === 'season') { showHomeList(state.current || state.season, '이번 시즌 신작'); return; }
    localStorage.setItem(`allSort:${state.source}`, 'updated');
    $('#catalogFilterReset').click(); switchView('all');
  }
  $('#seeAllSeason').onclick = seeAllHome;
  return { renderLibrary, renderHome };
})();
