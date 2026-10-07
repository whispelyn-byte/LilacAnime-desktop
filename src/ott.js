// OTT layout helpers: the header turns solid once the page scrolls (it sits clear over the home hero until then),
// and each home row (but the ranked chart) gets previous / next buttons that page it sideways, shown only where there is more to see.
(() => {
  const main = document.querySelector('main');
  const syncHeader = () => {
    document.body.classList.toggle('ott-scrolled', main.scrollTop > 12);
    document.body.classList.toggle('ott-home', document.querySelector('#homeView').classList.contains('active'));
  };
  main.addEventListener('scroll', syncHeader, { passive: true });
  new MutationObserver(syncHeader).observe(document.querySelector('#homeView'), { attributes: true, attributeFilter: ['class'] });
  syncHeader();

  const arrow = (side, label, path) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rail-arrow ${side}`;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
    return button;
  };
  document.querySelectorAll('#homeView :is(.poster-rail, .continue-rail):not(#topRail)').forEach(rail => {
    const wrap = document.createElement('div');
    wrap.className = 'rail-wrap';
    rail.before(wrap);
    const prev = arrow('prev', '이전', 'm15 5-7 7 7 7'), next = arrow('next', '다음', 'm9 5 7 7-7 7');
    wrap.append(prev, rail, next);
    const sync = () => {
      prev.hidden = rail.scrollLeft < 8;
      next.hidden = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 8;
    };
    const page = direction => rail.scrollBy({ left: direction * rail.clientWidth * .82, behavior: 'smooth' });
    prev.onclick = () => page(-1);
    next.onclick = () => page(1);
    rail.addEventListener('scroll', sync, { passive: true });
    new ResizeObserver(sync).observe(rail);
    new MutationObserver(sync).observe(rail, { childList: true });
    sync();
  });

  // Settings: one category at a time, picked from the list on the left; the last one comes back next time.
  const tabs = [...document.querySelectorAll('[data-settings-tab]')], panes = [...document.querySelectorAll('[data-settings-pane]')];
  const showSettingsPane = name => {
    if (!panes.some(pane => pane.dataset.settingsPane === name)) name = 'general';
    tabs.forEach(tab => { const on = tab.dataset.settingsTab === name; tab.classList.toggle('selected', on); tab.setAttribute('aria-selected', String(on)); });
    panes.forEach(pane => { pane.hidden = pane.dataset.settingsPane !== name; });
    try { localStorage.setItem('settingsTab', name); } catch {}
  };
  tabs.forEach(tab => tab.addEventListener('click', () => { showSettingsPane(tab.dataset.settingsTab); main.scrollTo({ top: 0 }); }));
  let savedTab = 'general';
  try { savedTab = localStorage.getItem('settingsTab') || savedTab; } catch {}
  showSettingsPane(savedTab);
  window.showSettingsPane = showSettingsPane;
})();
