(function () {
  const section = document.querySelector('#scheduleSection');
  if (!section) return;
  const tabs = section.querySelector('#scheduleTabs'), rail = section.querySelector('#scheduleRail');
  const status = section.querySelector('#scheduleStatus'), more = section.querySelector('#scheduleMore');
  const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) + 'T12:00:00Z');
  const monday = new Date(today); monday.setUTCDate(today.getUTCDate() - (today.getUTCDay() + 6) % 7);
  const dates = Array.from({ length: 7 }, (_, i) => { const date = new Date(monday); date.setUTCDate(monday.getUTCDate() + i); return date; });
  const label = date => `${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
  const names = ['월', '화', '수', '목', '금', '토', '일'];
  let selected = (today.getUTCDay() + 6) % 7, request = 0, expanded = false, items = [], timed = true;
  section.classList.remove('hidden');
  section.querySelector('#scheduleWeek').textContent = `${label(dates[0])} – ${label(dates[6])}`;
  function match(item) {
    const key = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    const wanted = [item.title, item.originalTitle].map(key).filter(Boolean);
    return [...(state.current || []), ...(state.airing || []), ...state.season, ...state.library].find(anime =>
      anime.provider === state.source && [anime.title, anime.title_japanese, anime.title_english].map(key).some(value => value && wanted.includes(value)));
  }
  function render() {
    rail.replaceChildren(...(expanded ? items : items.slice(0, 6)).map(item => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'schedule-show';
      const cancelled = item.cancelled, date = dates[selected].toISOString().slice(0, 10);
      const badge = cancelled ? '결방' : item.startDate > date ? `${item.startDate.slice(5).replace('-', '.')} 첫 방송` : item.startDate === date ? '첫 방송' : '';
      const meta = [item.episode ? `${item.episode}화` : '', item.track === 'dub' ? '영어 더빙' : '', ...item.genres.slice(0, 2)].filter(Boolean).join(' · ');
      const airingLabel = cancelled ? '결방' : !timed ? '방영 목록' : item.airingStatus === 'aired' ? '방영됨' : item.airingStatus === 'delayed' ? '방영 지연' : '방영 예정';
      button.innerHTML = `<span class="schedule-time${cancelled ? ' cancelled' : ''}">${escapeHtml(item.time || (timed ? '미정' : `${names[selected]}요일`))}<small>${airingLabel}</small></span><span class="schedule-show-copy"><b>${escapeHtml(item.anime ? titleOf(item.anime) : item.title)}</b><small>${escapeHtml(meta || '애니메이션')}${badge ? ` <em>${escapeHtml(badge)}</em>` : ''}</small></span>`;
      button.setAttribute('aria-label', `${item.time || '시간 미정'} ${item.title}${cancelled ? ' 결방' : ''}`);
      const cover = imageOf(item.anime || match(item) || {});
      if (cover) {
        const image = document.createElement('img'); image.className = 'schedule-cover'; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
        image.onerror = () => image.remove();
        button.insertBefore(image, button.querySelector('.schedule-show-copy'));
        setImageSource(image, cover);
      }
      if (item.anime) { titleAnime.set(animeTitleKey(item.anime), item.anime); button.querySelector('b').setAttribute('data-title-for', animeTitleKey(item.anime)); }
      button.onclick = () => { const anime = item.anime?.provider === state.source ? item.anime : match(item); if (anime) { rememberAnime(anime); openDetail(anime.mal_id); } else doSearch(item.title); };
      return button;
    }));
    more.classList.toggle('hidden', items.length <= 6);
    more.textContent = expanded ? '접기' : `${items.length}개 ${timed ? '일정' : '작품'} 모두 보기`;
  }
  async function select(index) {
    selected = index; expanded = false; items = []; const token = ++request;
    [...tabs.children].forEach((button, i) => { button.classList.toggle('selected', i === index); button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1; });
    rail.replaceChildren(); more.classList.add('hidden'); rail.setAttribute('aria-busy', 'true');
    status.textContent = `${names[index]}요일 방영 일정을 불러오는 중…`;
    try {
      const result = await window.lilac.providerSchedule(state.source, dates[index].getUTCDay());
      if (token !== request) return;
      items = result.items; timed = result.timed;
      section.querySelector('h2').textContent = result.native && !timed ? (result.provider === 'linkani' ? '요일별 애니 목록' : '요일별 방영표') : '이번 주 방영표';
      section.querySelector('#scheduleWeek').classList.toggle('hidden', result.native && result.provider === 'linkani');
      section.querySelector('.schedule-credit').textContent = result.note;
      status.textContent = items.length ? `${names[index]}요일 · ${items.length}개 일정 · ${timed ? '방영 시간순' : '작품명순'}` : '이 요일에 등록된 방영 일정이 없습니다.';
      render();
    } catch {
      if (token !== request) return;
      status.textContent = '방영 일정을 불러오지 못했어요. 다시 시도해 주세요.';
    } finally { if (token === request) rail.setAttribute('aria-busy', 'false'); }
  }
  tabs.replaceChildren(...dates.map((date, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab');
    const isToday = date.getTime() === today.getTime(); button.className = isToday ? 'schedule-day today' : 'schedule-day';
    button.innerHTML = `<span>${names[index]}${isToday ? '<i>오늘</i>' : ''}</span><b>${label(date)}</b>`;
    button.onclick = () => select(index);
    button.onkeydown = event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 6 : (selected + (event.key === 'ArrowRight' ? 1 : 6)) % 7; tabs.children[next].focus(); select(next); };
    return button;
  }));
  section.querySelector('#scheduleToday').onclick = () => select((today.getUTCDay() + 6) % 7);
  section.querySelector('#scheduleRetry').onclick = () => select(selected);
  more.onclick = () => { expanded = !expanded; render(); };
  select(selected);
})();

