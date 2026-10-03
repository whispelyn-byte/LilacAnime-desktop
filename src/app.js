// The video and its subtitle layer move into the mini player window (another document) and back, so they are
// looked up once and kept.
const pinnedElements=new Map();
const $ = s => { if(s==='#video'||s==='#videoStage'){if(!pinnedElements.has(s))pinnedElements.set(s,document.querySelector(s));return pinnedElements.get(s)} return document.querySelector(s); };
const $$ = s => [...document.querySelectorAll(s)];
const SPEED_OPTIONS=[.1,.25,.5,.75,1,1.25,1.5,1.75,2];
const store = {
  get(key, fallback = []) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
};
const state = { season: [], top: [], library: store.get('library'), history: store.get('history'), downloads:[], source: localStorage.getItem('contentSource') || 'reanime', catalogOffset:36, catalogTotal:null, catalogLoading:false, catalogDone:false };
let hlsPlayer = null;
let skipSegments = [];
let activeSkip = null;
let activeSkipKey = null;
let opEdAnalysisKey = null;
let currentSubtitlePath = null;
let viewBeforePlayer = 'home';
let controlsTimer = null;
let playerWindowFullscreen = false;
let currentHistoryKey = null;
let currentPlaybackContext = {};
let playbackRequestId = 0;
let pendingResumeProgress = 0;

// 설정 > 작품 제목 표시 (한국어 / 영어). Missing names are looked up in the background (main process: TMDB →
// AniList → Wikidata for Korean) and the titles on screen are updated in place when they arrive.
const displayTitles=new Map(),titleAnime=new Map(),pendingTitles=new Map();let titleTimer=null;
function titleLanguage(){return localStorage.getItem('titleLanguage')==='en'?'en':'ko'}
function animeTitleKey(a){return `${a?.provider||'jikan'}:${a?.id??a?.mal_id}`}
function titleOf(a) {
  if(!a)return '제목 없음';
  const key=animeTitleKey(a),hangul=value=>/[가-힣]/.test(value||''),known=displayTitles.get(key)||{};
  const ko=[a.title,known.ko].find(hangul)||'',en=[a.title_english,a.title,known.en].find(value=>value&&!hangul(value))||'';
  const wanted=titleLanguage()==='en'?en:ko;
  if(!wanted&&!displayTitles.has(key)&&(a.title||a.title_english)){titleAnime.set(key,a);pendingTitles.set(key,{provider:a.provider,id:a.id,mal_id:a.mal_id,title:a.title||a.title_english,title_english:a.title_english||'',title_japanese:a.title_japanese||'',anilistId:a.anilistId||null,malId:a.malId||null});clearTimeout(titleTimer);titleTimer=setTimeout(resolvePendingTitles,200)}
  return (titleLanguage()==='en'?(en||ko):(ko||en))||a.title||a.title_japanese||'제목 없음';
}
// Sent in small batches side by side so titles appear as each batch finishes.
async function resolvePendingTitles(){
  const batch=[...pendingTitles.values()];pendingTitles.clear();if(!batch.length)return;
  // Marked first so a miss is not requested again this session.
  batch.forEach(item=>displayTitles.set(animeTitleKey(item),displayTitles.get(animeTitleKey(item))||{}));
  const chunks=[];for(let i=0;i<batch.length;i+=6)chunks.push(batch.slice(i,i+6));
  await Promise.all(chunks.map(async chunk=>{
    const results=await window.lilac.resolveTitles(chunk).catch(()=>[]);
    for(const result of results)displayTitles.set(result.key,{ko:result.ko||'',en:result.en||''});
    refreshTitleElements(results.map(result=>result.key));
  }));
}
function refreshTitleElements(keys=null){
  $$('[data-title-for]').forEach(el=>{const key=el.dataset.titleFor;if(keys&&!keys.includes(key))return;const a=titleAnime.get(key);if(a)el.textContent=titleOf(a)});
  if(!keys||(currentPlaybackContext?.anime&&keys.includes(animeTitleKey(currentPlaybackContext.anime))))updatePlayerTitle();
}
// A saved item's title in the current language; items without anime info keep the name they were saved with.
function storedTitle(item){return item?.anime&&(item.anime.title||item.anime.title_english)?titleOf(item.anime):(item?.subtitleTitle||item?.title||String(item?.name||'').split(' · ')[0]||'제목 없음')}
// The player heading ("제목 · N화") follows the setting while an anime is playing.
function updatePlayerTitle(){const context=currentPlaybackContext||{},episode=context.episode;if(!context.anime||!episode||!$('#playerTitle'))return;$('#playerTitle').textContent=`${titleOf(context.anime)} · ${episode.name||episode.number||1}화`}
function titleAttr(a){const key=animeTitleKey(a);titleAnime.set(key,a);return `data-title-for="${escapeHtml(key)}"`}
function nearbyEpisodes(episodes,current){
  const others=(episodes||[]).filter(ep=>episodeRef(ep)!==episodeRef(current));
  const training=[1,2,3,4,5].map(number=>others.find(ep=>episodeNumberOf(ep)===number)).filter(Boolean);
  const fallback=others.slice().sort((a,b)=>Math.abs((episodeNumberOf(a)||0)-(episodeNumberOf(current)||0))-Math.abs((episodeNumberOf(b)||0)-(episodeNumberOf(current)||0)));
  return [...new Map([...training,...fallback].map(ep=>[episodeRef(ep),ep])).values()].slice(0,5);
}
function imageOf(a) { return a.images?.webp?.large_image_url || a.images?.jpg?.large_image_url || ''; }
async function displayImage(url){if(!url)return '';try{return await window.lilac.coverData(url)}catch{return url}}
async function setBackgroundImage(element,url){if(!element||!url)return;const resolved=await displayImage(url);if(element.isConnected)element.style.backgroundImage=`url(${JSON.stringify(resolved)})`}
async function setImageSource(element,url){if(!element||!url)return;const resolved=await displayImage(url);if(element.isConnected)element.src=resolved}
function normalize(a) { return { provider:a.provider,id:a.id,mal_id:a.mal_id,title:a.title,title_english:a.title_english,title_japanese:a.title_japanese,images:a.images,score:a.score,year:a.year,type:a.type,episodes:a.episodes,status:a.status,synopsis:a.synopsis,genres:a.genres,studios:a.studios,trailer:a.trailer,url:a.url,canWatch:a.canWatch,subbed:a.subbed,dubbed:a.dubbed,anilistId:a.anilistId||null,malId:a.malId||null,seriesTagIds:a.seriesTagIds||[] }; }
function saved(id) { return state.library.some(x => x.mal_id === id); }
function heartIcon(){return '<svg class="library-heart-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 9c0 5-8.5 10-8.5 10S3.5 14 3.5 9A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8.5 2Z"/></svg>'}
function downloadIcon(type='download'){const paths={download:'<path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14"/>',offline:'<path d="M12 4v9m0 0 3.5-3.5M12 13 8.5 9.5M6.5 19h11a3.5 3.5 0 0 0 .4-7A6 6 0 0 0 6.4 10.5 4.25 4.25 0 0 0 6.5 19Z"/>',close:'<path d="m7 7 10 10M17 7 7 17"/>',delete:'<path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/>',play:'<path d="m8 5 11 7-11 7Z"/>',retry:'<path d="M5 8V4m0 4h4M6 7a7 7 0 1 1-1 8"/>'};return `<svg class="download-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[type]||paths.download}</svg>`}
function updateLibraryButton(button,isSaved,withLabel=true){if(!button)return;button.classList.toggle('saved',isSaved);button.innerHTML=`${heartIcon()}${withLabel?'<span>내 목록</span>':''}`;button.setAttribute('aria-label',isSaved?'내 목록에서 삭제':'내 목록에 추가')}
// Cards shown outside the home lists (related works, schedule, filters) must still open.
const knownAnime=new Map();
function rememberAnime(a){if(a?.mal_id!=null&&!knownAnime.has(String(a.mal_id)))knownAnime.set(String(a.mal_id),a);return a}
function animeById(id) { return [...(state.current||[]),...(state.airing||[]),...state.season,...state.top,...state.library].find(x=>String(x.mal_id)===String(id))||knownAnime.get(String(id)); }
function toast(message) { const el=$('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),2200); }

// 설정 > 재생 시작 화면 (GitHub issue #1): full screen, or the app window as it is. Going on to another episode inside
// the player keeps the size it has now.
function enterPlayer(){const already=$('.view.active')?.id==='playerView';switchView('player');if(!already)playerWindowFullscreen=(localStorage.getItem('playerStart')||'fullscreen')!=='window';setPlayerWindowed();window.lilac.setPlayerFullscreen(playerWindowFullscreen)}
function switchView(name) {
  const current=$('.view.active')?.id?.replace(/View$/,'');
  if(name==='player'&&current&&current!=='player')viewBeforePlayer=current;
  document.body.classList.toggle('player-mode',name==='player');
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `${name}View`));
  $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  if (name === 'library') renderLibrary();
  if (name === 'all') loadFullCatalog();
  if (name === 'history') renderHistory();
  // Where the local model last ran changes with each translation.
  if (name === 'settings') {window.lilac.geminiSettings().then(value=>{translationSettings=value||translationSettings;renderLocalAi(value)}).catch(()=>{});renderSubtitleCache()}
  if(name!=='player')document.querySelector('main').scrollTo({top:0,behavior:'smooth'});
}

function card(a) {
  rememberAnime(a);const el=document.createElement('article'); el.className='anime-card'; el.dataset.id=a.mal_id;
  el.innerHTML=`<div class="poster"><button class="heart ${saved(a.mal_id)?'saved':''}" title="내 목록">${heartIcon()}</button>${a.score?`<span class="score">★ ${a.score}</span>`:''}</div><h3 ${titleAttr(a)}>${escapeHtml(titleOf(a))}</h3><p>${[a.year,a.type,a.episodes?`${a.episodes}화`:null].filter(Boolean).join(' · ')}</p>`;
  setBackgroundImage(el.querySelector('.poster'),imageOf(a));
  el.querySelector('.poster').addEventListener('click', e => { if(!e.target.closest('.heart')) openDetail(a.mal_id); });
  el.querySelector('.heart').addEventListener('click', e => { e.stopPropagation(); toggleLibrary(a, e.currentTarget); });
  return el;
}

function renderCards(target, items) { const el=$(target); el.classList.remove('loading-cards'); el.replaceChildren(...items.map(card)); }
function toggleLibrary(a, button) {
  if(saved(a.mal_id)){state.library=state.library.filter(x=>x.mal_id!==a.mal_id);updateLibraryButton(button,false,!button?.classList.contains('heart'));toast('내 목록에서 삭제했어요.');}
  else{state.library.unshift(normalize(a));updateLibraryButton(button,true,!button?.classList.contains('heart'));toast('내 목록에 추가했어요.');}
  store.set('library',state.library); renderLibrary();
}
function downloadStatusText(job){return job.status==='completed'?job.stage==='subtitle'?'다운로드 완료 · 자막 찾는 중':job.stage==='translate'?`다운로드 완료 · 자막 트랙 번역 중 (${job.translateProgress||''})`:job.subtitlePath?'다운로드 완료 · 자막 포함':'다운로드 완료':job.status==='downloading'?`${job.progress||0}% 다운로드 중`:job.status==='resolving'?'영상 주소 확인 중':job.status==='queued'?'대기 중':job.status==='paused'?'일시 중지':job.status==='failed'?`실패 · ${job.error||'다시 시도해 주세요'}`:job.status}
// Titles saved with a download fill in for lookups that are unavailable offline.
function seedDownloadTitles(){for(const job of state.downloads){const titles=job.displayTitles;if(!job.anime||!titles||!(titles.ko||titles.en))continue;const key=animeTitleKey(job.anime),known=displayTitles.get(key);if(!known?.ko&&!known?.en)displayTitles.set(key,{ko:titles.ko||'',en:titles.en||''})}}
function renderDownloads(){seedDownloadTitles();const list=$('#downloadList'),completed=state.downloads.filter(x=>x.status==='completed').length;$('#downloadCount').textContent=String(completed);list.replaceChildren(...state.downloads.map(job=>{const el=document.createElement('article');el.className='download-card';const cover=job.posterUrl||job.image;el.innerHTML=`<div class="download-cover"${cover?` style="background-image:url('${cover}')"`:''}></div><div class="download-copy"><b ${job.anime?titleAttr(job.anime):''}>${escapeHtml(storedTitle(job))}</b><span>${escapeHtml(String(job.episodeNumber))}화 · ${escapeHtml(downloadStatusText(job))}</span><div class="download-progress"><i style="width:${job.status==='completed'?100:job.progress||0}%"></i></div></div><div class="download-actions">${job.status==='completed'?`<button data-action="play">${downloadIcon('play')}<span>재생</span></button>`:job.status==='paused'||job.status==='failed'?`<button data-action="resume">${downloadIcon('retry')}<span>다시 시작</span></button>`:`<button data-action="cancel">${downloadIcon('close')}<span>중지</span></button>`}<button class="danger" data-action="remove">${downloadIcon('delete')}<span>삭제</span></button></div>`;el.querySelector('[data-action="play"]')?.addEventListener('click',async()=>{try{const local=await window.lilac.playDownload(job.id),seriesEpisodes=downloadedSeries(job);play(local.url,`${job.title} · ${job.episodeNumber}화`,{episode:job.episode,subtitleTitle:job.title,image:job.posterUrl||job.image,offline:true,anime:job.anime,resolveKind:job.resolveKind,seriesEpisodes});if(local.subtitleUrl)attachSubtitle(local.subtitleUrl,local.subtitleLabel||'다운로드 자막',{assUrl:local.subtitleAss?.url||null,assPath:local.subtitleAss?.path||null,fonts:local.subtitleAss?.fonts||[]})}catch(e){toast(e.message)}});el.querySelector('[data-action="cancel"]')?.addEventListener('click',()=>window.lilac.cancelDownload(job.id));el.querySelector('[data-action="resume"]')?.addEventListener('click',()=>window.lilac.resumeDownload(job.id));el.querySelector('[data-action="remove"]')?.addEventListener('click',()=>window.lilac.removeDownload(job.id));return el;}));$('#emptyDownloads').classList.toggle('hidden',state.downloads.length>0);refreshEpisodeDownloadButtons()}
function renderLibrary(){renderCards('#libraryGrid',state.library);$('#emptyLibrary').classList.toggle('hidden',state.library.length>0);renderDownloads();}
function episodeDownloadJob(anime,episode){return state.downloads.find(job=>job.key===`${anime.mal_id||anime.id}:${episode.provider||'provider'}:${episode.url||episode.token||episode.id||episode.number}`)}
function episodeRef(episode){return encodeURIComponent(String(episode.url||episode.token||episode.id||episode.number||''))}
// Linkkf episodes saved before they carried a number (history, downloads) only have their name ("12", "12화").
function episodeNumberOf(episode){return Number(episode?.number)||Number(String(episode?.name??'').match(/\d+/)?.[0])||null}
function jobByRef(ref){return state.downloads.find(job=>episodeRef(job.episode||{})===ref)}
function downloadedSeries(reference){const identity=reference?.anime?.mal_id||reference?.anime?.id||reference?.title;return state.downloads.filter(job=>job.status==='completed'&&(job.anime?.mal_id||job.anime?.id||job.title)===identity).sort((a,b)=>a.episodeNumber-b.episodeNumber).map(job=>job.episode)}
function episodeDownloadMarkup(job){if(job?.status==='completed')return downloadIcon('delete');if(job&&['downloading','resolving','queued'].includes(job.status))return `<span class="download-ring" style="--progress:${job.progress||0}">${downloadIcon('close')}</span>`;if(job&&['paused','failed'].includes(job.status))return downloadIcon('retry');return downloadIcon('download')}
function refreshEpisodeDownloadButtons(){$$('.episode-download').forEach(button=>{const job=jobByRef(button.dataset.downloadRef);button.classList.toggle('active',Boolean(job));button.classList.toggle('completed',job?.status==='completed');button.classList.toggle('downloading',Boolean(job&&['downloading','resolving','queued'].includes(job.status)));button.innerHTML=episodeDownloadMarkup(job);button.title=job?.status==='completed'?'다운로드 삭제':job&&['downloading','resolving','queued'].includes(job.status)?'다운로드 취소':job&&['paused','failed'].includes(job.status)?'다운로드 다시 시작':'다운로드'})}
async function handleEpisodeDownload(anime,episode,resolveKind='provider'){const job=jobByRef(episodeRef(episode));if(job?.status==='completed'){await window.lilac.removeDownload(job.id);toast(`${job.episodeNumber}화 다운로드를 삭제했습니다.`);return}if(job&&['downloading','resolving','queued'].includes(job.status)){await window.lilac.cancelDownload(job.id);toast(`${job.episodeNumber}화 다운로드를 중지했습니다.`);return}if(job&&['paused','failed'].includes(job.status)){await window.lilac.resumeDownload(job.id);toast(`${job.episodeNumber}화 다운로드를 다시 시작합니다.`);return}await queueEpisodeDownload(anime,episode,resolveKind)}
async function queueEpisodeDownload(anime,episode,resolveKind='provider'){const number=Number(episode.number||String(episode.name).match(/\d+/)?.[0]||1);const job=await window.lilac.addDownload({anime:normalize(anime),title:titleOf(anime),image:imageOf(anime),episode,episodeNumber:number,resolveKind,subtitleSource:localStorage.getItem('subtitleSource')||'reanime',opedAnalysis:localStorage.getItem('opedAudioAnalysis')!=='false'});toast(job.status==='completed'?`${number}화는 이미 저장되어 있습니다.`:`${number}화를 다운로드 대기열에 추가했습니다.`)}
// Loading more only appends cards, so cards already on screen do not replay their entrance animation.
// Sources whose list, detail and episodes come from the site's own pages or API (not Linkkf's).
const PROVIDER_SOURCES=['reanime','animenosub','miruro'],SOURCE_LABELS={linkkf:'Linkkf',animenosub:'Animenosub',reanime:'RE:Anime',miruro:'Miruro'};
function renderAll(){const items=[...new Map([...state.season,...state.top].map(a=>[a.mal_id,a])).values()],grid=$('#allGrid'),shown=[...grid.children].map(el=>el.dataset.id);if(shown.length&&!grid.classList.contains('loading-cards')&&shown.length<=items.length&&shown.every((id,i)=>id===String(items[i].mal_id))){if(items.length>shown.length)grid.append(...items.slice(shown.length).map(card))}else renderCards('#allGrid',items);$('#allStatus').textContent=`${items.length}개 작품 · ${SOURCE_LABELS[state.source]||'작품 정보'}`;}
async function loadFullCatalog(){renderAll();if(state.source==='linkkf'){loadLinkkfCatalogPage();return}if(!PROVIDER_SOURCES.includes(state.source)||state.catalogLoading||state.catalogDone||(state.catalogTotal!==null&&state.catalogOffset>=state.catalogTotal))return;state.catalogLoading=true;const label=SOURCE_LABELS[state.source];$('#allStatus').textContent=`${label} 목록을 더 불러오는 중... (${state.season.length}${state.catalogTotal?` / ${state.catalogTotal}`:''})`;try{const result=await window.lilac.providerCatalog(state.source,'',state.catalogOffset);const before=state.season.length,merged=new Map([...state.season,...result.data].map(a=>[a.mal_id,a]));state.season=[...merged.values()];state.catalogOffset=state.source==='reanime'?state.catalogOffset+result.data.length:result.nextOffset;state.catalogTotal=result.total||null;state.catalogDone=Boolean(result.done)||result.data.length===0||state.season.length===before;renderAll();$('#allStatus').textContent=state.catalogTotal?`${state.season.length} / ${state.catalogTotal}개 작품 · 아래로 스크롤하면 더 불러옵니다.`:`${state.season.length}개 작품${state.catalogDone?'':' · 아래로 스크롤하면 더 불러옵니다.'}`}catch(e){$('#allStatus').textContent=`목록을 더 불러오지 못했습니다: ${e.message}`}finally{state.catalogLoading=false}}
async function loadLinkkfCatalogPage(){if(state.catalogLoading||state.catalogDone)return;state.catalogLoading=true;$('#allStatus').textContent=`Linkkf 목록을 더 불러오는 중... (${state.season.length})`;try{const page=state.catalogPage||2,result=await window.lilac.linkkfHome(page,20),before=state.season.length;state.season=[...new Map([...state.season,...result.data].map(a=>[a.mal_id,a])).values()];state.catalogPage=page+1;state.catalogDone=result.data.length===0||state.season.length===before;renderAll();$('#allStatus').textContent=`${state.season.length}개 작품${state.catalogDone?'':' · 아래로 스크롤하면 더 불러옵니다.'}`}catch(e){$('#allStatus').textContent=`목록을 더 불러오지 못했습니다: ${e.message}`}finally{state.catalogLoading=false}}
function historyImage(h){if(h.image)return h.image;if(h.anime){const direct=imageOf(h.anime);if(direct)return direct}const title=h.subtitleTitle||h.name.split(' · ')[0];return imageOf([...state.season,...state.top,...state.library].find(a=>[titleOf(a),a.title,a.title_english].includes(title))||{})}
function renderHistory(){const list=$('#historyList');list.replaceChildren(...state.history.map(h=>{const row=document.createElement('article');row.className='history-card';row.tabIndex=0;row.setAttribute('role','button');const image=historyImage(h),episode=h.episode?.number||h.name.match(/(?:·|EP\.?)[^\d]*(\d+)/i)?.[1]||1;row.innerHTML=`<div class="history-thumb"${image?` style="background-image:url('${image}')"`:''}><span class="history-card-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6Z"/></svg></span><div class="history-progress"><i style="width:${Math.max(0,Math.min(100,h.progress||0))}%"></i></div></div><b ${h.anime?titleAttr(h.anime):''}>${escapeHtml(storedTitle(h))}</b><span>EP.${escapeHtml(String(episode))}</span>`;const key=historyKeyOf(h),activate=()=>{if(!historySelection.active){playHistoryItem(h);return}historySelection.keys.has(key)?historySelection.keys.delete(key):historySelection.keys.add(key);row.classList.toggle('selected',historySelection.keys.has(key));row.setAttribute('aria-pressed',String(historySelection.keys.has(key)));updateHistorySelectionBar()};row.classList.toggle('selecting',historySelection.active);if(historySelection.active){row.classList.toggle('selected',historySelection.keys.has(key));row.setAttribute('aria-pressed',String(historySelection.keys.has(key)));row.querySelector('.history-thumb').insertAdjacentHTML('beforeend','<span class="history-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 12 4 4 8-8"/></svg></span>')}row.onclick=activate;row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate()}};return row;}));updateHistorySelectionBar();$('#historyCount').textContent=`${state.history.length}개`;$('#emptyHistory').classList.toggle('hidden',state.history.length>0);list.classList.toggle('hidden',!state.history.length);}
async function playHistoryItem(item){let anime=item.anime||[...state.season,...state.top,...state.library].find(a=>[titleOf(a),a.title,a.title_english,displayTitles.get(animeTitleKey(a))?.ko,displayTitles.get(animeTitleKey(a))?.en].includes(item.subtitleTitle||item.name.split(' · ')[0])),episodes=[],localJob=item.episode?jobByRef(episodeRef(item.episode)):null;if(localJob?.status==='completed'){anime=localJob.anime||anime;episodes=downloadedSeries(localJob)}else try{if(anime?.provider==='linkkf'){const servers=await window.lilac.linkkfEpisodes(anime.id);episodes=servers.find(server=>server.episodes.some(ep=>ep.token===item.episode?.token))?.episodes||servers[0]?.episodes||[]}else if(anime&&PROVIDER_SOURCES.includes(anime.provider)){const detail=await window.lilac.providerDetail(anime);anime=detail.data;episodes=detail.episodes||[]}}catch{}if(!episodes.length&&item.episode?.provider==='reanime'&&URL.canParse?.(item.episode.url)){const current=Number(item.episode.number)||1,parsed=new URL(item.episode.url),next={...item.episode,name:String(current+1),number:current+1,url:`${parsed.origin}/watch/${parsed.pathname.split('/').filter(Boolean).pop()}?ep=${current+1}`};episodes=[item.episode,next]}const episode=item.episode,name=item.name;
// As on Android, continue watching reopens the last played episode; from 95% on it starts over (see play()).
const context={episode,subtitleTitle:item.subtitleTitle,image:item.image,resumeProgress:item.progress,comparisonEpisodes:nearbyEpisodes(episodes,episode),seriesEpisodes:episodes,resolveKind:item.resolveKind||(anime?.provider==='linkkf'?'linkkf':undefined),anime};if(item.episode){await resolveIntoPlayer(()=>context.resolveKind==='linkkf'?window.lilac.linkkfResolve(episode):window.lilac.providerResolve(episode),name,context,item.subtitleTitle||item.name.split(' · ')[0],episodeNumberOf(episode)||1)}else play(item.src,item.name,context)}

// Android DetailScreen parity: episodes are paged (Re:Anime 100, others 50), can be listed
// newest first, and Re:Anime rows carry filler/recap/aired/playable metadata (v0.3.9). Every source uses the same rows.
function episodeRichRow(ep,index){const unavailable=ep.playable===false,title=ep.title&&ep.title!==`Episode ${ep.number}`?ep.title:`${ep.name}화`;return `<div class="episode-row rich${unavailable?' unavailable':''}"><button class="episode-btn" data-index="${index}" ${unavailable?'disabled':''}><span class="episode-number">${escapeHtml(ep.name)}</span><span class="episode-copy"><b>${escapeHtml(title)}</b>${ep.nativeTitle?`<small>${escapeHtml(ep.nativeTitle)}</small>`:''}<span class="episode-meta">${ep.dub?'<i class="episode-badge dub">더빙</i>':''}${ep.isFiller?'<i class="episode-badge filler">FILLER</i>':''}${ep.isRecap?'<i class="episode-badge recap">RECAP</i>':''}${ep.airedDate?`<time>${escapeHtml(ep.airedDate.split('T')[0])}</time>`:''}${unavailable?'<em>재생 불가</em>':''}</span></span></button><button class="episode-download" data-download-index="${index}" data-download-ref="${episodeRef(ep)}" title="다운로드" ${unavailable?'disabled':''}>${episodeDownloadMarkup(jobByRef(episodeRef(ep)))}</button></div>`}
function mountEpisodeList(container,{heading,episodes,anime,resolveKind='provider',onPlay}){
  const sortKey=`episodeNewestFirst:${anime.mal_id||anime.id}`,pageSize=anime.provider==='reanime'?100:50,section=document.createElement('div');let page=0,newestFirst=localStorage.getItem(sortKey)==='true';
  section.className='episode-section';container.append(section);
  const render=()=>{
    const ordered=newestFirst?episodes.slice().reverse():episodes,pages=Math.max(1,Math.ceil(ordered.length/pageSize));page=Math.min(page,pages-1);
    const label=ep=>escapeHtml(String(ep?.name??ep?.number??''));
    const pager=pages>1?`<div class="episode-pager">${Array.from({length:pages},(_,i)=>`<button type="button" data-page="${i}" class="${i===page?'selected':''}">${label(ordered[i*pageSize])}–${label(ordered[Math.min(ordered.length,(i+1)*pageSize)-1])}</button>`).join('')}</div>`:'';
    const rows=ordered.slice(page*pageSize,(page+1)*pageSize).map(ep=>episodeRichRow(ep,episodes.indexOf(ep))).join('');
    section.innerHTML=`<div class="episode-block-head"><h3>${escapeHtml(heading)} <small>${episodes.length}화</small></h3><div class="episode-tools"><button type="button" class="episode-sort">${newestFirst?'최신화순':'오래된화순'}</button><button type="button" class="batch-download">${downloadIcon('offline')}<span>전체 저장</span></button></div></div>${pager}<div class="episode-list rich">${rows}</div>`;
    section.querySelector('.episode-sort').onclick=()=>{newestFirst=!newestFirst;localStorage.setItem(sortKey,String(newestFirst));page=0;render()};
    section.querySelectorAll('[data-page]').forEach(button=>button.onclick=()=>{page=Number(button.dataset.page);render()});
    section.querySelectorAll('.episode-btn').forEach(button=>button.onclick=()=>{const ep=episodes[Number(button.dataset.index)];if(ep.playable===false){toast('Re:Anime에서 재생할 수 없는 회차입니다.');return}onPlay(ep)});
    section.querySelectorAll('[data-download-index]').forEach(button=>button.onclick=()=>handleEpisodeDownload(anime,episodes[Number(button.dataset.downloadIndex)],resolveKind));
    section.querySelector('.batch-download').onclick=async()=>{const targets=episodes.filter(ep=>ep.playable!==false&&!jobByRef(episodeRef(ep)));for(const ep of targets)await queueEpisodeDownload(anime,ep,resolveKind);toast(`${targets.length}개 회차를 순서대로 저장합니다.`)};
    refreshEpisodeDownloadButtons();
  };
  render();
}
function relationLabel(value=''){return String(value).replace(/_/g,' ').toLowerCase().replace(/^./,c=>c.toUpperCase())}
function renderRelated(groups){
  const block=$('#relatedBlock'),tabs=$('#detailContent .detail-tabs');if(!block||!groups.length)return;
  block.replaceChildren(...groups.map(group=>{const el=document.createElement('div');el.className='related-group';el.innerHTML=`<h3>${escapeHtml(group.name)}${group.count?` <small>${group.count}</small>`:''}</h3><div class="poster-rail"></div>`;el.querySelector('.poster-rail').replaceChildren(...group.items.map(card));return el}));
  tabs.classList.remove('hidden');
}
function selectDetailTab(name){$$('#detailContent [data-detail-tab]').forEach(button=>{const selected=button.dataset.detailTab===name;button.classList.toggle('selected',selected);button.setAttribute('aria-selected',String(selected))});$('#episodeBlock')?.classList.toggle('hidden',name!=='episodes');$('#relatedBlock')?.classList.toggle('hidden',name!=='related')}

// Detail "재생" (Android DetailScreen): the most recently played episode of this anime,
// otherwise the first playable one.
function resumeEpisode(anime,episodes){
  const playable=episodes.filter(ep=>ep.playable!==false),refs=new Set(episodes.map(episodeRef));
  const last=state.history.find(item=>item.episode&&(refs.has(episodeRef(item.episode))||(item.anime&&String(item.anime.mal_id)===String(anime.mal_id))));
  if(!last)return {episode:playable[0]||null,resume:false};
  const numberOf=ep=>Number(ep.number??String(ep.name).match(/\d+/)?.[0]);
  const index=episodes.findIndex(ep=>episodeRef(ep)===episodeRef(last.episode)||(Number.isFinite(numberOf(last.episode))&&numberOf(ep)===numberOf(last.episode)&&!ep.dub===!last.episode.dub));
  if(index<0)return {episode:playable[0]||null,resume:false};
  // Android: the last played episode; it resumes below 95% and starts over from there on.
  return {episode:episodes[index],resume:Number(last.progress)>0&&Number(last.progress)<95};
}

function linkkfResumeTarget(anime,servers){
  const refs=new Set(state.history.filter(item=>item.episode).map(item=>episodeRef(item.episode)));
  const server=servers.find(item=>item.episodes.some(ep=>refs.has(episodeRef(ep))))||servers[0];
  return {...resumeEpisode(anime,server?.episodes||[]),episodes:server?.episodes||[]};
}

async function openDetail(id) {
  const dialog=$('#detailDialog'),token=Symbol(id);openDetail.token=token;$('#detailContent').innerHTML='<div class="empty-state"><p>작품 정보를 불러오는 중...</p></div>';if(!dialog.open)dialog.showModal();$('#detailContent').scrollTop=0;
  try {
    const isLinkkf=String(id).startsWith('linkkf:'); const isExternal=/^(animenosub|reanime|miruro):/.test(String(id));
    const known=animeById(id);if(isExternal&&!known)throw new Error('작품 정보를 찾지 못했습니다. 목록에서 다시 선택해 주세요.');
    const providerResult=isExternal?await window.lilac.providerDetail(known):null;
    const {data:a}=isLinkkf?await window.lilac.linkkfDetail(String(id).slice(7)):isExternal?providerResult:await window.lilac.detail(id);if(openDetail.token!==token)return;const isSaved=saved(a.mal_id),isReAnime=a.provider==='reanime';
    const native=a.title_japanese&&a.title_japanese!==titleOf(a)?a.title_japanese:'';
    const meta=[a.type,a.year,a.status,a.aired,(a.studios||[]).slice(0,2).map(x=>x.name).join(', ')].filter(Boolean).map(x=>escapeHtml(String(x))).join(' · ');
    $('#detailContent').innerHTML=`<div class="detail-hero"></div><div class="detail-body"><img alt=""><div class="detail-info"><span class="eyebrow">${escapeHtml(a.type||'ANIME')} · ${a.score?`★ ${a.score}`:isLinkkf?'LINKKF':'평점 없음'}</span><h1 ${titleAttr(a)}>${escapeHtml(titleOf(a))}</h1>${native?`<p class="detail-native">${escapeHtml(native)}</p>`:''}${meta?`<p class="detail-meta">${meta}</p>`:''}<p class="detail-stats hidden"></p><div class="tags">${(a.genres||[]).slice(0,5).map(g=>`<span>${escapeHtml(g.name)}</span>`).join('')}</div><p>${escapeHtml(a.synopsis||'등록된 줄거리가 없습니다.')}</p><div class="detail-actions"><button class="primary detail-play" ${providerResult?.unavailable?'disabled':''}>${providerResult?.unavailable?'현재 재생 불가':isLinkkf?'회차 불러오기':'▶ 플레이어 열기'}</button><button class="ghost detail-save library-toggle ${isSaved?'saved':''}">${heartIcon()}<span>내 목록</span></button>${a.url?'<button class="ghost detail-web"><svg class="external-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg><span>작품 정보</span></button>':''}</div><div class="detail-tabs hidden" role="tablist"><button type="button" role="tab" data-detail-tab="episodes" class="selected" aria-selected="true">회차</button><button type="button" role="tab" data-detail-tab="related" aria-selected="false">관련 작품</button></div><div id="episodeBlock" class="episode-block">${providerResult?.unavailable?'<p class="episode-loading">현재 제공처에 영상이 없는 작품입니다. 설정에서 다른 콘텐츠 소스를 선택해 주세요.</p>':''}</div><div id="relatedBlock" class="related-block hidden"></div></div></div>`;
    setBackgroundImage($('#detailContent .detail-hero'),imageOf(a));setImageSource($('#detailContent .detail-body img'),imageOf(a));
    $$('#detailContent [data-detail-tab]').forEach(button=>button.onclick=()=>selectDetailTab(button.dataset.detailTab));
    const playProvider=ep=>{dialog.close();return resolveIntoPlayer(()=>window.lilac.providerResolve(ep),`${titleOf(a)} · ${ep.name}화`,{episode:ep,subtitleTitle:titleOf(a),image:imageOf(a),comparisonEpisodes:nearbyEpisodes(providerResult.episodes,ep),seriesEpisodes:providerResult.episodes,anime:normalize(a)},titleOf(a),ep.number||1)};
    if(isExternal&&providerResult.episodes?.length&&!providerResult.unavailable){const target=resumeEpisode(a,providerResult.episodes);if(target.episode)$('.detail-play').textContent=`▶ ${target.episode.name}화 ${target.resume?'이어보기':'재생'}`}
    if(isExternal&&providerResult.episodes?.length)mountEpisodeList($('#episodeBlock'),{heading:'회차',episodes:providerResult.episodes,anime:a,onPlay:playProvider});
    if((isReAnime||a.provider==='miruro')&&a.related?.length){const groups=new Map();a.related.forEach(item=>{const name=relationLabel(item.relationType)||'관련 작품';if(!groups.has(name))groups.set(name,[]);groups.get(name).push(item)});renderRelated([...groups].map(([name,items])=>({name,items})))}
    const showStats=stats=>{if(!stats||openDetail.token!==token)return;const el=$('#detailContent .detail-stats');el.textContent=`조회수 오늘 ${stats.day.toLocaleString()} · 주간 ${stats.week.toLocaleString()} · 월간 ${stats.month.toLocaleString()} · 전체 ${stats.total.toLocaleString()}`;el.classList.remove('hidden')};
    if(isLinkkf){
      window.lilac.linkkfExtras(normalize(a)).then(({stats,related})=>{if(openDetail.token!==token)return;showStats(stats);renderRelated(related||[])}).catch(()=>{});
      // Android records a view once the detail page has stayed open for 9 seconds, then refreshes the counters.
      setTimeout(()=>{if(openDetail.token===token&&dialog.open)window.lilac.linkkfRecordView(a.id).then(showStats).catch(()=>{})},9000);
    }
    const playLinkkf=(ep,episodes)=>{const episodeNumber=Number(String(ep.name).match(/\d+/)?.[0]||1);dialog.close();return resolveIntoPlayer(()=>window.lilac.linkkfResolve(ep),`${titleOf(a)} · ${ep.name}화`,{episode:ep,subtitleTitle:titleOf(a),image:imageOf(a),seriesEpisodes:episodes,resolveKind:'linkkf',anime:normalize(a)},titleOf(a),episodeNumber)};
    // Linkkf episodes load with the page, like Android, so "재생" can resume the last played one.
    let linkkfServers=null;
    if(isLinkkf){
      const block=$('#episodeBlock'),playButton=$('.detail-play');playButton.disabled=true;playButton.textContent='▶ 재생';block.innerHTML='<p class="episode-loading">Linkkf 회차 서버에 연결하는 중...</p>';
      window.lilac.linkkfEpisodes(a.id).then(servers=>{
        if(openDetail.token!==token)return;linkkfServers=servers;block.replaceChildren();
        if(!servers.length){block.innerHTML='<p class="episode-loading">등록된 회차가 없습니다.</p>';return}
        servers.forEach(server=>mountEpisodeList(block,{heading:server.name,episodes:server.episodes,anime:a,resolveKind:'linkkf',onPlay:ep=>playLinkkf(ep,server.episodes)}));
        const target=linkkfResumeTarget(a,servers);if(target.episode){playButton.disabled=false;playButton.textContent=`▶ ${target.episode.name}화 ${target.resume?'이어보기':'재생'}`}
      }).catch(e=>{if(openDetail.token===token)block.innerHTML=`<p class="episode-loading">${escapeHtml(e.message)}</p>`});
    }
    $('.detail-play').onclick=async()=>{
      if(isExternal){const ep=resumeEpisode(a,providerResult.episodes||[]).episode;if(ep)await playProvider(ep);else toast(providerResult.unavailable?'현재 제공처에 영상이 없는 작품입니다.':'회차 목록을 불러오지 못했습니다. 작품 정보 버튼으로 제공처 상태를 확인해 주세요.');return;}
      if(!isLinkkf){dialog.close();$('#playerTitle').textContent=titleOf(a);switchView('player');return;}
      const target=linkkfServers?linkkfResumeTarget(a,linkkfServers):null;if(target?.episode)await playLinkkf(target.episode,target.episodes);
    };
    $('.detail-save').onclick=e=>toggleLibrary(a,e.currentTarget);
    $('.detail-web')?.addEventListener('click',()=>window.lilac.openExternal(a.url));
  } catch(e){if(openDetail.token===token)$('#detailContent').innerHTML=`<div class="empty-state"><h3>정보를 불러오지 못했어요</h3><p>${escapeHtml(e.message)}</p></div>`;}
}

async function doSearch(query) {
  query=query.trim(); if(!query)return; switchView('search'); $('#pageSearch').value=query; $('#searchStatus').textContent='검색 중...'; $('#searchGrid').replaceChildren();
  $('#filterMore').classList.add('hidden');if(state.source==='linkkf')$('#searchStatus').textContent='Linkkf 전체 목록에서 검색 중... (처음 검색은 목록을 받느라 조금 걸립니다)';
  const searchToken=(doSearch.token||0)+1;
  const search=text=>PROVIDER_SOURCES.includes(state.source)?window.lilac.providerCatalog(state.source,text):state.source==='linkkf'?window.lilac.linkkfSearch(text):window.lilac.search(text);
  try{
    // The other-language lookup runs alongside the first search.
    // Re:Anime / Animenosub: a Korean query also matches the Korean names of the whole catalog (main process index); those come first.
    const localPromise=['reanime','animenosub'].includes(state.source)&&/[가-힣]/.test(query)?window.lilac.catalogKoreanSearch(state.source,query).catch(()=>[]):Promise.resolve([]);
    // Animenosub's and Miruro's own searches are English only (Animenosub returns its newest posts for a Korean query).
    const serverSearch=text=>['animenosub','miruro'].includes(state.source)&&/[가-힣]/.test(text)?Promise.resolve({data:[]}):search(text);
    const token=doSearch.token=searchToken,variantsPromise=window.lilac.titleVariants(query).catch(()=>[]),[result,local]=await Promise.all([serverSearch(query),localPromise]);if(token!==doSearch.token)return;const localIds=new Set(local.map(a=>String(a.mal_id)));let data=[...local,...(result.data||[]).filter(a=>!localIds.has(String(a.mal_id)))];renderCards('#searchGrid',data);const firstStatus=`“${query}” 검색 결과 ${data.length}${result.total?` / ${result.total}`:''}개`;
    // Nothing yet (a Korean query on an English-only site): the other-language names are still being looked up.
    $('#searchStatus').textContent=data.length?firstStatus:'다른 언어 제목으로 찾는 중...';
    // Korean and English names both work: the query is also searched under its other-language titles.
    const variants=await variantsPromise;if(token!==doSearch.token)return;if(!variants.length){$('#searchStatus').textContent=firstStatus;return}
    // Six searches at a time: a short query can match many known titles.
    const lists=[];let next=0;await Promise.all(Array.from({length:6},async()=>{while(next<variants.length){const text=variants[next++];lists.push(await search(text).then(r=>r.data||[]).catch(()=>[]))}}));
    const extra=lists.flat(),seen=new Set(data.map(a=>String(a.mal_id)));
    const added=extra.filter(a=>!seen.has(String(a.mal_id))&&seen.add(String(a.mal_id)));if(token!==doSearch.token)return;if(!added.length){$('#searchStatus').textContent=firstStatus;return}
    data=[...data,...added];$('#searchGrid').append(...added.map(card));$('#searchStatus').textContent=`“${query}” 검색 결과 ${data.length}개 (${variants.length>3?`${variants.slice(0,3).join(', ')} 외 ${variants.length-3}개`:variants.join(', ')} 포함)`;
  }
  catch(e){if(doSearch.token===searchToken)$('#searchStatus').textContent=`검색 실패: ${String(e.message||e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')}`;}
}

function showPendingPlayer(name,context={}){
  const requestId=++playbackRequestId,video=$('#video');
  if(hlsPlayer){hlsPlayer.destroy();hlsPlayer=null;}
  video.pause();video.removeAttribute('src');video.load();
  currentPlaybackContext={...context,resolving:true};clearSubtitle();renderSavedSubtitles();skipSegments=[];activeSkip=null;currentHistoryKey=null;
  enterPlayer();showPlayerControls();
  $('#immersivePlayer').classList.remove('is-playing');$('#playerEmpty').classList.remove('hidden');
  $('#playerEmpty p').textContent='영상 서버에 연결하고 있어요';$('#playerTitle').textContent=name;updatePlayerTitle();$('#playerMeta').textContent='재생 준비 중';
  $('#downloadStatus').textContent='영상 주소를 확인하는 중...';$('#subtitleState').textContent='영상 연결 후 자막을 확인합니다.';renderSubtitleTracks();
  return requestId;
}


// Animenosub / Miruro: SUB servers have English burned in, RAW ones none. A server picked in the player is used again;
// otherwise RAW when this episode has a Korean subtitle (saved, or found online within 8 s), else SUB. A show whose
// earlier episode had one found online goes RAW at once, without waiting for the search.
const videoServerKey=provider=>`${provider||'animenosub'}Server`;
const KOREAN_SHOWS_KEY='koreanSubtitleShows';
function koreanShows(){try{return JSON.parse(localStorage.getItem(KOREAN_SHOWS_KEY)||'[]')}catch{return []}}
async function resolveWithVideoServer(episode,koreanSearch,anime){
  const picked=localStorage.getItem(videoServerKey(episode.provider))||'';let prefer='sub';
  const show=anime?.id?`${anime.provider||episode.provider}:${anime.id}`:'';
  koreanSearch.then(found=>{if(!found||!show)return;const list=koreanShows().filter(key=>key!==show);list.unshift(show);try{localStorage.setItem(KOREAN_SHOWS_KEY,JSON.stringify(list.slice(0,300)))}catch{}});
  if(!picked){
    const saved=await window.lilac.savedSubtitles(episodeRef(episode)).catch(()=>[]);
    if(saved.some(entry=>entry.source!=='provider')||(show&&koreanShows().includes(show))||await Promise.race([koreanSearch,new Promise(resolve=>setTimeout(()=>resolve(null),8000))]))prefer='raw';
  }
  return window.lilac.providerResolve({...episode,server:picked,prefer});
}
async function resolveIntoPlayer(resolver,name,context={},subtitleTitle='',episode=1){
  const requestId=showPendingPlayer(name,context);
  const searchTitle=subtitleTitle||context.subtitleTitle||name.split(' · ')[0];
  const koreanSearch=onlineSubtitleFor(searchTitle,episode,context.anime?{provider:context.anime.provider,id:context.anime.id,title:context.anime.title||context.anime.title_english||'',anilistId:context.anime.anilistId||null,malId:context.anime.malId||null}:null).catch(()=>null);
  try{
    const downloaded=context.episode?jobByRef(episodeRef(context.episode)):null;
    const stream=downloaded?.status==='completed'?{...await window.lilac.playDownload(downloaded.id),downloaded:true}:['animenosub','miruro'].includes(context.episode?.provider)?await resolveWithVideoServer(context.episode,koreanSearch,context.anime):await resolver();
    if(requestId!==playbackRequestId)return;
    const offlineEpisodes=downloaded?.status==='completed'?downloadedSeries(downloaded):[];
    play(stream.url,name,{...context,seriesEpisodes:offlineEpisodes.length?offlineEpisodes:context.seriesEpisodes,streamHeaders:stream.headers||{},offline:Boolean(downloaded?.status==='completed')});
    if(downloaded?.status==='completed')$('#downloadStatus').textContent='다운로드한 영상 재생 중';
    currentPlaybackContext.subtitleTracks=stream.subtitleTracks||[];currentPlaybackContext.subtitleReferer=stream.referer||'';renderSubtitleTracks();loadMissingSubtitleTracks();
    currentPlaybackContext.videoServers=stream.servers||[];currentPlaybackContext.videoServer=stream.server||'';if(typeof renderVideoServers==='function')renderVideoServers();
    ensureSubtitle(stream,searchTitle,episode);
  }catch(error){
    if(requestId!==playbackRequestId)return;
    // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
    const message=String(error?.message||'영상 서버에 연결하지 못했습니다.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
    $('#playerEmpty').classList.remove('hidden');$('#playerEmpty p').textContent='영상을 불러오지 못했어요';
    $('#playerMeta').textContent='뒤로 가서 다른 회차를 선택해 주세요';$('#downloadStatus').textContent=message;
    toast(`재생 실패: ${message}`);
  }
}

function play(src,name='직접 재생',context={}) {
  ++playbackRequestId;const video=$('#video');currentPlaybackContext={...context,currentUrl:src};cancelOtherEpisodeTranslations();clearSubtitle();renderSavedSubtitles();skipSegments=[];activeSkip=null;activeSkipKey=null;opEdAnalysisKey=null;if(hlsPlayer){hlsPlayer.destroy();hlsPlayer=null;} video.removeAttribute('src');
  enterPlayer();setPlayerLocked(false);showPlayerControls();updateEpisodeButtons();$('#playerEmpty').classList.remove('hidden');$('#subtitleState').textContent='온라인 자막을 확인하는 중...';
  const isHls=/\.m3u8(?:$|\?)/i.test(src)||/\/__flix\//i.test(src);
  if(isHls&&window.Hls?.isSupported()){
    hlsPlayer=new Hls({
      enableWorker:true,
      lowLatencyMode:false,
      startFragPrefetch:true,
      maxBufferLength:60,
      maxMaxBufferLength:60,
      maxBufferSize:1024*1024*1024,
      backBufferLength:10,
      maxBufferHole:.5,
      highBufferWatchdogPeriod:2,
      manifestLoadingTimeOut:120000,
      levelLoadingTimeOut:120000,
      fragLoadingTimeOut:120000,
      manifestLoadingMaxRetry:6,
      levelLoadingMaxRetry:6,
      fragLoadingMaxRetry:6
    });
    hlsPlayer.loadSource(src);
    hlsPlayer.attachMedia(video);
    $('#downloadStatus').textContent='영상 재생목록을 불러오는 중...';
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED,()=>{applyDefaultQuality();renderQualityChoices();scheduleOpEdAnalysis();$('#downloadStatus').textContent='재생하며 60초 앞까지 불러오는 중';video.play().catch(()=>{})});
    hlsPlayer.on(Hls.Events.LEVEL_SWITCHED,()=>{if(playerSettingsOpen())renderQualityChoices()});
    hlsPlayer.on(Hls.Events.FRAG_BUFFERED,()=>{if(!video.paused)$('#downloadStatus').textContent='재생 중 · 앞부분 계속 불러오는 중'});
    // Recover instead of stopping. FlixCloud segments do not always start on a keyframe and some
    // contain none, so playback cannot start inside them after a seek or resume ("Found no media").
    // Step back one fragment at a time until one with a keyframe plays. Counters reset only once
    // playback actually moves on to another fragment.
    const recovery={network:0,media:0,stepBack:0,lastSn:null};
    hlsPlayer.on(Hls.Events.FRAG_CHANGED,()=>{recovery.network=0;recovery.media=0;recovery.stepBack=0;recovery.lastSn=null});
    hlsPlayer.on(Hls.Events.ERROR,(_,data)=>{
      if(!hlsPlayer)return;
      if(data.details===Hls.ErrorDetails.FRAG_PARSING_ERROR&&data.frag?.type==='main'&&recovery.stepBack<8){
        if(recovery.lastSn===data.frag.sn&&!data.fatal)return;
        recovery.lastSn=data.frag.sn;recovery.stepBack++;
        const previous=(hlsPlayer.levels[data.frag.level]?.details?.fragments||[]).find(frag=>frag.sn===data.frag.sn-1);
        if(previous){video.currentTime=previous.start+.05;$('#downloadStatus').textContent='재생 위치를 맞추는 중...'}
        if(data.fatal)hlsPlayer.recoverMediaError();
        return;
      }
      if(!data.fatal)return;
      if(data.type===Hls.ErrorTypes.NETWORK_ERROR&&recovery.network<3){recovery.network++;$('#downloadStatus').textContent='영상 서버에 다시 연결하는 중...';hlsPlayer.startLoad();return}
      if(data.type===Hls.ErrorTypes.MEDIA_ERROR&&recovery.media<3){recovery.media++;if(recovery.media===2)hlsPlayer.swapAudioCodec();$('#downloadStatus').textContent='재생 오류를 복구하는 중...';hlsPlayer.recoverMediaError();return}
      {const detail=data.details||data.type||'unknown',status=data.response?.code||data.response?.status||'',reason=data.reason||data.error?.message||'';const message=[detail,status&&`HTTP ${status}`,reason].filter(Boolean).join(' · ');$('#downloadStatus').textContent=`HLS 오류: ${message}`;toast(`HLS 재생 오류: ${message}`)}});
  }else video.src=src;
  $('#streamUrl').value=/^https?:/i.test(src)?src:'';$('#playerTitle').textContent=name;updatePlayerTitle();$('#playerMeta').textContent=context.episode?`${episodeNumberOf(context.episode)||1}화`:'LilacAnime';$('#playerEmpty p').textContent='영상을 준비하고 있어요';$('#skipTitle').value=context.subtitleTitle||((name==='직접 재생')?'':name.split(' · ')[0]);if(context.episode)$('#skipEpisode').value=episodeNumberOf(context.episode)||1;video.volume=Math.max(0,Math.min(1,Number(localStorage.getItem('playerVolume')??1)));video.muted=localStorage.getItem('playerMuted')==='true';syncVolumeUI();video.playbackRate=Number($('#speed').value);if(!isHls)video.play().catch(()=>{});loadJimakuList();
  const historyKey=context.episode?`${context.episode.provider||context.resolveKind||'linkkf'}:${context.episode.url||context.episode.token||context.episode.id||context.episode.number}`:src;if(context.episode||!/^http:\/\/127\.0\.0\.1:\d+\/__flix\//i.test(src)){const previous=state.history.find(x=>(x.key||x.src)===historyKey),savedProgress=Number(context.resumeProgress??previous?.progress??0);pendingResumeProgress=savedProgress>0&&savedProgress<95?savedProgress:0;state.history=state.history.filter(x=>(x.key||x.src)!==historyKey);state.history.unshift({key:historyKey,src:context.episode?'':src,name,episode:context.episode||null,subtitleTitle:context.subtitleTitle||name.split(' · ')[0],image:context.image||previous?.image||'',comparisonEpisodes:context.comparisonEpisodes||previous?.comparisonEpisodes||[],anime:context.anime||previous?.anime||null,resolveKind:context.resolveKind||previous?.resolveKind||null,progress:savedProgress,updated:Date.now()});state.history=state.history.slice(0,30);currentHistoryKey=historyKey;store.set('history',state.history);renderContinue();applyPendingResume()}else{currentHistoryKey=null;pendingResumeProgress=0}
}
function escapeHtml(v=''){const d=document.createElement('div');d.textContent=v;return d.innerHTML;}
// Subtitle currently applied. ASS subtitles render through libass (ass-renderer.js) while
// "ASS 자막 효과" is on; the WebVTT copy is the simplified fallback, as on Android.
let currentSubtitle=null,subtitleFontPromise=null;
const SUBTITLE_SOURCE_LABELS={linkkf:'Linkkf',reanime:'Re:Anime',kairan:'Kairan',csora:'Csora',anissia:'Anissia',jimaku:'Jimaku',user:'사용자',provider:'제공',download:'다운로드',gemini:'AI 번역'};
function assEffectsEnabled(){return localStorage.getItem('assEffects')!=='false'}
// 기본 자막 폰트 (기본체 / 나눔고딕 / 명조체 or a font file) as {family, data}, shared by VTT and ASS.
function subtitleFontData(){subtitleFontPromise ||= window.lilac.defaultSubtitleFont(localStorage.getItem('subtitleFont')||'기본체',localStorage.getItem('subtitleFontPath')||'').then(font=>font?.data?{family:font.family,data:new Uint8Array(font.data)}:null).catch(()=>null);return subtitleFontPromise}
function assRendererReady(){return window.LilacAss?Promise.resolve(window.LilacAss):new Promise(resolve=>window.addEventListener('lilac-ass-ready',()=>resolve(window.LilacAss),{once:true}))}
// Chromium keeps drawing the cue that was on screen when its <track> is removed (the next episode then shows the last
// line of the previous one until subtitles are switched off and on), so the tracks are turned off first.
function clearSubtitle(){currentSubtitle=null;const video=$('#video');for(const track of video.textTracks)track.mode='disabled';video.querySelectorAll('track').forEach(x=>x.remove());window.LilacAss?.destroy()}
function setVttVisible(){const track=$('#video').textTracks[0];if(track)track.mode=$('#subtitleEnabled').checked&&!currentSubtitle?.assRendering?'showing':'hidden'}
async function renderAssSubtitle(){
  const subtitle=currentSubtitle;if(!subtitle?.assUrl)return;
  if(!assEffectsEnabled()){subtitle.assRendering=false;window.LilacAss?.destroy();setVttVisible();return}
  try{
    const [ass,font]=await Promise.all([assRendererReady(),subtitleFontData()]);if(currentSubtitle!==subtitle)return;
    subtitle.assRendering=true;setVttVisible();
    await ass.attach($('#video'),{subUrl:subtitle.assUrl,fonts:subtitle.fonts||[],defaultFont:font,offsetMs:Number(localStorage.getItem('subtitleSync')||0),visible:$('#subtitleEnabled').checked});
  }catch{if(currentSubtitle===subtitle){subtitle.assRendering=false;setVttVisible();toast('ASS 자막 효과를 적용하지 못해 단순 자막으로 표시합니다.')}}
}
// options: {path, assUrl, assPath, fonts, source, saved}. A source+path is remembered per episode.
function attachSubtitle(src,label='자막',options={}){
  const video=$('#video');clearSubtitle();const subtitle={src,label,...options,assRendering:false};currentSubtitle=subtitle;
  const track=document.createElement('track');track.kind='subtitles';track.label=label;track.srclang='ko';track.src=src;track.default=true;video.append(track);
  track.addEventListener('load',()=>{if(currentSubtitle!==subtitle)return;applyVttLayout();setVttVisible();if(!translatingNow())$('#subtitleState').textContent=`${label} 적용됨${subtitle.assUrl&&assEffectsEnabled()?' · ASS 효과':''}`;toast(options.notice||`${label}을 적용했습니다.`)});
  track.addEventListener('error',()=>{if(currentSubtitle===subtitle)$('#subtitleState').textContent='자막 파일을 불러오지 못했습니다.'});
  renderAssSubtitle();
  if(options.source&&options.path&&!options.saved)rememberSubtitle(subtitle);else renderSavedSubtitles();if(typeof renderDiscoveredFonts==='function')renderDiscoveredFonts();
}

// Android SubtitleStore parity: subtitles are remembered per episode and source.
function subtitleStoreKey(){const episode=currentPlaybackContext.episode;return episode?episodeRef(episode):''}
async function rememberSubtitle(subtitle){const key=subtitleStoreKey();if(!key)return;try{await window.lilac.saveSubtitle(key,{source:subtitle.source,label:subtitle.label,path:subtitle.path,assPath:subtitle.assPath||null,fonts:subtitle.fonts||[]})}catch{}renderSavedSubtitles()}
function applySavedSubtitle(entry){if(entry.source==='jimaku')return applySavedJimaku(entry);currentSubtitlePath=entry.path;attachSubtitle(entry.url,entry.label,{path:entry.path,assUrl:entry.assUrl,assPath:entry.assPath,fonts:entry.fonts,source:entry.source,saved:true})}
async function renderSavedSubtitles(){
  const box=$('#savedSubtitles'),list=$('#savedSubtitleList'),key=subtitleStoreKey();if(!key){box.classList.add('hidden');list.replaceChildren();return}
  const entries=await window.lilac.savedSubtitles(key).catch(()=>[]);if(key!==subtitleStoreKey())return;
  box.classList.toggle('hidden',!entries.length);$('#savedSubtitleCount').textContent=`${entries.length}개`;
  list.replaceChildren(...entries.map(entry=>{
    const row=document.createElement('div'),active=currentSubtitle?.path===entry.path;row.className='saved-subtitle';
    row.innerHTML=`<button type="button" class="track-option${active?' selected':''}" aria-pressed="${active}"><span>${escapeHtml(entry.label)}</span><small>${escapeHtml(SUBTITLE_SOURCE_LABELS[entry.source]||entry.source)}${entry.assPath?' · ASS':''}</small></button><button type="button" class="saved-remove" aria-label="${escapeHtml(entry.label)} 삭제">×</button>`;
    row.querySelector('.track-option').onclick=()=>applySavedSubtitle(entry);
    row.querySelector('.saved-remove').onclick=async()=>{await window.lilac.removeSavedSubtitle(key,entry.id);if(currentSubtitle?.path===entry.path){clearSubtitle();$('#subtitleState').textContent='저장된 자막을 삭제했습니다.'}renderSavedSubtitles()};
    return row;
  }));
}
// Kairan → Csora → Anissia (the preferred one first), started while the stream is still being resolved so the
// result is usually ready when playback starts. One search per title and episode. The three are asked at once and
// taken in that order, so a miss on the first no longer waits for the next search to start.
let onlineSubtitleSearch=null;
function onlineSubtitleFor(title,episode,anime){
  const key=`${title}|${episode}`;if(onlineSubtitleSearch?.key===key)return onlineSubtitleSearch.promise;
  const preferred=localStorage.getItem('subtitleSource')||'reanime',online=['kairan','csora','anissia'],sources=online.includes(preferred)?[preferred,...online.filter(x=>x!==preferred)]:online;
  const searches=sources.map(source=>window.lilac.findSubtitle(source,title,episode,anime).then(result=>({source,result}),()=>null));
  const promise=(async()=>{for(const search of searches){const found=await search;if(found)return found}return null})();
  onlineSubtitleSearch={key,promise};
  promise.then(found=>{if(!found&&onlineSubtitleSearch?.promise===promise)onlineSubtitleSearch=null});
  return promise;
}
function attachOnlineSubtitle({source,result}){currentSubtitlePath=result.path;attachSubtitle(result.url,communityLabel(source,result),{path:result.path,assUrl:result.assUrl,assPath:result.assPath,fonts:result.fonts,source})}
// The subtitle playing is not Korean (a saved Jimaku file, a saved stream subtitle): offer a Korean one when it
// turns up. A Korean one already playing (the stream's own track, a saved or translated file) is left alone.
async function offerKoreanSubtitle(title,episode,requestId,current){
  const found=await onlineSubtitleFor(title,episode,subtitleSearchAnime());
  if(!found||requestId!==playbackRequestId||currentSubtitle!==current)return;
  const name=communityLabel(found.source,found.result).replace(/ 자막$/,'');
  const box=$('#subtitleOffer');$('#subtitleOfferText').textContent=`한국어 자막(${name})을 찾았어요. 바꿀까요?`;
  box.classList.remove('hidden');clearTimeout(offerKoreanSubtitle.timer);offerKoreanSubtitle.timer=setTimeout(()=>box.classList.add('hidden'),20000);
  $('#subtitleOfferApply').textContent='바꾸기';$('#subtitleOfferApply').onclick=()=>{box.classList.add('hidden');if(requestId===playbackRequestId)attachOnlineSubtitle(found)};
  $('#subtitleOfferDismiss').onclick=()=>box.classList.add('hidden');
}
async function ensureSubtitle(stream,title,episode,{skipSaved=false}={}){
  const requestId=playbackRequestId,preferred=localStorage.getItem('subtitleSource')||'reanime',key=subtitleStoreKey();
  $('#subtitleOffer').classList.add('hidden');
  const saved=key&&!skipSaved?await window.lilac.savedSubtitles(key).catch(()=>[]):[];if(requestId!==playbackRequestId)return false;
  // Same order as Android: the preferred source's saved file, the stream's own subtitle, any saved file, then online search.
  // Only a subtitle that is not Korean gets the online Korean offer; fansubs and the user's own files are final.
  const offerAfter=(source,korean)=>{if(!korean&&!['kairan','csora','anissia','user','gemini'].includes(source))offerKoreanSubtitle(title,episode,requestId,currentSubtitle)};
  // A machine translation stands for the Re:Anime / Jimaku subtitle it was made from.
  const savedPreferred=(['reanime','jimaku'].includes(preferred)&&saved.find(entry=>entry.source==='gemini'))||saved.find(entry=>entry.source===preferred);if(savedPreferred){await applySavedSubtitle(savedPreferred);offerAfter(savedPreferred.source,savedPreferred.source!=='jimaku');return true}
  // Re:ANIME and Miruro: like Android only a Korean track is applied by itself; any other language is left for the user
  // to pick from the track list while the Korean search runs.
  const reanime=currentPlaybackContext.episode?.provider==='reanime',koreanUrl=url=>/(?:^|[^a-z])(?:kor|korean|ko)(?:[^a-z]|$)|한국/i.test(decodeURIComponent(String(url||'')));
  // A downloaded episode's subtitle was picked for it when it was saved (a fansub, or the track the user chose).
  const fromDownload=Boolean(stream?.downloaded),fansub=fromDownload&&/Kairan|Csora|Anissia/.test(stream.subtitleLabel||'');
  const track=(stream?.subtitleTracks||[]).find(isKoreanTrack),streamKorean=Boolean(track)||currentPlaybackContext.resolveKind==='linkkf'||(reanime&&koreanUrl(stream?.subtitleUrl))||fromDownload;
  if(stream?.subtitleUrl&&(!reanime||streamKorean)){if(!fromDownload&&(track||stream.subtitleTrack))currentPlaybackContext.selectedSubtitleTrack=track?.url||stream.subtitleTrack;renderSubtitleTracks();const source=track?'reanime':currentPlaybackContext.resolveKind==='linkkf'?'linkkf':reanime?'reanime':'provider';if(!track)currentPlaybackContext.streamSubtitle={src:stream.subtitleUrl,label:stream.subtitleLabel||'제공 자막',options:{path:stream.subtitlePath||null,assUrl:stream.subtitleAss?.url||null,assPath:stream.subtitleAss?.path||null,fonts:stream.subtitleAss?.fonts||[],source:stream.subtitlePath?source:null}};attachSubtitle(stream.subtitleUrl,track&&!fromDownload?`${trackSourceLabel()} ${track.label} 자막`:stream.subtitleLabel||(fromDownload?'다운로드 자막':'제공 자막'),{path:stream.subtitlePath||null,assUrl:stream.subtitleAss?.url||null,assPath:stream.subtitleAss?.path||null,fonts:stream.subtitleAss?.fonts||[],source:stream.subtitlePath?source:null});
    if(!fansub)offerAfter(source,streamKorean);
    return true}
  if(saved[0]){await applySavedSubtitle(saved[0]);offerAfter(saved[0].source,!['provider','jimaku'].includes(saved[0].source));return true}
  // The search gives way to whatever the user picks meanwhile (a track, a Jimaku file, a saved or own subtitle).
  const before=currentSubtitle,superseded=()=>requestId!==playbackRequestId||Boolean(currentPlaybackContext.selectedSubtitleTrack)||currentSubtitle!==before;$('#subtitleState').textContent='온라인 자막을 찾는 중...';
  const found=await onlineSubtitleFor(title,episode,subtitleSearchAnime());if(superseded())return false;if(found){attachOnlineSubtitle(found);return true}
  if(await autoJimaku(superseded))return true;
  if(superseded())return false;const needsTmdb=currentPlaybackContext.episode?.provider==='reanime'&&!(await window.lilac.tmdbKey().catch(()=>({})))?.key;if(superseded())return false;$('#subtitleState').textContent=needsTmdb?'Kairan/Csora 자막을 찾지 못했습니다. 설정 > 한국어 제목 검색에서 TMDB API 키를 넣으면 더 많은 작품을 찾을 수 있어요.':trackProvider()&&currentPlaybackContext.subtitleTracks?.length?`한국어 자막이 없습니다. 아래 ${trackSourceLabel()} 트랙에서 다른 언어를 고르거나 내 자막 파일을 열 수 있어요.`:'자동으로 찾은 자막이 없습니다. 내 자막 파일을 열 수 있어요.';return false;
}
// No Korean subtitle anywhere (no Korean track, nothing from Kairan / Csora / Anissia): the episode's best Jimaku file,
// translated as 설정 > 자막 자동 번역 > Jimaku 자막 자동 번역 says (the Japanese file plays until the translation is in).
async function autoJimaku(superseded){
  translationSettings=await window.lilac.geminiSettings().catch(()=>translationSettings);
  const provider=translationSettings?.jimakuTranslate,anime=subtitleSearchAnime();
  if(superseded()||!['cloud','local'].includes(provider)||!anime||!(translationReady('cloud')||translationReady('local')))return false;
  $('#subtitleState').textContent='한국어 자막이 없어 Jimaku 일본어 자막을 찾는 중...';
  const files=await loadJimakuList();if(superseded()||!files.length)return false;
  await applyJimaku(files[0]);return true;
}
function communityLabel(source,result={}){return source==='anissia'?`Anissia${result.maker?` · ${result.maker}`:''} 자막`:`${source==='kairan'?'Kairan':'Csora'} 자막`}
function subtitleSearchAnime(){const anime=currentPlaybackContext.anime;return anime?{provider:anime.provider,id:anime.id,title:anime.title||anime.title_english||'',anilistId:anime.anilistId||null,malId:anime.malId||null}:null}
function syncAssEffectsUI(){$('#assEffectsSheet').checked=assEffectsEnabled()}
function syncSubtitleFontUI(){const choice=localStorage.getItem('subtitleFont')||'기본체',file=localStorage.getItem('subtitleFontPath')||'';$$('#fontChoices button').forEach(button=>button.classList.toggle('selected',!file&&button.dataset.value===choice));$('#subtitleFontFile').textContent=file?`사용자 폰트: ${file.split(/[\\/]/).pop()}`:'폰트 파일을 지정하면 선택한 폰트 대신 사용합니다.';$('#resetSubtitleFont').classList.toggle('hidden',!file)}
async function subtitleFontChanged(){subtitleFontPromise=null;syncSubtitleFontUI();await applyCueStyle();if(currentSubtitle?.assUrl)renderAssSubtitle()}
function isKoreanTrack(track){return /kor|korean|한국/i.test(`${track.language} ${track.label}`)||/^ko(?:[-_]|$)/i.test(track.language||"")||/_kor_/i.test(track.url)}
// Re:ANIME/FlixCloud and Miruro expose every subtitle language; Android v0.3.9 lets the user pick one. The "reanime"
// subtitle source stands for the playing source's tracks.
const TRACK_PROVIDERS=['reanime','miruro'];
function trackProvider(){const provider=currentPlaybackContext.episode?.provider;return TRACK_PROVIDERS.includes(provider)?provider:null}
function trackSourceLabel(){return trackProvider()==='miruro'?'Miruro':'Re:Anime'}
function renderSubtitleTracks(){
  const box=$('#subtitleTracks'),list=$('#subtitleTrackList'),tracks=currentPlaybackContext.subtitleTracks||[],hasTracks=Boolean(trackProvider());
  $('#subtitleTracks .sheet-tracks-head b').textContent=`${trackSourceLabel()} 자막 트랙`;$$('[data-source="reanime"]').forEach(button=>(button.querySelector('b')||button).textContent=trackProvider()==='miruro'?'Miruro':'Re:Anime');
  // Only the sources this episode can use: the site's own subtitle (Linkkf) or tracks (Re:Anime / Miruro) when it has them.
  $('#psSubtitleSources [data-source="linkkf"]').classList.toggle('hidden',currentPlaybackContext.resolveKind!=='linkkf');$('#psSubtitleSources [data-source="reanime"]').classList.toggle('hidden',!trackProvider());
  $('#jimakuBox').classList.toggle('hidden',!subtitleSearchAnime());
  // The translate buttons come with a picked track, as they do with a picked Jimaku file.
  box.classList.toggle('hidden',!hasTracks);$('#subtitleTrackTranslate').classList.toggle('hidden',!tracks.some(track=>track.url===currentPlaybackContext.selectedSubtitleTrack));$('#subtitleTrackTranslate').nextElementSibling.classList.toggle('hidden',$('#subtitleTrackTranslate').classList.contains('hidden'));if(!hasTracks){list.replaceChildren();return}
  $('#subtitleTrackState').textContent=tracks.length?`${tracks.length}개 트랙`:currentPlaybackContext.resolving||currentPlaybackContext.tracksLoading?'현재 회차의 자막 트랙을 불러오는 중…':'자막 트랙을 불러오지 못했습니다.';$('#reloadSubtitleTracks').classList.toggle('hidden',Boolean(tracks.length||currentPlaybackContext.resolving||currentPlaybackContext.tracksLoading));
  // Korean, English and Japanese first; a label like "Chinese (Chinese (Han, Simplified) - Full Subtitles)" shows the
  // language on top and the rest small underneath.
  const rank=track=>isKoreanTrack(track)?0:/english|^en(?:[-_]|$)/i.test(`${track.label} ${track.language||''}`)?1:/japanese|^ja(?:[-_]|$)/i.test(`${track.label} ${track.language||''}`)?2:3;
  list.replaceChildren(...tracks.map((track,index)=>({track,index})).sort((a,b)=>rank(a.track)-rank(b.track)||a.index-b.index).map(({track})=>{const button=document.createElement('button'),selected=currentPlaybackContext.selectedSubtitleTrack===track.url;button.type='button';button.className=`track-option${selected?' selected':''}`;button.setAttribute('aria-pressed',String(selected));button.title=track.label;
    const parts=String(track.label||'').match(/^(.*?)\s*\((.*)\)$/),name=parts?.[1]||track.label,detail=parts?parts[2].replace(name,'').replace(/^[\s-]+/,'').trim():'';
    button.innerHTML=`<span><b>${escapeHtml(name)}</b>${detail?`<em>${escapeHtml(detail)}</em>`:''}</span><small>${escapeHtml(String(track.format||'vtt').toUpperCase())}${track.translatedUrl?' · 번역됨':''}</small>`;button.onclick=()=>selectSubtitleTrack(track);return button}));
}
// Downloaded episodes play from disk, so fetch the Re:ANIME track list separately.
async function loadMissingSubtitleTracks(){
  const context=currentPlaybackContext,episode=context.episode;if(episode?.provider!=='reanime'||context.subtitleTracks?.length)return;
  const requestId=playbackRequestId;context.tracksLoading=true;renderSubtitleTracks();
  try{const result=await window.lilac.providerSubtitleTracks(episode);if(requestId!==playbackRequestId)return;context.subtitleTracks=result.tracks||[];context.subtitleReferer=result.referer||context.subtitleReferer}catch{}
  finally{if(requestId===playbackRequestId){context.tracksLoading=false;renderSubtitleTracks()}}
}
// Korean translation (the translation API or the local AI, 설정 > 자막 자동 번역) of the selected Re:Anime / Miruro track or the picked
// Jimaku file. Tracks saved with a download carry their translation, which is applied as is (also offline).
// Each place has an API and a local AI button; a picked Jimaku file is translated by itself as set in 설정. When the
// one asked for is not set up or stops (no key, the API's allowance used up, no model), the other one
// takes over if it is set up.
let translationSettings=null;
const translationReady=provider=>provider==='local'?(translationSettings?.localModels||[]).some(model=>model.id===translationSettings.localModel&&model.installed):provider==='cloud'?Boolean(translationSettings?.cloudReady):Boolean(autoProvider());
const autoProvider=()=>translationReady('cloud')?'cloud':translationReady('local')?'local':null;
const cloudName=()=>translationSettings?.cloudName||'Gemini';
const translatedLabel=(result,name)=>`${result.engine||(String(result.model||'').startsWith('local:')?'로컬 AI':'AI')} 번역 (${name})`;
// A track's file: the copy saved with the download, else fetched.
const trackFile=track=>track.localUrl?Promise.resolve({path:track.path,url:track.localUrl,assPath:track.assUrl?track.assPath:null,assUrl:track.assUrl||null,fonts:[]}):window.lilac.remoteSubtitle(track.url,currentPlaybackContext.subtitleReferer);
const ipcMessage=error=>String(error?.message||error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
async function translateSubtitleTrack(provider='cloud',{fresh=false}={}){
  const context=currentPlaybackContext,tracks=context.subtitleTracks||[],button=provider==='local'?$('#translateSubtitleLocal'):$('#translateSubtitle');
  const track=tracks.find(item=>item.url===context.selectedSubtitleTrack);
  if(!track){toast(tracks.length?'번역할 자막 트랙을 먼저 선택하세요.':`번역할 ${trackSourceLabel()} 자막 트랙이 없습니다.`);return}
  if(track.translatedUrl&&!fresh){currentSubtitlePath=track.translatedPath;attachSubtitle(track.translatedUrl,`AI 번역 (${track.label})`,{path:track.translatedPath,source:'gemini'});return}
  await runTranslation({file:()=>trackFile(track),name:track.label,button,provider,fresh});
}
// Translates a subtitle file (file: a function giving {path}) and applies the result; the button shows the progress
// and, pressed again, cancels the run (the lines done so far are kept: the next run goes on from them). Only the newest
// run applies its result (picking another Jimaku file while one is translated), and a button is put back by the run
// that last used it. A run for an episode no longer playing is cancelled when another episode starts.
const translationButtons=new Map(),translationEpisodes=new Map();let translationRun=0,translating=null;
const TRANSLATION_CANCELLED=/번역을 취소했습니다/;
// 새로 번역 (under both pairs of buttons, one setting): the next button press translates again instead of taking a kept
// translation, then the switch turns itself off (a new translation costs time or API use).
let freshTranslation=false;
const syncFreshTranslation=()=>$$('.fresh-translation input').forEach(input=>input.checked=freshTranslation);
$$('.fresh-translation input').forEach(input=>input.onchange=()=>{freshTranslation=input.checked;syncFreshTranslation()});
const takeFreshTranslation=()=>{const fresh=freshTranslation;freshTranslation=false;syncFreshTranslation();return fresh};
function cancelButtonRun(button){const run=Number(button.dataset.run);if(!run||!translationButtons.has(run))return false;window.lilac.cancelTranslation(run).catch(()=>{});return true}
function cancelOtherEpisodeTranslations(){const episode=subtitleStoreKey();for(const [run,key] of translationEpisodes)if(key!==episode)window.lilac.cancelTranslation(run).catch(()=>{})}
// A translation for the episode on screen is running: its progress stays in the subtitle state line.
const translatingNow=()=>translating?.requestId===playbackRequestId;
async function runTranslation({file,name,button,provider,fresh=false}){
  translationSettings=await window.lilac.geminiSettings().catch(()=>translationSettings);
  if(!translationReady('cloud')&&!translationReady('local')){toast(provider==='local'?'설정 > 자막 자동 번역에서 로컬 AI 모델을 먼저 받아 주세요.':`설정 > 자막 자동 번역에서 ${cloudName()} API 키를 넣어 주세요.`);return}
  cancelButtonRun(button); // a run this button was showing gives way (another Jimaku file picked)
  const label=button.dataset.label||(button.dataset.label=button.textContent),run=++translationRun;
  const requestId=playbackRequestId,title=currentPlaybackContext.subtitleTitle||$('#skipTitle').value.trim(),current=()=>requestId===playbackRequestId&&run===translationRun;
  translationButtons.set(run,button);translationEpisodes.set(run,subtitleStoreKey());translating={run,requestId,name};button.dataset.run=String(run);button.textContent='번역 준비 중… · 취소';$('#subtitleState').textContent=`${name} 자막을 한국어로 번역하는 중...`;
  try{
    const source=await file();if(!current())return;
    const result=await window.lilac.translateSubtitle({path:source.path,title,id:run,provider,fresh,anime:subtitleSearchAnime()});if(!current())return;
    currentSubtitlePath=result.path;attachSubtitle(result.url,translatedLabel(result,name),{path:result.path,source:'gemini'});
    // A Jimaku file the local AI translated: the next episode is made ready meanwhile (see prepareNextEpisode).
    if(name==='Jimaku'&&result.engine==='로컬 AI')prepareNextEpisode();
    if(result.fallbackNote)toast(`${result.fallbackNote}${result.fallbackReason?`: ${result.fallbackReason}`:'.'}`);
    if(result.failed)toast(`${result.failed}줄은 번역하지 못해 원문으로 남겼습니다.`);
  }catch(error){if(current()){if(TRANSLATION_CANCELLED.test(ipcMessage(error)))$('#subtitleState').textContent='번역을 멈췄어요. 다시 누르면 멈춘 곳부터 이어서 번역해요.';else{$('#subtitleState').textContent='자동 번역에 실패했습니다.';toast(`자동 번역 실패: ${ipcMessage(error)}`)}}}
  finally{translationButtons.delete(run);translationEpisodes.delete(run);if(translating?.run===run)translating=null;if(button.dataset.run===String(run)){delete button.dataset.run;button.textContent=label}}
}
// Jimaku (Android JIMAKU_USER_SELECTION_V2): the episode's Japanese subtitle files are listed for the user to pick; the
// picked one is applied, saved for the episode and, when set up, translated into Korean right away. Like the Re:Anime /
// Miruro tracks, the list is in the sheet for every episode the app knows the series of: it is loaded when the episode
// starts, once (the automatic Jimaku fallback reads the same list).
function loadJimakuList(){
  const context=currentPlaybackContext,anime=subtitleSearchAnime();
  if(!anime){renderJimaku();return Promise.resolve([])}
  if(!context.jimakuListing){
    // A server switch copies the context while the list may still be loading, so the result goes to whichever context
    // holds this listing now.
    const episode=Number($('#skipEpisode').value)||Number(context.episode?.number)||1,settle=(files,error)=>{for(const target of new Set([context,currentPlaybackContext]))if(target.jimakuListing===listing){target.jimakuFiles=files;target.jimakuError=error}if(currentPlaybackContext.jimakuListing===listing)renderJimaku();return files};
    const listing=window.lilac.jimakuList(anime,episode).then(files=>settle(files,''),error=>settle(null,ipcMessage(error)));
    context.jimakuListing=listing;context.jimakuError='';renderJimaku();
  }
  return context.jimakuListing.then(files=>files||[]);
}
// The Jimaku chip: show the list (loading it if it failed before) and scroll it into view.
async function openJimaku(){
  const context=currentPlaybackContext;if(!subtitleSearchAnime()){toast('작품 정보가 없어 Jimaku를 찾을 수 없습니다.');return}
  if(context.jimakuError){context.jimakuListing=null;context.jimakuError=''}
  $('#jimakuBox').scrollIntoView({block:'nearest'});await loadJimakuList();
}
function renderJimaku(){
  const context=currentPlaybackContext,files=context.jimakuFiles||[];
  $('#jimakuBox').classList.toggle('hidden',!subtitleSearchAnime());
  $('#jimakuState').textContent=!subtitleSearchAnime()?'작품 정보가 없어 찾을 수 없습니다.':context.jimakuError?context.jimakuError:!context.jimakuFiles?'Jimaku에서 찾는 중…':files.length?`${files.length}개 파일`:'이 회차의 파일이 없습니다.';$('#jimakuTranslate').classList.toggle('hidden',!context.jimakuSubtitle);$('#jimakuTranslate').nextElementSibling.classList.toggle('hidden',!context.jimakuSubtitle);
  $('#jimakuList').replaceChildren(...files.map(file=>{const button=document.createElement('button'),selected=context.jimakuFile===file.url;button.type='button';button.className=`track-option${selected?' selected':''}`;button.setAttribute('aria-pressed',String(selected));button.innerHTML=`<span>${escapeHtml(file.name)}</span><small>${escapeHtml(file.name.split('.').pop().toUpperCase())}${file.size?` · ${Math.max(1,Math.round(file.size/1024))}KB`:''}</small>`;button.onclick=()=>applyJimaku(file);return button}));
}
async function applyJimaku(file){
  const context=currentPlaybackContext,requestId=playbackRequestId,episode=Number($('#skipEpisode').value)||Number(context.episode?.number)||1;$('#subtitleState').textContent='Jimaku 자막을 받는 중...';
  try{
    const result=await window.lilac.jimakuDownload(file,subtitleSearchAnime(),episode);if(requestId!==playbackRequestId)return;
    context.jimakuFile=file.url;context.jimakuSubtitle={path:result.path,name:file.name};context.selectedSubtitleTrack=null;currentSubtitlePath=result.path;
    const provider=await jimakuAutoProvider();if(requestId!==playbackRequestId)return;
    attachSubtitle(result.url,'Jimaku 자막',{path:result.path,assUrl:result.assUrl,assPath:result.assPath,fonts:result.fonts,source:'jimaku',notice:provider?JIMAKU_TRANSLATING:''});renderJimaku();renderSubtitleTracks();
    if(provider)translateJimaku(provider);
  }catch(error){if(requestId===playbackRequestId){$('#subtitleState').textContent='Jimaku 자막을 받지 못했습니다.';toast(`Jimaku: ${ipcMessage(error)}`)}}
}
const JIMAKU_TRANSLATING='일본어 자막을 먼저 띄웠어요. 한국어 번역이 끝나면 바로 바뀌어요.';
// 설정 > 자막 자동 번역 > Jimaku 자막 자동 번역: off, the translation API or the local AI (null: off, or neither is set up).
async function jimakuAutoProvider(){
  translationSettings=await window.lilac.geminiSettings().catch(()=>translationSettings);
  const provider=translationSettings?.jimakuTranslate;if(provider!=='cloud'&&provider!=='local')return null;
  if(translationReady('cloud')||translationReady('local'))return provider;
  toast(`${cloudName()} API 키도 로컬 AI 모델도 없어 자동 번역을 건너뛰었습니다. 설정 > 자막 자동 번역에서 준비할 수 있어요.`);return null;
}
// A Jimaku file saved for the episode whose translation never came in (the episode was closed while it ran, the API
// was out of quota): translated again when the episode opens. A finished translation comes from the cache at once,
// and one still running is joined.
async function applySavedJimaku(entry){
  const requestId=playbackRequestId,provider=await jimakuAutoProvider();if(requestId!==playbackRequestId)return;
  currentPlaybackContext.jimakuSubtitle={path:entry.path,name:entry.label};
  currentSubtitlePath=entry.path;attachSubtitle(entry.url,entry.label,{path:entry.path,assUrl:entry.assUrl,assPath:entry.assPath,fonts:entry.fonts,source:entry.source,saved:true,notice:provider?JIMAKU_TRANSLATING:''});renderJimaku();
  if(provider)translateJimaku(provider);
}
// The next episode's Jimaku translation, done by the local AI while this one plays, so it opens in Korean at once
// (skipped when it has a Korean subtitle online). The API is quick enough to need no head start.
function prepareNextEpisode(){
  const next=typeof siblingEpisode==='function'?siblingEpisode(1):null,anime=subtitleSearchAnime();if(!next||!anime)return;
  window.lilac.prepareEpisodeSubtitle({anime,episode:episodeNumberOf(next)||1,title:currentPlaybackContext.subtitleTitle||$('#skipTitle').value.trim()}).catch(()=>{});
}
function translateJimaku(provider='cloud',{fresh=false}={}){const subtitle=currentPlaybackContext.jimakuSubtitle;if(subtitle)runTranslation({file:async()=>subtitle,name:'Jimaku',button:provider==='local'?$('#translateJimakuLocal'):$('#translateJimaku'),provider,fresh})}
$('#translateJimaku').onclick=event=>cancelButtonRun(event.currentTarget)||translateJimaku('cloud',{fresh:takeFreshTranslation()});$('#translateJimakuLocal').onclick=event=>cancelButtonRun(event.currentTarget)||translateJimaku('local',{fresh:takeFreshTranslation()});
$('#translateSubtitle').onclick=event=>cancelButtonRun(event.currentTarget)||translateSubtitleTrack('cloud',{fresh:takeFreshTranslation()});$('#translateSubtitleLocal').onclick=event=>cancelButtonRun(event.currentTarget)||translateSubtitleTrack('local',{fresh:takeFreshTranslation()});
window.lilac.onTranslateProgress(({id,done,total,status})=>{
  const button=translationButtons.get(id),percent=`${Math.round(done/Math.max(1,total)*100)}%`;if(button&&button.dataset.run===String(id))button.textContent=`${status||`번역 중… ${percent}`} · 취소`;
  if(translating?.run===id&&translatingNow())$('#subtitleState').textContent=status?`${status}…`:`${translating.name} 자막을 한국어로 번역하는 중… ${percent}`;
});
async function selectSubtitleTrack(track){
  const requestId=playbackRequestId;$('#subtitleState').textContent=`${track.label} 자막을 불러오는 중...`;
  try{const file=await trackFile(track);if(requestId!==playbackRequestId)return;currentPlaybackContext.selectedSubtitleTrack=track.url;currentSubtitlePath=file.path;localStorage.setItem('subtitleSource','reanime');$('#subtitleSource').value='reanime';syncSettingChoices();renderSubtitleTracks();attachSubtitle(file.url,`${trackSourceLabel()} ${track.label} 자막`,{path:file.path,assUrl:file.assUrl,assPath:file.assPath,fonts:file.fonts,source:'reanime'})}
  catch(e){$('#subtitleState').textContent='자막을 불러오지 못했습니다.';toast(`자막을 불러오지 못했습니다: ${e.message}`)}
}
function formatTime(value){if(!Number.isFinite(value))return '00:00';const seconds=Math.max(0,Math.floor(value)),h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
function syncVolumeUI(){const video=$('#video'),control=$('.volume-control'),slider=$('#playerVolume'),muted=video.muted||video.volume===0;control.classList.toggle('muted',muted);slider.value=String(Math.round(video.volume*100));$('#mutePlayer').setAttribute('aria-label',muted?'음소거 해제':'음소거')}
function playbackDuration(){const video=$('#video');if(Number.isFinite(video.duration)&&video.duration>0)return video.duration;const details=hlsPlayer?.latestLevelDetails||hlsPlayer?.levels?.[hlsPlayer.currentLevel]?.details||hlsPlayer?.levels?.find(level=>level.details)?.details,duration=Number(details?.totalduration);return Number.isFinite(duration)&&duration>0?duration:0}
function applyPendingResume(){if(!pendingResumeProgress)return false;const video=$('#video'),duration=playbackDuration();if(!duration)return false;const target=duration*pendingResumeProgress/100;if(Number.isFinite(target)&&target>0){video.currentTime=Math.min(target,Math.max(0,duration-.5));pendingResumeProgress=0;return true}return false}
function showPlayerControls(){const player=$('#immersivePlayer'),settingsOpen=()=>typeof playerSettingsOpen==='function'&&playerSettingsOpen();if(typeof playerLocked!=='undefined'&&playerLocked)return;player.classList.add('controls-visible');clearTimeout(controlsTimer);if(!$('#video').paused&&!settingsOpen())controlsTimer=setTimeout(()=>{if(!settingsOpen())player.classList.remove('controls-visible')},2000)}
function scheduleOpEdAnalysis(attempt=0){const duration=playbackDuration();if(!duration&&attempt<20){setTimeout(()=>scheduleOpEdAnalysis(attempt+1),500);return}loadOpEdSegments()}
async function loadOpEdSegments(){const title=$('#skipTitle').value.trim(),episode=Number($('#skipEpisode').value)||1,duration=playbackDuration(),analysisKey=`${currentPlaybackContext.currentUrl}:${episode}`;if(!title||!duration||opEdAnalysisKey===analysisKey)return;opEdAnalysisKey=analysisKey;$('#downloadStatus').textContent='OP/ED 구간을 확인하는 중...';try{const currentJob=currentPlaybackContext.episode?jobByRef(episodeRef(currentPlaybackContext.episode)):null,comparison=currentPlaybackContext.offline&&currentJob?downloadedSeries(currentJob).filter(item=>episodeRef(item)!==episodeRef(currentPlaybackContext.episode)):(currentPlaybackContext.comparisonEpisodes||[]);const candidates=await Promise.all(comparison.map(async candidate=>{const job=jobByRef(episodeRef(candidate));if(job?.status!=='completed')return candidate;try{const local=await window.lilac.playDownload(job.id);return {...candidate,localUrl:local.url}}catch{return candidate}}));skipSegments=await window.lilac.opEdSkip({title,episode,duration,currentUrl:currentPlaybackContext.currentUrl,currentHeaders:currentPlaybackContext.streamHeaders||{},candidates,anilistId:currentPlaybackContext.episode?.anilistId||currentPlaybackContext.anime?.anilistId||null,malId:currentPlaybackContext.episode?.malId||currentPlaybackContext.anime?.malId||null,audioAnalysis:localStorage.getItem('opedAudioAnalysis')!=='false',offline:Boolean(currentPlaybackContext.offline),jobId:currentPlaybackContext.episode?jobByRef(episodeRef(currentPlaybackContext.episode))?.id||null:null});$('#downloadStatus').textContent=skipSegments.length?`OP/ED 구간 ${skipSegments.length}개 준비됨`:'OP/ED 구간을 찾지 못했습니다.'}catch(e){skipSegments=[];opEdAnalysisKey=null;$('#downloadStatus').textContent=`OP/ED 분석 실패: ${e.message}`}}
// VTT/SRT/SMI look like Android's mpv text renderer: white text with a black outline and no box, 5% of the
// video height at 100%, bold by default. mpv measures the outline in pixels of a 720-line screen, so it grows
// with the picture. "VTT 원본 스타일" keeps the cue's own italics/bold/colour tags.
let cueFamily="'Malgun Gothic',sans-serif";
function vttVideoHeight(){const video=$('#video'),width=video.clientWidth,height=video.clientHeight;return video.videoWidth&&width&&height?Math.min(height,width*video.videoHeight/video.videoWidth):height||720}
function renderCueStyle(){
  let style=$('#cueStyle');if(!style){style=document.createElement('style');style.id='cueStyle';document.head.append(style)}
  const size=Number(localStorage.getItem('subtitleSize')||100),bold=localStorage.getItem('vttBold')!=='false',keepStyle=localStorage.getItem('vttStyle')!=='false';
  const outline=Math.max(0,Number(localStorage.getItem('vttOutline')??2))*vttVideoHeight()/720;
  const ring=outline?[...Array(16)].map((_,i)=>{const a=i*Math.PI/8;return `${(Math.cos(a)*outline).toFixed(2)}px ${(Math.sin(a)*outline).toFixed(2)}px 0 #000`}).join(','):'none';
  style.textContent=`video::cue{font-family:${cueFamily};font-size:${size}%;font-weight:${bold?'700':'400'};color:#fff;background:transparent;text-shadow:${ring}}${keepStyle?'':'video::cue(i),video::cue(b),video::cue(u),video::cue(c){font-style:normal;font-weight:inherit;text-decoration:none;color:inherit}'}`;
}
async function applyCueStyle(){let family="'Malgun Gothic',sans-serif";const font=await subtitleFontData();if(font){try{const face=new FontFace('LilacSubtitle',font.data);await face.load();[...document.fonts].filter(font=>font.family==='LilacSubtitle').forEach(font=>document.fonts.delete(font));document.fonts.add(face);family="LilacSubtitle,'Malgun Gothic',sans-serif"}catch{}}cueFamily=family;renderCueStyle()}
new ResizeObserver(()=>renderCueStyle()).observe($('#video'));$('#video').addEventListener('loadedmetadata',()=>renderCueStyle());
function syncSettingChoices(){[['titleLanguageChoices','titleLanguage'],['themeChoices','themeSelect'],['sourceChoices','contentSource'],['qualityChoices','defaultQuality'],['playerStartChoices','playerStart'],['subtitleChoices','subtitleSource']].forEach(([group,select])=>$$(`#${group} button`).forEach(button=>button.classList.toggle('selected',button.dataset.value===$(`#${select}`).value)))}
function applyTheme(value){const systemLight=matchMedia('(prefers-color-scheme: light)').matches,wantsLight=value==='light'||(value==='system'&&systemLight);document.body.classList.toggle('light',wantsLight);window.lilac?.setWindowTheme?.(wantsLight)}

// Android HomeScreen (Linkkf): 방영 일정(UP/월~일) + PV·트레일러 / 극장판 / 16+ rails.
const SCHEDULE_TABS=['UP','월','화','수','목','금','토','일'];
let linkkfSchedule=null;
function renderScheduleTab(index){
  $$('#scheduleTabs button').forEach((button,i)=>{button.classList.toggle('selected',i===index);button.setAttribute('aria-selected',String(i===index))});
  const items=index===0?state.season:(linkkfSchedule?.[index-1]||[]);
  if(index>0&&!linkkfSchedule){$('#scheduleRail').classList.add('loading-cards');$('#scheduleRail').replaceChildren();return}
  renderCards('#scheduleRail',items.slice(0,20));
  if(!items.length)$('#scheduleRail').innerHTML='<p class="rail-empty">이 요일에 등록된 작품이 없습니다.</p>';
}
async function loadLinkkfHome(){
  $('#scheduleSection').classList.remove('hidden');$('#seasonTitle').textContent='최신 애니메이션';
  const today=(new Date().getDay()+6)%7+1;let selected=today;
  $('#scheduleTabs').replaceChildren(...SCHEDULE_TABS.map((label,index)=>{const button=document.createElement('button');button.type='button';button.setAttribute('role','tab');button.textContent=label;button.onclick=()=>{selected=index;renderScheduleTab(index)};return button}));
  renderScheduleTab(selected);
  window.lilac.linkkfSchedule().then(days=>{linkkfSchedule=days;renderScheduleTab(selected)}).catch(()=>{linkkfSchedule=[];renderScheduleTab(selected)});
  window.lilac.linkkfSections().then(sections=>{[['pv','#pvSection','#pvRail'],['movie','#movieSection','#movieRail'],['adult16','#adultSection','#adultRail']].forEach(([key,section,rail])=>{const items=sections?.[key]||[];$(section).classList.toggle('hidden',!items.length);if(items.length)renderCards(rail,items)})}).catch(()=>{});
}

// Android SearchScreen (Linkkf): 태그 필터 — 시즌 타입 / 장르 / 연도, one tag per group.
const filterState={format:null,genre:null,year:null,page:1,totalPages:1,loaded:false};
function renderFilterChips(tags){
  [['format',tags.formats],['genre',tags.genres],['year',(tags.years||[]).slice(0,20)]].forEach(([group,list])=>{
    const row=$(`[data-filter-group="${group}"]`);
    row.replaceChildren(...(list||[]).map(tag=>{const button=document.createElement('button');button.type='button';button.textContent=tag.name;button.dataset.id=String(tag.id);button.classList.toggle('selected',filterState[group]===tag.id);button.onclick=()=>{filterState[group]=filterState[group]===tag.id?null:tag.id;row.querySelectorAll('button').forEach(x=>x.classList.toggle('selected',Number(x.dataset.id)===filterState[group]))};return button}));
    if(!list?.length)row.innerHTML='<span class="rail-empty">태그를 불러오지 못했습니다.</span>';
  });
}
async function toggleFilterPanel(){
  const panel=$('#filterPanel'),open=panel.classList.contains('hidden');panel.classList.toggle('hidden',!open);$('#filterToggle').setAttribute('aria-expanded',String(open));
  if(open&&!filterState.loaded){$$('[data-filter-group]').forEach(row=>row.innerHTML='<span class="rail-empty">태그를 불러오는 중...</span>');try{renderFilterChips(await window.lilac.linkkfFilterTags());filterState.loaded=true}catch(e){toast(`태그를 불러오지 못했습니다: ${e.message}`)}}
}
function filterCount(){return ['format','genre','year'].filter(key=>filterState[key]!=null).length}
async function runLinkkfFilter(append=false){
  if(!filterCount()){toast('필터를 하나 이상 선택하세요.');return}
  filterState.page=append?filterState.page+1:1;switchView('search');$('#searchStatus').textContent='필터 결과를 불러오는 중...';$('#filterMore').classList.add('hidden');
  if(!append)$('#searchGrid').replaceChildren();
  try{
    const result=await window.lilac.linkkfFilter({page:filterState.page,limit:40,seasonTypeIds:filterState.format?[filterState.format]:[],genreIds:filterState.genre?[filterState.genre]:[],yearIds:filterState.year?[filterState.year]:[]});
    filterState.totalPages=result.totalPages||1;$('#searchGrid').append(...result.data.map(card));$('#searchGrid').classList.remove('loading-cards');
    $('#searchStatus').textContent=`필터 ${filterCount()}개 · ${result.total||$('#searchGrid').children.length}개 작품`;
    $('#filterMore').classList.toggle('hidden',filterState.page>=filterState.totalPages);$('#filterToggle').textContent=`태그 필터 · ${filterCount()}`;
  }catch(e){$('#searchStatus').textContent=`필터 검색 실패: ${e.message}`}
}

// Android WatchHistoryScreen: select several entries and delete them together.
const historySelection={active:false,keys:new Set()};
function historyKeyOf(item){return item.key||item.src}
function setHistorySelection(active){historySelection.active=active;if(!active)historySelection.keys.clear();$('#historySelectionBar').classList.toggle('hidden',!active);$('#selectHistory').classList.toggle('hidden',active);renderHistory()}
function updateHistorySelectionBar(){$('#historySelectedCount').textContent=`${historySelection.keys.size}개 선택`;$('#historyDeleteSelected').disabled=!historySelection.keys.size}

async function init(){
  // Never restore a stale playback request on a fresh app launch.
  playbackRequestId++;playerWindowFullscreen=false;
  if(state.source==='ohli24'){state.source='linkkf';localStorage.setItem('contentSource','linkkf');}
  // Only the selected source's full catalog loads in the background.
  window.lilac.activateCatalog(state.source).then(renderCatalogIndex).catch(()=>{});
  state.downloads=await window.lilac.downloads();renderDownloads();
  state.history=state.history.filter(item=>!/^http:\/\/127\.0\.0\.1:\d+\/__flix\//i.test(item.src||''));store.set('history',state.history);
  renderContinue(); renderLibrary();
  $('#contentSource').value=state.source;$('#themeSelect').value=localStorage.getItem('theme')||'dark';$('#titleLanguage').value=titleLanguage();const savedSpeed=Number(localStorage.getItem('defaultSpeed')||1),speedIndex=Math.max(0,SPEED_OPTIONS.indexOf(savedSpeed));$('#defaultSpeed').value=String(speedIndex);$('#speed').value=String(savedSpeed);$('#speedLabel').textContent=`${savedSpeed.toFixed(2)}x`;$('#defaultQuality').value=localStorage.getItem('defaultQuality')||'1080p';$('#playerStart').value=localStorage.getItem('playerStart')==='window'?'window':'fullscreen';$('#subtitleSource').value=localStorage.getItem('subtitleSource')||'reanime';$('#subtitleSize').value=localStorage.getItem('subtitleSize')||'100';$('#subtitleSync').value=localStorage.getItem('subtitleSync')||'0';$('#vttBold').checked=localStorage.getItem('vttBold')!=='false';$('#vttOutline').value=localStorage.getItem('vttOutline')||'2';$('#subtitlePosition').value=localStorage.getItem('subtitlePosition')||'12';$('#seekSeconds').value=localStorage.getItem('seekSeconds')||'10';$('#opedAudioAnalysis').checked=localStorage.getItem('opedAudioAnalysis')!=='false';$('#subtitleSizeLabel').textContent=`${$('#subtitleSize').value}%`;$('#subtitleSyncLabel').textContent=`${$('#subtitleSync').value} ms`;$('#outlineLabel').textContent=Number($('#vttOutline').value).toFixed(1);$('#positionLabel').textContent=`${$('#subtitlePosition').value}%`;syncSettingChoices();
  try {
    let season,top;
    if(state.source==='linkkf'){
      try{const linkkf=await window.lilac.linkkfHome(1,20);season=linkkf;top={data:linkkf.data.slice().reverse()};state.catalogPage=2;$('#filterBar').classList.remove('hidden');}
      catch(error){toast('Linkkf 서버가 응답하지 않아 작품 정보 모드로 표시합니다.');[season,top]=await Promise.all([window.lilac.season(),window.lilac.top()]);}
    }else if(PROVIDER_SOURCES.includes(state.source)){
      // The catalog's first page (most popular first) fills 인기 애니메이션 and 전체; this season's shows come separately.
      const current=window.lilac.providerSeason(state.source).catch(()=>null),airing=window.lilac.providerAiring(state.source).catch(()=>null);
      try{season=await window.lilac.providerCatalog(state.source);top={data:season.data};const [result,onAir]=await Promise.all([current,airing]);if(result){state.current=result.data||[];state.currentLabel=result.label}if(onAir?.data?.length)state.airing=onAir.data}
      catch(error){toast(`${state.source} 서버가 응답하지 않아 작품 정보 모드로 표시합니다.`);[season,top]=await Promise.all([window.lilac.season(),window.lilac.top()]);}
    }else [season,top]=await Promise.all([window.lilac.season(),window.lilac.top()]);
    state.season=season.data;state.top=top.data;if(state.source==='reanime'){state.catalogOffset=season.data.length;state.catalogTotal=season.total||null}else if(state.source==='animenosub'){state.catalogOffset=season.nextOffset||2}else if(state.source==='miruro'){state.catalogOffset=season.nextOffset;state.catalogDone=Boolean(season.done)}$('#seasonRail').closest('.content-section').classList.toggle('hidden',Boolean(state.current&&!state.current.length));renderCards('#seasonRail',(state.current||state.season).slice(0,30));$('#airingSection').classList.toggle('hidden',!state.airing?.length);if(state.airing?.length)renderCards('#airingRail',state.airing.slice(0,30));renderCards('#topRail',state.top.slice(0,20));$('#seasonTitle').textContent=state.current?`${state.currentLabel} 신작`:'이번 시즌 신작';if(state.source==='linkkf'&&state.season[0]?.provider==='linkkf')loadLinkkfHome();
    const a=state.current?.[0]||state.season[0]||state.top[0];if(a){const hero=$('#hero'),libraryButton=hero.querySelector('.library-toggle');hero.classList.remove('skeleton');setBackgroundImage(hero,imageOf(a));hero.querySelector('h1').textContent=titleOf(a);titleAnime.set(animeTitleKey(a),a);hero.querySelector('h1').dataset.titleFor=animeTitleKey(a);hero.querySelector('p').textContent=(a.synopsis||'새로운 이야기를 만나보세요.').slice(0,145);hero.querySelector('.primary').onclick=()=>openDetail(a.mal_id);updateLibraryButton(libraryButton,saved(a.mal_id));libraryButton.onclick=e=>toggleLibrary(a,e.currentTarget);}
  } catch(e){$('#seasonRail').classList.remove('loading-cards');$('#topRail').classList.remove('loading-cards');toast('목록을 불러오지 못했습니다. 인터넷 연결을 확인하세요.');}
}

$$('.nav').forEach(b=>b.onclick=()=>switchView(b.dataset.view));$$('[data-goto]').forEach(b=>b.onclick=()=>switchView(b.dataset.goto));
// 홈 > "2026 가을 신작" / "방영 중" > 전체 보기: the whole list in the search view.
function showHomeList(list,label){switchView('search');if(!list?.length)return;$('#pageSearch').value='';$('#filterMore')?.classList.add('hidden');renderCards('#searchGrid',list);$('#searchStatus').textContent=`${label} ${list.length}개 · 인기순`}
$('#seeAllSeason').onclick=()=>showHomeList(state.current,`${state.currentLabel} 신작`);
$('#seeAllAiring').onclick=()=>showHomeList(state.airing,'방영 중');
$$('[data-library-tab]').forEach(button=>button.onclick=()=>{$$('[data-library-tab]').forEach(x=>x.classList.toggle('selected',x===button));$('#savedLibraryPanel').classList.toggle('hidden',button.dataset.libraryTab!=='saved');$('#downloadsPanel').classList.toggle('hidden',button.dataset.libraryTab!=='downloads')});
$('#openDownloadFolder').onclick=()=>window.lilac.openDownloadsFolder();
window.lilac.onDownloadsChanged(downloads=>{state.downloads=downloads;renderDownloads()});
$('#globalSearch').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch(e.target.value)});$('#pageSearch').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch(e.target.value)});$('#searchButton').onclick=()=>doSearch($('#pageSearch').value);
applyTheme(localStorage.getItem('theme')||'dark');
$('#openVideo').onclick=async()=>{const src=await window.lilac.chooseVideo();if(src)play(src,decodeURIComponent(src.split('/').pop()))};$('#playUrl').onclick=()=>{const url=$('#streamUrl').value.trim();if(/^https?:\/\//i.test(url))play(url,'직접 스트림');else toast('올바른 https 영상 주소를 입력하세요.')};
$('#openSubtitle').onclick=async()=>{const file=await window.lilac.chooseSubtitleDetails();if(!file)return;currentSubtitlePath=file.path;attachSubtitle(file.url,'사용자 자막',{path:file.path,assUrl:file.assUrl,assPath:file.assPath,fonts:file.fonts,source:'user'})};
$('#findSubtitle').onclick=async()=>{const title=$('#skipTitle').value.trim(),episode=Number($('#skipEpisode').value)||1;if(!title){toast('작품명을 확인하지 못했습니다.');return;}$('#downloadStatus').textContent='온라인 자막을 찾는 중...';currentPlaybackContext.selectedSubtitleTrack=null;renderSubtitleTracks();onlineSubtitleSearch=null;const found=await ensureSubtitle(null,title,episode,{skipSaved:true});$('#downloadStatus').textContent=found?'자막 적용 완료':'자막을 찾지 못했습니다.'};
$('#miniPlayer').onclick=()=>togglePictureInPicture();
$('#togglePlayer').onclick=()=>{$('#video').paused?$('#video').play():$('#video').pause()};
$('#mutePlayer').onclick=()=>{const video=$('#video'),wasMuted=video.muted||video.volume===0;if(wasMuted&&video.volume===0){video.volume=.5;localStorage.setItem('playerVolume','.5')}video.muted=!wasMuted;localStorage.setItem('playerMuted',String(video.muted));syncVolumeUI()};
$('#playerVolume').oninput=e=>{const video=$('#video');video.volume=Number(e.target.value)/100;video.muted=video.volume===0;localStorage.setItem('playerVolume',String(video.volume));localStorage.setItem('playerMuted',String(video.muted));syncVolumeUI();showPlayerControls()};
$('#video').addEventListener('volumechange',syncVolumeUI);
$('#rewindPlayer').onclick=()=>{const seconds=Number(localStorage.getItem('seekSeconds')||10);$('#video').currentTime=Math.max(0,$('#video').currentTime-seconds)};
$('#forwardPlayer').onclick=()=>{const seconds=Number(localStorage.getItem('seekSeconds')||10);$('#video').currentTime=Math.min($('#video').duration||Infinity,$('#video').currentTime+seconds)};
$('#playerSeek').oninput=e=>{const video=$('#video'),duration=playbackDuration();if(duration)video.currentTime=duration*Number(e.target.value)/1000};
$('#fullscreenPlayer').onclick=async()=>{try{playerWindowFullscreen=!playerWindowFullscreen;setPlayerWindowed();await window.lilac.setPlayerFullscreen(playerWindowFullscreen)}catch(e){toast(`전체 화면 오류: ${e.message}`)}};
$('#playerBack').onclick=async()=>{saveHistorySoon();playbackRequestId++;window.LilacAss?.destroy();playerWindowFullscreen=false;setPlayerWindowed();setPlayerLocked(false);openPlayerSettings(false);await window.lilac.setPlayerFullscreen(false);$('#video').pause();renderContinue();renderHistory();switchView(viewBeforePlayer)};
$('#subtitleEnabled').onchange=e=>{const track=$('#video').textTracks[0];setVttVisible();window.LilacAss?.setVisible(e.target.checked)};
['mousedown','touchstart'].forEach(type=>$('#immersivePlayer').addEventListener(type,event=>{if(event.target!==$('#video'))showPlayerControls()},{passive:true}));
$('#video').addEventListener('click',()=>{const player=$('#immersivePlayer');if(playerLocked){flashUnlockButton();return}if(playerSettingsOpen()){openPlayerSettings(false);return}if(player.classList.contains('controls-visible')){clearTimeout(controlsTimer);player.classList.remove('controls-visible')}else showPlayerControls()});
$('#downloadVideo').onclick=async()=>{const url=$('#streamUrl').value.trim();if(!/^https?:\/\//i.test(url)){toast('다운로드 가능한 영상 URL이 없습니다.');return;}$('#downloadStatus').textContent='저장 위치를 선택하세요.';try{const saved=await window.lilac.downloadMedia(url,`${($('#playerTitle').textContent||'episode').replace(/[<>:"/\\|?*]/g,'_')}.mp4`);$('#downloadStatus').textContent=saved?'다운로드 완료':'다운로드 취소';}catch(e){$('#downloadStatus').textContent=`다운로드 실패: ${e.message}`}};
window.lilac.onDownloadProgress(({percent,received})=>{$('#downloadStatus').textContent=percent==null?`${Math.round(received/1048576)} MB 다운로드 중`:`${percent}% 다운로드 중`});
window.lilac.onOpEdStatus(message=>{$('#downloadStatus').textContent=`OP/ED · ${message}`});
$('#loadSkip').onclick=loadOpEdSegments;
$('#skipNow').onclick=()=>{if(activeSkip){$('#video').currentTime=activeSkip.endTime;activeSkip=null;activeSkipKey=null;$('#skipNow').classList.add('hidden')}};
$('#speed').onchange=e=>$('#video').playbackRate=Number(e.target.value);$('.dialog-close').onclick=()=>$('#detailDialog').close();$('#detailDialog').addEventListener('click',e=>{if(e.target===$('#detailDialog'))$('#detailDialog').close()});
$('#contentSource').onchange=e=>{localStorage.setItem('contentSource',e.target.value);window.lilac.activateCatalog(e.target.value).then(renderCatalogIndex).catch(()=>{});syncSettingChoices();toast('콘텐츠 소스를 저장했습니다. 앱을 다시 시작하면 적용됩니다.')};$('#titleLanguage').onchange=e=>{localStorage.setItem('titleLanguage',e.target.value);syncSettingChoices();refreshTitleElements();toast(e.target.value==='en'?'작품 제목을 영어로 표시합니다.':'작품 제목을 한국어로 표시합니다.')};$('#themeSelect').onchange=e=>{localStorage.setItem('theme',e.target.value);applyTheme(e.target.value);syncSettingChoices()};$('#defaultSpeed').oninput=e=>{const value=SPEED_OPTIONS[Number(e.target.value)]||1;localStorage.setItem('defaultSpeed',String(value));$('#speed').value=String(value);$('#speedLabel').textContent=`${value.toFixed(2)}x`};
['defaultQuality','playerStart','subtitleSource'].forEach(id=>$(`#${id}`).onchange=e=>{localStorage.setItem(id,e.target.value);syncSettingChoices()});[['titleLanguageChoices','titleLanguage'],['themeChoices','themeSelect'],['sourceChoices','contentSource'],['qualityChoices','defaultQuality'],['playerStartChoices','playerStart'],['subtitleChoices','subtitleSource']].forEach(([group,select])=>$$(`#${group} button`).forEach(button=>button.onclick=()=>{const target=$(`#${select}`);target.value=button.dataset.value;target.dispatchEvent(new Event('change'))}));$('#subtitleSize').oninput=e=>{localStorage.setItem('subtitleSize',e.target.value);$('#subtitleSizeLabel').textContent=`${e.target.value}%`;applyCueStyle()};$('#subtitleSync').oninput=e=>{localStorage.setItem('subtitleSync',e.target.value);window.LilacAss?.setOffset(Number(e.target.value));applyVttLayout();$('#subtitleSyncLabel').textContent=`${e.target.value} ms`};$$('[data-sync]').forEach(button=>button.onclick=()=>{const current=Number($('#subtitleSync').value),delta=Number(button.dataset.sync),next=delta===0?0:Math.max(-5000,Math.min(5000,current+delta));$('#subtitleSync').value=String(next);$('#subtitleSync').dispatchEvent(new Event('input'))});$('#vttBold').onchange=e=>{localStorage.setItem('vttBold',String(e.target.checked));applyCueStyle()};$('#vttOutline').oninput=e=>{localStorage.setItem('vttOutline',e.target.value);applyCueStyle();$('#outlineLabel').textContent=Number(e.target.value).toFixed(1)};$('#subtitlePosition').oninput=e=>{localStorage.setItem('subtitlePosition',e.target.value);applyVttLayout();$('#positionLabel').textContent=`${e.target.value}%`};$('#seekSeconds').onchange=e=>localStorage.setItem('seekSeconds',String(Math.max(1,Number(e.target.value)||10)));['clearOpEdAnalysis','clearOpEdFingerprint','clearOpEdAll'].forEach(id=>$(`#${id}`).onclick=async()=>{await window.lilac.clearOpEd();opEdAnalysisKey=null;skipSegments=[];toast('OP/ED 분석 데이터를 삭제했습니다.')});
$('#video').addEventListener('timeupdate',e=>{applyPendingResume();const v=e.currentTarget,duration=playbackDuration();$('#playerSeek').value=duration?Math.round(v.currentTime/duration*1000):0;$('#playerTime').textContent=`${formatTime(v.currentTime)} / ${formatTime(duration)}`;activeSkip=skipSegments.find(x=>v.currentTime>=x.startTime&&v.currentTime<x.endTime)||null;activeSkipKey=activeSkip?`${activeSkip.type}:${activeSkip.startTime}:${activeSkip.endTime}`:null;updateSkipState(v);if(activeSkip){const type=activeSkip.type.toLowerCase();$('#skipNow span').textContent=type==='recap'?'요약 스킵':type.includes('ed')?'ED 스킵':'OP 스킵'}if(!duration||!currentHistoryKey)return;const item=state.history.find(x=>(x.key||x.src)===currentHistoryKey);if(!item)return;item.progress=Math.max(0,Math.min(100,Math.round(v.currentTime/duration*100)));item.updated=Date.now();if(Date.now()-(saveHistorySoon.last||0)>5000)saveHistorySoon();const card=$$('.continue-card').find(x=>x.dataset.historyKey===currentHistoryKey);if(card){card.querySelector('.history-progress i').style.width=`${item.progress}%`;card.querySelector(':scope > span').textContent=`EP.${item.episode?.number||1} · ${item.progress}%`}});
$('#video').addEventListener('playing',()=>{$('#immersivePlayer').classList.add('is-playing');$('#playerEmpty').classList.add('hidden');showPlayerControls()});
// Progress is saved every few seconds while playing, and right away on pause and when leaving the player.
function saveHistorySoon(){saveHistorySoon.last=Date.now();store.set('history',state.history)}
$('#video').addEventListener('pause',()=>{saveHistorySoon();$('#immersivePlayer').classList.remove('is-playing');showPlayerControls()});
$('#video').addEventListener('waiting',()=>{$('#playerEmpty').classList.remove('hidden')});
$('#video').addEventListener('canplay',()=>{$('#playerEmpty').classList.add('hidden');applyPendingResume()});
$('#video').addEventListener('ended',()=>{const next=siblingEpisode(1);if(!next){$('#downloadStatus').textContent='마지막 회차입니다.';showPlayerControls();return}if(!playerFlag('playerAutoPlay')){$('#downloadStatus').textContent='재생이 끝났습니다.';showPlayerControls();return}playSiblingEpisode(next)});
$('#video').addEventListener('loadedmetadata',()=>{applyPendingResume();scheduleOpEdAnalysis()});
$('#video').addEventListener('durationchange',applyPendingResume);
$('#filterToggle').onclick=toggleFilterPanel;$('#filterApply').onclick=()=>{$('#filterPanel').classList.add('hidden');$('#filterToggle').setAttribute('aria-expanded','false');runLinkkfFilter()};$('#filterReset').onclick=()=>{filterState.format=filterState.genre=filterState.year=null;$$('[data-filter-group] button').forEach(x=>x.classList.remove('selected'));$('#filterToggle').textContent='태그 필터'};$('#filterMore').onclick=()=>runLinkkfFilter(true);
$('#opedAudioAnalysis').onchange=e=>localStorage.setItem('opedAudioAnalysis',String(e.target.checked));
$('#selectHistory').onclick=()=>setHistorySelection(true);$('#historyCancelSelect').onclick=()=>setHistorySelection(false);$('#historySelectAll').onclick=()=>{state.history.forEach(item=>historySelection.keys.add(historyKeyOf(item)));renderHistory()};$('#historyDeleteSelected').onclick=()=>{const count=historySelection.keys.size;if(!count)return;state.history=state.history.filter(item=>!historySelection.keys.has(historyKeyOf(item)));store.set('history',state.history);setHistorySelection(false);renderContinue();toast(`${count}개 시청 기록을 삭제했습니다.`)};
const setAssEffects=enabled=>{localStorage.setItem('assEffects',String(enabled));syncAssEffectsUI();if(currentSubtitle?.assUrl){renderAssSubtitle();$('#subtitleState').textContent=`${currentSubtitle.label} 적용됨${enabled?' · ASS 효과':''}`}};$('#assEffectsSheet').onchange=e=>setAssEffects(e.target.checked);
$$('#fontChoices button').forEach(button=>button.onclick=()=>{localStorage.setItem('subtitleFont',button.dataset.value);localStorage.removeItem('subtitleFontPath');subtitleFontChanged()});$('#chooseSubtitleFont').onclick=async()=>{const file=await window.lilac.chooseFont();if(!file)return;localStorage.setItem('subtitleFontPath',file);subtitleFontChanged();toast('자막 폰트를 적용했습니다.')};$('#resetSubtitleFont').onclick=()=>{localStorage.removeItem('subtitleFontPath');subtitleFontChanged()};syncAssEffectsUI();syncSubtitleFontUI();
$('#reloadSubtitleTracks').onclick=()=>{currentPlaybackContext.subtitleTracks=[];loadMissingSubtitleTracks()};
$('#clearHistory').onclick=()=>{state.history=[];store.set('history',[]);renderHistory();toast('시청 기록을 삭제했습니다.')};
document.querySelector('main').addEventListener('scroll',event=>{const main=event.currentTarget;if($('#allView').classList.contains('active')&&main.scrollTop+main.clientHeight>=main.scrollHeight-700)loadFullCatalog()});
applyCueStyle();
// Keep one continue card per anime, always the most recently updated episode.
function latestHistoryByAnime(items){const seen=new Set();return items.filter(item=>{const key=item.anime?.mal_id||item.anime?.id||item.subtitleTitle||item.name.split(' · ')[0];if(seen.has(key))return false;seen.add(key);return true;});}
function renderContinue(){const section=$('#continueSection'),rail=$('#continueRail'),latest=latestHistoryByAnime(state.history);section.classList.toggle('hidden',!latest.length);rail.replaceChildren(...latest.slice(0,6).map(h=>{const el=document.createElement('article'),image=historyImage(h),episode=h.episode?.number||h.name.match(/(?:·|EP\.?)\D*(\d+)/i)?.[1]||1;el.className='continue-card';el.dataset.historyKey=h.key||h.src;el.innerHTML=`<div class="continue-thumb"${image?` style="background-image:url('${image}')"`:''}><span class="continue-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6Z"/></svg></span><div class="history-progress"><i style="width:${Math.max(0,Math.min(100,h.progress||0))}%"></i></div></div><b ${h.anime?titleAttr(h.anime):''}>${escapeHtml(storedTitle(h))}</b><span>EP.${escapeHtml(String(episode))} · ${Math.max(0,Math.min(100,h.progress||0))}%</span>`;el.onclick=()=>playHistoryItem(h);return el;}));}
init();
// GitHub release auto update: banner + settings controls.
let updateBannerDismissed=false;
function renderUpdate(state={}){
  const status=$('#updateStatus'),apply=$('#applyUpdate'),banner=$('#updateBanner'),text=$('#updateBannerText'),action=$('#updateBannerAction');
  const messages={idle:`현재 버전 ${state.current||''}`,checking:'업데이트를 확인하는 중...',latest:`최신 버전입니다. (v${state.current})`,available:`새 버전 v${state.latest}을 사용할 수 있습니다.`,downloading:`v${state.latest} 다운로드 중${state.percent!=null?` ${state.percent}%`:''}`,ready:`v${state.latest} 설치 준비 완료 · 설치하면 앱이 다시 시작됩니다.`,error:`업데이트 실패: ${state.error||'알 수 없는 오류'}`};
  status.textContent=messages[state.status]||'';
  apply.classList.toggle('hidden',!['available','ready','downloading'].includes(state.status));apply.disabled=state.status==='downloading';apply.textContent=state.status==='ready'?'지금 설치':'업데이트 다운로드';
  const show=['available','downloading','ready'].includes(state.status)&&!updateBannerDismissed;banner.classList.toggle('hidden',!show);
  if(show){text.textContent=messages[state.status];action.textContent=state.status==='ready'?'지금 설치':state.status==='downloading'?'다운로드 중':'업데이트';action.disabled=state.status==='downloading'}
}
async function runUpdateAction(){const state=await window.lilac.updateState();try{if(state.status==='ready')await window.lilac.installUpdate();else if(state.status==='available')await window.lilac.downloadUpdate()}catch(e){toast(`업데이트 실패: ${e.message}`)}}
$('#checkUpdate').onclick=async()=>{updateBannerDismissed=false;const state=await window.lilac.checkUpdate();if(state.status==='latest')toast('최신 버전입니다.')};
$('#applyUpdate').onclick=runUpdateAction;$('#updateBannerAction').onclick=runUpdateAction;$('#updateBannerClose').onclick=()=>{updateBannerDismissed=true;$('#updateBanner').classList.add('hidden')};
// TMDB key (설정 > 한국어 제목 검색): the user's own key overrides the bundled one.
function renderTmdbState(value,message){$('#tmdbKey').value=value?.key||'';$('#tmdbKeyState').textContent=message||(value?.key?'TMDB API 키를 사용 중입니다.':'키가 없으면 AniList·Wikidata로만 찾아서 못 찾는 작품이 많습니다. themoviedb.org 설정 > API에서 발급한 키를 넣어 주세요.')}
window.lilac.tmdbKey().then(value=>renderTmdbState(value)).catch(()=>{});
// Progress of the catalog Korean title indexes (main process).
function renderCatalogIndex(value){
  if(!value?.sources)return;const step={catalog:'목록 받는 중',wikidata:'Wikidata 확인 중',waiting:'TMDB 대기 중',tmdb:'TMDB로 찾는 중',error:'목록을 받지 못했어요. 30분마다 다시 시도해요'};
  const lines=value.sources.map(source=>source.total?(source.korean==null?`${source.label} 전체 ${source.total.toLocaleString()}개를 불러왔어요`:`${source.label} ${source.total.toLocaleString()}개 중 ${source.korean.toLocaleString()}개의 한국어 제목을 알고 있어요`)+(step[source.status]?` (${step[source.status]}…)`:''):step[source.status]?`${source.label} ${step[source.status]}…`:'').filter(Boolean);
  const needsTmdb=!value.tmdb&&value.sources.some(source=>source.korean!=null);
  $('#reanimeIndexState').textContent=lines.length?`${lines.join(' · ')}${needsTmdb?' — TMDB 키를 넣으면 나머지도 찾아요.':''}`:'';
}
window.lilac.onCatalogIndexState(renderCatalogIndex);window.lilac.catalogIndexState().then(renderCatalogIndex).catch(()=>{});
// 번역 API (Gemini, OpenAI, DeepL or Qwen, as in the Android app): each one's key, checked when saved, and its model
// (Gemini, OpenAI and Qwen list the models the key can use). Only the picked API's settings are shown.
const CLOUD_FIELDS={
  gemini:{name:'Gemini',key:'key',model:'model',models:'models',id:'gemini',empty:'aistudio.google.com에서 발급한 API 키를 넣어 주세요.'},
  openai:{name:'OpenAI',key:'openaiKey',model:'openaiModel',models:'openaiModels',id:'openai',empty:'platform.openai.com에서 발급한 API 키를 넣어 주세요.'},
  deepl:{name:'DeepL',key:'deeplKey',id:'deepl',empty:'deepl.com에서 발급한 API 키를 넣어 주세요. 무료 키(끝이 :fx)도 됩니다.'},
  qwen:{name:'Qwen',key:'qwenKey',model:'qwenModel',models:'qwenModels',id:'qwen',empty:'Alibaba Cloud Model Studio에서 발급한 API 키를 넣어 주세요.'}
};
function renderTranslationSettings(value,message,messageFor){
  translationSettings=value||translationSettings;renderLocalAi(value);if(!value)return;
  $('#geminiDownloads').checked=value.translateDownloads===true;$$('#jimakuTranslateChoices button').forEach(button=>button.classList.toggle('selected',button.dataset.value===(value.jimakuTranslate||'off')));
  $$('#cloudChoices button').forEach(button=>button.classList.toggle('selected',button.dataset.value===value.cloud));$$('.cloud-block').forEach(block=>block.classList.toggle('hidden',block.dataset.cloud!==value.cloud));
  $$('#qwenRegionChoices button').forEach(button=>button.classList.toggle('selected',button.dataset.value===value.qwenRegion));
  for(const field of Object.values(CLOUD_FIELDS)){
    $(`#${field.id}Key`).value=value[field.key]||'';
    if(field.model){const select=$(`#${field.id}Model`),models=value[field.models]||[];select.replaceChildren(...models.map(name=>{const option=document.createElement('option');option.value=name;option.textContent=name;return option}));select.value=value[field.model]||'';select.disabled=!models.length}
    $(`#${field.id}KeyState`).textContent=(messageFor===field.id&&message)||(value[field.key]?`${field.name} API 키를 사용 중입니다${field.model&&value[field.model]?` (${value[field.model]})`:''}.`:field.empty);
  }
  // The player's API buttons carry the picked API's name.
  const label=`${value.cloudName}${value.cloudRo} 한국어 번역`;
  ['#translateSubtitle','#translateJimaku'].forEach(id=>{const button=$(id);button.dataset.label=label;if(!button.dataset.run)button.textContent=label});
}
window.lilac.geminiSettings().then(value=>renderTranslationSettings(value)).catch(()=>{});
async function saveCloudKey(cloud){
  const field=CLOUD_FIELDS[cloud],button=$(`#save${field.id[0].toUpperCase()+field.id.slice(1)}Key`),state=$(`#${field.id}KeyState`);button.disabled=true;state.textContent='키를 확인하는 중...';
  try{
    const change={[field.key]:$(`#${field.id}Key`).value};if(field.model&&$(`#${field.id}Model`).value)change[field.model]=$(`#${field.id}Model`).value;
    const value=await window.lilac.setGeminiSettings(change);renderTranslationSettings(value,value[field.key]?`키를 확인하고 저장했습니다${field.model&&value[field.model]?` (${value[field.model]})`:''}.`:undefined,cloud);toast(`${field.name} 설정을 저장했습니다.`);
  }catch(error){state.textContent=`저장하지 못했습니다: ${ipcMessage(error)}`}
  finally{button.disabled=false}
}
for(const cloud of Object.keys(CLOUD_FIELDS)){
  const field=CLOUD_FIELDS[cloud];$(`#save${field.id[0].toUpperCase()+field.id.slice(1)}Key`).onclick=()=>saveCloudKey(cloud);
  if(field.model)$(`#${field.id}Model`).onchange=()=>saveTranslation({[field.model]:$(`#${field.id}Model`).value});
}
$$('#cloudChoices button').forEach(button=>button.onclick=()=>saveTranslation({cloud:button.dataset.value}));
$$('#qwenRegionChoices button').forEach(button=>button.onclick=()=>saveTranslation({qwenRegion:button.dataset.value}));
$('#geminiDownloads').onchange=()=>saveTranslation({translateDownloads:$('#geminiDownloads').checked});
// 자막 캐시: how much the subtitle files take, and how much of it no saved subtitle uses.
const megabytes=bytes=>bytes>=1e9?`${(bytes/1e9).toFixed(1)}GB`:`${Math.max(bytes?0.1:0,bytes/1e6).toFixed(1)}MB`;
async function renderSubtitleCache(message){try{const usage=await window.lilac.subtitleCacheUsage();$('#subtitleCacheState').textContent=`${message?`${message} `:''}자막 파일 ${megabytes(usage.total)} 중 ${megabytes(usage.removable)}를 지울 수 있어요.`;$('#cleanSubtitleCache').disabled=!usage.removable}catch{$('#subtitleCacheState').textContent='자막 파일 용량을 확인하지 못했습니다.'}}
$('#cleanSubtitleCache').onclick=async()=>{const button=$('#cleanSubtitleCache');button.disabled=true;try{const result=await window.lilac.cleanSubtitleCache();renderSubtitleCache(`파일 ${result.removed}개(${megabytes(result.bytes)})를 지웠어요.`)}catch(error){toast(`지우지 못했습니다: ${ipcMessage(error)}`);button.disabled=false}};
// 번역 방식 (번역 API / 로컬 AI) and the local models: presets downloaded with progress, or a GGUF file added from disk.
const localModelProgress={};
async function saveTranslation(change){try{renderTranslationSettings(await window.lilac.setGeminiSettings(change))}catch(error){toast(`저장하지 못했습니다: ${ipcMessage(error)}`)}}
// Where the model last ran: all of it on the graphics card, part of it (the CPU sets the pace), or the CPU alone.
const localRunText=run=>run.layers?`마지막 실행: ${run.device||'그래픽카드'} · ${run.layers}/${run.total}층${run.layers<run.total?' (나머지는 CPU라 느림)':''}`:`마지막 실행: CPU만 사용${run.reason?` (${run.reason})`:''}`;
const lowMemoryQuestion=(model,verb)=>`${model.label}은 램이 ${model.ram}GB 이상 필요한데 이 PC는 ${model.memory}GB예요. 번역이 아주 느리거나 PC가 멈출 수 있어요. 그래도 ${verb}?`;
function renderLocalAi(value){
  if(!value)return;
  $('#localModelList').replaceChildren(...(value.localModels||[]).map(model=>{
    // Only a model on disk can be in use; one not downloaded yet shows what it needs instead.
    const row=document.createElement('div'),progress=localModelProgress[model.id],selected=model.installed&&model.id===value.localModel;row.className=`local-model${selected?' selected':''}`;
    const state=selected?'사용 중':model.installed?'받음 · 눌러서 사용':progress!=null?'받는 중':'받지 않음';
    const memoryNote=model.lowMemory?`<small class="local-model-run partial">이 PC의 램 ${model.memory}GB로는 부족해요 (${model.ram}GB 이상). 번역이 아주 느리거나 PC가 멈출 수 있어요.</small>`:'';
    row.innerHTML=`<button type="button" class="local-model-pick"><b>${escapeHtml(model.label)}</b><small>${escapeHtml(model.note||'')}</small>${memoryNote}${model.installed&&model.run?`<small class="local-model-run${model.run.layers<model.run.total||!model.run.layers?' partial':''}">${escapeHtml(localRunText(model.run))}</small>`:''}</button><span class="local-model-state">${state}</span><button type="button" class="local-model-action"></button>`;
    const pick=row.querySelector('.local-model-pick'),action=row.querySelector('.local-model-action');pick.disabled=!model.installed||selected;pick.onclick=()=>{if(!model.lowMemory||confirm(lowMemoryQuestion(model,'쓸까요')))saveTranslation({localModel:model.id})};
    // While it downloads the button stops it; a stopped (or broken off) download goes on from where it was.
    if(progress!=null){action.textContent=`받는 중 ${progress}% · 취소`;action.onclick=()=>window.lilac.cancelLocalModelInstall(model.id)}
    else if(model.installed){action.textContent=model.path?'목록에서 빼기':'삭제';action.onclick=async()=>{if(!confirm(`${model.label} 모델을 ${model.path?'목록에서 뺄까요':'삭제할까요'}?`))return;renderTranslationSettings(await window.lilac.removeLocalModel(model.id))}}
    else{action.textContent=model.partial?`이어 받기 · ${Math.round(model.partial/model.size*100)}% 받음`:`받기 · ${(model.size/1e9).toFixed(1)}GB`;action.onclick=()=>{if(!model.lowMemory||confirm(lowMemoryQuestion(model,'받을까요')))installLocalModel(model.id)}}
    return row;
  }));
}
async function installLocalModel(id){
  localModelProgress[id]=0;renderLocalAi(translationSettings);
  try{const value=await window.lilac.installLocalModel(id);delete localModelProgress[id];const model=(value.localModels||[]).find(item=>item.id===id);renderTranslationSettings(await window.lilac.setGeminiSettings({localModel:id}));toast(`${model?.label||'모델'}을 받았습니다.`)}
  catch(error){delete localModelProgress[id];renderTranslationSettings(await window.lilac.geminiSettings().catch(()=>translationSettings));toast(/받기를 멈췄습니다/.test(ipcMessage(error))?ipcMessage(error):`모델을 받지 못했습니다: ${ipcMessage(error)}`)}
}
window.lilac.onLocalModelProgress(({id,done,total,finished,error})=>{if(finished||error)return;const percent=Math.floor(done/Math.max(1,total)*100);if(localModelProgress[id]!==percent){localModelProgress[id]=percent;renderLocalAi(translationSettings)}});
$$('#jimakuTranslateChoices button').forEach(button=>button.onclick=()=>saveTranslation({jimakuTranslate:button.dataset.value}));
$('#addLocalModel').onclick=async()=>{try{const value=await window.lilac.addLocalModelFile();if(value)renderTranslationSettings(value)}catch(error){toast(ipcMessage(error))}};
$('#saveTmdbKey').onclick=async()=>{const button=$('#saveTmdbKey');button.disabled=true;$('#tmdbKeyState').textContent='키를 확인하는 중...';try{const value=await window.lilac.setTmdbKey($('#tmdbKey').value);renderTmdbState(value,value.key?'키를 확인하고 저장했습니다.':undefined);toast('TMDB 설정을 저장했습니다.')}catch(e){$('#tmdbKeyState').textContent=`저장하지 못했습니다: ${String(e.message||e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')}`}finally{button.disabled=false}};
window.lilac.onUpdateState(renderUpdate);window.lilac.updateState().then(value=>{$('#appVersion').textContent=`Version ${value.current}`;renderUpdate(value);showChangelogIfUpdated(value.current)});
// Release notes (GitHub Markdown) as plain HTML: headings, lists, paragraphs, bold, code and https links.
function releaseNotesHtml(text){
  const inline=value=>escapeHtml(value).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/\[([^\]]+)\]\((https:\/\/[^)\s"'<>]+)\)/g,'<a href="$2" data-external>$1</a>');
  let html='',list=false;const close=()=>{if(list){html+='</ul>';list=false}};
  for(const raw of String(text||'').replace(/\r/g,'').split('\n')){
    const line=raw.trimEnd(),heading=line.match(/^#{1,6}\s+(.*)/),item=line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)/);
    if(heading){close();html+=`<h4>${inline(heading[1])}</h4>`}
    else if(item){if(!list){html+='<ul>';list=true}html+=`<li>${inline(item[1])}</li>`}
    else if(!line.trim())close();
    else{close();html+=`<p>${inline(line)}</p>`}
  }
  close();return html;
}
// Shown once on the first start of each version, a fresh install included.
async function showChangelogIfUpdated(version){
  let seen=null;try{seen=localStorage.getItem('lastSeenVersion');localStorage.setItem('lastSeenVersion',version)}catch{return}
  if(seen===version)return;
  const data=await window.lilac.updateNotes().catch(()=>null),dialog=$('#changelogDialog');
  $('#changelogTitle').textContent=`v${version} 변경 사항`;
  // Release texts start with their own "## v0.3.19" heading, which the dialog title already says.
  const notes=String(data?.notes||'').replace(/^\s*#{1,6}\s*v?\d+(?:\.\d+)+\s*(?:\n|$)/,'').trim();
  $('#changelogBody').innerHTML=notes?releaseNotesHtml(notes):'<p>변경 사항을 불러오지 못했어요. GitHub 릴리스에서 확인할 수 있어요.</p>';
  $('#changelogLink').classList.toggle('hidden',!data?.url);$('#changelogLink').onclick=()=>window.lilac.openExternal(data.url);
  if(!dialog.open)dialog.showModal();
}
$('#changelogClose').onclick=()=>$('#changelogDialog').close();
$('#changelogBody').addEventListener('click',event=>{const link=event.target.closest('a[data-external]');if(link){event.preventDefault();window.lilac.openExternal(link.href)}});
