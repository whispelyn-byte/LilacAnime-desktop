const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const zlib = require('zlib');
const cheerio = require('cheerio');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { createFlixProxyUrl, createFlixAvProxyUrl, closeFlixProxy } = require('./flix-proxy.cjs');
const { detectOpEd } = require('./oped-fingerprint.cjs');
const { DownloadManager } = require('./download-manager.cjs');
const { Updater } = require('./updater.cjs');
const { SubtitleStore } = require('./subtitle-store.cjs');
const { createTranslator } = require('./subtitle-translator.cjs');
let subtitleTranslator = null;
const translator = () => subtitleTranslator ||= createTranslator(app.getPath('userData'));

app.commandLine.appendSwitch('disable-blink-features','AutomationControlled');
// Android BackgroundAudioService: playback continues while the window is hidden or minimized.
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.setAppUserModelId('com.lilac.anime.desktop');
let mainWindow = null;
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    else if (app.isReady()) createWindow();
  });
}

const API = 'https://api.jikan.moe/v4';
const LINKKF_API = 'https://linkkf1.5imgdarr.top/api';
const LINKKF_EPISODE_API = 'https://linkkfep1.5imgdarr.top';
const LINKKF_WEB = 'https://linkkf.app';
const LINKKF_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome||'131.0.0.0'} Safari/537.36`;
const REANIME_WEB = 'https://reanime.to';
const ANIMENOSUB_WEB = 'https://animenosub.to';
const MIRURO_WEB = 'https://www.miruro.to';
const ANDROID_WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const resolvedStreamHeaders = new Map();
// Headers of the Miruro stream playing in the main window. Its playlists and segments come from several hosts, so they
// go on every video request of the player (see the session hooks) until another episode is resolved.
let playerStreamHeaders = null;
const malIdCache = new Map();
let downloadManager;
let updater;

async function coverDataUrl(rawUrl){
  return String(rawUrl||'');
}

async function resolveMalIdFromAniList(anilistId){
  const id=Number(anilistId);if(!id)return null;if(malIdCache.has(id))return malIdCache.get(id);
  const response=await fetch('https://graphql.anilist.co',{signal:AbortSignal.timeout(25000),method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'LilacAnime Android'},body:JSON.stringify({query:'query ($id: Int) { Media(id: $id, type: ANIME) { idMal } }',variables:{id}})});
  if(!response.ok)return null;const malId=Number((await response.json())?.data?.Media?.idMal)||null;if(malId)malIdCache.set(id,malId);return malId;
}

const ANISKIP_TYPES=['op','ed','mixed-op','mixed-ed','recap'];
async function androidOnlineSkipTimes({episode,anilistId,malId,duration}){
  const resolvedMalId=Number(malId)||await resolveMalIdFromAniList(anilistId);if(!resolvedMalId||Number(episode)<=0)return [];
  const allowed=new Set(ANISKIP_TYPES);
  // AniSkip expects repeated types[] parameters. Prefer a duration-matched record and
  // fall back to episodeLength=0, which returns every known match (Android v0.3.9).
  const request=async length=>{
    const query=ANISKIP_TYPES.map(type=>`types[]=${type}`).join('&');
    const url=`https://api.aniskip.com/v2/skip-times/${resolvedMalId}/${Number(episode)}?${query}&episodeLength=${Math.max(0,Math.round(Number(length)||0))}`;
    try{
      const response=await fetch(url,{signal:AbortSignal.timeout(25000),headers:{Accept:'application/json','User-Agent':'LilacAnime Android'}});if(!response.ok)return [];
      const root=await response.json();return (root.results||[]).map(item=>{const interval=item.interval||item;return {type:item.skipType,startTime:Number(interval.startTime),endTime:Number(interval.endTime)}}).filter(item=>allowed.has(item.type)&&Number.isFinite(item.startTime)&&item.startTime>=0&&item.endTime>item.startTime).sort((a,b)=>a.startTime-b.startTime);
    }catch{return []}
  };
  const length=Number(duration)||0;
  if(length>0){const matched=await request(length);if(matched.length)return matched}
  return request(0);
}

async function api(pathname) {
  const response = await fetch(`${API}${pathname}`, {
    headers: { 'User-Agent': `LilacAnime-Desktop/${app.getVersion()}` }
  });
  if (!response.ok) throw new Error(`API 요청 실패 (${response.status})`);
  return response.json();
}

// Same as Android LinkkfApiClient: call timeout 30 s, 3 attempts, 350/700 ms apart.
async function linkkfFetch(url, timeout = 30000) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': LINKKF_UA, Accept: 'application/json,text/plain,*/*', Referer: `${LINKKF_WEB}/` }
      });
      if (!response.ok) throw new Error(`Linkkf HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
  throw new Error(lastError?.name === 'AbortError' ? 'Linkkf 서버 응답 시간이 초과되었습니다.' : `Linkkf 연결 실패: ${lastError?.message || '알 수 없는 오류'}`);
}

function linkkfImage(url = '') {
  if (!url || url.startsWith('https://rez1.ims1.top/')) return url;
  if (url.startsWith('//')) url = `https:${url}`;
  return /^https?:\/\//.test(url) ? `https://rez1.ims1.top/350x/${url}` : url;
}

function linkkfAnime(item = {}) {
  const first = (...keys) => keys.map(key => String(item[key] || '').trim()).find(Boolean) || '';
  const split = value => value.split(/[,|/]/).map(x => x.trim()).filter(Boolean);
  const id = first('postid');
  return {
    provider: 'linkkf', id, mal_id: `linkkf:${id}`,
    title: first('postname', 'name'), title_english: first('english'), title_japanese: first('native'),
    images: { webp: { large_image_url: linkkfImage(first('postthum', 'thumb')) } },
    score: null, year: first('postyear'), type: first('postseasontype') || 'Anime', episodes: null,
    synopsis: first('postcontent', 'description', 'synopsis'), genres: split(first('postanigenres', 'genres')).map(name => ({ name })),
    studios: split(first('poststudios')).map(name => ({ name })), url: `${LINKKF_WEB}/up/${id}/`,
    anilistId: Number(first('anilistid', 'anilist_id', 'postanilistid', 'postanilist', 'anilistId', 'anilist')) || null,
    seriesTagIds: split(first('postanisstagid')).map(Number).filter(Boolean), aired: first('postdate', 'datepub'),
    source: first('anisource'), romaji: first('romaji'), synonyms: first('anisynonyms'), note: first('postnote', 'postnoti')
  };
}

const LINKKF_SCHEDULE_TAGS = [21189, 21190, 21191, 21192, 21193, 21194, 21195]; // 월~일
const LINKKF_SEASON_TYPES = { pv: 5086, movie: 5061, adult16: 5085 };
async function linkkfFilter({ page = 1, limit = 20, seasonTypeIds = [], genreIds = [], yearIds = [] } = {}) {
  const params = new URLSearchParams({ page: String(Number(page) || 1), limit: String(Number(limit) || 20) });
  const ids = list => (Array.isArray(list) ? list : []).map(Number).filter(Boolean).join(',');
  if (ids(seasonTypeIds)) params.set('postseasontypetagid', ids(seasonTypeIds));
  if (ids(genreIds)) params.set('postanigenrestagid', ids(genreIds));
  if (ids(yearIds)) params.set('postyeartagid', ids(yearIds));
  const root = await linkkfFetch(`${LINKKF_API}/singlefilter.php?${params}`);
  const pagination = root.pagination || {};
  return { data: (root.data || []).map(linkkfAnime).filter(a => a.id), page: Number(pagination.current_page) || Number(page) || 1, totalPages: Number(pagination.total_pages) || 1, total: Number(pagination.total_results) || 0 };
}
// Android searches the whole Linkkf catalog locally (title/genre). The full list is the Linkkf catalog index
// (see CATALOGS), loaded in the background like the other sources; it is downloaded here when not loaded yet.
let activeCatalogSource = null;
async function downloadLinkkfCatalog() {
  const found = new Map(), limit = 100;
  for (let page = 1; page <= 400; page += 4) {
    const batch = await Promise.all([0, 1, 2, 3].map(offset => linkkfFetch(`${LINKKF_API}/filter.php?page=${page + offset}&limit=${limit}`).then(root => (root.data || []).map(linkkfAnime)).catch(() => null)));
    if (batch.every(items => items === null)) throw new Error('Linkkf 목록을 불러오지 못했습니다.');
    batch.flat().filter(Boolean).forEach(item => { if (item.id) found.set(item.id, item); });
    if (batch.some(items => !items || items.length < limit)) break;
  }
  return [...found.values()];
}
async function linkkfCatalog() {
  const index = catalogIndex('linkkf');
  if (!index.items.length) { index.items = await downloadLinkkfCatalog(); index.updated = Date.now(); saveCatalogIndex('linkkf'); }
  return index.items;
}
function linkkfSearchKey(value = '') { return String(value).toLowerCase().normalize('NFKC').replace(/[\s\-_:·.,!?'"()[\]~]+/g, ''); }

async function providerFetch(url, { json = false, referer } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000); // Android ReAnimeClient call timeout
  try {
    const response = await fetch(url, { signal: controller.signal, headers: {
      'User-Agent': LINKKF_UA, Accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9,ko;q=0.7', Referer: referer || new URL(url).origin + '/'
    }});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return json ? response.json() : response.text();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('서버 응답 시간이 초과되었습니다.');
    throw error;
  } finally { clearTimeout(timer); }
}

function reanimeItems(root) {
  const preferred = ['data','results','anime','animes','items','latest_aired','top_weekly'];
  let list = Array.isArray(root) ? root : preferred.map(k => root?.[k]).find(Array.isArray);
  if (!list && root) for (const key of preferred) {
    const nested = root[key]; list = preferred.map(k => nested?.[k]).find(Array.isArray); if (list) break;
  }
  return (list || []).map(raw => {
    const a = raw.anime || raw;
    const title = a.title?.english || a.title?.romaji || a.title?.native || a.title || a.name || raw.title || raw.name || '';
    const link = a.detailUrl || a.detail_url || a.url || a.link || raw.url || raw.link || '';
    const rawSlug = a.anime_id || raw.anime_id || a.slug || a.anime_slug || raw.slug || '';
    const slug = String(link).match(/\/(?:anime|watch)\/([^/?#]+)/)?.[1] || String(rawSlug).replace(/^\/+|\/+$/g,'') || String(title).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const image = a.cover_image || a.cover || a.poster || a.image || raw.cover_image || raw.poster || raw.image || '';
    const imageUrl = typeof image === 'string' ? image : image.extra_large || image.large || image.medium || image.url || image.src || '';
    const genresRaw = a.genres || raw.genres || [];
    const genres = (Array.isArray(genresRaw) ? genresRaw : Object.values(genresRaw)).map(x => ({name: typeof x === 'string' ? x : x.name || x.title || ''})).filter(x=>x.name);
    const episodeCount=Number(a.episodes||0)||Math.max(Number(a.subbed||0),Number(a.dubbed||0))||0;
    return {provider:'reanime',id:slug,mal_id:`reanime:${slug}`,title,title_english:'',images:{webp:{large_image_url:imageUrl}},score:Number(a.average_score||a.score||0)/10||null,year:a.season_year||a.year||'',type:a.format||'Anime',episodes:episodeCount||null,status:a.status||'',synopsis:a.description||a.synopsis||'',genres,studios:[],url:`${REANIME_WEB}/anime/${slug}`,anilistId:Number(a.anilist_id||a.anilistId||a.anilist||0)||null,malId:Number(a.mal_id||0)||null,canWatch:a.can_watch!==false,subbed:Number(a.subbed||0),dubbed:Number(a.dubbed||0)};
  }).filter(x => x.title && x.id);
}

function absoluteUrl(value, base) { try { return new URL(value, base).href; } catch { return ''; } }
// Search pages also carry the sidebar's popular / newest lists, which are not results: onlyResults skips them.
function animenosubList(html, base = `${ANIMENOSUB_WEB}/`, { onlyResults = false } = {}) {
  const $ = cheerio.load(html); const found = new Map();
  $('a[href]').each((_, node) => {
    if (onlyResults && $(node).closest('#sidebar, header, footer, nav').length) return;
    const el=$(node), href=absoluteUrl(el.attr('href'),base);
    if(!href.startsWith(`${ANIMENOSUB_WEB}/`)||(!href.includes('/anime/')&&!/-episode-\d+/i.test(href)))return;
    const episodeSlug=new URL(href).pathname.split('/').filter(Boolean).pop()||'';
    // An episode link names its series before "-episode-N"; a suffix other than "-dub" belongs to the series too
    // ("…-episode-1-uncensored" is episode 1 of "…-uncensored").
    const seriesSlug=(href.includes('/anime/')?episodeSlug:episodeSlug.replace(/-episode-\d+[a-z]?((?:-[a-z]+)*)$/i,(_,suffix)=>suffix.replace(/-dub(?=-|$)/i,''))).toLowerCase();
    if(!seriesSlug||new URL(href).pathname==='/anime/')return; const container=el.closest('article,li,.item,.film-poster,.post,.ani,div');
    const img=el.find('img').first().length?el.find('img').first():container.find('img').first();
    const poster=absoluteUrl(img.attr('data-src')||img.attr('data-lazy-src')||img.attr('src')||'',base);
    let title=(img.attr('alt')||container.find('h1,h2,h3,h4,.title,.film-name,.post-title').first().text()||el.text()).trim();
    title=title.replace(/\s+episode\s+\d+.*$/i,'').trim()||seriesSlug.replace(/[-_]+/g,' ');
    const id=`animenosub:${seriesSlug}`, current=found.get(id);
    if(!current||(!current.images.webp.large_image_url&&poster))found.set(id,{provider:'animenosub',id:seriesSlug,mal_id:id,title,title_english:'',images:{webp:{large_image_url:poster}},score:null,year:'',type:'Anime',episodes:null,synopsis:'',genres:[],studios:[],url:`${ANIMENOSUB_WEB}/anime/${seriesSlug}/`});
  });
  return [...found.values()];
}

function animenosubDetail(html, original) {
  const $=cheerio.load(html), title=($('h1,.film-name,.film-title,.anime-title,.post-title,.entry-title').first().text()||original.title).trim();
  const synopsis=($('.description,.desc,.synopsis,.film-description,.summary').first().text()||$('meta[name=description]').attr('content')||'').trim();
  const poster=absoluteUrl($('div.thumb img').attr('src')||$('div.bigcover img').attr('src')||imageOfMain(original),original.url);
  const genres=[];$('a[href*="/genre/"]').each((_,x)=>{const name=$(x).text().trim();if(name&&!genres.some(g=>g.name===name))genres.push({name})});
  return {...original,title,synopsis,genres,images:{webp:{large_image_url:poster}}};
}
function imageOfMain(a){return a?.images?.webp?.large_image_url||''}

function providerEpisodes(html, provider, anime) {
  const $=cheerio.load(html), episodes=[];
  $('a[href]').each((_,node)=>{const el=$(node),href=absoluteUrl(el.attr('href'),anime.url);let match;
    const parsed=(()=>{try{return new URL(href)}catch{return null}})();
    // "-episode-3", "-episode-3b", "-episode-3-dub" and suffixed versions ("-episode-1-uncensored").
    if(provider==='animenosub')match=parsed?.pathname.match(/-episode-(\d+)([a-z]?)((?:-[a-z]+)*)\/?$/i);
    else if(provider==='reanime'&&parsed?.pathname.includes('/watch/'))match=(parsed.searchParams.get('ep')||el.text()).match(/(?:episode|ep|#)?\s*(\d+)/i);
    if(!match)return;const number=Number(match[1]);
    // Animenosub's episode list dates each episode ("June 19, 2026"), shown like Re:Anime's air dates.
    const date=provider==='animenosub'?new Date(el.find('.epl-date').text().trim()):null,airedDate=date&&!isNaN(date)?`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`:'';
    episodes.push({name:`${number}${match[2]||''}`,number,url:href,dub:/(?:^|-)dub(?:-|$)/i.test(match[3]||''),provider,anilistId:anime.anilistId||null,...(airedDate?{airedDate}:{})});
  });
  // The same episode is linked more than once (first/last episode buttons); the dated link wins.
  const unique=new Map();for(const x of episodes){const key=`${x.name}:${x.dub}`;if(!unique.has(key)||(!unique.get(key).airedDate&&x.airedDate))unique.set(key,x)}
  return [...unique.values()].sort((a,b)=>a.number-b.number);
}

// Re:ANIME detail pages embed an AniList-like media object and the first episode page
// as a JS object literal (SSR payload). The same data is also served as JSON by the site's
// own /api/v1 routes, which the desktop port prefers; the SSR regexes mirror Android v0.3.9.
function decodeJsString(value=''){if(!value)return '';try{return JSON.parse(`"${value}"`).trim()}catch{return value.replace(/\\"/g,'"').replace(/\\\\/g,'\\').replace(/\\\//g,'/').trim()}}
function reanimeDate(value){const year=Number(value?.year),month=Number(value?.month),day=Number(value?.day);return year&&month&&day?`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`:''}
function reanimeRelated(list,selfSlug){
  return (Array.isArray(list)?list:[]).map(item=>{
    const slug=String(item.anime_id||'').trim();if(!slug||slug===selfSlug)return null;
    const english=item.title?.english||'',native=item.title?.native||'',romaji=item.title?.romaji||'',poster=item.cover_image?.extra_large||item.cover_image?.large||'';
    return {provider:'reanime',id:slug,mal_id:`reanime:${slug}`,title:english||romaji||native,title_english:'',title_japanese:native,romaji,images:{webp:{large_image_url:poster}},type:item.format||'',relationType:item.relation_type||'',season:item.season||'',year:item.season_year||'',url:`${REANIME_WEB}/anime/${slug}`};
  }).filter(Boolean).filter((item,index,array)=>array.findIndex(x=>x.id===item.id)===index);
}
function reanimeMediaFromJson(root,original){
  const title=root.title||{},description=String(root.description||'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').trim();
  const start=reanimeDate(root.start_date),end=reanimeDate(root.end_date);
  return {...original,
    title:original.title||title.english||title.romaji||title.native,title_japanese:title.native||original.title_japanese||'',romaji:title.romaji||'',english:title.english||'',
    synopsis:description||original.synopsis,images:{webp:{large_image_url:root.cover_image?.extra_large||imageOfMain(original)}},
    genres:(root.genres||[]).length?root.genres.map(name=>({name:String(name)})):original.genres,
    studios:(root.studios||[]).map(x=>({name:String(x.name||'')})).filter(x=>x.name),
    synonyms:(root.synonyms||[]).filter(Boolean).join(', '),type:root.format||original.type,year:root.season_year||start.slice(0,4)||original.year,
    status:root.status||original.status,season:root.season||'',source:root.source||'',aired:start&&end?`${start} ~ ${end}`:start,
    score:Number(root.average_score)?Number(root.average_score)/10:original.score,
    anilistId:Number(root.anilist_id)||original.anilistId||null,malId:Number(root.mal_id)||original.malId||null,
    episodes:Number(root.episodes_total)||original.episodes,subbed:Number(root.subbed)||original.subbed,dubbed:Number(root.dubbed)||original.dubbed,
    related:reanimeRelated(root.relations,original.id)};
}
function reanimeMediaFromHtml(html,original){
  const animeStart=html.indexOf('anime:{'),episodesStart=animeStart>=0?html.indexOf('},episodes:{',animeStart):-1;
  const media=animeStart>=0&&episodesStart>animeStart?html.slice(animeStart,episodesStart):html;
  const str=pattern=>{const match=media.match(pattern);return match?decodeJsString(match[1]):''};
  const list=(pattern,item)=>{const block=media.match(pattern)?.[1];return block?[...block.matchAll(item)].map(m=>decodeJsString(m[1])).filter(Boolean):[]};
  const date=key=>{const m=media.match(new RegExp(`${key}:\\{day:(\\d+),month:(\\d+),year:(\\d+)`));return m?reanimeDate({day:m[1],month:m[2],year:m[3]}):''};
  const $=cheerio.load(html),start=date('start_date'),end=date('end_date');
  const description=str(/description:"((?:\\.|[^"])*)"/).replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').trim();
  const genres=list(/genres:\[([^\]]*)\]/,/"((?:\\.|[^"])*)"/g),studios=list(/studios:\[([^\]]*)\]/,/name:"((?:\\.|[^"])*)"/g);
  const relStart=html.indexOf('relations:['),relEnd=relStart>=0?html.indexOf('],requested:',relStart):-1,related=[];
  if(relStart>=0&&relEnd>relStart){
    const pattern=/\{anime_id:"([^"]+)",cover_image:\{[^}]*extra_large:"([^"]+)"[^}]*\},format:"([^"]*)",relation_type:"([^"]*)",season:"([^"]*)",season_year:(\d+),title:\{english:"([^"]*)",native:"([^"]*)",romaji:"([^"]*)"/g;
    for(const m of html.slice(relStart,relEnd).matchAll(pattern))related.push({anime_id:decodeJsString(m[1]),cover_image:{extra_large:decodeJsString(m[2])},format:m[3],relation_type:m[4],season:m[5],season_year:Number(m[6]),title:{english:decodeJsString(m[7]),native:decodeJsString(m[8]),romaji:decodeJsString(m[9])}});
  }
  return {...original,
    title:($('h1').first().text().trim()||original.title),title_japanese:str(/title:\{[^}]*native:"((?:\\.|[^"])*)"/)||original.title_japanese||'',
    romaji:str(/title:\{[^}]*romaji:"((?:\\.|[^"])*)"/),english:str(/title:\{[^}]*english:"((?:\\.|[^"])*)"/),
    synopsis:description||$('meta[name=description]').attr('content')||original.synopsis,
    images:{webp:{large_image_url:$('meta[property="og:image"]').attr('content')||imageOfMain(original)}},
    genres:genres.length?genres.map(name=>({name})):original.genres,studios:studios.map(name=>({name})),
    type:str(/format:"([^"]+)"/)||original.type,status:str(/status:"([^"]+)"/)||original.status,source:str(/source:"([A-Z_]+)"/),season:str(/season:"([^"]+)"/),
    year:media.match(/season_year:(\d+)/)?.[1]||start.slice(0,4)||original.year,aired:start&&end?`${start} ~ ${end}`:start,
    anilistId:Number(media.match(/anilist_id:(\d+)/)?.[1])||original.anilistId||null,malId:Number(media.match(/mal_id:(\d+)/)?.[1])||original.malId||null,
    related:reanimeRelated(related,original.id)};
}
async function reanimeDetail(anime,html){
  try{const root=await providerFetch(`${REANIME_WEB}/api/v1/anime/${encodeURIComponent(anime.id)}`,{json:true,referer:anime.url});if(root&&typeof root==='object'&&root.anime_id)return reanimeMediaFromJson(root,anime)}catch{/* SSR payload fallback below. */}
  return reanimeMediaFromHtml(html,anime);
}
function reanimeEpisode(raw,anime){
  const number=Number(raw.episode_number);if(!Number.isFinite(number)||number<=0)return null;
  return {name:String(number),number,url:`${REANIME_WEB}/watch/${encodeURIComponent(anime.id)}?ep=${number}`,dub:false,provider:'reanime',anilistId:anime.anilistId||null,malId:anime.malId||null,
    title:String(raw.title||'').trim()||`Episode ${number}`,nativeTitle:String(raw.title_japanese||'').trim(),airedDate:String(raw.aired||''),
    isFiller:raw.is_filler===true,isRecap:raw.is_recap===true,playable:raw.playable!==false,subbed:raw.subbed===true,dubbed:raw.dubbed===true,thumbnail:String(raw.thumbnail||'')};
}
function reanimeSsrEpisodes(html,anime){
  // episodes:{data:[{aired:"…",…,episode_number:1,…},…],limit:100,offset:0,total:…,totalPages:…}
  let start=html.indexOf('episodes:{data:[');if(start<0)start=html.indexOf('episodes: {data:[');if(start<0)return [];
  const dataStart=html.indexOf('[',start),dataEnd=html.indexOf('],limit:',dataStart);if(dataEnd<=dataStart)return [];
  const payload=html.slice(dataStart+1,dataEnd),episodes=[];
  for(const match of payload.matchAll(/\{aired:"((?:\\.|[^"])*)",[^{}]*?\}/g)){
    const body=match[0],field=key=>body.match(new RegExp(`[{,]${key}:("(?:\\\\.|[^"])*"|true|false|\\d+)`))?.[1];
    const text=key=>{const value=field(key);return value?.startsWith('"')?decodeJsString(value.slice(1,-1)):''},flag=key=>field(key)==='true';
    const episode=reanimeEpisode({episode_number:Number(field('episode_number')),title:text('title'),title_japanese:text('title_japanese'),aired:text('aired'),is_filler:flag('is_filler'),is_recap:flag('is_recap'),playable:field('playable')!=='false',subbed:flag('subbed'),dubbed:flag('dubbed'),thumbnail:text('thumbnail')},anime);
    if(episode)episodes.push(episode);
  }
  return episodes;
}
async function reanimeEpisodes(anime, detailHtml) {
  // The site's own episode route returns every page at once (the SSR payload only has 100).
  try{
    const root=await providerFetch(`${REANIME_WEB}/api/v1/anime/${encodeURIComponent(anime.id)}/episodes?limit=2000`,{json:true,referer:anime.url});
    const list=(Array.isArray(root?.data)?root.data:[]).map(raw=>reanimeEpisode(raw,anime)).filter(Boolean);
    if(list.length)return [...new Map(list.map(ep=>[ep.number,ep])).values()].sort((a,b)=>a.number-b.number);
  }catch{/* SSR payload fallback below. */}
  const ssr=reanimeSsrEpisodes(detailHtml,anime);
  if(ssr.length)return [...new Map(ssr.map(ep=>[ep.number,ep])).values()].sort((a,b)=>a.number-b.number);
  let episodes=providerEpisodes(detailHtml,'reanime',anime);
  if(!episodes.length){const watchUrl=`${REANIME_WEB}/watch/${encodeURIComponent(anime.id)}?ep=1`;try { episodes=providerEpisodes(await providerFetch(watchUrl,{referer:anime.url}),'reanime',anime); } catch { /* API count fallback below. */ }}
  const highestParsed=episodes.reduce((max,episode)=>Math.max(max,Number(episode.number)||0),0);
  const count=Math.min(Math.max(Number(anime.subbed||0),Number(anime.episodes||0),highestParsed),5000);
  if(!count)return episodes;
  const byNumber=new Map(episodes.map(episode=>[Number(episode.number),episode]));
  for(let number=1;number<=count;number++)if(!byNumber.has(number))byNumber.set(number,{name:String(number),number,url:`${REANIME_WEB}/watch/${encodeURIComponent(anime.id)}?ep=${number}`,dub:false,provider:'reanime',anilistId:anime.anilistId||null});
  return [...byNumber.values()].sort((a,b)=>a.number-b.number);
}

async function reanimeServers(episode) {
  const parsed=new URL(episode.url),slug=parsed.pathname.split('/').filter(Boolean).pop(),number=Number(parsed.searchParams.get('ep')||episode.number||1);
  let links=[];
  try {
    const root=await providerFetch(`${REANIME_WEB}/api/watch/${encodeURIComponent(slug)}/${number}`,{json:true,referer:`${REANIME_WEB}/`});
    links=Array.isArray(root.episode_links)?root.episode_links:[];
  } catch { /* Current API often serves streams only from /api/flix. */ }
  if(!links.length&&episode.anilistId){
    const flix=await providerFetch(`${REANIME_WEB}/api/flix/${Number(episode.anilistId)}/${number}`,{json:true,referer:`${REANIME_WEB}/`});
    links=Array.isArray(flix.servers)?flix.servers:[];
  }
  const candidates=links.map(item=>({name:String(item.serverName||''),url:String(item.dataLink||item.link||'')})).filter(item=>/^https:\/\/flixcloud\.cc\/e\//i.test(item.url));
  return [...candidates.filter(item=>/HD-?2/i.test(item.name)),...candidates.filter(item=>/HD-?1/i.test(item.name)),...candidates]
    .filter((item,index,array)=>array.findIndex(x=>x.url===item.url)===index);
}
// Subtitle track list only (no stream resolving): lets downloaded Re:ANIME episodes offer tracks too.
async function reanimeSubtitleTracks(episode) {
  for(const server of await reanimeServers(episode)){
    try{
      const html=await providerFetch(server.url,{referer:`${REANIME_WEB}/`});
      const tracks=parseFlixSubtitleTracks(html);if(tracks.length)return {tracks,referer:server.url};
    }catch{/* Try the next server. */}
  }
  return {tracks:[],referer:''};
}

async function resolveProviderEpisode(episode) {
  if(episode.provider==='miruro')return resolveMiruroEpisode(episode);
  if(episode.provider==='reanime') {
    const ordered=await reanimeServers(episode);
    if(!ordered.length)throw new Error('이 작품은 현재 RE:Anime에서 재생할 수 없습니다. 다른 콘텐츠 소스를 선택해주세요.');
    let lastError;
    for(const server of ordered){
      try{return await resolveStreamPage(server.url,`${REANIME_WEB}/`)}catch(error){lastError=error}
    }
    throw lastError||new Error('모든 영상 서버 연결에 실패했습니다.');
  }
  if(episode.provider==='animenosub'){
    const servers=animenosubServers(await providerFetch(episode.url,{referer:`${ANIMENOSUB_WEB}/`}),episode.url);
    // The server picked in the player first, then the preferred kind (RAW under a Korean subtitle), then SUB. Server
    // names point at different hosts from episode to episode and some hosts never answer, so the servers of one kind
    // are tried at once (each in a session of its own) and the first that answers is used; the others are stopped.
    const tierOf=server=>server.label===episode.server?0:server.kind===episode.prefer?1:server.kind==='sub'?2:server.kind==='raw'?3:4;
    const tiers=[...new Set(servers.map(tierOf))].sort((a,b)=>a-b).map(tier=>servers.filter(server=>tierOf(server)===tier));
    let lastError=null;
    for(const tier of tiers){
      const controller=new AbortController();
      try{
        const {stream,server}=await Promise.any(tier.map(server=>resolveStreamPage(server.url,episode.url,15000,{partition:`lilac-resolve-${resolverSlot=(resolverSlot+1)%8}`,waitSubtitle:false,signal:controller.signal}).then(stream=>({stream,server}))));
        return {...stream,servers:servers.map(({label,kind})=>({label,kind})),server:server.label};
      }catch(error){lastError=error.errors?.[0]||error}
      finally{controller.abort()}
    }
    if(servers.length)throw lastError||new Error('모든 영상 서버 연결에 실패했습니다.');
  }
  return resolveStreamPage(episode.url,episode.referer||new URL(episode.url).origin+'/');
}

// Animenosub's server menu: base64 <iframe> snippets labelled "SUB - Moon", "RAW - Omega"… SUB videos carry burned-in
// English subtitles, RAW ones none. Pages without the menu have a single embedded player.
let resolverSlot=0;
function animenosubServers(html,pageUrl){
  const $=cheerio.load(html),servers=[];
  $('option[value]').each((_,option)=>{
    const value=$(option).attr('value');if(!value)return;
    let src='';try{src=cheerio.load(Buffer.from(value,'base64').toString('utf8'))('iframe').attr('src')||''}catch{/* not a server */}
    const label=$(option).text().trim();
    if(src&&label&&!servers.some(server=>server.label===label))servers.push({label,kind:/^raw\b/i.test(label)?'raw':/^dub\b/i.test(label)?'dub':'sub',url:absoluteUrl(src,pageUrl)});
  });
  const embedded=absoluteUrl($('iframe[src]').first().attr('src')||$('iframe[data-src]').first().attr('data-src')||'',pageUrl);
  if(!servers.length&&embedded)servers.push({label:'기본',kind:'sub',url:embedded});
  return servers;
}

// --- Miruro --------------------------------------------------------------------------------------------------------
// The site's own catalog API (AniList data under Miruro ids). Answers are gzip XORed with "miruro/catalog"; lists take
// 12 or 15 entries a page and are paged with a cursor.
const MIRURO_KEY=Buffer.from('miruro/catalog');
async function miruroApi(pathname,params={}){
  const url=new URL(`/api/v1/${pathname}`,MIRURO_WEB);
  for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(key,String(value));
  const response=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{'User-Agent':LINKKF_UA,Accept:'*/*',Referer:`${MIRURO_WEB}/`}});
  const data=Buffer.from(await response.arrayBuffer());
  if(!response.ok){let detail='';try{detail=JSON.parse(data.toString('utf8')).detail||''}catch{/* not JSON */}throw new Error(`Miruro HTTP ${response.status}${detail?` (${detail})`:''}`)}
  for(let i=0;i<data.length;i++)data[i]^=MIRURO_KEY[i%MIRURO_KEY.length];
  return JSON.parse(zlib.gunzipSync(data).toString('utf8'));
}
function miruroText(html=''){return String(html||'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&mdash;/g,'—').replace(/&ndash;/g,'–').replace(/&quot;/g,'"').replace(/&#0?39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim()}
function miruroItem(raw={}){
  const title=raw.title||{},native=title.native||'',externalId=key=>Number(raw.external_ids?.[key]?.[0])||null;
  return {provider:'miruro',id:raw.id,mal_id:`miruro:${raw.id}`,title:title.english||title.romaji||native,title_english:'',title_japanese:native,romaji:title.romaji||'',
    images:{webp:{large_image_url:raw.cover_url||''}},score:Number(raw.average_score)?Number(raw.average_score)/10:null,year:raw.season_year||'',type:raw.format||'Anime',
    episodes:Number(raw.episode_count)||null,status:String(raw.status||'').toLowerCase().replace(/_/g,' ').replace(/^./,c=>c.toUpperCase()),synopsis:miruroText(raw.description),genres:(raw.genres||[]).map(name=>({name:String(name)})),studios:[],
    url:`${MIRURO_WEB}/watch/${raw.id}`,anilistId:externalId('anilist'),malId:externalId('mal')};
}
function miruroEpisode(raw,anime){
  const number=Number(raw.episode_number);if(!Number.isFinite(number)||number<=0)return null;
  return {name:String(number),number,url:`${MIRURO_WEB}/watch/${anime.id}?ep=${number}`,animeId:anime.id,dub:false,provider:'miruro',anilistId:anime.anilistId||null,malId:anime.malId||null,
    title:String(raw.title||'').trim()||`Episode ${number}`,airedDate:String(raw.aired_on||''),isFiller:raw.canon_type==='filler',isRecap:raw.canon_type==='recap',thumbnail:String(raw.thumbnail_url||'')};
}
// The site's own rules: a movie's episode list is kind "film" (as "regular" it is empty), and episodes past the
// available count or not aired yet are listed but cannot be played.
function miruroPlayableEpisodes(list,root,now=Date.now()){
  const counts=root.episode_counts||{},raw=counts.raw??null,limit=[root.episode_count,raw].reduce((min,value)=>value==null?min:min==null?value:Math.min(min,value),null);
  return list.filter(raw=>{
    const number=Number(raw.episode_number);if(limit!=null&&number>limit)return false;
    if(counts.raw!=null||number<=Math.max(counts.sub??0,counts.dub??0))return true;
    const aired=raw.aired_on?Date.parse(raw.aired_on):NaN;return Number.isFinite(aired)?aired<=now:root.status!=='NOT_YET_RELEASED';
  });
}
// Whether a show has an episode to play now (the home rail's check), remembered for half an hour.
const miruroEpisodeCheck=new Map();
async function miruroHasEpisodes(root){
  const known=miruroEpisodeCheck.get(root.id);if(known&&Date.now()-known.time<30*60*1000)return known.value;
  const list=await miruroApi(`anime/${root.id}/episodes`,{kind:root.format==='MOVIE'?'film':'regular',limit:10000}).catch(()=>null);
  const value=Boolean(list&&miruroPlayableEpisodes(list.data||[],root).length);
  miruroEpisodeCheck.set(root.id,{value,time:Date.now()});return value;
}
async function miruroDetail(anime){
  const root=await miruroApi(`anime/${anime.id}`);
  const [episodes,relations]=await Promise.all([miruroApi(`anime/${anime.id}/episodes`,{kind:root.format==='MOVIE'?'film':'regular',limit:10000}),miruroApi(`anime/${anime.id}/relations`).catch(()=>null)]);
  const start=root.started_on||'',end=root.ended_on||'',studios=root.studios||[];
  const data={...anime,...miruroItem(root),studios:(studios.filter(item=>item.is_animation_studio).length?studios.filter(item=>item.is_animation_studio):studios.slice(0,2)).map(item=>({name:item.name})),
    aired:start&&end?`${start} ~ ${end}`:start,related:(relations?.data||[]).filter(item=>item.anime?.id).map(item=>({...miruroItem(item.anime),relationType:item.kind||''}))};
  return {data,episodes:miruroPlayableEpisodes(episodes?.data||[],root).map(raw=>miruroEpisode(raw,data)).filter(Boolean),unavailable:false};
}
// The play route lists every track: "sub" has English burned in, "ssub" (SOFT) is the clean video with separate
// subtitle files, "raw" the broadcast without any, "dub" comes last. Servers without a direct HLS stream (embed pages
// only) are left out. Order: the server picked in the player; under a Korean subtitle (prefer "raw") a clean video
// (RAW / SOFT), otherwise SOFT with an English subtitle file (applied, and offered for Gemini translation like Re:Anime's
// tracks), then SUB; within a kind the provider that worked last, then the steadiest ones.
const MIRURO_KINDS={sub:'sub',ssub:'soft',raw:'raw',dub:'dub'},MIRURO_PROVIDERS=['anikoto','kickassanime','icarus','aniwaves'];
let miruroWorkingProvider='';
// Request headers of Miruro subtitle files by address: their hosts want the video server's Referer and Origin.
const miruroTrackHeaders=new Map();
function remoteTrackOptions(url,referer=''){
  const headers=miruroTrackHeaders.get(String(url));
  return headers?{referer:headers.Referer||'',userAgent:LINKKF_UA,headers}:{referer:/^https:\/\//i.test(referer||'')?referer:'https://flixcloud.cc/',userAgent:ANDROID_WEBVIEW_UA};
}
const isEnglishTrack=track=>/^en/i.test(track.language||'')&&!/forced|sign/i.test(track.label||'');
async function resolveMiruroEpisode(episode){
  const root=await miruroApi(`anime/${episode.animeId}/episodes/${episode.number}/play`),servers=[];
  for(const track of root.tracks||[]){
    if(!MIRURO_KINDS[track.track])continue;
    for(const provider of track.providers||[])for(const server of provider.servers||[]){
      const tracks=(provider.subtitles||[]).filter(item=>/^https:\/\//i.test(item.file||'')).map(item=>({url:item.file,language:String(item.language||'und'),label:String(item.label||item.language||'').replace(/\.(?:vtt|srt|ass)$/i,'').trim()||'자막',format:String(item.format||'vtt').toLowerCase()}));
      // An "ssub" video without any subtitle file has English burned in after all (every one of "Your Name."'s does).
      const kind=MIRURO_KINDS[track.track]==='soft'&&!tracks.length?'sub':MIRURO_KINDS[track.track];
      const stream=(server.streams||[]).find(item=>item.format==='hls'&&/^https:/i.test(item.url||'')),label=`${kind.toUpperCase()} - ${provider.provider} ${server.server}`;
      // Some segment hosts also want the Origin of the Referer (kickassanime's), which the list leaves out.
      const headers={...server.headers};if(headers.Referer&&!headers.Origin)try{headers.Origin=new URL(headers.Referer).origin}catch{/* no origin */}
      tracks.forEach(item=>miruroTrackHeaders.set(item.url,headers));
      if(stream&&!servers.some(item=>item.label===label))servers.push({label,kind,provider:provider.provider,url:stream.url,headers,tracks});
    }
  }
  if(!servers.length)throw new Error('이 회차는 Miruro에서 재생할 수 있는 영상이 없습니다.');
  const known=provider=>{const index=MIRURO_PROVIDERS.indexOf(provider);return index<0?MIRURO_PROVIDERS.length:index};
  const clean=server=>['raw','soft'].includes(server.kind),english=server=>server.kind==='soft'&&server.tracks.some(isEnglishTrack);
  // A SOFT server with a Korean file of its own comes first, like a Korean Re:Anime track.
  const korean=server=>server.kind==='soft'&&server.tracks.some(isKoreanTrack);
  const kindRank=server=>korean(server)?0.5:episode.prefer==='raw'?(clean(server)?1:server.kind==='sub'?2:3):(english(server)?1:server.kind==='sub'?2:clean(server)?3:4);
  const rank=server=>(server.label===episode.server?0:kindRank(server)*100)+(server.provider===miruroWorkingProvider?0:10)+known(server.provider);
  const result=async(server,extra={})=>{
    const stream={url:server.url,headers:server.headers,referer:server.headers.Referer||'',servers:servers.map(({label,kind})=>({label,kind})),server:server.label,subtitleTracks:server.tracks,...extra};
    // Only a Korean file is applied by itself, as with Re:Anime; other languages wait in the track list.
    const track=server.kind!=='soft'?null:server.tracks.find(isKoreanTrack);
    if(track)try{const file=subtitleResult(await saveRemoteSubtitle(track.url,remoteTrackOptions(track.url)));Object.assign(stream,{subtitleUrl:file.url,subtitlePath:file.path,subtitleAss:file.assUrl?{url:file.assUrl,path:file.assPath}:null,subtitleLabel:`Miruro ${track.label} 자막`,subtitleTrack:track.url})}catch{/* the track list still offers it */}
    return stream;
  };
  // A download keeps one server for the whole episode, and the hosts' speed changes by the hour (one can crawl at a few
  // KB/s while the others are fast): a segment of each is timed and the first fast one is used, else the fastest of
  // up to six, and the download manager fetches its segments itself (mirror). The player can switch servers itself, so
  // it only checks that the playlist answers.
  let lastError=null;const slow=[];
  for(const server of servers.slice().sort((a,b)=>rank(a)-rank(b))){
    try{
      if(episode.download){
        const probe=await hlsProbe(server.url,server.headers);
        if(probe.speed<MIRURO_MIN_SPEED){slow.push({server,probe});if(slow.length<6)continue;break}
        miruroWorkingProvider=server.provider;return result(server,{program:probe.program,mirror:true});
      }
      const response=await fetch(server.url,{signal:AbortSignal.timeout(10000),headers:{'User-Agent':LINKKF_UA,...server.headers}}),text=response.ok?await response.text():'';
      if(!text.startsWith('#EXTM3U'))throw new Error(`HTTP ${response.status}`);
      miruroWorkingProvider=server.provider;
      return result(server);
    }catch(error){lastError=error}
  }
  const fastest=slow.sort((a,b)=>b.probe.speed-a.probe.speed)[0];if(fastest){miruroWorkingProvider=fastest.server.provider;return result(fastest.server,{program:fastest.probe.program,mirror:true})}
  throw new Error(`모든 영상 서버 연결에 실패했습니다.${lastError?` (${lastError.message})`:''}`);
}
// The best variant of an HLS playlist and the speed of one of its segments (KB/s). The variant is FFmpeg's program id
// (variants in playlist order), so a download fetches one quality instead of all of them (Miruro masters list 1080p,
// 720p and 360p).
const MIRURO_MIN_SPEED=300;
async function hlsProbe(url,headers={}){
  const get=async(target,timeout)=>{const response=await fetch(target,{signal:AbortSignal.timeout(timeout),headers:{'User-Agent':LINKKF_UA,...headers}});if(!response.ok)throw new Error(`HTTP ${response.status}`);return response};
  const master=await (await get(url,10000)).text();
  const variants=[...master.matchAll(/#EXT-X-STREAM-INF:([^\r\n]*)\r?\n\s*([^\r\n#][^\r\n]*)/g)].map(match=>({height:Number(match[1].match(/RESOLUTION=\d+x(\d+)/)?.[1])||0,bandwidth:Number(match[1].match(/BANDWIDTH=(\d+)/)?.[1])||0,uri:match[2].trim()}));
  const program=variants.length?variants.reduce((best,item,index)=>(item.height-variants[best].height||item.bandwidth-variants[best].bandwidth)>0?index:best,0):null;
  const base=program==null?url:new URL(variants[program].uri,url).href,media=program==null?master:await (await get(base,10000)).text();
  const segments=media.split(/\r?\n/).filter(line=>line.trim()&&!line.startsWith('#'));if(!segments.length)throw new Error('빈 재생목록');
  const started=Date.now(),size=(await (await get(new URL(segments[Math.min(3,segments.length-1)].trim(),base).href,15000)).arrayBuffer()).byteLength;
  return {program:variants.length>1?program:null,speed:size/1024/Math.max(.05,(Date.now()-started)/1000)};
}

function openProviderPlayer(episode, title = 'LilacAnime Player') {
  const player = new BrowserWindow({width:1180,height:760,minWidth:760,minHeight:500,backgroundColor:'#050407',title,autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  return player.loadURL(episode.url,{httpReferrer:episode.referer||new URL(episode.url).origin+'/'});
}

function parseFlixSubtitleTracks(html=''){
  // Track names can contain brackets ("English [nedragrevev]"), so find the closing ']' outside strings.
  const text=String(html),start=text.search(/subtitles:\[/);if(start<0)return [];
  let end=-1,depth=0,quote='';
  for(let i=text.indexOf('[',start);i<text.length;i++){
    const c=text[i];
    if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue}
    if(c==='"'||c==="'")quote=c;else if(c==='[')depth++;else if(c===']'&&--depth===0){end=i;break}
  }
  const block=end>0?text.slice(text.indexOf('[',start)+1,end):'';if(!block)return [];
  const tracks=[];
  for(const match of block.matchAll(/\{([^{}]*?url:"[^"]+"[^{}]*?)\}/g)){
    const fields={};for(const field of match[1].matchAll(/(?:^|,)\s*(url|language|label|format):"((?:\\.|[^"])*)"/g))fields[field[1]]=decodeJsString(field[2]);
    const url=String(fields.url||'').replace(/\u0026/g,'&');if(!/^https?:/i.test(url))continue;
    const language=fields.language||'und';
    tracks.push({url,language,label:fields.label||language,format:(fields.format||(/\.srt(?:$|\?)/i.test(url)?'srt':/\.ass(?:$|\?)/i.test(url)?'ass':'vtt')).toLowerCase()});
  }
  return tracks.filter((track,index,array)=>array.findIndex(x=>x.url===track.url)===index);
}
function isKoreanTrack(track){return /kor|korean|한국/i.test(`${track.language} ${track.label}`)||/^ko(?:[-_]|$)/i.test(track.language||'')||/_kor_/i.test(track.url)}
// ASS/SSA keep their original file for libass (JASSUB) rendering; every format also gets a
// WebVTT copy for the <track> fallback. Fonts extracted next to the subtitle are passed along.
function subtitleResult(file,extra={}){
  const isAss=/\.(ass|ssa)$/i.test(file),vtt=/\.srt$/i.test(file)?srtToVtt(file):/\.(smi|sami)$/i.test(file)?smiToVtt(file):isAss?assToVtt(file):file;
  const fonts=isAss?fs.readdirSync(path.dirname(file)).filter(name=>/\.(ttf|otf|ttc|woff2?)$/i.test(name)).map(name=>pathToFileURL(path.join(path.dirname(file),name)).href):[];
  return {...extra,path:vtt,url:pathToFileURL(vtt).href,assPath:isAss?file:null,assUrl:isAss?pathToFileURL(file).href:null,fonts};
}
// Downloads a remote VTT/SRT/ASS subtitle and returns the original file (see subtitleResult).
async function saveRemoteSubtitle(url,{referer='',userAgent=LINKKF_UA,headers={}}={}){
  const response=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{...headers,'User-Agent':userAgent,Referer:referer||new URL(url).origin+'/'}});
  if(!response.ok)throw new Error(`자막 다운로드 HTTP ${response.status}`);
  const data=Buffer.from(await response.arrayBuffer());if(!data.length||data.length>=200*1024*1024)throw new Error('자막 파일 크기가 올바르지 않습니다.');
  const text=data.toString('utf8').replace(/^﻿/,''),head=text.trimStart().slice(0,200).toLowerCase();
  if(head.startsWith('<!doctype html')||head.startsWith('<html')||head.startsWith('<head'))throw new Error('자막 대신 HTML 응답을 받았습니다.');
  const ext=/^webvtt/i.test(text.trimStart())?'.vtt':/\[script info\]/i.test(text)?'.ass':/^\s*\d+\s*$/m.test(text)&&text.includes(' --> ')?'.srt':'.vtt';
  const dir=path.join(app.getPath('userData'),'subtitles','provider');fs.mkdirSync(dir,{recursive:true});
  let file=path.join(dir,`subtitle_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);fs.writeFileSync(file,text,'utf8');
  return file;
}

// Android gives the player WebView 30 s (Re:Anime) or 15 s (Linkkf) to expose the stream.
// options: partition (a session of its own, so several pages can be resolved at once without swapping each other's
// request hooks), waitSubtitle (Linkkf pages carry a Korean subtitle requested after the video), signal (stops it).
async function resolveStreamPage(targetUrl, referer = '', timeoutMs = 30000, { partition: ownPartition = '', waitSubtitle = true, signal = null } = {}) {
  const isFlixCloud=/flixcloud\.cc/i.test(targetUrl);
  const partition=ownPartition||(isFlixCloud?'persist:lilac-android-webview-v2':'persist:lilac-provider');
  const browserUa=isFlixCloud?ANDROID_WEBVIEW_UA:LINKKF_UA;
  const resolver=new BrowserWindow({show:false,width:960,height:640,webPreferences:{partition,contextIsolation:true,nodeIntegration:false,sandbox:true,autoplayPolicy:'no-user-gesture-required',backgroundThrottling:false}});
  resolver.webContents.setUserAgent(browserUa);
  const ses=resolver.webContents.session;let stream=null,subtitle=null,lastHeaders={},flixPk='',flixVideo='',flixAudio='';const streams=new Map();
  const filter={urls:['*://*/*']};
  ses.webRequest.onBeforeSendHeaders(filter,(details,callback)=>{const lower=details.url.toLowerCase(),headers=details.requestHeaders||{};if(isFlixCloud){headers['User-Agent']=ANDROID_WEBVIEW_UA;headers['sec-ch-ua']='"Chromium";v="131", "Not_A Brand";v="24"';headers['sec-ch-ua-mobile']='?1';headers['sec-ch-ua-platform']='"Android"';headers['Accept-Language']='en-US,en;q=0.9,ko;q=0.7'}const adMedia=/runative|magsrv|juneworewyjyna|pxltag/i.test(lower),media=lower.includes('.m3u8')||/\.(mp4|webm)(?:\?|$)/i.test(lower);if(media&&!adMedia&&!lower.includes('ad')){streams.set(details.url,{...headers});if(!stream){stream=details.url;lastHeaders={...headers}}}if(!isFlixCloud&&lower.includes('.vtt')&&!/thumbnail/i.test(lower))subtitle ||= details.url;callback({requestHeaders:headers});});
  const stop=()=>{if(!resolver.isDestroyed())resolver.destroy()};signal?.addEventListener('abort',stop);
  try {
    // The address is looked for while the page loads: a player page can keep loading ads for half a minute after the
    // video request this waits for. The time limit covers the load too, so a host that does not answer is left in time.
    let loaded=false,blockChecked=false;
    resolver.loadURL(targetUrl,{httpReferrer:referer||new URL(targetUrl).origin+'/',userAgent:browserUa}).then(()=>{loaded=true},()=>{loaded=true});
    const streamDeadline=Date.now()+timeoutMs;
    while(!stream&&!resolver.isDestroyed()&&Date.now()<streamDeadline){
      if(isFlixCloud&&loaded&&!blockChecked){
        blockChecked=true;
        const blocked=await resolver.webContents.executeJavaScript(`(()=>{const text=(document.title+' '+(document.body?.innerText||'')).toLowerCase();return text.includes('sorry, you have been blocked')||text.includes('you have been blocked')})()`,true).catch(()=>false);
        if(blocked)throw new Error('FlixCloud가 이 앱 세션을 차단했습니다. 다른 영상 서버로 전환합니다.');
      }
      for(const frame of resolver.webContents.mainFrame.frames){
        frame.executeJavaScript(`(()=>{document.querySelectorAll('video').forEach(v=>{v.muted=true;v.play().catch(()=>{})});const els=[...document.querySelectorAll('button,[role=button],.play,.vjs-big-play-button,.jw-display-icon-container,.jw-icon-display,.jwplayer')];const play=els.find(e=>/play|재생|watch|jw-display|jw-icon-display/i.test((e.innerText||e.getAttribute('aria-label')||e.className||'')));if(play&&!play.dataset.lilacClicked){play.dataset.lilacClicked='1';play.click()}let jw=[];try{const api=window.jwplayer?.();const item=api?.getPlaylistItem?.();jw=[item?.file,...(item?.sources||[]).map(x=>x.file)].filter(Boolean);api?.play?.()}catch{}const resources=performance.getEntriesByType('resource').map(e=>e.name);return {urls:[...jw,...resources].filter(u=>/\.(m3u8|mp4|webm)(?:\?|$)/i.test(u)&&!/runative|magsrv|juneworewyjyna|pxltag/i.test(u)),pk:window.__pk||''}})()`,true).then(result=>{if(Array.isArray(result?.urls)){const preferred=result.urls[0];if(preferred&&!stream)stream=preferred}if(result?.pk)flixPk=result.pk}).catch(()=>{});
      }
      await new Promise(resolve=>setTimeout(resolve,350));
    }
    if(isFlixCloud&&stream&&!resolver.isDestroyed()){
      // Done as soon as the playlists (a master, or video and audio) and the key are there; a page that offers
      // something else is taken once its list of addresses has stopped growing for 1.5 s.
      const has=pattern=>[...streams.keys()].some(url=>pattern.test(new URL(url).pathname));
      const complete=()=>has(/master/i)||(has(/\/video(?:\/|\.|$)/i)&&has(/\/audio(?:\/|\.|$)/i));
      const readyDeadline=Date.now()+10000;let previousSize=-1,stableSince=Date.now();
      while(!resolver.isDestroyed()&&Date.now()<readyDeadline){
        if(!flixPk)flixPk=await resolver.webContents.executeJavaScript(`window.__pk||''`,true).catch(()=>'');
        if(streams.size!==previousSize){previousSize=streams.size;stableSince=Date.now()}
        if(flixPk&&(complete()||Date.now()-stableSince>=1500))break;
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      const urls=[...streams.keys()];
      flixVideo=urls.find(url=>/\/video(?:\/|\.|$)/i.test(new URL(url).pathname))||'';
      flixAudio=urls.find(url=>/\/audio(?:\/|\.|$)/i.test(new URL(url).pathname))||'';
      const selected=urls.find(url=>{const p=new URL(url).pathname.toLowerCase();return p.endsWith('master.m3u8')||p.includes('/master')})
        ||flixVideo
        ||urls.find(url=>{const p=new URL(url).pathname.toLowerCase();return !p.includes('/audio/')&&!p.endsWith('/audio.m3u8')})
        ||urls.find(url=>!new URL(url).pathname.toLowerCase().endsWith('/audio.m3u8'))
        ||urls[0];
      if(selected){stream=selected;lastHeaders=streams.get(selected)||lastHeaders}
    }
    let subtitleTracks=[];
    if(isFlixCloud&&!resolver.isDestroyed()){
      // FlixCloud embeds the complete track list in the player HTML. Report every track so the
      // player can offer a choice, and only auto-select Korean (Android v0.3.9).
      const html=await resolver.webContents.executeJavaScript(`document.documentElement.innerHTML||''`,true).catch(()=>'');
      subtitleTracks=parseFlixSubtitleTracks(html);
      subtitle=subtitleTracks.find(isKoreanTrack)?.url||null;
    }
    if(stream&&!subtitle&&!isFlixCloud&&waitSubtitle){const subtitleDeadline=Date.now()+2500;while(Date.now()<subtitleDeadline&&!subtitle)await new Promise(resolve=>setTimeout(resolve,200));}
    if(!stream)throw new Error(resolver.isDestroyed()?'플레이어 창이 닫혀 스트림 탐색을 중단했습니다.':'영상 주소를 찾지 못했습니다 (응답 시간 초과).');
    // The key appears with the player; a page that never sets it is given up instead of waiting forever.
    if(isFlixCloud){const keyDeadline=Date.now()+15000;while(!flixPk&&!resolver.isDestroyed()&&Date.now()<keyDeadline){flixPk=await resolver.webContents.executeJavaScript(`window.__pk||''`,true).catch(()=>'');if(!flixPk)await new Promise(resolve=>setTimeout(resolve,250))}if(!flixPk)throw new Error(resolver.isDestroyed()?'플레이어 창이 닫혀 복호화 키 탐색을 중단했습니다.':'FlixCloud 복호화 키를 찾지 못했습니다.');const headers={...lastHeaders,Referer:targetUrl,'User-Agent':ANDROID_WEBVIEW_UA};stream=flixVideo&&flixAudio?await createFlixAvProxyUrl(flixVideo,flixAudio,flixPk,headers):await createFlixProxyUrl(stream,flixPk,headers);}
    let subtitleUrl=subtitle,subtitlePath=null,subtitleAss=null;if(subtitle){try{const saved=subtitleResult(await saveRemoteSubtitle(subtitle,{referer:targetUrl,userAgent:browserUa,headers:lastHeaders}));subtitleUrl=saved.url;subtitlePath=saved.path;subtitleAss=saved.assUrl?{url:saved.assUrl,path:saved.assPath}:null}catch{/* Community subtitle fallback remains available. */}}
    resolvedStreamHeaders.set(new URL(stream).host,{...lastHeaders,Referer:targetUrl});return {url:stream,subtitleUrl,subtitlePath,subtitleAss,subtitleTracks,headers:lastHeaders,referer:targetUrl};
  } finally {signal?.removeEventListener('abort',stop);ses.webRequest.onBeforeSendHeaders(null);if(!resolver.isDestroyed())resolver.destroy();}
}

function simpleTitle(value=''){return value.toLowerCase().normalize('NFKC').replace(/\[[^\]]*]|\([^)]*\)/g,' ').replace(/\b(?:subtitle|sub)\b|(?:한글|한국어)?\s*자막/gi,' ').replace(/[^a-z0-9가-힣]+/g,' ').trim()}
function titleKey(value=''){const clean=simpleTitle(value),hangul=(clean.match(/[가-힣]+/g)||[]).join('');return hangul.length>=2?hangul:clean.replace(/\s+/g,'')}
// Words such as "청춘 돼지는 ○○의 꿈을 꾸지 않는다" are shared across a whole franchise, so word overlap only
// counts when one title's words all appear in the other; words missing on both sides mean another work.
function titleScore(target,candidate){const keyA=titleKey(target),keyB=titleKey(candidate);if(!keyA||!keyB)return 0;if(keyA===keyB)return 1;if(keyA.includes(keyB)||keyB.includes(keyA))return Math.min(keyA.length,keyB.length)/Math.max(keyA.length,keyB.length);const a=[...new Set(simpleTitle(target).split(' ').filter(Boolean))],b=[...new Set(simpleTitle(candidate).split(' ').filter(Boolean))];if(!a.length||!b.length)return 0;const found=(x,list)=>list.some(y=>Math.min(x.length,y.length)>=2&&(y.includes(x)||x.includes(y)));const missingA=a.filter(x=>x.length>=2&&!found(x,b)),missingB=b.filter(y=>y.length>=2&&!found(y,a));if(missingA.length&&missingB.length)return 0;return Math.min((a.length-missingA.length)/a.length,(b.length-missingB.length)/b.length)}
// Same as Android KairanSubtitleService/GoogleDriveDownloader: 15 s to connect, 60 s without data.
async function downloadBuffer(url,referer){
  const controller=new AbortController();let timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(url,{signal:controller.signal,headers:{'User-Agent':LINKKF_UA,Referer:referer||url}});if(!response.ok)throw new Error(`자막 다운로드 HTTP ${response.status}`);
    const chunks=[];const reader=response.body.getReader();
    for(;;){clearTimeout(timer);timer=setTimeout(()=>controller.abort(),60000);const {done,value}=await reader.read();if(done)break;chunks.push(value)}
    return Buffer.concat(chunks);
  }catch(error){if(error.name==='AbortError')throw new Error('자막 다운로드 시간이 초과되었습니다.');throw error}finally{clearTimeout(timer)}
}
function driveId(url){return url.match(/\/file\/d\/([^/?]+)/)?.[1]||url.match(/[?&]id=([^&]+)/)?.[1]||null}
function findExecutable(name){const suffix=process.platform==='win32'?'.exe':'';const candidates=(process.env.PATH||'').split(path.delimiter).map(dir=>path.join(dir,`${name}${suffix}`));if(process.platform==='win32'){candidates.push(path.join(process.env.LOCALAPPDATA||'','Programs','mpv','mpv.exe'),path.join(process.env.PROGRAMFILES||'','mpv','mpv.exe'),path.join(app.getAppPath(),'bin','mpv.exe'))}return candidates.find(file=>file&&fs.existsSync(file))||null}
// Reads the English family name (name ID 1) from a TTF/OTF, or the first font of a TTC.
function fontFamilyName(data){
  let offset=0;if(data.toString('latin1',0,4)==='ttcf')offset=data.readUInt32BE(12);
  const tables=data.readUInt16BE(offset+4);let nameTable=-1;
  for(let i=0;i<tables;i++){const record=offset+12+i*16;if(data.toString('latin1',record,record+4)==='name'){nameTable=data.readUInt32BE(record+8);break}}
  if(nameTable<0)return '';
  const count=data.readUInt16BE(nameTable+2),strings=nameTable+data.readUInt16BE(nameTable+4);let fallback='';
  for(let i=0;i<count;i++){
    const record=nameTable+6+i*12,platform=data.readUInt16BE(record),language=data.readUInt16BE(record+4),nameId=data.readUInt16BE(record+6),length=data.readUInt16BE(record+8),start=strings+data.readUInt16BE(record+10);
    if(nameId!==1)continue;
    const raw=data.subarray(start,start+length),text=platform===3||platform===0?Buffer.from(raw).swap16().toString('utf16le'):raw.toString('latin1');
    if(platform===3&&language===0x409)return text.trim();fallback ||= text.trim();
  }
  return fallback;
}
// Korean SRT/SMI files are often CP949 or UTF-16 rather than UTF-8.
function readSubtitleText(file){
  const data=fs.readFileSync(file);
  if(data[0]===0xff&&data[1]===0xfe)return new TextDecoder('utf-16le').decode(data.subarray(2));
  if(data[0]===0xfe&&data[1]===0xff)return new TextDecoder('utf-16be').decode(data.subarray(2));
  try{return new TextDecoder('utf-8',{fatal:true}).decode(data).replace(/^\uFEFF/,'')}catch{return new TextDecoder('euc-kr').decode(data)}
}
// Android prepareSmiAsVttFile: each <SYNC Start=ms> cue lasts until the next SYNC (or 5 s for the last one).
function smiToVtt(file){
  const source=readSubtitleText(file),syncs=[...source.matchAll(/<sync\s+start\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\s+start\s*=|$)/gi)];
  const clean=raw=>raw.replace(/<br\s*\/?>/gi,'\n').replace(/<\/p\s*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/g,"'").split('\n').map(line=>line.trim()).join('\n').trim();
  const clock=ms=>{const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,sec=Math.floor(ms/1000)%60;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`};
  const cues=syncs.map((match,index)=>{const start=Number(match[1]),end=syncs[index+1]?Number(syncs[index+1][1]):start+5000,text=clean(match[2]);return end>start&&text?`${index+1}\n${clock(start)} --> ${clock(end)}\n${text}`:null}).filter(Boolean);
  const out=file.replace(/\.(smi|sami)$/i,'.vtt');fs.writeFileSync(out,`WEBVTT\n\n${cues.join('\n\n')}\n`,'utf8');return out;
}
function srtToVtt(file){const text=readSubtitleText(file).replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2');const out=file.replace(/\.srt$/i,'.vtt');fs.writeFileSync(out,`WEBVTT\n\n${text}`,'utf8');return out}
function assToVtt(file){const lines=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/);let inEvents=false,fields=[];const cues=[];const stamp=value=>{const match=String(value).trim().match(/(\d+):(\d{2}):(\d{2})[.](\d{1,3})/);if(!match)return null;return `${String(match[1]).padStart(2,'0')}:${match[2]}:${match[3]}.${match[4].padEnd(3,'0').slice(0,3)}`};for(const line of lines){if(/^\[Events]/i.test(line)){inEvents=true;continue}if(/^\[/.test(line)){inEvents=false;continue}if(!inEvents)continue;if(/^Format:/i.test(line)){fields=line.slice(line.indexOf(':')+1).split(',').map(x=>x.trim().toLowerCase());continue}if(!/^Dialogue:/i.test(line)||!fields.length)continue;const raw=line.slice(line.indexOf(':')+1),parts=raw.split(','),values=parts.slice(0,fields.length-1);values.push(parts.slice(fields.length-1).join(','));const row=Object.fromEntries(fields.map((field,index)=>[field,values[index]||'']));const start=stamp(row.start),end=stamp(row.end);if(!start||!end)continue;const text=(row.text||'').replace(/\{[^}]*}/g,'').replace(/\\[Nn]/g,'\n').replace(/\\h/g,' ').trim();if(text)cues.push(`${start} --> ${end}\n${text}`)}const out=file.replace(/\.(ass|ssa)$/i,'.vtt');fs.writeFileSync(out,`WEBVTT\n\n${cues.join('\n\n')}\n`,'utf8');return out}
// Local audio analysis over downloaded episodes only (Android LinkkfChapterService.detectSkipSegmentsOffline).
// Results are cached per title and episode.
async function analyzeOfflineOpEd({title,episode,currentUrl,duration,candidates,status=()=>{}}){
  const cacheFile=path.join(app.getPath('userData'),'oped-fingerprint-cache.json'),key=`v6-offline:${simpleTitle(title)}:${Number(episode)||1}`;let cache={};try{cache=JSON.parse(fs.readFileSync(cacheFile,'utf8'))}catch{}if(Array.isArray(cache[key])&&cache[key].length)return cache[key];
  const segments=await detectOpEd({currentUrl,duration:Number(duration),currentHeaders:{},candidates,resolveEpisode:candidate=>Promise.resolve({url:candidate.localUrl,headers:{}}),status});
  if(segments.length){cache[key]=segments;try{fs.writeFileSync(cacheFile,JSON.stringify(cache),'utf8')}catch{}}
  return segments;
}
// Korean titles for Re:ANIME entries (Kairan/Csora posts are Korean): TMDB's ko-KR names with the user's
// TMDB API key (설정 > 한국어 제목 검색), then AniList and Wikidata. Seasons are read from the original title,
// so the series name is enough.
const koreanTitleCache=new Map();
function koreanTitleCacheFile(){return path.join(app.getPath('userData'),'korean-title-cache.json')}
function readKoreanTitleCache(){try{return JSON.parse(fs.readFileSync(koreanTitleCacheFile(),'utf8'))||{}}catch{return {}}}
function tmdbSettingsFile(){return path.join(app.getPath('userData'),'tmdb.json')}
function tmdbKey(){try{return String(JSON.parse(fs.readFileSync(tmdbSettingsFile(),'utf8')).key||'').trim()}catch{return ''}}
// A v4 "API Read Access Token" is a JWT sent as a bearer token; a v3 "API Key" goes in the query string.
async function tmdbFetch(pathname,params={},key=tmdbKey()){
  if(!key)throw new Error('TMDB API 키가 없습니다.');
  const url=new URL(`https://api.themoviedb.org/3${pathname}`),bearer=key.includes('.');
  for(const [name,value] of Object.entries(params))url.searchParams.set(name,value);
  if(!bearer)url.searchParams.set('api_key',key);
  const response=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{Accept:'application/json',...(bearer?{Authorization:`Bearer ${key}`}:{})}});
  if(!response.ok)throw new Error(response.status===401?'TMDB API 키가 올바르지 않습니다.':`TMDB HTTP ${response.status}`);
  return response.json();
}
// TMDB keeps seasons inside one series, so season words are dropped; a subtitle after ":" is dropped on a
// second try ("Ascendance of a Bookworm: Adopted Daughter of an Archduke" is listed as the series).
// TMDB keeps a franchise's seasons in one series, so its alternative titles can name another season
// ("청춘 돼지는 산타클로스의…" under "청춘 돼지는 바니걸 선배의…"). Such a title shares several words with the
// main name but each has words the other lacks; a genuinely different name ("봇치 더 록!" for
// "외톨이 THE ROCK!") shares none.
function siblingTitle(main,other){
  if(!main||!other)return false;
  const words=value=>[...new Set(simpleTitle(value).split(' ').filter(word=>word.length>=2))],a=words(main),b=words(other);
  const found=(word,list)=>list.some(item=>item.includes(word)||word.includes(item));
  const shared=a.filter(word=>found(word,b)).length;
  return shared>=2&&a.some(word=>!found(word,b))&&b.some(word=>!found(word,a));
}
// TMDB lists later seasons with their own names ("Rascal Does Not Dream of Santa Claus" is season 2 of
// "…Bunny Girl Senpai"). When the English title matches a named season, that season's Korean name is used;
// a ko-KR name that is only a subtitle ("시즌 2: 영주의 양녀") is appended to the series name. Seasons named
// just "Season N" are left to the series name and the season number in the English title.
async function tmdbSeasonTitle(id,original){
  const [en,ko]=await Promise.all([tmdbFetch(`/tv/${id}`,{language:'en-US'}),tmdbFetch(`/tv/${id}`,{language:'ko-KR'})]);
  const key=titleCompareKey(original);
  // Season 1 is often named after the series, which every later title also contains: take the longest match.
  const season=(en.seasons||[]).filter(item=>!/^(?:season\s*\d+|specials)$/i.test(item.name||'')&&titleCompareKey(item.name).length>=6&&key.includes(titleCompareKey(item.name))).sort((a,b)=>titleCompareKey(b.name).length-titleCompareKey(a.name).length)[0];
  const name=String((ko.seasons||[]).find(item=>item.season_number===season?.season_number)?.name||'').replace(/^시즌\s*\d+\s*[:：]?\s*/,'').trim();
  if(!season||!/[가-힣]{2}/.test(name))return '';
  const series=String(ko.name||'').trim(),firstWord=simpleTitle(series).split(' ')[0]||'';
  return firstWord&&simpleTitle(name).includes(firstWord)?name:`${series.replace(/\s*[~〜～][^~〜～]*[~〜～]\s*/g,' ').trim()} ${name}`;
}
async function tmdbKoreanTitles(titles,{light=false}={}){
  const queries=[];
  for(const title of titles){
    const base=String(title||'').replace(/…/g,'...').replace(/\s*(?:season\s*\d+|\d+(?:st|nd|rd|th)\s*season|part\s*\d+|第\d+期)\s*$/i,'').replace(/[:：]\s*$/,'').trim();
    for(const query of [base,base.split(/\s*[:：]\s+|\s+-\s+/)[0]])if(query&&!/[가-힣]/.test(query)&&!queries.includes(query))queries.push(query);
  }
  const found=[];
  for(const query of queries){
    for(const kind of ['tv','movie']){
      // The same search in English and Korean: the English names pick the work (TMDB can rank a spin-off such as
      // "Attack on Titan: Junior High" first), the Korean results give its ko-KR name.
      const [enRoot,koRoot]=await Promise.all([tmdbFetch(`/search/${kind}`,{query,language:'en-US',include_adult:'false'}),tmdbFetch(`/search/${kind}`,{query,language:'ko-KR',include_adult:'false'})]);
      const japanese=item=>Number(item.origin_country?.includes?.('JP')||item.original_language==='ja');
      const animation=(enRoot?.results||[]).filter(item=>(item.genre_ids||[]).includes(16)),wantedKey=titleCompareKey(query),nameKey=item=>titleCompareKey(item.name||item.title||'');
      // Otherwise TMDB's own ranking (Japanese works first): "Grand Blue" is listed as "Grand Blue Dreaming", and a
      // prefix match would pick the unrelated "Grand Blues!".
      const pick=animation.find(item=>nameKey(item)===wantedKey)||animation.slice().sort((a,b)=>japanese(b)-japanese(a))[0];
      const results=pick?[(koRoot?.results||[]).find(item=>item.id===pick.id)||pick]:[];
      // Everything after the first title must not name another season of the same franchise.
      const add=name=>{name=String(name||'').trim();if(/[가-힣]{2}/.test(name)&&!found.includes(name)&&!siblingTitle(found[0],name))found.push(name)};
      if(kind==='tv'&&results[0])add(await tmdbSeasonTitle(results[0].id,titles[0]).catch(()=>''));
      if(results[0]&&/[가-힣]/.test(results[0].name||results[0].title||''))add(results[0].name||results[0].title);
      // Fan subtitle blogs often use a different Korean title than the official one
      // ("봇치 더 록!" rather than "외톨이 THE ROCK!"); TMDB lists those as Korean alternative titles.
      if(results[0]&&!light){const alt=await tmdbFetch(`/${kind}/${results[0].id}/alternative_titles`).catch(()=>null);for(const item of [...(alt?.results||[]),...(alt?.titles||[])])if(item.iso_3166_1==='KR')add(item.title)}
      if(found.length)return found;
    }
  }
  return found;
}
// Fallbacks when TMDB has no Korean name (or no key is set): AniList's Korean synonyms, then the Korean
// Wikidata labels of the work and its series, looked up by MAL/AniList ID.
function titleCompareKey(value=''){return String(value).normalize('NFKC').toLowerCase().replace(/…/g,'...').replace(/[\s:：'’"“”!！?？.,·・\-–—~〜()（）]/g,'')}
async function anilistMedia(title,anime){
  // Without an ID, prefer an exact title match, then a TV series: the top hit can be a spin-off
  // ("Frieren" returns the mini anime first).
  const id=Number(anime.anilistId)||null;
  const query=`query($id:Int,$search:String){Page(perPage:5){media(id:$id,search:$search,type:ANIME,sort:SEARCH_MATCH){id idMal format synonyms title{romaji english}}}}`;
  const response=await fetch('https://graphql.anilist.co',{signal:AbortSignal.timeout(25000),method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'LilacAnime Android'},body:JSON.stringify({query,variables:id?{id}:{search:title.replace(/…/g,'...')}})});
  const list=response.ok?(await response.json())?.data?.Page?.media||[]:[],same=value=>titleCompareKey(value||'')===titleCompareKey(title);
  return list.find(item=>same(item.title?.english)||same(item.title?.romaji))||list.find(item=>item.format==='TV')||list[0]||null;
}
async function wikidataKoreanTitles(malId,anilistId){
  const where=[malId&&`{?item wdt:P4086 "${malId}"}`,anilistId&&`{?item wdt:P8729 "${anilistId}"}`].filter(Boolean).join(' UNION ');if(!where)return [];
  const sparql=`SELECT ?ko ?seriesKo WHERE { ${where} OPTIONAL{?item rdfs:label ?ko FILTER(lang(?ko)="ko")} OPTIONAL{?item wdt:P179 ?series. ?series rdfs:label ?seriesKo FILTER(lang(?seriesKo)="ko")} } LIMIT 5`;
  const response=await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,{signal:AbortSignal.timeout(25000),headers:{Accept:'application/sparql-results+json','User-Agent':`LilacAnime-Desktop/${app.getVersion()} (https://github.com/whispelyn-byte/LilacAnime-desktop)`}});
  return response.ok?((await response.json())?.results?.bindings||[]).flatMap(row=>[row.ko?.value,row.seriesKo?.value]):[];
}
// Order: TMDB (needs the user's key), then AniList, then Wikidata; each is only asked when the previous
// one found nothing.
async function koreanTitleCandidates(title,anime={}){
  const original=String(title||'').trim();if(!original||/[가-힣]/.test(original))return original?[original]:[];
  const tmdb=Boolean(tmdbKey()),key=`${tmdb?'tmdb':'free'}:${anime.id||original}`;if(koreanTitleCache.has(key))return koreanTitleCache.get(key);
  const disk=readKoreanTitleCache();if(Array.isArray(disk[key])&&disk[key].length){koreanTitleCache.set(key,disk[key]);return disk[key]}
  const found=[],add=value=>{const clean=String(value||'').replace(/\((?:애니메이션|TV|애니)[^)]*\)/g,'').replace(/\s+/g,' ').trim();if(/[가-힣]{2}/.test(clean)&&!found.includes(clean))found.push(clean)};
  if(tmdb){
    // Re:ANIME and Miruro also know the Japanese title, which TMDB matches as the original name.
    let native='';
    if(anime.id&&anime.provider==='reanime'){try{const media=await providerFetch(`${REANIME_WEB}/api/v1/anime/${encodeURIComponent(anime.id)}`,{json:true,referer:`${REANIME_WEB}/`});native=String(media?.title?.native||'')}catch{/* English only */}}
    else if(anime.id&&anime.provider==='miruro')native=String(anime.title_japanese||'')||await miruroApi(`anime/${anime.id}`).then(media=>String(media?.title?.native||'')).catch(()=>'');
    (await tmdbKoreanTitles([original,native]).catch(()=>[])).forEach(add);
  }
  let media=null;
  if(!found.length){media=await anilistMedia(original,anime).catch(()=>null);(media?.synonyms||[]).forEach(add)}
  if(!found.length){const malId=Number(anime.malId)||media?.idMal||null,anilistId=Number(anime.anilistId)||media?.id||null;(await wikidataKoreanTitles(malId,anilistId).catch(()=>[])).forEach(add)}
  const result=found.length?found:[original];koreanTitleCache.set(key,result);
  if(found.length){disk[key]=found;try{fs.writeFileSync(koreanTitleCacheFile(),JSON.stringify(disk),'utf8')}catch{}}
  return result;
}
// Display titles (설정 > 작품 제목 표시). Korean names come from the same TMDB → AniList → Wikidata lookup as the
// subtitle search, English names from the provider, AniList (by ID) or TMDB. Results, misses included, are
// kept on disk for a week so lists do not repeat the lookups.
const DISPLAY_TITLE_TTL=7*24*60*60*1000;
let displayTitleDisk=null;
function displayTitleFile(){return path.join(app.getPath('userData'),'display-title-cache.json')}
function displayTitleStore(){if(!displayTitleDisk){try{displayTitleDisk=JSON.parse(fs.readFileSync(displayTitleFile(),'utf8'))||{}}catch{displayTitleDisk={}}}return displayTitleDisk}
let displayTitleSaveTimer=null;
function saveDisplayTitles(){clearTimeout(displayTitleSaveTimer);displayTitleSaveTimer=setTimeout(()=>{try{fs.writeFileSync(displayTitleFile(),JSON.stringify(displayTitleStore()),'utf8')}catch{}},1000)}
const hasHangul=value=>/[가-힣]/.test(String(value||''));
async function englishTitleFor(anime){
  if(anime.title_english&&!hasHangul(anime.title_english))return anime.title_english;
  if(anime.title&&!hasHangul(anime.title))return anime.title;
  if(Number(anime.anilistId)){
    const media=await anilistMedia(anime.title||'',{anilistId:anime.anilistId}).catch(()=>null);
    if(media?.title?.english||media?.title?.romaji)return media.title.english||media.title.romaji;
  }
  if(tmdbKey()&&anime.title){
    // TMDB matches the Korean translation and answers in the requested language.
    for(const kind of ['tv','movie']){
      const root=await tmdbFetch(`/search/${kind}`,{query:anime.title,language:'en-US',include_adult:'false'}).catch(()=>null);
      const item=(root?.results||[]).find(result=>(result.genre_ids||[]).includes(16));
      if(item&&(item.name||item.title)&&!hasHangul(item.name||item.title))return item.name||item.title;
    }
  }
  return anime.title_japanese||'';
}
async function displayKoreanTitle(title,anime){
  if(tmdbKey()){const found=(await tmdbKoreanTitles([title],{light:true}).catch(()=>[])).find(hasHangul);if(found)return found}
  const clean=value=>String(value||'').replace(/\((?:애니메이션|TV|애니)[^)]*\)/g,'').replace(/\s+/g,' ').trim();
  const media=await anilistMedia(title,anime).catch(()=>null),synonym=(media?.synonyms||[]).map(clean).find(value=>/[가-힣]{2}/.test(value));if(synonym)return synonym;
  const malId=Number(anime.malId)||media?.idMal||null,anilistId=Number(anime.anilistId)||media?.id||null;
  return (await wikidataKoreanTitles(malId,anilistId).catch(()=>[])).map(clean).find(value=>/[가-힣]{2}/.test(value))||'';
}
async function resolveDisplayTitle(anime={}){
  const key=`${anime.provider||'jikan'}:${anime.id??anime.mal_id}`,store=displayTitleStore(),cached=store[key];
  const title=String(anime.title||'').trim();
  // Entries saved before a season form was recognised get it here.
  if(cached&&Date.now()-cached.time<DISPLAY_TITLE_TTL)return {key,ko:withSeason(cached.ko||'',title),en:cached.en||''};
  const ko=withSeason(hasHangul(title)?title:await displayKoreanTitle(title,anime).catch(()=>''),title);
  const en=await englishTitleFor(anime).catch(()=>'');
  const merged={ko:ko||cached?.ko||'',en:en||cached?.en||''};
  store[key]={...merged,time:Date.now()};saveDisplayTitles();
  return {key,...merged};
}
// --- Catalog title indexes (Re:Anime, Animenosub) ----------------------------------------------
// The whole catalog of a source, so a Korean search also finds titles never shown in the app. Korean names go into
// the display-title store: Wikidata in one query by AniList id (Re:Anime), then a TMDB lookup for each remaining
// entry (needs the key), in catalog order, in the background. Lists are refreshed daily; every entry is looked up
// once (misses again after 30 days). Kept on disk per source.
const DAY=24*60*60*1000;
const CATALOGS={
  // Re:Anime: about 20,000 entries, 100 per request, most popular first.
  reanime:{label:'Re:Anime',fetch:fetchReanimeCatalog,wikidata:true},
  // Animenosub: the anime sitemaps list every series (about 1,400) with its poster, newest first. The address only
  // gives a lossy title ("im-looking-for-a-zombie"), so the series page is read once for the real one.
  animenosub:{label:'Animenosub',fetch:fetchAnimenosubCatalog,title:animenosubRealTitle},
  // Linkkf titles are already Korean, so only the list is loaded.
  linkkf:{label:'Linkkf',fetch:downloadLinkkfCatalog,korean:false}
};
const catalogIndexes={};
let catalogIndexRunning=false,catalogRetryTimer=null;
// activeCatalogSource (declared with the Linkkf catalog): the source in use; only that one loads in the background.
function catalogIndex(provider){
  if(catalogIndexes[provider])return catalogIndexes[provider];
  const index={items:[],updated:0,wikidata:0,tried:{},status:'idle'};
  const file=name=>path.join(app.getPath('userData'),`${provider}-${name}.json`);
  try{Object.assign(index,JSON.parse(fs.readFileSync(file('index'),'utf8')))}catch{/* first run */}
  try{index.tried={...index.tried,...JSON.parse(fs.readFileSync(file('tried'),'utf8'))}}catch{/* none yet */}
  return catalogIndexes[provider]=index;
}
// The list (several MB) is written when it changes; the small "looked up" marks separately while TMDB runs.
const indexSaveTimers={};
function saveCatalogFile(provider,name,value){const key=`${provider}-${name}`;clearTimeout(indexSaveTimers[key]);indexSaveTimers[key]=setTimeout(()=>{try{fs.writeFileSync(path.join(app.getPath('userData'),`${key}.json`),JSON.stringify(value()))}catch{}},2000)}
function saveCatalogIndex(provider){const index=catalogIndex(provider);saveCatalogFile(provider,'index',()=>({items:index.items,updated:index.updated,wikidata:index.wikidata}))}
function saveCatalogTried(provider){const index=catalogIndex(provider);saveCatalogFile(provider,'tried',()=>index.tried)}
const indexKorean=(provider,item)=>withSeason(displayTitleStore()[`${provider}:${item.id}`]?.ko||'',item.title);
function catalogIndexState(){return {tmdb:Boolean(tmdbKey()),sources:Object.entries(CATALOGS).filter(([provider])=>provider===activeCatalogSource).map(([provider,{label,korean}])=>{const index=catalogIndex(provider);return {provider,label,status:index.status,total:index.items.length,korean:korean===false?null:index.items.filter(item=>indexKorean(provider,item)).length}})}}
function reportCatalogIndex(provider,status){
  catalogIndex(provider).status=status;const state=catalogIndexState();
  BrowserWindow.getAllWindows().forEach(win=>{if(!win.isDestroyed())win.webContents.send('catalog-index:state',state)});
}
function storeIndexKorean(provider,item,ko){
  ko=withSeason(ko,item.title);
  const key=`${provider}:${item.id}`,store=displayTitleStore();store[key]={ko,en:store[key]?.en||item.title,time:Date.now()};
}
async function fetchReanimeCatalog(){
  const page=offset=>providerFetch(`${REANIME_WEB}/api/v1/search?limit=100&offset=${offset}`,{json:true,referer:`${REANIME_WEB}/search`});
  const first=await page(0),total=Number(first?.total)||0,roots=[first],offsets=[];
  for(let offset=100;offset<total;offset+=100)offsets.push(offset);
  let next=0;
  // Stops when another source is selected (the list is then incomplete and dropped below).
  await Promise.all(Array.from({length:4},async()=>{while(next<offsets.length&&activeCatalogSource==='reanime'){const offset=offsets[next++];for(let attempt=0;attempt<2;attempt++){try{roots.push(await page(offset));break}catch{/* once more */}}}}));
  const items=new Map();
  for(const root of roots){
    const popularity=new Map((root?.results||[]).map(raw=>[String(raw.anime_id),Number(raw.popularity)||0]));
    for(const item of reanimeItems(root)){delete item.synopsis;item.popularity=popularity.get(String(item.id))||0;items.set(item.id,item)}
  }
  // A partial download keeps the previous list.
  if(!total||items.size<total*.9)throw new Error(`Re:Anime 목록을 다 받지 못했습니다 (${items.size}/${total}).`);
  return [...items.values()].sort((a,b)=>b.popularity-a.popularity);
}
async function fetchAnimenosubCatalog(previous=[]){
  const known=new Map(previous.map(item=>[item.id,item])),index=await providerFetch(`${ANIMENOSUB_WEB}/sitemap_index.xml`,{referer:`${ANIMENOSUB_WEB}/`});
  const maps=[...index.matchAll(/<loc>([^<]*\/anime-sitemap\d*\.xml)<\/loc>/g)].map(match=>match[1]);
  if(!maps.length)throw new Error('Animenosub 사이트맵을 찾지 못했습니다.');
  const items=[],seen=new Set();
  for(const map of maps){
    if(activeCatalogSource!=='animenosub')throw new Error('다른 소스로 바뀌었습니다.');
    const xml=await providerFetch(map,{referer:`${ANIMENOSUB_WEB}/`});
    for(const [,block] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)){
      const slug=block.match(/<loc>[^<]*\/anime\/([^/<]+)\/?<\/loc>/)?.[1]?.toLowerCase();if(!slug||seen.has(slug))continue;seen.add(slug);
      const old=known.get(slug),poster=block.match(/<image:loc>([^<]*)<\/image:loc>/)?.[1]||'';
      items.push(old||{provider:'animenosub',id:slug,mal_id:`animenosub:${slug}`,title:slug.replace(/-+/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),title_english:'',images:{webp:{large_image_url:poster}},score:null,year:'',type:'Anime',episodes:null,genres:[],studios:[],url:`${ANIMENOSUB_WEB}/anime/${slug}/`,slugTitle:true});
    }
  }
  return items;
}
async function animenosubRealTitle(item){
  if(!item.slugTitle)return;
  const title=animenosubDetail(await providerFetch(item.url,{referer:`${ANIMENOSUB_WEB}/`}),item).title;
  if(title){item.title=title;delete item.slugTitle}
}
async function wikidataKoreanByAnilist(){
  const query='SELECT ?al ?ko WHERE { ?item wdt:P8729 ?al . ?item rdfs:label ?ko FILTER(LANG(?ko)="ko") }';
  const response=await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`,{signal:AbortSignal.timeout(90000),headers:{Accept:'application/sparql-results+json','User-Agent':`LilacAnime-Desktop/${app.getVersion()} (https://github.com/whispelyn-byte/LilacAnime-desktop)`}});
  if(!response.ok)throw new Error(`Wikidata HTTP ${response.status}`);
  const map=new Map();for(const row of (await response.json())?.results?.bindings||[]){const id=Number(row.al?.value),ko=String(row.ko?.value||'').trim();if(id&&/[가-힣]/.test(ko)&&!map.has(id))map.set(id,ko)}
  return map;
}
async function refreshCatalogList(provider){
  const index=catalogIndex(provider);
  if(index.items.length&&Date.now()-index.updated<DAY)return;
  reportCatalogIndex(provider,'catalog');
  try{index.items=await CATALOGS[provider].fetch(index.items);index.updated=Date.now();saveCatalogIndex(provider)}catch{
    // The previous list stays; the download is tried again in 30 minutes, also while the source is down.
    clearTimeout(catalogRetryTimer);catalogRetryTimer=setTimeout(()=>buildCatalogIndexes().catch(()=>{}),30*60*1000);catalogRetryTimer.unref?.();
  }
  if(CATALOGS[provider].wikidata&&index.items.length&&Date.now()-index.wikidata>7*DAY){
    reportCatalogIndex(provider,'wikidata');
    try{const map=await wikidataKoreanByAnilist();for(const item of index.items)if(item.anilistId&&map.has(item.anilistId)&&!indexKorean(provider,item))storeIndexKorean(provider,item,map.get(item.anilistId));saveDisplayTitles();index.wikidata=Date.now();saveCatalogIndex(provider)}catch{/* next run */}
  }
  reportCatalogIndex(provider,index.items.length?'waiting':'error');
}
// TMDB, six entries at a time (well under its request limit).
async function lookupCatalogKorean(provider){
  if(CATALOGS[provider].korean===false)return;
  const index=catalogIndex(provider),queue=index.items.filter(item=>!indexKorean(provider,item)&&!(Date.now()-(index.tried[item.id]||0)<30*DAY));
  let done=0,titled=false;
  while(tmdbKey()&&queue.length&&activeCatalogSource===provider){
    reportCatalogIndex(provider,'tmdb');
    await Promise.all(queue.splice(0,6).map(async item=>{
      // A title read from the series page (Animenosub) changes the list itself.
      try{if(item.slugTitle){await CATALOGS[provider].title?.(item);titled=true}}catch{/* the slug title still works */}
      const ko=(await tmdbKoreanTitles([item.title],{light:true}).catch(()=>[])).find(hasHangul);
      index.tried[item.id]=Date.now();if(ko)storeIndexKorean(provider,item,ko);
    }));
    if(++done%50===0){saveDisplayTitles();saveCatalogTried(provider);if(titled){saveCatalogIndex(provider);titled=false}}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(done){saveDisplayTitles();saveCatalogTried(provider);if(titled)saveCatalogIndex(provider)}
}
async function buildCatalogIndexes(){
  if(catalogIndexRunning)return;catalogIndexRunning=true;
  try{
    // Again when the source changed while this ran.
    for(let provider=activeCatalogSource;CATALOGS[provider];provider=activeCatalogSource!==provider?activeCatalogSource:null){
      await refreshCatalogList(provider);await lookupCatalogKorean(provider);
      if(activeCatalogSource===provider)reportCatalogIndex(provider,catalogIndex(provider).items.length?'ready':'error');
    }
  }finally{catalogIndexRunning=false}
}
// Korean search over a whole catalog, in catalog order: the Korean names found so far, then the entries whose own
// (English) title contains an English name of the query. Animenosub has no bulk Korean source like Re:Anime's
// Wikidata, so most of its entries are only reached the second way until TMDB has gone through the list; Re:Anime
// answers from its Korean names alone, without waiting for the TMDB / AniList lookup.
async function searchCatalogIndex(provider,query){
  const key=titleCompareKey(query);if(!key||!CATALOGS[provider])return [];
  const items=catalogIndex(provider).items,korean=items.filter(item=>{const ko=indexKorean(provider,item);return ko&&titleCompareKey(ko).includes(key)});
  const english=CATALOGS[provider].wikidata?[]:(await titleSearchVariants(query).catch(()=>[])).filter(value=>!hasHangul(value)).map(titleCompareKey).filter(value=>value.length>=6);
  const seen=new Set(korean),byEnglish=english.length?items.filter(item=>!seen.has(item)&&english.some(value=>titleCompareKey(item.title).includes(value))):[];
  return [...korean,...byEnglish].slice(0,60).map(({slugTitle,popularity,...item})=>item);
}
// Other-language spellings of a search query, so Korean and English searches both reach every source. The
// renderer and the catalog search ask for the same query at once, so lookups are shared for a few minutes.
const titleVariantCache=new Map();
function titleSearchVariants(query){
  const text=String(query||'').trim();if(!text)return Promise.resolve([]);
  const cached=titleVariantCache.get(text);if(cached&&Date.now()-cached.time<5*60*1000)return cached.promise;
  if(titleVariantCache.size>100)titleVariantCache.clear();
  const promise=lookupTitleVariants(text);titleVariantCache.set(text,{time:Date.now(),promise});promise.catch(()=>titleVariantCache.delete(text));
  return promise;
}
async function lookupTitleVariants(text){
  const korean=hasHangul(text),variants=new Set(),key=titleCompareKey(text);
  // Every title already shown in the other language whose shown name contains the query (all of them, so a
  // series with several seasons or movies is found whole), then TMDB / AniList for titles not seen yet.
  for(const entry of Object.values(displayTitleStore())){
    const ko=withSeason(entry.ko||'',entry.en||''),from=korean?ko:entry.en,to=korean?entry.en:ko;
    if(from&&to&&titleCompareKey(from).includes(key))variants.add(to);
  }
  const [tv,movie,media]=await Promise.all([
    ...['tv','movie'].map(kind=>tmdbKey()?tmdbFetch(`/search/${kind}`,{query:text,language:korean?'en-US':'ko-KR',include_adult:'false'}).catch(()=>null):null),
    korean?anilistMedia(text,{}).catch(()=>null):null]);
  for(const root of [tv,movie])for(const item of (root?.results||[]).filter(result=>(result.genre_ids||[]).includes(16)).slice(0,2)){const name=item.name||item.title;if(name&&hasHangul(name)!==korean)variants.add(name)}
  if(media?.title?.english)variants.add(media.title.english);
  return [...variants].filter(value=>titleCompareKey(value)!==key).slice(0,30);
}
// Tries each Korean title until a Kairan/Csora post matches.
async function findCommunitySubtitleByTitles(source,titles,episode,options){
  let lastError=null;
  for(const title of titles){try{return {...await (source==='anissia'?findAnissiaSubtitle(title,episode,options):findCommunitySubtitle(source,title,episode,options)),searchTitle:title}}catch(error){lastError=error}}
  throw lastError||new Error('자막 게시물을 찾지 못했습니다.');
}
// Blogger feeds return at most 150 posts per request, so the whole blog is paged in. Like Android the index is
// kept on disk for a day, a failed refresh falls back to the stale copy, and a miss refreshes once (below).
const communityPostCache=new Map();
async function communityPosts(blog,{force=false}={}){
  const file=path.join(app.getPath('userData'),`community-${new URL(blog).hostname.split('.')[0]}.json`);
  let cached=communityPostCache.get(blog);if(!cached){try{cached=JSON.parse(fs.readFileSync(file,'utf8'))}catch{cached=null}}
  const age=cached?.posts?.length?Date.now()-cached.time:Infinity;
  if(age<(force?10*60*1000:24*60*60*1000)){communityPostCache.set(blog,cached);return cached.posts}
  try{
    const page=start=>providerFetch(`${blog}/feeds/posts/default?alt=json&max-results=150&start-index=${start}`,{json:true,referer:`${blog}/`});
    const first=await page(1),total=Number(first.feed?.openSearch$totalResults?.$t)||0,rest=[];
    for(let start=151;start<=total;start+=150)rest.push(page(start).catch(()=>null));
    const posts=[first,...await Promise.all(rest)].flatMap(root=>root?.feed?.entry||[]).map(entry=>({title:entry.title?.$t||'',url:(entry.link||[]).find(x=>x.rel==='alternate')?.href||'',html:entry.content?.$t||entry.summary?.$t||''}));
    if(!posts.length)throw new Error('empty feed');
    const fresh={time:Date.now(),posts};communityPostCache.set(blog,fresh);try{fs.writeFileSync(file,JSON.stringify(fresh))}catch{}
    return posts;
  }catch(error){if(cached?.posts?.length){communityPostCache.set(blog,cached);return cached.posts}throw error}
}
// Episode numbers written as "12화", "9, 10화", "1 ~ 12화" or "EP 3". Bare digits ("2기", "무직전생3") are not episodes.
function communityEpisodes(text=''){
  const list=[],ranges=[];const value=String(text).normalize('NFKC');
  for(const m of value.matchAll(/(\d+)\s*[~∼\-]\s*(\d+)\s*(?:화|회|편)/g))ranges.push([Number(m[1]),Number(m[2])]);
  for(const m of value.replace(/(\d+)\s*[~∼\-]\s*(\d+)\s*(?:화|회|편)/g,' ').matchAll(/((?:\d+\s*,\s*)*\d+)\s*(?:화|회|편)/g))list.push(...m[1].split(',').map(Number));
  for(const m of value.matchAll(/\bep(?:isode)?\s*\.?\s*(\d+)/gi))list.push(Number(m[1]));
  return {list,ranges,has:ep=>list.includes(ep)||ranges.some(([a,b])=>ep>=a&&ep<=b),any:list.length+ranges.length>0};
}
function communitySeason(text=''){
  const value=String(text).normalize('NFKC'),m=value.match(/(?:season|시즌)\s*(\d+)|(\d+)\s*기(?![가-힣])|(\d+)(?:st|nd|rd|th)(?:\s*season)?\b|[가-힣](\d)(?=\s|$)/i);
  return m?Number(m[1]||m[2]||m[3]||m[4]):null;
}
// Provider (English) titles also number a later season with a bare digit or a roman numeral at the end
// ("The Angel Next Door Spoils Me Rotten 2", Re:Anime's "…Rotten2", "Overlord IV"), but "Kaiju No. 8",
// "Part 2" and "Mob Psycho 100" are not seasons.
function titleSeason(text=''){
  const value=String(text).normalize('NFKC').trim(),season=communitySeason(value);if(season!=null)return season;
  const digit=value.match(/([a-z]+)[!?'’)]*\s*([2-9])$/i);if(digit&&!/^(?:no|vol|part|cour|lv|level|ep|episode|chapter|act|phase|movie)$/i.test(digit[1]))return Number(digit[2]);
  const roman=value.match(/\s(II|III|IV)$/);return roman?{II:2,III:3,IV:4}[roman[1]]:null;
}
// A later season keeps its number when the Korean name has none ("장송의 프리렌" for Season 2 → "… 2기").
function withSeason(ko,title){
  const season=titleSeason(title);return ko&&!hasHangul(title)&&season>1&&communitySeason(ko)==null&&!/\d\s*$/.test(ko)?`${ko} ${season}기`:ko;
}
// The season a subtitle search asks for: the searched (usually Korean) title's own, else the provider title's. A Korean
// title ending with that same number ("마크로스 7" for "Macross 7") names the work, not a season.
function searchSeason(title,originalTitle){
  const own=communitySeason(title);if(own!=null)return own;
  const season=titleSeason(originalTitle);
  return season!=null&&hasHangul(title)&&new RegExp(`(?:^|\\D)${season}\\s*$`).test(String(title).normalize('NFKC'))?null:season;
}
// Posts often drop the "~부제~" part ("무직전생3"), so a distinctive shared prefix of 4+ Hangul counts as a match too.
// Android HangulSimilarityMatcher: edit distance where two syllables differing only in one jamo cost
// 0.3-0.4, so spelling variants ("카구야"/"가구야") still count as the same title.
function hangulEditSimilarity(first,second){
  const clean=value=>String(value).toLowerCase().normalize('NFC').replace(/[^가-힣a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,'');
  const a=[...clean(first)],b=[...clean(second)];if(!a.length||!b.length)return {similarity:0,distance:Infinity};if(a.join('')===b.join(''))return {similarity:1,distance:0};
  const jamo=c=>{const code=c.codePointAt(0)-0xac00;return code>=0&&code<11172?[Math.floor(code/588),Math.floor(code/28)%21,code%28]:null};
  const cost=(x,y)=>{if(x===y)return 0;const p=jamo(x),q=jamo(y);return p&&q?(p[0]!==q[0]?.4:0)+(p[1]!==q[1]?.3:0)+(p[2]!==q[2]?.3:0):1};
  let previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=0;i<a.length;i++){const current=[i+1];for(let j=0;j<b.length;j++)current[j+1]=Math.min(previous[j+1]+1,current[j]+1,previous[j]+cost(a[i],b[j]));previous=current}
  return {similarity:Math.max(0,1-previous[b.length]/Math.max(a.length,b.length)),distance:previous[b.length]};
}
// Posts often drop the "~부제~" part ("무직전생3"), so a distinctive shared prefix of 4+ Hangul counts as a match too.
function communityScore(target,candidate){
  const bare=value=>value.replace(/[~〜～][^~〜～]*[~〜～]/g,' ').replace(/\s+/g,' ').trim(),score=Math.max(titleScore(target,candidate),titleScore(bare(target),bare(candidate)));
  const a=titleKey(bare(target)),b=titleKey(bare(candidate)),short=a.length<b.length?a:b,long=short===a?b:a;
  let best=/^[가-힣]{4,}$/.test(short)&&long.startsWith(short)?Math.max(score,.6):score;
  // Edit distance only settles spelling variants of a letter or two ("카구야"/"가구야", "푸른"/"포론"). Long
  // franchise titles differing in one word ("바니걸 선배" / "란도셀걸") also score high as a ratio, so the raw
  // distance is capped too. Korean/English runs are not compared separately (a shared "BanG Dream!" would
  // match every season).
  const variant=value=>value.replace(/카구야/g,'가구야');
  const edit=hangulEditSimilarity(variant(a),variant(b));if(edit.similarity>=.75&&edit.distance<=1.5)best=Math.max(best,edit.similarity);
  return best;
}
// Older Kairan titles end in a bare episode number ("히로아카7 20", "... 12(완)").
const COMMUNITY_TRAILING_EPISODE=/(?<!season|시즌|part|파트|vol\.?|제)\s+(\d{1,3})\s*(?:\((?:끝|완)\))?\s*(?:자막)?\s*$/i;
function communityPostEpisodes(title=''){const episodes=communityEpisodes(title);if(episodes.any)return episodes;const m=String(title).normalize('NFKC').match(COMMUNITY_TRAILING_EPISODE);return m?communityEpisodes(`${m[1]}화`):episodes}
function communityPostTitle(title=''){return communityTitle(String(title).normalize('NFKC').replace(COMMUNITY_TRAILING_EPISODE,' '))}
function communityTitle(text=''){return String(text).replace(/(\d+)\s*[~∼\-,]\s*(?=\d)/g,'').replace(/\d+\s*(?:화|회|편)|\((?:끝|완)\)|작업\s*중|블루레이판|자막/g,' ').trim()}
// Picks the post's download links for one episode: per-episode posts (Kairan) carry the number in the
// title, series posts (Csora) label each link ("13화", "1 ~ 12화") and add a separate "폰트" link.
function communityLinks(post,episode){
  const $=cheerio.load(post.html),anchors=[];
  $('a[href]').each((_,a)=>{const href=absoluteUrl($(a).attr('href'),post.url);if(/drive\.google\.com|docs\.google\.com|\.zip(?:$|\?)|\.(?:ass|ssa|srt|vtt|smi)(?:$|\?)/i.test(href))anchors.push({href,label:$(a).text().trim()})});
  const fonts=anchors.filter(a=>/폰트|font/i.test(a.label)),subs=anchors.filter(a=>!fonts.includes(a)),withFonts=list=>list.length?[...new Set([...list,...fonts].map(a=>a.href))]:[];
  const titleEpisodes=communityPostEpisodes(post.title);
  if(titleEpisodes.any)return titleEpisodes.has(episode)?{links:withFonts(subs),episode}:{links:[],episode};
  const labeled=subs.map(a=>({...a,episodes:communityEpisodes(a.label)})).filter(a=>a.episodes.any);
  // No numbers at all: a movie or a whole-season bundle, whose file has to be matched by episode.
  if(!labeled.length)return {links:withFonts(subs),episode,strict:true};
  const pick=ep=>labeled.find(a=>a.episodes.list.includes(ep))||labeled.find(a=>a.episodes.has(ep));
  // Later seasons often continue the numbering (2기 = 13~24화) while the player counts from 1.
  const first=Math.min(...labeled.flatMap(a=>[...a.episodes.list,...a.episodes.ranges.map(r=>r[0])]));
  const direct=pick(episode),shifted=!direct&&first>1?pick(episode+first-1):null,chosen=direct||shifted;
  const number=direct?episode:shifted?episode+first-1:episode;
  // A range link ("1 ~ 12화") is a bundle, so its file must be matched by episode number.
  return {links:chosen?withFonts([chosen]):[],episode:number,strict:Boolean(chosen&&!chosen.episodes.list.includes(number))};
}
// "S02E05" counts as episode 5 only, and a CRC tag ("[5A2B3C4D]") is not an episode number.
function communityFileMatches(file,episode){
  const name=path.basename(file).normalize('NFKC').replace(/\.[^.]+$/,'').replace(/\b(?:s\d+|season\s*\d+|\d{3,4}p|x26[45]|h\.?26[45]|(?:19|20)\d{2})\b|\bs\d{1,2}(?=e\d)|\[[0-9a-f]{8}\]|\d+\s*기/gi,' ');
  return new RegExp(`(?:^|[^0-9])(?:e|ep|episode)?\\s*0*${episode}(?:v\\d)?(?:[^0-9]|$)`,'i').test(name);
}
const COMMUNITY_FILE=/\.(ass|ssa|srt|vtt|smi|ttf|otf|ttc)$/i;
function communityFileName(name){return path.basename(String(name).replace(/\\/g,'/')).normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu,'_')}
// Large Drive files answer with a "virus scan warning" page (always when a foreign Referer is sent);
// its form holds the real download URL.
async function downloadDriveBuffer(url,referer){
  const buffer=await downloadBuffer(url,referer);if(buffer[0]!==0x3c||!/virus scan warning|download-form/i.test(buffer.slice(0,4096).toString('utf8')))return buffer;
  const $=cheerio.load(buffer.toString('utf8')),form=$('form#download-form').first();if(!form.length)return buffer;
  const next=new URL(absoluteUrl(form.attr('action'),url));form.find('input[name]').each((_,input)=>next.searchParams.set($(input).attr('name'),$(input).attr('value')||''));
  return downloadBuffer(next.href,referer);
}
// Unpacks subtitle and font files. Zip names without the UTF-8 flag are CP949 (Korean Windows);
// 7z/RAR go through Windows' bundled bsdtar.
async function extractCommunityArchive(buffer,dir){
  const files=[],write=(name,data)=>{if(!COMMUNITY_FILE.test(name))return;let out=path.join(dir,communityFileName(name));if(files.includes(out))out=path.join(dir,`${files.length}_${communityFileName(name)}`);fs.writeFileSync(out,data);files.push(out)};
  if(buffer[0]===0x50&&buffer[1]===0x4b){
    const zip=new AdmZip(buffer);let extracted=0;
    for(const entry of zip.getEntries()){if(entry.isDirectory)continue;const size=Number(entry.header?.size||0);extracted+=size;if(size>100*1024*1024||extracted>300*1024*1024)throw new Error('ZIP 자막 크기 제한을 초과했습니다.');
      const name=entry.header?.flags&0x800?entry.entryName:new TextDecoder('euc-kr').decode(entry.rawEntryName);write(name,entry.getData())}
    return files;
  }
  const isSevenZip=buffer.slice(0,6).equals(Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c])),isRar=buffer.slice(0,4).toString('latin1')==='Rar!';
  if(!isSevenZip&&!isRar||process.platform!=='win32')return null;
  const work=fs.mkdtempSync(path.join(app.getPath('temp'),'lilac-sub-')),archive=path.join(work,isRar?'a.rar':'a.7z'),out=path.join(work,'x');
  try{
    fs.writeFileSync(archive,buffer);fs.mkdirSync(out);
    await new Promise((resolve,reject)=>{const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'),['-xf',archive,'-C',out],{windowsHide:true});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`tar ${code}`)))});
    const walk=folder=>fs.readdirSync(folder,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(folder,item.name)):[path.join(folder,item.name)]);
    for(const file of walk(out))write(file,fs.readFileSync(file));
    return files;
  }finally{fs.rmSync(work,{recursive:true,force:true})}
}
// UTF-16 files (common for SMI) are read by their byte order mark.
function communitySubtitleExt(buffer){const bom=buffer[0]===0xff&&buffer[1]===0xfe?'utf-16le':buffer[0]===0xfe&&buffer[1]===0xff?'utf-16be':'utf-8',head=new TextDecoder(bom).decode(buffer.subarray(0,8192)).replace(/^\uFEFF/,'');return /^WEBVTT/.test(head)?'.vtt':/\[Script Info\]/i.test(head)?'.ass':/<sami[\s>]/i.test(head)?'.smi':/\d+:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(head)?'.srt':null}
// Posts of one blog ranked for a title and episode (best first).
function rankCommunityPosts(posts,title,episode,originalTitle='',{offsets=[]}={}){
  const season=searchSeason(title,originalTitle)??1,wanted=communityTitle(title);
  const rank=(list,name,number)=>list.map(post=>({post,score:communityScore(name,communityPostTitle(post.title))})).filter(x=>x.score>=.52) // Android MIN_SIMILARITY
    .map(x=>({...x,...communityLinks(x.post,number)})).filter(x=>x.links.length)
    // Per-episode links beat bundles of a similarly named post; newer posts come first in the feed.
    .sort((a,b)=>Math.round((b.score-a.score)*20)||Number(Boolean(a.strict))-Number(Boolean(b.strict)));
  const usable=posts.filter(post=>!/작업\s*중|하차/.test(post.title));
  const direct=rank(usable.filter(post=>(communitySeason(communityPostTitle(post.title))??1)===season),wanted,episode);
  if(direct.length||season<2)return direct;
  // Some makers number a later season on from the first ("정반대의 너와 나 15화" is 2기 3화) and drop the season
  // from the title. Such posts are matched under the series name with the previous seasons' episodes added,
  // and only when the number itself appears in the post (a title or a labelled link).
  const base=communityTitle(wanted.replace(/\s*(?:\d+\s*기(?![가-힣])|season\s*\d+|시즌\s*\d+|\d+(?:st|nd|rd|th)\s*season)/gi,' '));
  const unmarked=usable.filter(post=>communitySeason(communityPostTitle(post.title))==null);
  for(const offset of offsets){
    const number=episode+offset,found=rank(unmarked,base,number).filter(x=>x.episode===number&&(communityPostEpisodes(x.post.title).has(number)||!x.strict));
    if(found.length)return found;
  }
  return [];
}
// Episodes of the previous seasons, from AniList's prequel chain (TV series only): the direct prequel alone and
// the whole chain, since makers restart either per franchise or per season.
const prequelEpisodeCache=new Map();
async function previousSeasonEpisodes(anime={},title=''){
  const season=searchSeason(title,anime.title||'')??1;if(season<2)return [];
  let id=Number(anime.anilistId)||null;
  if(!id&&anime.title&&!hasHangul(anime.title))id=(await anilistMedia(anime.title,anime).catch(()=>null))?.id||null;
  if(!id)return [];if(prequelEpisodeCache.has(id))return prequelEpisodeCache.get(id);
  const counts=[];let current=id;
  for(let depth=0;depth<8&&current;depth++){
    const query=`query($id:Int){Media(id:$id,type:ANIME){relations{edges{relationType node{id format episodes}}}}}`;
    const response=await fetch('https://graphql.anilist.co',{signal:AbortSignal.timeout(25000),method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'LilacAnime Android'},body:JSON.stringify({query,variables:{id:current}})}).catch(()=>null);
    const edges=response?.ok?(await response.json())?.data?.Media?.relations?.edges||[]:[];
    const prequel=edges.find(edge=>edge.relationType==='PREQUEL'&&['TV','TV_SHORT','ONA'].includes(edge.node?.format)&&edge.node?.episodes);
    if(!prequel)break;counts.push(prequel.node.episodes);current=prequel.node.id;
  }
  const offsets=[...new Set([counts[0],counts.reduce((sum,count)=>sum+count,0)].filter(value=>value>0))];
  prequelEpisodeCache.set(id,offsets);return offsets;
}
async function findCommunitySubtitle(source,title,episode,{originalTitle='',offsets=[]}={}){
  const blog=source==='kairan'?'https://kairan03.blogspot.com':'https://csora556.blogspot.com',label=source==='kairan'?'Kairan':'Csora';
  // A cached index can predate the episode (Csora adds links to existing posts), so a miss refreshes once.
  let match=rankCommunityPosts(await communityPosts(blog),title,episode,originalTitle,{offsets})[0];
  if(!match)match=rankCommunityPosts(await communityPosts(blog,{force:true}),title,episode,originalTitle,{offsets})[0];
  if(!match)throw new Error(`${label} 자막 게시물을 찾지 못했습니다.`);
  return downloadCommunityMatch(match,source,title,episode);
}
// Downloads a ranked post's links (Drive, zip/7z/RAR, subtitle files) and picks the episode's file.
async function downloadCommunityMatch(match,source,title,episode){
  const dir=path.join(app.getPath('userData'),'subtitles',simpleTitle(title).replace(/\s+/g,'_')||'anime',String(episode));fs.mkdirSync(dir,{recursive:true});const candidates=[];
  for(const original of match.links){
    try{
      const id=driveId(original),url=id?`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`:original,buffer=await downloadDriveBuffer(url,id?undefined:match.post.url);
      if(buffer.length<16||buffer.length>300*1024*1024)continue;
      const unpacked=await extractCommunityArchive(buffer,dir);
      if(unpacked){candidates.push(...unpacked.filter(file=>/\.(ass|ssa|srt|vtt|smi)$/i.test(file)));continue}
      const ext=communitySubtitleExt(buffer);if(!ext)continue;
      const out=path.join(dir,`${source}_${Date.now()}_${candidates.length}${ext}`);fs.writeFileSync(out,buffer);candidates.push(out);
    }catch{/* Try remaining links. */}
  }
  // A movie bundle has no numbered files (the main script, an MV, an older version...): take the largest.
  const unnumbered=episode===1&&!candidates.some(x=>communityFileMatches(x,2)),largest=()=>candidates.slice().sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size)[0];
  const selected=candidates.find(x=>communityFileMatches(x,match.episode))||(!match.strict?candidates[0]:unnumbered?largest():null);if(!selected)throw new Error('사용 가능한 자막 파일을 추출하지 못했습니다.');return subtitleResult(selected,{source,post:match.post.url,postTitle:match.post.title,all:candidates});
}
// Some makers pack their subtitles into the post's image instead of linking a file (WinPNG,
// https://github.com/harnenim/WinPNG). The blog's own viewer decodes the image and converts Jamaker projects (.jmk) to
// ASS / SMI, so the post is opened in a hidden window, its image clicked and the converted files read back. Pages
// without that viewer are left after a few seconds, and a page that does not finish within a minute is given up.
async function winPngEntries(pageUrl){
  const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{partition:'persist:lilac-provider',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  let timer=null;
  const work=(async()=>{
    await win.loadURL(pageUrl,{userAgent:LINKKF_UA});
    return win.webContents.executeJavaScript(`(async()=>{
      // The viewer answers an image it cannot read with prompt() and alert(), which would open real dialogs.
      window.alert=()=>{};window.prompt=()=>null;window.confirm=()=>false;
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      for(let i=0;i<20&&typeof window.downloadZip!=='function';i++)await wait(250);
      if(typeof window.downloadZip!=='function')return [];
      const read=async url=>{try{return url?await (await fetch(url)).text():null}catch{return null}};
      for(const img of document.querySelectorAll('.contents_style img, .tt_article_useless_p_margin img, article img')){
        img.click();let entries=[];
        // Done when every file is listed and none is still being converted.
        for(let i=0;i<60;i++){await wait(500);entries=[...document.querySelectorAll('a[data-href]')];if(entries.length&&!document.querySelector('a.processing'))break}
        if(!entries.length)continue;
        const out=[];
        for(const a of entries){const name=a.download||'';out.push({name,ass:await read(a.getAttribute('data-ass')),smi:await read(a.getAttribute('data-smi')||a.getAttribute('data-cleared')),raw:/\\.(?:ass|ssa|srt|vtt)$/i.test(name)?await read(a.getAttribute('data-href')):null})}
        return out;
      }
      return [];
    })()`,true);
  })();
  work.catch(()=>{/* given up below */});
  try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('WinPNG 글을 여는 데 너무 오래 걸립니다.')),60000)})])}
  finally{clearTimeout(timer);if(!win.isDestroyed())win.destroy()}
}
// The episode's file among a WinPNG image's files: extras (textless OP/ED, specials) are left out, ASS is preferred
// over SMI. A file numbered for the episode wins; otherwise the largest script is taken only for a movie (no numbered
// files) or from the episode's own post (matched), never from a post of another episode.
const WINPNG_EXTRA=/non-?telop|\bNC(?:OP|ED)\b|tokuten|\bSP\d|\bPV\b|\bCM\b|menu|preview|trailer/i;
async function winPngSubtitle(pageUrl,title,episode,{matched=false}={}){
  const entries=(await winPngEntries(pageUrl)).filter(entry=>entry.ass||entry.raw||entry.smi);if(!entries.length)return null;
  const dir=path.join(app.getPath('userData'),'subtitles',simpleTitle(title).replace(/\s+/g,'_')||'anime',String(episode));fs.mkdirSync(dir,{recursive:true});
  const files=entries.map((entry,index)=>{
    const ext=entry.ass?'.ass':entry.raw?path.extname(entry.name).toLowerCase():'.smi',out=path.join(dir,`winpng_${index}_${communityFileName(entry.name.replace(/\.[^.]+$/,''))}${ext}`);
    fs.writeFileSync(out,String(entry.ass||entry.raw||entry.smi).replace(/^﻿/,''),'utf8');return {file:out,name:entry.name};
  });
  const main=files.filter(item=>!WINPNG_EXTRA.test(item.name)),pool=main.length?main:files,largest=()=>pool.slice().sort((a,b)=>fs.statSync(b.file).size-fs.statSync(a.file).size)[0];
  const unnumbered=!pool.some(item=>Array.from({length:60},(_,index)=>index+1).some(number=>communityFileMatches(item.name,number)));
  const selected=pool.find(item=>communityFileMatches(item.name,episode))||(unnumbered||(matched&&pool.length===1)?largest():null);
  return selected?subtitleResult(selected.file,{source:'anissia',post:pageUrl,postTitle:title,all:files.map(item=>item.file)}):null;
}
// --- Jimaku (Japanese subtitles, jimaku.cc) ------------------------------------------------------------------------
// Android JimakuSubtitleService: the home page lists every entry with its AniList id (no API key needed) and an entry's
// page its files. The player lists the episode's files and the user picks one (Android JIMAKU_USER_SELECTION_V2).
const JIMAKU_WEB='https://jimaku.cc',JIMAKU_FORMATS={ass:100,ssa:96,srt:90,vtt:86,smi:84,sami:84};
let jimakuIndex={time:0,entries:new Map()},jimakuIndexLoading=null;
// The home page is about 2 MB, so it is read again after six hours, or after ten minutes when an id is missing; lookups
// meanwhile share the one download.
async function jimakuEntryId(anilistId){
  const age=Date.now()-jimakuIndex.time;
  if(age>6*60*60*1000||(!jimakuIndex.entries.has(anilistId)&&age>10*60*1000)){
    jimakuIndexLoading||=(async()=>{
      const $=cheerio.load(await providerFetch(`${JIMAKU_WEB}/`,{referer:`${JIMAKU_WEB}/`})),entries=new Map();
      $('div.entry[data-extra]').each((_,node)=>{let extra=null;try{extra=JSON.parse($(node).attr('data-extra'))}catch{return}const id=Number(extra?.anilist_id),entry=$(node).find('a[href*="/entry/"]').attr('href')?.match(/\/entry\/(\d+)/)?.[1];if(id&&entry&&!entries.has(id))entries.set(id,entry)});
      if(entries.size)jimakuIndex={time:Date.now(),entries};
    })().finally(()=>{jimakuIndexLoading=null});
    await jimakuIndexLoading;
  }
  return jimakuIndex.entries.get(anilistId)||null;
}
async function jimakuFiles(entry){
  const url=`${JIMAKU_WEB}/entry/${entry}`,$=cheerio.load(await providerFetch(url,{referer:`${JIMAKU_WEB}/`})),files=[];
  $('div.entry[data-extra]').each((_,node)=>{
    let extra={};try{extra=JSON.parse($(node).attr('data-extra'))||{}}catch{/* the link below */}
    const name=String(extra.name||$(node).find('a.file-name').text()||'').trim(),href=String(extra.url||$(node).find('a.file-name').attr('href')||'').trim();
    if(name&&href&&JIMAKU_FORMATS[name.split('.').pop().toLowerCase()]&&!files.some(file=>file.name===name))files.push({name,url:absoluteUrl(href,url),size:Number(extra.size)||0,entry:String(entry)});
  });
  return files;
}
// Android JimakuSubtitleService.scoreEpisodeFiles: SxxEyy beats Eyy beats a bare number; a range ("01-12") holds the
// episodes it names.
function jimakuEpisodeScore(name,episode){
  const lower=name.toLowerCase(),n=String(Number(episode));
  const range=lower.match(/(?:s\d{1,2}e)0*(\d{1,3})\s*[-~〜–—]\s*(?:s\d{1,2}e)?0*(\d{1,3})/)||lower.match(/(?:^|[^a-z0-9])(?:e|ep|episode)?0*(\d{1,3})\s*[-~〜–—]\s*(?:e|ep|episode)?0*(\d{1,3})(?:$|[^0-9])/);
  if(range&&Number(range[1])<Number(range[2]))return episode>=Number(range[1])&&episode<=Number(range[2])?45:0;
  if(new RegExp(`(?:^|[^a-z0-9])s\\d{1,2}e0*${n}(?:[^0-9]|$)`).test(lower))return 65;
  if(new RegExp(`(?:^|[^a-z0-9])(?:ep|episode|e)0*${n}(?:[^0-9]|$)`).test(lower))return 58;
  if(new RegExp(`(?:^|[^a-z0-9])0*${n}\\s*(?:화|회|편|話)`).test(lower))return 55;
  return new RegExp(`(?:^|[^a-z0-9])0*${n}(?:[^a-z0-9]|$)`).test(lower)?50:0;
}
async function jimakuAnilistId(anime={}){
  const id=Number(anime.anilistId)||null;if(id)return id;
  return anime.title&&!hasHangul(anime.title)?(await anilistMedia(anime.title,anime).catch(()=>null))?.id||null:null;
}
// The episode's files, best first (ASS over SRT, furigana / .ja ASS a little ahead, the season's own files ahead). A
// movie's entry has no numbered files, so all of them are listed.
async function jimakuEpisodeFiles(anime,episode){
  const anilistId=await jimakuAnilistId(anime);if(!anilistId)throw new Error('AniList 작품을 찾지 못해 Jimaku를 검색할 수 없습니다.');
  const entry=await jimakuEntryId(anilistId);if(!entry)throw new Error('Jimaku에 이 작품의 자막이 없습니다.');
  const files=await jimakuFiles(entry),season=titleSeason(anime.title||'');
  const quality=name=>{const lower=name.toLowerCase(),ext=lower.split('.').pop(),ass=/^(?:ass|ssa)$/.test(ext);return JIMAKU_FORMATS[ext]+(ass?(lower.includes('furigana')?8:lower.includes('.ja')?6:3):lower.includes('.ja')?2:0)+(season>1&&new RegExp(`(?:^|[^a-z0-9])s0*${season}(?:e|[-_ ])`).test(lower)?12:0)};
  const movie=Number(episode)===1&&!files.some(file=>jimakuEpisodeScore(file.name,2)>0);
  return files.map(file=>({...file,anilistId,score:movie?1:jimakuEpisodeScore(file.name,Number(episode))})).filter(file=>file.score>0)
    .sort((a,b)=>(b.score+quality(b.name))-(a.score+quality(a.name))||b.size-a.size||a.name.localeCompare(b.name));
}
// Subtitles are kept as UTF-8: UTF-16 by its byte order mark, otherwise UTF-8 when it decodes cleanly, else Shift_JIS.
function japaneseSubtitleText(buffer){
  if(buffer[0]===0xff&&buffer[1]===0xfe)return new TextDecoder('utf-16le').decode(buffer);
  if(buffer[0]===0xfe&&buffer[1]===0xff)return new TextDecoder('utf-16be').decode(buffer);
  try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer)}catch{return new TextDecoder('shift_jis').decode(buffer)}
}
async function jimakuDownload(file,anime,episode){
  if(!/^https:\/\/jimaku\.cc\/entry\/\d+\/download\//.test(String(file?.url||'')))throw new Error('Jimaku 파일 주소가 아닙니다.');
  const text=japaneseSubtitleText(await downloadBuffer(file.url,`${JIMAKU_WEB}/entry/${file.entry}`)).replace(/^\uFEFF/,'');
  const ext=communitySubtitleExt(Buffer.from(text.slice(0,8192),'utf8'))||path.extname(file.name).toLowerCase();
  const dir=path.join(app.getPath('userData'),'subtitles','jimaku',String(Number(file.anilistId)||simpleTitle(anime?.title||'').replace(/\s+/g,'_')||'anime'),String(Number(episode)||1));fs.mkdirSync(dir,{recursive:true});
  const out=path.join(dir,`${communityFileName(file.name).replace(/\.[^.]+$/,'')}${ext}`);fs.writeFileSync(out,text,'utf8');
  return subtitleResult(out,{source:'jimaku',label:'Jimaku 자막',name:file.name});
}
// The work a translation is for: its provider title next to the Korean one, its genres and story, and its main
// characters (AniList: names split into given and family name, gender), so names are spelled the same way in every
// line and who says what to whom can be told.
const anilistStoryCache=new Map();
async function anilistStory(anilistId){
  const id=Number(anilistId);if(!id)return null;if(anilistStoryCache.has(id))return anilistStoryCache.get(id);
  const query='query($id:Int){Media(id:$id,type:ANIME){genres description(asHtml:false) characters(perPage:25,sort:[ROLE,RELEVANCE]){nodes{name{full native first last} gender}}}}';
  const response=await fetch('https://graphql.anilist.co',{signal:AbortSignal.timeout(15000),method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'LilacAnime Android'},body:JSON.stringify({query,variables:{id}})});
  if(!response.ok)return null;
  const media=(await response.json())?.data?.Media||{};
  const characters=(media.characters?.nodes||[]).map(node=>({name:String(node?.name?.full||''),native:String(node?.name?.native||''),first:String(node?.name?.first||''),last:String(node?.name?.last||''),gender:String(node?.gender||'')})).filter(item=>item.name||item.native);
  const synopsis=String(media.description||'').replace(/<[^>]*>/g,' ').replace(/\(Source:[^)]*\)/gi,' ').replace(/\s+/g,' ').trim().slice(0,700);
  const value={characters,genres:Array.isArray(media.genres)?media.genres:[],synopsis};anilistStoryCache.set(id,value);return value;
}
async function translationContext(anime={},title=''){
  const anilistId=await jimakuAnilistId(anime||{}).catch(()=>null),media=anilistId?await anilistStory(anilistId).catch(()=>null):null;
  return {originalTitle:anime?.title&&anime.title!==title?String(anime.title):'',characters:media?.characters||[],genres:media?.genres||[],synopsis:media?.synopsis||''};
}
const ANISSIA_API='https://api.anissia.net';
// Online subtitle sources in their default search order.
const COMMUNITY_SOURCES=['kairan','csora','anissia'];
function communitySubtitleLabel(source,result={}){return source==='anissia'?`Anissia${result.maker?` · ${result.maker}`:''} 자막`:`${source==='kairan'?'Kairan':'Csora'} 자막`}
async function anissiaFetch(pathname){
  const response=await fetch(`${ANISSIA_API}${pathname}`,{signal:AbortSignal.timeout(20000),headers:{Accept:'application/json','User-Agent':'LilacAnime/1.0'}});
  if(!response.ok)throw new Error(`Anissia HTTP ${response.status}`);
  const root=await response.json();if(root?.code&&root.code!=='ok')throw new Error(`Anissia ${root.code}`);
  return root?.data;
}
// The Anissia entry for a Korean title, with the season required to match ("2기", "Season 3").
async function anissiaAnime(title,originalTitle=''){
  const season=searchSeason(title,originalTitle)??1,wanted=communityTitle(title);
  const bare=wanted.replace(/[~〜～][^~〜～]*[~〜～]/g,' ').replace(/\s*(?:\d+\s*기|season\s*\d+|시즌\s*\d+)\s*$/i,'').replace(/\s+/g,' ').trim();
  // Anissia's search misses titles typed with their punctuation ("명탐정 프리큐어!").
  const plain=bare.replace(/[!?！？.,:;·'"“”‘’♡♥☆★]+/g,' ').replace(/\s+/g,' ').trim();
  const queries=[...new Set([bare,plain,plain.split(' ').slice(0,2).join(' ')])].filter(query=>query.length>=2);
  const seen=new Map();
  for(const query of queries){
    for(const item of (await anissiaFetch(`/anime/list/0?q=${encodeURIComponent(query)}`).catch(()=>null))?.content||[])seen.set(item.animeNo,item);
    const best=[...seen.values()].filter(item=>(communitySeason(item.subject)??1)===season).map(item=>({item,score:communityScore(wanted,item.subject)})).filter(x=>x.score>=.52).sort((a,b)=>b.score-a.score)[0];
    if(best)return best.item;
  }
  return null;
}
// Tistory: the RSS feed carries the latest posts; the blog search finds older ones. Post pages are fetched
// only for the few candidates whose title matches, since attachments are not in the listing.
async function tistoryPosts(origin,subject,extraQueries=[]){
  const posts=new Map(),add=(url,title)=>{url=absoluteUrl(url,origin);title=String(title||'').replace(/\s+/g,' ').trim();if(url&&title&&!posts.has(url))posts.set(url,{url,title})};
  try{
    // Tistory answers 406 to an HTML-only Accept header.
    const response=await fetch(`${origin}/rss`,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':LINKKF_UA,Accept:'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',Referer:`${origin}/`}});
    if(response.ok){const $=cheerio.load(await response.text(),{xmlMode:true});$('item').each((_,item)=>add($(item).find('link').first().text(),$(item).find('title').first().text()))}
  }catch{/* search below */}
  // Posts of a later season often omit "2기", so the series name is searched as well.
  const series=subject.replace(/\s*(?:\d+\s*기(?![가-힣])|season\s*\d+|시즌\s*\d+)\s*$/i,'').trim();
  for(const query of [...new Set([subject,series,...extraQueries])].filter(Boolean))try{
    const html=await providerFetch(`${origin}/search/${encodeURIComponent(query)}`,{referer:`${origin}/`}),$=cheerio.load(html);
    $('a[href]').each((_,a)=>{const href=$(a).attr('href')||'';if(/^(?:https?:\/\/[^/]+)?\/(?:entry\/)?\d+$/.test(href)){
      // Result cards repeat the title in their excerpt; keep the text up to the first episode number.
      const text=$(a).text().replace(/\s+/g,' ').trim(),cut=text.match(/^.*?\d+\s*(?:화|회|편)(?:\s*\((?:끝|완|完)\)|\s*-끝-)?/)?.[0]||text.slice(0,80);add(href,cut)}});
  }catch{/* RSS only */}
  return [...posts.values()];
}
// A maker's own name for the anime: the linked post's title without episode numbers or marks, when it is not
// simply the official title.
function anissiaNickname(pageTitle,subject){
  const title=String(pageTitle||''),head=title.match(/^(.*?\S)\s*\d+\s*(?:화|회|편)/)?.[1];
  const name=(head||title).replace(/\d+\s*(?:화|회|편)?|\((?:끝|완|完)\)|完|자막|-끝-/g,' ').replace(/\s+/g,' ').trim();
  return name.length>=2&&communityScore(communityTitle(subject),name)<.52?name:'';
}
async function anissiaLinkedPost(url,subject,origin){
  try{
    const html=await providerFetch(url,{referer:`${origin}/`}),$=cheerio.load(html);
    const pageTitle=($('meta[property="og:title"]').attr('content')||$('title').first().text()||'').replace(/\s*[-|:]\s*[^-|:]*$/,'').trim();
    return {url,title:`${subject} ${pageTitle}`.trim(),pageTitle,html};
  }catch{return null}
}
// Naver blogs: a post page lists its attachments in aPostFiles, and the mobile API lists and searches posts.
function naverBlogRef(url){
  try{
    const u=new URL(url);if(!/^(?:m\.)?blog\.naver\.com$/i.test(u.hostname))return null;
    const parts=u.pathname.split('/').filter(Boolean),blogId=u.searchParams.get('blogId')||(/\.naver$/i.test(parts[0]||'')?'':parts[0]||'');
    return blogId?{blogId,logNo:u.searchParams.get('logNo')||(/^\d+$/.test(parts[1]||'')?parts[1]:'')}:null;
  }catch{return null}
}
async function naverPost(blogId,logNo){
  const url=`https://blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}`;
  const page=await providerFetch(url,{referer:`https://blog.naver.com/${blogId}`}),escape=value=>String(value||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const files=[...page.matchAll(/aPostFiles\[\d+\] = JSON\.parse\('(.*?)'\.replace/g)].flatMap(x=>{try{return JSON.parse(x[1].replace(/\\'/g,''))}catch{return []}});
  const pageTitle=cheerio.load(page)('title').first().text().replace(/\s*:\s*네이버\s*블로그\s*$/,'').trim();
  // The attachments become plain links, so the post is matched like any other blog post.
  return {url,pageTitle,html:files.filter(file=>file?.encodedAttachFileUrl).map(file=>`<a href="${escape(file.encodedAttachFileUrl)}">${escape(file.encodedAttachFileName)}</a>`).join('')};
}
async function naverPosts(blogId,subject,extraQueries=[]){
  const posts=new Map(),api=pathname=>providerFetch(`https://m.blog.naver.com/api/blogs/${encodeURIComponent(blogId)}${pathname}`,{json:true,referer:`https://m.blog.naver.com/${blogId}`});
  const add=item=>{const logNo=String(item?.logNo||''),title=cheerio.load(`<p>${item?.title||item?.titleWithInspectMessage||''}</p>`)('p').text().replace(/\s+/g,' ').trim();if(logNo&&title&&!posts.has(logNo))posts.set(logNo,{url:`https://blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${logNo}`,logNo,title})};
  try{((await api('/post-list?categoryNo=0&itemCount=30&page=1'))?.result?.items||[]).forEach(add)}catch{/* search below */}
  const series=subject.replace(/\s*(?:\d+\s*기(?![가-힣])|season\s*\d+|시즌\s*\d+)\s*$/i,'').trim();
  for(const query of [...new Set([subject,series,...extraQueries])].filter(Boolean)){
    for(let page=1;page<=4;page++){
      try{const result=(await api(`/search/post?query=${encodeURIComponent(query)}&page=${page}`))?.result,list=result?.list||[];list.forEach(add);if(!list.length||page*list.length>=Number(result?.totalCount||0))break}catch{break}
    }
  }
  return [...posts.values()];
}
// Makers whose blogs can be read: Blogger, Tistory and Naver. Kairan/Csora have their own sources.
function anissiaMakerSupport(website){
  let host='';try{host=new URL(website).hostname}catch{return 'invalid'}
  if(/^(?:kairan03|csora556)\.blogspot\.com$/i.test(host))return 'own-source';
  return /\.blogspot\.com$|\.tistory\.com$|^(?:m\.)?blog\.naver\.com$/i.test(host)?'ok':'unsupported';
}
async function anissiaMakers(title,originalTitle=''){
  const anime=await anissiaAnime(title,originalTitle);if(!anime)return null;
  const captions=((await anissiaFetch(`/anime/caption/animeNo/${anime.animeNo}`))||[]).filter(item=>/^https?:\/\//i.test(item.website||'')).sort((a,b)=>String(b.updDt).localeCompare(String(a.updDt)));
  return {anime,captions};
}
async function findAnissiaSubtitle(title,episode,{originalTitle='',offsets=[],maker=''}={}){
  const found=await anissiaMakers(title,originalTitle);if(!found)throw new Error('Anissia에서 작품을 찾지 못했습니다.');
  // A maker picked in the player is the only one tried.
  const anime=found.anime,captions=maker?found.captions.filter(item=>item.name===maker):found.captions;
  for(const caption of captions){
    let origin;try{origin=new URL(caption.website).origin}catch{continue}
    const host=new URL(origin).hostname;
    // Kairan and Csora have their own sources.
    if(/^(?:kairan03|csora556)\.blogspot\.com$/i.test(host))continue;
    try{
      let match=null;
      // The post Anissia links belongs to this anime even when the maker spells the title differently
      // ("후리렌 1기(完)" for 장송의 프리렌), so it is ranked under the Anissia title.
      const naver=naverBlogRef(caption.website);
      const linked=naver?(naver.logNo?await naverPost(naver.blogId,naver.logNo).then(post=>({...post,title:`${anime.subject} ${post.pageTitle}`.trim()})).catch(()=>null):null):await anissiaLinkedPost(caption.website,anime.subject,origin);
      if(/\.blogspot\.com$/i.test(host)){
        const posts=[...await communityPosts(origin),...(linked?[linked]:[])];
        for(const name of [anime.subject,title])if(!match)match=rankCommunityPosts(posts,name,episode,originalTitle,{offsets})[0];
      }else if(/\.tistory\.com$/i.test(host)||naver){
        // Some makers use their own short name ("츠레카노 12"); the post Anissia links gives it away, so it is
        // searched too and its posts count as this anime's.
        const nickname=anissiaNickname(linked?.pageTitle||'',anime.subject);
        const nicknameEpisode=title=>{const at=title.indexOf(nickname),number=at<0?null:title.slice(at+nickname.length).match(/^\s*(\d{1,3})(?!\d)/)?.[1];return number?`${anime.subject} ${Number(number)}화`:null};
        const nicknames=nickname?[...new Set([nickname,nickname.replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim()])].filter(Boolean):[];
        const listed=(naver?await naverPosts(naver.blogId,anime.subject,nicknames):await tistoryPosts(origin,anime.subject,nicknames)).map(post=>{const renamed=nickname&&post.title.includes(nickname)&&communityScore(communityTitle(anime.subject),communityPostTitle(post.title))<.52?nicknameEpisode(post.title):null;return renamed?{...post,title:renamed}:post}),season=communitySeason(anime.subject)??1;
        // The season's own number, or a continued one on posts without a season ("15화" for 2기 3화).
        const numbered=post=>{const postSeason=communitySeason(communityPostTitle(post.title)),episodes=communityPostEpisodes(post.title);return ((postSeason??1)===season&&episodes.has(episode))||(season>1&&postSeason==null&&offsets.some(offset=>episodes.has(episode+offset)))};
        const base=value=>communityTitle(value).replace(/\s*(?:\d+\s*기|season\s*\d+|시즌\s*\d+)\s*$/i,'');
        const likely=listed.filter(post=>numbered(post)&&Math.max(communityScore(base(anime.subject),communityPostTitle(post.title)),communityScore(base(title),communityPostTitle(post.title)))>=.52).slice(0,4);
        for(const post of likely){try{post.html=naver?(await naverPost(naver.blogId,post.logNo)).html:await providerFetch(post.url,{referer:`${origin}/`})}catch{post.html=''}}
        const posts=[...likely.filter(post=>post.html),...(linked&&!likely.some(post=>post.url===linked.url)?[linked]:[])];
        for(const name of [anime.subject,title])if(!match)match=rankCommunityPosts(posts,name,episode,originalTitle,{offsets})[0];
        // No download link: the files may be packed into the post's image (WinPNG). The episode's own posts first,
        // then the one Anissia links.
        if(!match&&/\.tistory\.com$/i.test(host)){
          const episodePosts=new Set(likely.map(post=>post.url));
          for(const url of [...new Set([...episodePosts,linked?.url||caption.website].filter(Boolean))].slice(0,3)){
            const result=await winPngSubtitle(url,anime.subject,episode,{matched:episodePosts.has(url)}).catch(()=>null);
            if(result)return {...result,maker:caption.name,anissiaTitle:anime.subject};
          }
        }
      }
      if(match){const result=await downloadCommunityMatch(match,'anissia',anime.subject,episode);return {...result,maker:caption.name,anissiaTitle:anime.subject}}
    }catch{/* next maker */}
  }
  throw new Error('Anissia 자막을 찾지 못했습니다.');
}
async function downloadHls(url,filePath,event){
  let playlistUrl=url;let text=await providerFetch(playlistUrl,{referer:new URL(url).origin+'/'});
  if(/#EXT-X-STREAM-INF/i.test(text)){const lines=text.split(/\r?\n/);const variants=[];for(let i=0;i<lines.length;i++)if(lines[i].startsWith('#EXT-X-STREAM-INF')){const bandwidth=Number(lines[i].match(/BANDWIDTH=(\d+)/i)?.[1]||0);const child=lines.slice(i+1).find(x=>x.trim()&&!x.startsWith('#'));if(child)variants.push({bandwidth,url:new URL(child.trim(),playlistUrl).href})}const best=variants.sort((a,b)=>b.bandwidth-a.bandwidth)[0];if(!best)throw new Error('HLS 화질 목록을 해석하지 못했습니다.');playlistUrl=best.url;text=await providerFetch(playlistUrl,{referer:url});}
  if(/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/i.test(text))throw new Error('암호화된 HLS는 오프라인 저장을 지원하지 않습니다.');
  const segments=text.split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')).map(x=>new URL(x,playlistUrl).href);if(!segments.length)throw new Error('HLS 세그먼트를 찾지 못했습니다.');
  const output=fs.createWriteStream(filePath);try{for(let i=0;i<segments.length;i++){const response=await fetch(segments[i],{headers:{'User-Agent':LINKKF_UA,Referer:playlistUrl}});if(!response.ok)throw new Error(`세그먼트 ${i+1} HTTP ${response.status}`);const data=Buffer.from(await response.arrayBuffer());if(!output.write(data))await new Promise(resolve=>output.once('drain',resolve));event.sender.send('download:progress',{received:i+1,total:segments.length,percent:Math.round((i+1)/segments.length*100)});}}finally{await new Promise(resolve=>output.end(resolve));}
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#121212',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#121212', symbolColor: '#d0cdd6', height: 42 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Timers drive auto skip and autoplay; keep them running in the background.
      backgroundThrottling: false
    }
  });
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

app.whenReady().then(async () => {
  const broadcast=(channel,value)=>BrowserWindow.getAllWindows().forEach(win=>{if(!win.isDestroyed())win.webContents.send(channel,value)});
  const subtitleStore=new SubtitleStore({app});
  // Same order as the player's ensureSubtitle: the preferred source's saved file, the stream's own
  // subtitle, any saved file, then Kairan/Csora.
  const downloadSubtitleKey=job=>{const episode=job.episode||{};return encodeURIComponent(String(episode.url||episode.token||episode.id||episode.number||''))};
  const findDownloadSubtitle=async(job,stream)=>{
    const key=downloadSubtitleKey(job),saved=key?subtitleStore.list(key):[],preferred=job.subtitleSource||'reanime';
    const fromSaved=entry=>({source:entry.source,path:entry.path,assPath:entry.assPath,fonts:entry.fonts||[],label:entry.label});
    // A Gemini translation stands for the Re:Anime subtitle it was made from.
    const savedPreferred=(preferred==='reanime'&&saved.find(entry=>entry.source==='gemini'))||saved.find(entry=>entry.source===preferred);if(savedPreferred)return fromSaved(savedPreferred);
    if(stream?.subtitleUrl)return {stream:true};
    if(saved[0])return fromSaved(saved[0]);
    const search=communitySearch(job);
    for(const source of COMMUNITY_SOURCES.includes(preferred)?[preferred,...COMMUNITY_SOURCES.filter(x=>x!==preferred)]:COMMUNITY_SOURCES){
      try{return await search(source)}catch{/* next source */}
    }
    return null;
  };
  // One online source's Korean subtitle for a download (the Korean titles are looked up once per download).
  const communitySearch=job=>{
    const anime=job.anime||{},title=job.title||anime.title||'',episode=Number(job.episodeNumber)||1;
    const titles=['reanime','animenosub','miruro'].includes(anime.provider)?koreanTitleCandidates(title,anime).catch(()=>[title]):Promise.resolve([title]),offsets=previousSeasonEpisodes(anime,title).catch(()=>[]);
    return async source=>{const result=await findCommunitySubtitleByTitles(source,await titles,episode,{originalTitle:anime.title||'',offsets:await offsets});return {source,path:result.path,assPath:result.assPath,fonts:result.fonts,label:communitySubtitleLabel(source,result)}};
  };
  // Unless the stream has its own Korean track: the episode's best Jimaku file (saved for the episode too, so the
  // player offers it), translated when 설정 > Jimaku 자막 자동 번역 is Gemini or the local AI and one of them is set up.
  const jimakuTranslation=()=>{const setting=translator().settings().jimakuTranslate;return setting!=='off'&&translator().ready()?setting:null};
  const findDownloadJimaku=async job=>{
    const anime=job.anime||{},episode=Number(job.episodeNumber)||1,[file]=await jimakuEpisodeFiles(anime,episode).catch(()=>[]);if(!file)return null;
    const result=await jimakuDownload(file,anime,episode),key=downloadSubtitleKey(job);
    if(key)subtitleStore.save(key,{source:'jimaku',label:'Jimaku 자막',path:result.path,assPath:result.assPath,fonts:result.fonts});
    return {path:result.path,assPath:result.assPath,fonts:result.fonts,label:'Jimaku 일본어 자막'};
  };
  const translateDownloadJimaku=async(job,file)=>{
    const provider=jimakuTranslation();if(!provider)return null;
    const title=job.displayTitles?.ko||job.title||'',result=await translator().translate({file,title,provider,context:await translationContext(job.anime||{},title)});
    const label=`${String(result.model||'').startsWith('local:')?'로컬 AI':'Gemini'} 번역 (Jimaku)`,key=downloadSubtitleKey(job);
    if(key&&!result.failed)subtitleStore.save(key,{source:'gemini',label,path:result.path});
    return {path:result.path,label};
  };
  // Android LilacDownloadService: AniSkip timestamps are saved with the download (one retry after 500 ms);
  // without them the local analyzer runs over the anime's other downloaded episodes.
  const findDownloadSkips=async job=>{
    const anilistId=job.episode?.anilistId||job.anime?.anilistId||null,malId=job.episode?.malId||job.anime?.malId||null,lookup=()=>androidOnlineSkipTimes({episode:job.episodeNumber,anilistId,malId,duration:job.duration||0}).catch(()=>[]);
    let segments=await lookup();if(!segments.length){await new Promise(resolve=>setTimeout(resolve,500));segments=await lookup()}
    return segments;
  };
  const analyzeDownload=async(job,siblings)=>analyzeOfflineOpEd({title:job.title,episode:job.episodeNumber,currentUrl:pathToFileURL(job.filePath).href,duration:job.duration,candidates:siblings.map(item=>({...item.episode,number:item.episodeNumber,localUrl:pathToFileURL(item.filePath).href}))});
  downloadManager=new DownloadManager({app,resolveTitles:anime=>resolveDisplayTitle(anime),
    saveTrack:(url,referer)=>saveRemoteSubtitle(String(url),remoteTrackOptions(url,referer)).then(file=>subtitleResult(file)),
    translateTrack:async(file,title,anime)=>{const settings=translator().settings();return translator().ready()&&settings.translateDownloads?translator().translate({file,title,context:await translationContext(anime||{},title)}):null},findSubtitle:findDownloadSubtitle,findJimaku:findDownloadJimaku,translateJimaku:translateDownloadJimaku,findSkips:findDownloadSkips,analyzeOpEd:analyzeDownload,// Animenosub and Miruro downloads follow the player: the RAW video when the episode has a Korean subtitle (saved or found
    // by the same search the download attaches afterwards) or a Jimaku file it will translate, else SUB with its
    // burned-in English.
    resolveEpisode:async(episode,job)=>{if(!['animenosub','miruro'].includes(episode?.provider))return resolveProviderEpisode(episode);const korean=await findDownloadSubtitle(job,null).catch(()=>null),jimaku=!korean&&jimakuTranslation()&&(await jimakuEpisodeFiles(job.anime||{},Number(job.episodeNumber)||1).catch(()=>[])).length;return resolveProviderEpisode({...episode,prefer:korean||jimaku?'raw':'sub',download:true})},resolveLinkkf:async episode=>{
    let playerUrl='';try{const root=await linkkfFetch(`https://emdlinkkf.5imgdarr.top/apilink2.php?data=${encodeURIComponent(episode.token)}`);const links=Array.isArray(root.data)?root.data:[];playerUrl=(links.find(x=>String(x.server).toUpperCase()==='NR-HD')||links[0]||{}).link||'';}catch{}
    if(!playerUrl)playerUrl=`${LINKKF_WEB}/up/${encodeURIComponent(episode.postId)}/watch/?slug=${encodeURIComponent(episode.slug)}`;return resolveStreamPage(playerUrl,`${LINKKF_WEB}/`,15000);
  },broadcast});
  // A Miruro stream's playlists and segments (main window video requests) carry its Referer/Origin, and those hosts
  // only allow their own site's origin, so the answer is opened to the player.
  const playerMediaRequest=details=>Boolean(playerStreamHeaders)&&['xhr','media'].includes(details.resourceType)&&/^https?:/i.test(details.url)&&!details.url.startsWith(MIRURO_WEB)&&details.webContentsId!==undefined&&details.webContentsId===mainWindow?.webContents?.id;
  session.defaultSession.webRequest.onBeforeSendHeaders({urls:['*://*/*']},(details,callback)=>{let headers=details.requestHeaders||{};const host=new URL(details.url).host,remembered=resolvedStreamHeaders.get(host)||(playerMediaRequest(details)?playerStreamHeaders:null);if(remembered){for(const [key,value] of Object.entries(remembered)){if(['referer','origin','user-agent','cookie','authorization'].includes(key.toLowerCase())&&value)headers[key]=value;}}callback({requestHeaders:headers});});
  session.defaultSession.webRequest.onHeadersReceived({urls:['*://*/*']},(details,callback)=>{
    if(!playerMediaRequest(details))return callback({});
    const headers={...details.responseHeaders};for(const key of Object.keys(headers))if(/^access-control-allow-(?:origin|credentials)$/i.test(key))delete headers[key];
    headers['Access-Control-Allow-Origin']=['*'];callback({responseHeaders:headers});
  });
  ipcMain.handle('anime:season', () => api('/seasons/now?limit=20&sfw=true'));
  ipcMain.handle('anime:top', () => api('/top/anime?filter=bypopularity&limit=20&sfw=true'));
  ipcMain.handle('anime:search', (_, query) => api(`/anime?q=${encodeURIComponent(query)}&limit=24&sfw=true&order_by=popularity`));
  ipcMain.handle('anime:detail', (_, id) => api(`/anime/${Number(id)}/full`));
  ipcMain.handle('linkkf:home', async (_, page = 1, limit = 20) => {
    const root = await linkkfFetch(`${LINKKF_API}/filter.php?page=${Number(page)}&limit=${Number(limit)}`);
    return { data: (root.data || []).map(linkkfAnime) };
  });
  ipcMain.handle('linkkf:detail', async (_, postId) => {
    const root = await linkkfFetch(`${LINKKF_API}/single.php?postid=${encodeURIComponent(postId)}`);
    return { data: linkkfAnime(root.data || {}) };
  });
  ipcMain.handle('linkkf:schedule', async () => {
    const days = await Promise.all(LINKKF_SCHEDULE_TAGS.map(tag => linkkfFetch(`${LINKKF_API}/singlefilter.php?categorytagid=${tag}&limit=50`).then(root => (root.data || []).map(linkkfAnime)).catch(() => [])));
    return days;
  });
  ipcMain.handle('linkkf:sections', async () => {
    const entries = await Promise.all(Object.entries(LINKKF_SEASON_TYPES).map(([key, tag]) => linkkfFilter({ page: 1, limit: 10, seasonTypeIds: [tag] }).then(result => [key, result.data]).catch(() => [key, []])));
    return Object.fromEntries(entries);
  });
  ipcMain.handle('linkkf:filter-tags', async () => {
    const load = taxonomy => linkkfFetch(`${LINKKF_API}/link/api.php?taxonomy=${encodeURIComponent(taxonomy)}&limit=200&orderby=name&order=ASC`).then(root => (root.terms || []).map(term => ({ id: Number(term.tag_ID) || 0, name: String(term.name || '').trim(), count: Number(term.count) || 0 })).filter(tag => tag.id > 0 && tag.name)).catch(() => []);
    const [formats, genres, years] = await Promise.all([load('anime-seasontype'), load('anigenres'), load('anime-seasonys')]);
    return { formats, genres, years: years.reverse() };
  });
  ipcMain.handle('linkkf:filter', (_, request) => linkkfFilter(request));
  ipcMain.handle('linkkf:search', async (_, query = '') => {
    const key = linkkfSearchKey(query); if (!key) return { data: [] };
    const catalog = await linkkfCatalog();
    const data = catalog.filter(a => [a.title, a.title_english, a.title_japanese, a.romaji, a.synonyms, ...(a.genres || []).map(g => g.name)].some(value => linkkfSearchKey(value).includes(key)));
    return { data, total: data.length };
  });
  // Android records a Linkkf view after the detail page has been open for 9 s, then refreshes the counters.
  ipcMain.handle('linkkf:record-view', async (_, postId = '') => {
    const id = String(postId || '').trim(); if (!/^\d+$/.test(id)) return null;
    const form = new FormData(); form.append('action', 'record'); form.append('id', id);
    try { await fetch(`${LINKKF_API}/view.php`, { method: 'POST', body: form, headers: { 'User-Agent': LINKKF_UA, Referer: `${LINKKF_WEB}/up/${id}/` } }); } catch { /* counters are best effort */ }
    return linkkfFetch(`${LINKKF_API}/view.php?action=get&id=${encodeURIComponent(id)}`).then(root => root.status === 'success' && root.data ? { day: Number(root.data.day_views) || 0, week: Number(root.data.week_views) || 0, month: Number(root.data.month_views) || 0, total: Number(root.data.total_views) || 0 } : null).catch(() => null);
  });
  ipcMain.handle('linkkf:extras', async (_, anime = {}) => {
    const postId = String(anime.id || '');
    const stats = await linkkfFetch(`${LINKKF_API}/view.php?action=get&id=${encodeURIComponent(postId)}`).then(root => root.status === 'success' && root.data ? { day: Number(root.data.day_views) || 0, week: Number(root.data.week_views) || 0, month: Number(root.data.month_views) || 0, total: Number(root.data.total_views) || 0 } : null).catch(() => null);
    const related = (await Promise.all((anime.seriesTagIds || []).map(async tagId => {
      try {
        const tax = await linkkfFetch(`${LINKKF_API}/link/tax.php?taxonomy=anime-aniss&tag_ID=${Number(tagId)}`), term = (tax.terms || [])[0] || {};
        const root = await linkkfFetch(`${LINKKF_API}/singlefilter.php?postanisstagid=${Number(tagId)}&limit=25`);
        const items = (root.data || []).map(linkkfAnime).filter(item => item.id && item.id !== postId);
        return items.length ? { id: Number(tagId), name: String(term.name || '').trim() || `Series ${tagId}`, count: Number(term.count) || 0, items } : null;
      } catch { return null; }
    }))).filter(Boolean).sort((a, b) => b.count - a.count);
    return { stats, related };
  });
  ipcMain.handle('linkkf:episodes', async (_, postId) => {
    const root = await linkkfFetch(`${LINKKF_EPISODE_API}/api2.php?epid=${encodeURIComponent(postId)}`);
    return (Array.isArray(root) ? root : []).map(server => ({
      id: server.id, name: server.server_name || `Server ${server.id}`,
      episodes: (server.server_data || []).map(item => ({
        name: String(item.name || item.slug || ''), slug: String(item.slug || ''),
        // The player's episode number (next episode, subtitles, OP/ED) from the name ("12", "12화", "12-13").
        number: Number(String(item.name || item.slug || '').match(/\d+/)?.[0]) || null,
        token: String(item.link || `${postId}v${server.id}_${item.slug || ''}`), postId
      }))
    })).filter(server => server.episodes.length);
  });
  ipcMain.handle('linkkf:play', async (_, episode) => {
    let playerUrl = '';
    try {
      const root = await linkkfFetch(`https://emdlinkkf.5imgdarr.top/apilink2.php?data=${encodeURIComponent(episode.token)}`);
      const links = Array.isArray(root.data) ? root.data : [];
      playerUrl = (links.find(x => String(x.server).toUpperCase() === 'NR-HD') || links[0] || {}).link || '';
    } catch { /* Use the watch page while the player-link server is unavailable. */ }
    if (!playerUrl) playerUrl = `${LINKKF_WEB}/up/${encodeURIComponent(episode.postId)}/watch/?slug=${encodeURIComponent(episode.slug)}`;
    const player = new BrowserWindow({
      width: 1180, height: 760, minWidth: 760, minHeight: 500, backgroundColor: '#050407',
      title: `LilacAnime · ${episode.name}화`, autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    await player.loadURL(playerUrl, { httpReferrer: `${LINKKF_WEB}/` });
    return true;
  });
  ipcMain.handle('linkkf:resolve', async (_, episode) => {
    playerStreamHeaders=null;let playerUrl='';try{const root=await linkkfFetch(`https://emdlinkkf.5imgdarr.top/apilink2.php?data=${encodeURIComponent(episode.token)}`);const links=Array.isArray(root.data)?root.data:[];playerUrl=(links.find(x=>String(x.server).toUpperCase()==='NR-HD')||links[0]||{}).link||'';}catch{}
    if(!playerUrl)playerUrl=`${LINKKF_WEB}/up/${encodeURIComponent(episode.postId)}/watch/?slug=${encodeURIComponent(episode.slug)}`;
    return resolveStreamPage(playerUrl,`${LINKKF_WEB}/`,15000);
  });
  // Home rails, most popular first and only shows that already have episodes (early in a season most are still to
  // air): "2026 가을 신작" (this season; Re:Anime and Miruro filter their catalog by season and year, Animenosub its
  // list by season tag) and "방영 중" (airing now). Seasons follow the anime calendar (January winter, April spring,
  // July summer, October autumn).
  async function homeShows(provider,kind){
    const now=new Date(),year=now.getFullYear(),index=Math.floor(now.getMonth()/3),season=['WINTER','SPRING','SUMMER','FALL'][index];
    const current=kind==='season',data=[];
    if (provider === 'reanime') {
      const filter=current?`season=${season}&year=${year}`:'status=RELEASING&sort=popularity';
      const root=await providerFetch(`${REANIME_WEB}/api/v1/search?limit=100&offset=0&${filter}`,{json:true,referer:`${REANIME_WEB}/search`});
      // Its status can say "Not Yet Released" for a show with episodes, so the episode counts decide.
      data.push(...reanimeItems(root).filter(item=>item.subbed>0||item.dubbed>0));
    } else if (provider === 'miruro') {
      let cursor;const candidates=[];
      for(let page=0;page<6&&candidates.length<40;page++){
        const root=await miruroApi('anime',current?{season,season_year:year,sort:'-popularity',limit:15,cursor}:{status:'RELEASING',sort:'-popularity',limit:15,cursor});
        candidates.push(...(root.data||[]).filter(raw=>raw.status!=='NOT_YET_RELEASED'&&Object.values(raw.episode_counts||{}).some(count=>Number(count)>0)));
        cursor=root.next_cursor;if(!root.has_more||!cursor)break;
      }
      // Its status and counts can promise episodes of a new show that has none to play yet (Cyberpunk: Edgerunners 2 had
      // 9, Narumi's Week at Work 4), so this season's shows are checked against their episode lists.
      if(current){
        let next=0;const playable=new Set();
        await Promise.all(Array.from({length:6},async()=>{while(next<candidates.length){const raw=candidates[next++];if(await miruroHasEpisodes(raw))playable.add(raw.id)}}));
        data.push(...candidates.filter(raw=>playable.has(raw.id)).map(miruroItem));
      }else data.push(...candidates.map(miruroItem));
    } else if (provider === 'animenosub') {
      const filter=current?`season%5B0%5D=${season.toLowerCase()}-${year}`:'status=ongoing';
      for(let page=1;page<=3;page++){
        // Only the result cards (the page also links its own views such as "Text Mode" under /anime/), without the
        // ones ribboned "Upcoming".
        const $=cheerio.load(await providerFetch(`${ANIMENOSUB_WEB}/anime/?${page>1?`page=${page}&`:''}${filter}&order=popular`,{referer:`${ANIMENOSUB_WEB}/`})),cards=$('article.bs');
        const items=animenosubList(cards.filter((_,node)=>!/upcoming/i.test($(node).find('.ans-status-ribbon').text())).map((_,node)=>$.html(node)).get().join(''));
        const fresh=items.filter(item=>!data.some(known=>known.mal_id===item.mal_id));data.push(...fresh);if(!cards.length)break;
      }
    } else throw new Error('지원하지 않는 콘텐츠 소스입니다.');
    return {data,label:current?`${year} ${['겨울','봄','여름','가을'][index]}`:''};
  }
  ipcMain.handle('provider:season', (_, provider) => homeShows(provider,'season'));
  ipcMain.handle('provider:airing', (_, provider) => homeShows(provider,'airing'));
  ipcMain.handle('provider:catalog', async (_, provider, query = '', offset = 0) => {
    if (provider === 'reanime') {
      const pageOffset=Math.max(0,Number(offset)||0),url=new URL('/api/v1/search',REANIME_WEB);if(query)url.searchParams.set('q',query);url.searchParams.set('limit','36');url.searchParams.set('offset',String(pageOffset));const root=await providerFetch(url.href,{json:true,referer:`${REANIME_WEB}/search?limit=36&offset=${pageOffset}`});return {data:reanimeItems(root),total:Number(root?.total)||null,offset:pageOffset,limit:36};
    }
    if (provider === 'animenosub') {
      const page=Math.max(1,Number(offset)||1),base=query?`${ANIMENOSUB_WEB}/?s=${encodeURIComponent(query)}`:(page===1?`${ANIMENOSUB_WEB}/`:`${ANIMENOSUB_WEB}/page/${page}/`),url=query&&page>1?`${ANIMENOSUB_WEB}/page/${page}/?s=${encodeURIComponent(query)}`:base;const data=animenosubList(await providerFetch(url,{referer:`${ANIMENOSUB_WEB}/`}),undefined,{onlyResults:Boolean(query)});return {data,offset:page,nextOffset:page+1,done:data.length===0};
    }
    if (provider === 'miruro') {
      // offset is the cursor of the next page (none for the first).
      const root=await miruroApi('anime',query?{q:query,limit:15,sort:'-popularity',cursor:offset||undefined}:{sort:'-popularity',limit:15,cursor:offset||undefined});
      return {data:(root.data||[]).map(miruroItem),offset,nextOffset:root.next_cursor||null,done:!root.has_more||!root.next_cursor};
    }
    throw new Error('지원하지 않는 콘텐츠 소스입니다.');
  });
  ipcMain.handle('provider:detail', async (_, anime) => {
    if (anime.provider === 'miruro') return miruroDetail(anime);
    const html=await providerFetch(anime.url,{referer:new URL(anime.url).origin+'/'});
    const detail=anime.provider==='animenosub'?animenosubDetail(html,anime):anime.provider==='reanime'?await reanimeDetail(anime,html):{...anime,synopsis:cheerio.load(html)('meta[name=description]').attr('content')||anime.synopsis};
    const episodes=anime.provider==='reanime'?await reanimeEpisodes(detail,html):providerEpisodes(html,anime.provider,detail);
    return {data:detail,episodes,unavailable:false};
  });
  ipcMain.handle('provider:play', (_, episode, title) => openProviderPlayer(episode,title).then(()=>true));
  // The player's own resolves (downloads resolve in the background through resolveProviderEpisode directly).
  ipcMain.handle('provider:resolve', async (_, episode) => {
    playerStreamHeaders = null;
    const stream = await resolveProviderEpisode(episode);
    if (episode?.provider === 'miruro') playerStreamHeaders = stream.headers || null;
    return stream;
  });
  ipcMain.handle('provider:subtitle-tracks', (_, episode) => reanimeSubtitleTracks(episode));
  ipcMain.handle('cover:data', (_, url) => coverDataUrl(url));
  updater=new Updater({app,broadcast});
  ipcMain.handle('subtitle-store:list',(_,key)=>subtitleStore.list(String(key||'')));
  ipcMain.handle('subtitle-store:save',(_,key,entry)=>subtitleStore.save(String(key||''),entry));
  ipcMain.handle('subtitle-store:remove',(_,key,id)=>subtitleStore.remove(String(key||''),String(id||'')));
  ipcMain.handle('window:theme',(event,light)=>{const win=BrowserWindow.fromWebContents(event.sender);if(win&&!win.isDestroyed())win.setTitleBarOverlay(light?{color:'#ffffff',symbolColor:'#1c1b1f',height:42}:{color:'#121212',symbolColor:'#d0cdd6',height:42});});
  ipcMain.handle('update:state',()=>updater.state);
  ipcMain.handle('update:notes',()=>updater.notes());
  ipcMain.handle('update:check',()=>updater.check());
  ipcMain.handle('update:download',()=>updater.download());
  ipcMain.handle('update:install',()=>updater.install());
  ipcMain.handle('downloads:list',()=>downloadManager.list());
  ipcMain.handle('downloads:add',(_,request)=>downloadManager.enqueue(request));
  ipcMain.handle('downloads:cancel',(_,id)=>downloadManager.cancel(id));
  ipcMain.handle('downloads:resume',(_,id)=>downloadManager.resume(id));
  ipcMain.handle('downloads:remove',(_,id)=>downloadManager.remove(id));
  ipcMain.handle('downloads:play',(_,id)=>downloadManager.localPlayback(id));
  ipcMain.handle('downloads:open-folder',()=>shell.openPath(downloadManager.root));
  // Android OpEdSkipResolver: online playback uses AniSkip only; a downloaded episode uses the AniSkip
  // timestamps saved with the download, then the local audio analyzer over other downloaded episodes.
  ipcMain.handle('oped:get', async (event, request = {}) => {
    const {title='',episode,duration,currentUrl,candidates=[],anilistId=null,malId=null,audioAnalysis=true,offline=false,jobId=null}=request;if(!/^(https?|file):/i.test(currentUrl||'')||!Number.isFinite(Number(duration)))return [];
    const status=message=>event.sender.send('oped:status',message);
    if(!offline){status('AniSkip 타임스탬프 확인 중');try{return await androidOnlineSkipTimes({episode,anilistId,malId,duration})}catch{return []}}
    const saved=downloadManager.jobs.find(job=>job.id===jobId)?.skipSegments;if(Array.isArray(saved)&&saved.length)return saved;
    if(audioAnalysis===false)return [];
    return analyzeOfflineOpEd({title,episode,currentUrl,duration,candidates:candidates.filter(candidate=>candidate.localUrl),status});
  });
  ipcMain.handle('oped:clear', async () => {const cacheFile=path.join(app.getPath('userData'),'oped-fingerprint-cache.json');try{fs.unlinkSync(cacheFile)}catch(error){if(error.code!=='ENOENT')throw error}return true;});
  ipcMain.handle('media:download', async (event, url, suggestedName = 'episode.mp4') => {
    const isHls=/\.m3u8(?:$|\?)/i.test(url);if(isHls)suggestedName=suggestedName.replace(/\.[^.]+$/,'.ts');
    const result = await dialog.showSaveDialog({title:'영상 저장',defaultPath:suggestedName,filters:[{name:'Video',extensions:['mp4','mkv','webm','ts']}]});
    if (result.canceled || !result.filePath) return null;
    if(isHls){await downloadHls(url,result.filePath,event);return result.filePath;}
    const response = await fetch(url,{headers:{'User-Agent':LINKKF_UA}});
    if (!response.ok || !response.body) throw new Error(`다운로드 HTTP ${response.status}`);
    const total=Number(response.headers.get('content-length')||0);let received=0;
    const stream=Readable.fromWeb(response.body);stream.on('data',chunk=>{received+=chunk.length;event.sender.send('download:progress',{received,total,percent:total?Math.round(received/total*100):null})});
    await pipeline(stream,fs.createWriteStream(result.filePath));
    return result.filePath;
  });
  ipcMain.handle('subtitle:remote', (_, url, referer = '') => {
    if (!/^https:\/\//i.test(String(url || ''))) throw new Error('올바른 자막 주소가 아닙니다.');
    return saveRemoteSubtitle(String(url), remoteTrackOptions(url, referer)).then(file => subtitleResult(file));
  });
  // The sandboxed preload has no url.pathToFileURL, so file URLs are built here.
  ipcMain.handle('subtitle:find', async (_, source, title, episode, anime = null, options = {}) => {
    // Kairan/Csora posts use Korean titles; Re:ANIME titles are resolved to Korean first (TMDB, AniList, Wikidata).
    // Korean subtitle blogs need the Korean title of English-titled sources.
    const titles = ['reanime', 'animenosub', 'miruro'].includes(anime?.provider) ? await koreanTitleCandidates(title, anime).catch(() => [title]) : [title];
    const offsets = await previousSeasonEpisodes(anime || {}, title).catch(() => []);
    return findCommunitySubtitleByTitles(source, titles, Number(episode), { originalTitle: anime?.title || '', offsets, maker: String(options?.maker || '') });
  });
  // Anissia makers of the playing anime, for the player menu.
  ipcMain.handle('anissia:makers', async (_, title, anime = null) => {
    // Korean subtitle blogs need the Korean title of English-titled sources.
    const titles = ['reanime', 'animenosub', 'miruro'].includes(anime?.provider) ? await koreanTitleCandidates(title, anime).catch(() => [title]) : [title];
    for (const name of titles) {
      const found = await anissiaMakers(name, anime?.title || '').catch(() => null);
      if (found) return { subject: found.anime.subject, makers: found.captions.map(item => ({ name: item.name, episode: item.episode, support: anissiaMakerSupport(item.website) })).filter((item, index, list) => list.findIndex(other => other.name === item.name) === index) };
    }
    return { subject: '', makers: [] };
  });
  ipcMain.handle('mpv:status', () => ({available:Boolean(findExecutable('mpv')),path:findExecutable('mpv')}));
  ipcMain.handle('player:fullscreen', (event,enabled) => {const win=BrowserWindow.fromWebContents(event.sender);if(win)win.setFullScreen(Boolean(enabled));return Boolean(enabled)});
  ipcMain.handle('mpv:play', (_, mediaUrl, subtitlePath, title = 'LilacAnime') => {
    const executable=findExecutable('mpv');if(!executable)throw new Error('mpv를 찾지 못했습니다. 설정에서 경로를 확인하거나 mpv를 설치하세요.');
    const args=['--hwdec=auto','--force-window=yes',`--title=${title}`,'--save-position-on-quit','--watch-later-options=start'];if(subtitlePath)args.push(`--sub-file=${subtitlePath}`);args.push(mediaUrl);const child=spawn(executable,args,{detached:true,stdio:'ignore'});child.unref();return true;
  });
  ipcMain.handle('file:video', async () => {
    const result = await dialog.showOpenDialog({
      title: '재생할 영상 선택',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mkv', 'm4v', 'mov'] }]
    });
    return result.canceled ? null : { path: result.filePaths[0], url: pathToFileURL(result.filePaths[0]).href };
  });
  ipcMain.handle('file:subtitle', async () => {
    const result = await dialog.showOpenDialog({
      title: '자막 선택',
      properties: ['openFile'],
      filters: [{ name: 'Subtitle', extensions: ['vtt', 'srt', 'ass', 'ssa', 'smi', 'sami'] }]
    });
    if(result.canceled)return null;return subtitleResult(result.filePaths[0]);
  });
  // Default ASS font: the user's choice (설정 > 기본 자막 폰트) or a Korean system font,
  // since libass' bundled fallback font has no Hangul glyphs.
  ipcMain.handle('tmdb:get',()=>({key:tmdbKey()}));
  // Gemini translation of subtitle tracks (the user's own key); progress goes to the page that asked.
  ipcMain.handle('jimaku:list',(_,anime={},episode=1)=>jimakuEpisodeFiles(anime||{},Number(episode)||1));
  ipcMain.handle('jimaku:download',(_,file={},anime={},episode=1)=>jimakuDownload(file||{},anime||{},Number(episode)||1));
  ipcMain.handle('gemini:get',()=>translator().settings());
  // Local AI models (설정 > 자막 자동 번역): a preset is downloaded from Hugging Face with progress events, or a GGUF
  // file on this PC is added.
  ipcMain.handle('localai:install',async(_,id)=>{
    const send=value=>broadcast('localai:progress',{id,...value});
    try{await translator().local.installModel(String(id||''),(done,total)=>send({done,total}));send({finished:true})}catch(error){send({error:error.message});throw error}
    return translator().settings();
  });
  ipcMain.handle('localai:add-file',async()=>{
    const result=await dialog.showOpenDialog({title:'GGUF 모델 파일 선택',properties:['openFile'],filters:[{name:'GGUF',extensions:['gguf']}]});
    if(result.canceled||!result.filePaths[0])return null;
    const id=translator().local.addFile(result.filePaths[0]);return translator().saveSettings({localModel:id});
  });
  ipcMain.handle('localai:remove',(_,id)=>{translator().local.removeModel(String(id||''));return translator().settings()});
  ipcMain.handle('gemini:set',(_,value={})=>translator().saveSettings(value||{}));
  ipcMain.handle('subtitle:translate',async(event,{path:file='',title='',id=0,provider='',anime=null}={})=>{
    const resolved=path.resolve(String(file||''));
    // App subtitle files and the tracks saved with downloads.
    if(![path.join(app.getPath('userData'),'subtitles'),downloadManager?.root].some(root=>root&&resolved.startsWith(root+path.sep))||!/\.vtt$/i.test(resolved)||!fs.existsSync(resolved))throw new Error('번역할 자막 파일이 없습니다.');
    const send=value=>{if(!event.sender.isDestroyed())event.sender.send('translate:progress',{id,...value})};
    const context=await translationContext(anime||{},String(title||''));
    const result=await translator().translate({file:resolved,title:String(title||''),provider:['gemini','local'].includes(provider)?provider:'',context,progress:(done,total)=>send({done,total}),status:text=>send({status:text})});
    return subtitleResult(result.path,{model:result.model,failed:result.failed,cached:result.cached,fallbackFrom:result.fallbackFrom||'',fallbackReason:result.fallbackReason||''});
  });
  // Several lookups at a time (TMDB answers quickly; AniList allows about 90 requests a minute).
  ipcMain.handle('titles:resolve',async(_,list=[])=>{
    const items=(Array.isArray(list)?list:[]).slice(0,60),results=[];let next=0;
    await Promise.all(Array.from({length:6},async()=>{while(next<items.length){const item=items[next++];results.push(await resolveDisplayTitle(item).catch(()=>({key:`${item.provider||'jikan'}:${item.id??item.mal_id}`,ko:'',en:''})))}}));
    return results;
  });
  ipcMain.handle('titles:variants',(_,query)=>titleSearchVariants(query).catch(()=>[]));
  ipcMain.handle('catalog:search-korean',(_,provider,query)=>searchCatalogIndex(String(provider||''),String(query||'')).catch(()=>[]));
  ipcMain.handle('catalog:activate',(_,provider)=>{
    activeCatalogSource=String(provider||'');
    if(CATALOGS[activeCatalogSource]){const index=catalogIndex(activeCatalogSource);if(!index.items.length||index.status==='idle')index.status='catalog';buildCatalogIndexes().catch(()=>{})}
    return catalogIndexState();
  });
  ipcMain.handle('catalog-index:state',()=>catalogIndexState());
  ipcMain.handle('tmdb:set',async(_,value='')=>{
    const key=String(value||'').trim();
    if(key)await tmdbFetch('/configuration',{},key);
    fs.writeFileSync(tmdbSettingsFile(),JSON.stringify({key}),'utf8');koreanTitleCache.clear();for(const [name,entry] of Object.entries(displayTitleStore()))if(!entry.ko||!entry.en)delete displayTitleStore()[name];saveDisplayTitles();
    if(key)buildCatalogIndexes().catch(()=>{});
    return {key};
  });
  ipcMain.handle('font:default', (_, choice = '기본체', customPath = '') => {
    const windir = process.env.WINDIR || 'C:\\Windows', system = name => path.join(windir, 'Fonts', name), user = name => path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts', name);
    const presets = { '기본체': [system('malgun.ttf')], '나눔고딕': [system('NanumGothic.ttf'), user('NanumGothic.ttf')], '명조체': [system('batang.ttc'), system('NanumMyeongjo.ttf'), user('NanumMyeongjo.ttf')] };
    const candidates = [customPath, ...(presets[choice] || []), system('malgun.ttf'), system('gulim.ttc')].filter(Boolean);
    // libass picks its fallback font by family name, so the real family name is read from the font file.
    for (const file of candidates) {
      if (!/\.(ttf|otf|ttc)$/i.test(file) || !fs.existsSync(file)) continue;
      try { const data = fs.readFileSync(file), family = fontFamilyName(data); if (family) return { name: path.basename(file), family, data }; } catch { /* try next */ }
    }
    return null;
  });
  ipcMain.handle('file:font', async () => {
    const result = await dialog.showOpenDialog({ title: '기본 자막 폰트 선택', properties: ['openFile'], filters: [{ name: 'Font', extensions: ['ttf', 'otf', 'ttc'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('open:external', (_, url) => {
    if (/^https:\/\//i.test(url)) return shell.openExternal(url);
  });
  if(process.env.LILAC_SMOKE_REANIME==='1'){
    try{
      const result=await resolveProviderEpisode({provider:'reanime',url:`${REANIME_WEB}/watch/attack-on-titan-p9y2p9?ep=1`,number:1,anilistId:16498});
      const manifestResponse=await fetch(result.url);const manifest=await manifestResponse.text();
      if(!manifestResponse.ok||!manifest.startsWith('#EXTM3U'))throw new Error(`복호화 프록시 manifest 검증 실패 (${manifestResponse.status}) ${manifest.slice(0,120)}`);
      const playerTest=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false}});
      await playerTest.loadFile(path.join(__dirname,'..','src','index.html'));
      const hlsResult=await playerTest.webContents.executeJavaScript(`new Promise(resolve=>{const video=document.getElementById('video');const hls=new Hls({enableWorker:true});let manifest={},codecs={},lastFrag='';const timer=setTimeout(()=>{hls.destroy();resolve({ok:false,error:'renderer timeout',manifest,codecs,lastFrag})},60000);hls.on(Hls.Events.MANIFEST_PARSED,()=>{manifest={levels:hls.levels.map(x=>({audioCodec:x.audioCodec,videoCodec:x.videoCodec,width:x.width,height:x.height})),audioTracks:hls.audioTracks.map(x=>({name:x.name,lang:x.lang,audioCodec:x.audioCodec}))}});hls.on(Hls.Events.BUFFER_CODECS,(_,data)=>{for(const [k,v] of Object.entries(data))if(v&&v.codec)codecs[k]={codec:v.codec,container:v.container,levelCodec:v.levelCodec}});hls.on(Hls.Events.FRAG_BUFFERED,(_,data)=>{lastFrag=data.frag?.type;if(codecs.audio&&codecs.video){clearTimeout(timer);const out={ok:true,manifest,codecs,fragType:lastFrag,muted:video.muted,volume:video.volume,audioTracks:video.audioTracks?.length??null};hls.destroy();resolve(out)}});hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal){clearTimeout(timer);hls.destroy();resolve({ok:false,error:data.details||data.type,manifest,codecs})}});hls.loadSource(${JSON.stringify(result.url)});hls.attachMedia(video)})`,true);
      if(!hlsResult?.ok)throw new Error(`HLS.js 실제 세그먼트 검증 실패: ${hlsResult?.error||'unknown'}`);
      playerTest.destroy();
      console.log(`LILAC_SMOKE_OK ${JSON.stringify({url:result.url,subtitle:Boolean(result.subtitleUrl),subtitleTracks:(result.subtitleTracks||[]).map(x=>x.label),manifest:true,fragment:true,hls:hlsResult})}`);
    }catch(error){console.error(`LILAC_SMOKE_FAILED ${error.stack||error.message}`);process.exitCode=1}
    app.quit();return;
  }
  createWindow();
  // Installed builds check GitHub releases shortly after launch; dev runs use the settings button.
  // At start and every 3 hours while the app stays open.
  // The selected source's catalog index refreshes in the background (started by the page, see catalog:activate).
  setInterval(()=>buildCatalogIndexes().catch(()=>{}),6*60*60*1000).unref?.();
  if(app.isPackaged){setTimeout(()=>updater.check(),5000);setInterval(()=>updater.check(),3*60*60*1000).unref?.()}
  app.on('activate', () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); });
});

app.on('before-quit', () => { closeFlixProxy(); subtitleTranslator?.local?.stop(); });
app.on('window-all-closed', () => { if (process.env.LILAC_SMOKE_REANIME==='1')return;if (process.platform !== 'darwin') app.quit(); });
