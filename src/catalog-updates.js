const catalogUpdateUI = (() => {
  const supported = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'];
  // The picked orders are kept across launches; a source without update lists shows 이번 시즌 but keeps the choice.
  const savedOrder = (key, values, fallback) => { try { const value = localStorage.getItem(key); return values.includes(value) ? value : fallback; } catch { return fallback; } };
  const keepOrder = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const cache = new Map(); let homeOrder = savedOrder('homeOrder', ['season', 'updated'], 'season'), libraryOrder = savedOrder('libraryOrder', ['saved', 'updated'], 'saved'), homeRequest = 0, libraryRequest = 0;
  if (!supported.includes(state.source)) homeOrder = 'season';
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
  // --- 내 목록 (GitHub issue #28) ---
  // A saved work is the card of the day it was saved: its episode counts stood still (a show at 7화 still said 3화), and
  // 최근 업데이트순 knew a date only for RE:Anime's and Miruro's works that were in their recent lists, so works of the
  // other sources and older ones followed in an order of their own (11.10, 11.09, 11.08, then 11.09, 11.06, 11.07 …).
  // What each saved work has now is kept apart from the saved card (libraryFacts in localStorage, so the library that is
  // synced between devices is not rewritten): its counts, and updatedAt, the day of its latest episode. They come from
  // the sources' recent lists and, for the works those do not settle, from the work's own page (library:refresh in the
  // main process), asked again every few hours for a show still airing and weekly for a finished one.
  // 링크애니 dates no episode: its works are dated by when a new episode was first seen here (seenAt).
  const FACTS_KEY = 'libraryFacts', HOUR = 60 * 60000, FACT_FIELDS = ['availableEpisodes', 'totalEpisodes', 'episodes', 'subbed', 'dubbed', 'status'];
  const refreshable = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'], dated = ['reanime', 'miruro', 'animenosub', 'ohli24'];
  let facts = (() => { try { const value = JSON.parse(localStorage.getItem(FACTS_KEY)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } })();
  let feedRank = new Map(), refreshRun = null;
  function keepFacts() {
    const saved = new Set(state.library.map(item => String(item.mal_id)));
    for (const id of Object.keys(facts)) if (!saved.has(id)) delete facts[id];
    try { localStorage.setItem(FACTS_KEY, JSON.stringify(facts)); } catch {}
  }
  const timeOf = value => { const time = Date.parse(value || ''); return Number.isFinite(time) ? time : 0; };
  const uploaded = item => Number(item?.availableEpisodes ?? item?.episodes) || 0;
  // What a list or a page says of a saved work now. A value it does not give leaves the known one; the later date stays.
  function learn(saved, values, checked) {
    const id = String(saved.mal_id), before = { ...saved, ...(facts[id] || {}) }, known = facts[id] || (facts[id] = {});
    for (const field of FACT_FIELDS) if (values[field] != null && values[field] !== '') known[field] = values[field];
    if (timeOf(values.updatedAt) > timeOf(known.updatedAt)) known.updatedAt = values.updatedAt;
    // More episodes than the last look: an update seen now (the date of a work whose source gives none).
    if (known.checkedAt && uploaded({ ...saved, ...known }) > uploaded(before)) known.seenAt = Date.now();
    if (checked) known.checkedAt = Date.now();
  }
  const shown = saved => { const known = facts[String(saved.mal_id)]; return known ? { ...saved, ...Object.fromEntries(Object.entries(known).filter(([field, value]) => (FACT_FIELDS.includes(field) || field === 'updatedAt') && value != null && value !== '')) } : saved; };
  const updateTime = (item, known) => timeOf(item.updatedAt) || Number(known?.seenAt) || 0;
  function drawLibrary() {
    const list = state.library.map((saved, index) => {
      const id = String(saved.mal_id), item = shown(saved);
      return { item, index, time: updateTime(item, facts[id]), rank: feedRank.has(id) ? feedRank.get(id) : null };
    });
    // The latest episode's day, newest first, whatever the source. Works without a date follow: those in their source's
    // recent list (in its order), then the rest as saved.
    if (libraryOrder === 'updated') list.sort((a, b) => {
      if (Boolean(a.time) !== Boolean(b.time)) return a.time ? -1 : 1;
      if (a.time) return b.time - a.time || a.index - b.index;
      if ((a.rank != null) !== (b.rank != null)) return a.rank != null ? -1 : 1;
      if (a.rank == null) return a.index - b.index;
      if (a.item.provider !== b.item.provider) return String(a.item.provider).localeCompare(String(b.item.provider));
      return a.rank - b.rank || a.index - b.index;
    });
    renderCards('#libraryGrid', list.map(entry => entry.item));
  }
  const finished = item => (Number(item.totalEpisodes) > 0 && uploaded(item) >= Number(item.totalEpisodes)) || /finished|completed|ended|완결/i.test(String(item.status || ''));
  // The saved works whose own page is due, those never looked at first, 120 a visit (40 a request).
  function dueWorks(now = Date.now()) {
    return state.library.filter(item => refreshable.includes(item.provider)).map(item => ({ item, known: facts[String(item.mal_id)] || {} }))
      .filter(({ item, known }) => now - (known.checkedAt || 0) > (finished({ ...item, ...known }) ? 7 * 24 * HOUR : 3 * HOUR))
      .sort((a, b) => (a.known.checkedAt || 0) - (b.known.checkedAt || 0)).slice(0, 120).map(entry => entry.item);
  }
  function refreshDue() {
    if (refreshRun || typeof window.lilac.libraryRefresh !== 'function') return refreshRun;
    const due = dueWorks(); if (!due.length) return null;
    refreshRun = (async () => {
      for (let at = 0; at < due.length; at += 40) {
        const batch = due.slice(at, at + 40).filter(item => state.library.some(saved => saved.mal_id === item.mal_id));
        const results = await window.lilac.libraryRefresh(batch).catch(() => []), answered = new Map((results || []).map(result => [String(result.mal_id), result]));
        for (const item of batch) {
          const result = answered.get(String(item.mal_id));
          if (result) learn(item, result, true);
          // A page that could not be read is tried again in half an hour.
          else { const known = facts[String(item.mal_id)] || (facts[String(item.mal_id)] = {}); known.checkedAt = Date.now() - 3 * HOUR + 30 * 60000; }
        }
        keepFacts(); drawLibrary();
      }
    })().finally(() => { refreshRun = null; });
    return refreshRun;
  }
  async function renderLibrary() {
    const request = ++libraryRequest; select('#libraryOrder', libraryOrder); drawLibrary();
    if (!state.library.length) { note('#libraryOrderNote', ''); return; }
    if (libraryOrder !== 'updated') { note('#libraryOrderNote', ''); await refreshDue(); return; }
    const providers = [...new Set(state.library.map(item => item.provider))], available = providers.filter(provider => supported.includes(provider));
    note('#libraryOrderNote', '저장한 작품의 최근 회차 목록을 확인하는 중…');
    const results = await Promise.allSettled(available.map(async provider => ({ provider, ...(await recent(provider, 8)) })));
    if (request !== libraryRequest || libraryOrder !== 'updated') return;
    feedRank = new Map(); const failures = [], saved = new Map(state.library.map(item => [String(item.mal_id), item]));
    results.forEach((result, at) => {
      if (result.status === 'rejected') { failures.push(SOURCE_LABELS[available[at]] || available[at]); return; }
      result.value.items.forEach((item, rank) => {
        const id = String(item.mal_id), work = saved.get(id); if (!work) return;
        feedRank.set(id, rank);
        const before = uploaded({ ...work, ...(facts[id] || {}) });
        // A list that dates the work settles it; one that does not (Animenosub, 애니24) leaves its page to be read when
        // the work has no date yet or shows more episodes than before. 링크애니 has no dates anywhere.
        const settled = Boolean(timeOf(item.updatedAt)) || !dated.includes(work.provider);
        learn(work, item, settled);
        if (!settled && (!timeOf(facts[id].updatedAt) || uploaded({ ...work, ...facts[id] }) > before)) facts[id].checkedAt = 0;
      });
    });
    keepFacts(); drawLibrary();
    const unsupported = providers.filter(provider => !supported.includes(provider)).map(provider => SOURCE_LABELS[provider] || '기타 소스');
    const text = () => `최신 회차가 나온 날짜순입니다. 날짜를 알 수 없는 작품은 뒤에 둡니다.${unsupported.length ? ` ${unsupported.join('·')}: 업데이트순 미지원.` : ''}${failures.length ? ` ${failures.join('·')}: 목록을 불러오지 못했습니다.` : ''}`;
    const run = refreshDue();
    if (run) { note('#libraryOrderNote', `${text()} 저장한 작품의 최신 회차를 확인하는 중…`); await run; if (request !== libraryRequest || libraryOrder !== 'updated') return; }
    note('#libraryOrderNote', text());
  }
  $$('#homeOrder button').forEach(button => button.onclick = () => { homeOrder = button.dataset.order; keepOrder('homeOrder', homeOrder); return renderHome(); });
  $$('#libraryOrder button').forEach(button => button.onclick = () => { libraryOrder = button.dataset.order; keepOrder('libraryOrder', libraryOrder); return renderLibrary(); });
  $('#homeOrder [data-order="updated"]').classList.toggle('hidden', !supported.includes(state.source));
  async function seeAllHome() {
    if (homeOrder === 'season') { showHomeList(state.current || state.season, '이번 시즌 신작'); return; }
    localStorage.setItem(`allSort:${state.source}`, 'updated');
    $('#catalogFilterReset').click(); switchView('all');
  }
  $('#seeAllSeason').onclick = seeAllHome;
  return { renderLibrary, renderHome };
})();
