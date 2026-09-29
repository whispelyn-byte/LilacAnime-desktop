const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
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

app.commandLine.appendSwitch('disable-blink-features','AutomationControlled');
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
const ANDROID_WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const resolvedStreamHeaders = new Map();
const malIdCache = new Map();
let downloadManager;
let updater;

async function coverDataUrl(rawUrl){
  return String(rawUrl||'');
}

async function resolveMalIdFromAniList(anilistId){
  const id=Number(anilistId);if(!id)return null;if(malIdCache.has(id))return malIdCache.get(id);
  const response=await fetch('https://graphql.anilist.co',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'LilacAnime Android'},body:JSON.stringify({query:'query ($id: Int) { Media(id: $id, type: ANIME) { idMal } }',variables:{id}})});
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
      const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'LilacAnime Android'}});if(!response.ok)return [];
      const root=await response.json();return (root.results||[]).map(item=>{const interval=item.interval||item;return {type:item.skipType,startTime:Number(interval.startTime),endTime:Number(interval.endTime)}}).filter(item=>allowed.has(item.type)&&Number.isFinite(item.startTime)&&item.startTime>=0&&item.endTime>item.startTime).sort((a,b)=>a.startTime-b.startTime);
    }catch{return []}
  };
  const length=Number(duration)||0;
  if(length>0){const matched=await request(length);if(matched.length)return matched}
  return request(0);
}

async function api(pathname) {
  const response = await fetch(`${API}${pathname}`, {
    headers: { 'User-Agent': 'LilacAnime-Desktop/0.3.9' }
  });
  if (!response.ok) throw new Error(`API 요청 실패 (${response.status})`);
  return response.json();
}

async function linkkfFetch(url, timeout = 18000) {
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
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
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
// Android searches the whole Linkkf catalog locally (title/genre). Cache it per session.
let linkkfCatalogCache = null;
async function linkkfCatalog() {
  if (linkkfCatalogCache) return linkkfCatalogCache;
  const found = new Map(), limit = 100;
  for (let page = 1; page <= 400; page += 4) {
    const batch = await Promise.all([0, 1, 2, 3].map(offset => linkkfFetch(`${LINKKF_API}/filter.php?page=${page + offset}&limit=${limit}`).then(root => (root.data || []).map(linkkfAnime)).catch(() => null)));
    if (batch.every(items => items === null)) throw new Error('Linkkf 목록을 불러오지 못했습니다.');
    batch.flat().filter(Boolean).forEach(item => { if (item.id) found.set(item.id, item); });
    if (batch.some(items => !items || items.length < limit)) break;
  }
  linkkfCatalogCache = [...found.values()];
  setTimeout(() => { linkkfCatalogCache = null; }, 30 * 60 * 1000).unref?.();
  return linkkfCatalogCache;
}
function linkkfSearchKey(value = '') { return String(value).toLowerCase().normalize('NFKC').replace(/[\s\-_:·.,!?'"()[\]~]+/g, ''); }

async function providerFetch(url, { json = false, referer } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
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
function animenosubList(html, base = `${ANIMENOSUB_WEB}/`) {
  const $ = cheerio.load(html); const found = new Map();
  $('a[href]').each((_, node) => {
    const el=$(node), href=absoluteUrl(el.attr('href'),base);
    if(!href.startsWith(`${ANIMENOSUB_WEB}/`)||(!href.includes('/anime/')&&!/-episode-\d+/i.test(href)))return;
    const episodeSlug=new URL(href).pathname.split('/').filter(Boolean).pop()||'';
    const seriesSlug=(href.includes('/anime/')?episodeSlug:episodeSlug.replace(/-episode-\d+[a-z]?(?:-dub)?$/i,'')).toLowerCase();
    if(!seriesSlug)return; const container=el.closest('article,li,.item,.film-poster,.post,.ani,div');
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
    if(provider==='animenosub')match=parsed?.pathname.match(/-episode-(\d+)([a-z]?)(-dub)?\/?$/i);
    else if(provider==='reanime'&&parsed?.pathname.includes('/watch/'))match=(parsed.searchParams.get('ep')||el.text()).match(/(?:episode|ep|#)?\s*(\d+)/i);
    if(!match)return;const number=Number(match[1]);episodes.push({name:`${number}${match[2]||''}`,number,url:href,dub:Boolean(match[3]),provider,anilistId:anime.anilistId||null});
  });
  return [...new Map(episodes.map(x=>[`${x.name}:${x.dub}`,x])).values()].sort((a,b)=>a.number-b.number);
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
    const html=await providerFetch(episode.url,{referer:`${ANIMENOSUB_WEB}/`});
    const $=cheerio.load(html);
    const embedded=absoluteUrl($('iframe[src],iframe[data-src]').first().attr('src')||$('iframe[data-src]').first().attr('data-src')||'',episode.url);
    if(embedded)return resolveStreamPage(embedded,episode.url);
  }
  return resolveStreamPage(episode.url,episode.referer||new URL(episode.url).origin+'/');
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
function isKoreanTrack(track){return /kor|korean|한국/i.test(`${track.language} ${track.label}`)||/_kor_/i.test(track.url)}
// ASS/SSA keep their original file for libass (JASSUB) rendering; every format also gets a
// WebVTT copy for the <track> fallback. Fonts extracted next to the subtitle are passed along.
function subtitleResult(file,extra={}){
  const isAss=/\.(ass|ssa)$/i.test(file),vtt=/\.srt$/i.test(file)?srtToVtt(file):isAss?assToVtt(file):file;
  const fonts=isAss?fs.readdirSync(path.dirname(file)).filter(name=>/\.(ttf|otf|ttc|woff2?)$/i.test(name)).map(name=>pathToFileURL(path.join(path.dirname(file),name)).href):[];
  return {...extra,path:vtt,url:pathToFileURL(vtt).href,assPath:isAss?file:null,assUrl:isAss?pathToFileURL(file).href:null,fonts};
}
// Downloads a remote VTT/SRT/ASS subtitle and returns the original file (see subtitleResult).
async function saveRemoteSubtitle(url,{referer='',userAgent=LINKKF_UA,headers={}}={}){
  const response=await fetch(url,{headers:{...headers,'User-Agent':userAgent,Referer:referer||new URL(url).origin+'/'}});
  if(!response.ok)throw new Error(`자막 다운로드 HTTP ${response.status}`);
  const data=Buffer.from(await response.arrayBuffer());if(!data.length||data.length>=200*1024*1024)throw new Error('자막 파일 크기가 올바르지 않습니다.');
  const text=data.toString('utf8').replace(/^﻿/,''),head=text.trimStart().slice(0,200).toLowerCase();
  if(head.startsWith('<!doctype html')||head.startsWith('<html')||head.startsWith('<head'))throw new Error('자막 대신 HTML 응답을 받았습니다.');
  const ext=/^webvtt/i.test(text.trimStart())?'.vtt':/\[script info\]/i.test(text)?'.ass':/^\s*\d+\s*$/m.test(text)&&text.includes(' --> ')?'.srt':'.vtt';
  const dir=path.join(app.getPath('userData'),'subtitles','provider');fs.mkdirSync(dir,{recursive:true});
  let file=path.join(dir,`subtitle_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);fs.writeFileSync(file,text,'utf8');
  return file;
}

async function resolveStreamPage(targetUrl, referer = '') {
  const isFlixCloud=/flixcloud\.cc/i.test(targetUrl);
  const partition=isFlixCloud?'persist:lilac-android-webview-v2':'persist:lilac-provider';
  const browserUa=isFlixCloud?ANDROID_WEBVIEW_UA:LINKKF_UA;
  const resolver=new BrowserWindow({show:false,width:960,height:640,webPreferences:{partition,contextIsolation:true,nodeIntegration:false,sandbox:true,autoplayPolicy:'no-user-gesture-required',backgroundThrottling:false}});
  resolver.webContents.setUserAgent(browserUa);
  const ses=resolver.webContents.session;let stream=null,subtitle=null,lastHeaders={},flixPk='',flixVideo='',flixAudio='';const streams=new Map();
  const filter={urls:['*://*/*']};
  ses.webRequest.onBeforeSendHeaders(filter,(details,callback)=>{const lower=details.url.toLowerCase(),headers=details.requestHeaders||{};if(isFlixCloud){headers['User-Agent']=ANDROID_WEBVIEW_UA;headers['sec-ch-ua']='"Chromium";v="131", "Not_A Brand";v="24"';headers['sec-ch-ua-mobile']='?1';headers['sec-ch-ua-platform']='"Android"';headers['Accept-Language']='en-US,en;q=0.9,ko;q=0.7'}const adMedia=/runative|magsrv|juneworewyjyna|pxltag/i.test(lower),media=lower.includes('.m3u8')||/\.(mp4|webm)(?:\?|$)/i.test(lower);if(media&&!adMedia&&!lower.includes('ad')){streams.set(details.url,{...headers});if(!stream){stream=details.url;lastHeaders={...headers}}}if(!isFlixCloud&&lower.includes('.vtt')&&!/thumbnail/i.test(lower))subtitle ||= details.url;callback({requestHeaders:headers});});
  try {
    await resolver.loadURL(targetUrl,{httpReferrer:referer||new URL(targetUrl).origin+'/',userAgent:browserUa});
    const blocked=await resolver.webContents.executeJavaScript(`(()=>{const text=(document.title+' '+(document.body?.innerText||'')).toLowerCase();return text.includes('sorry, you have been blocked')||text.includes('you have been blocked')})()`,true).catch(()=>false);
    if(blocked)throw new Error('FlixCloud가 이 앱 세션을 차단했습니다. 다른 영상 서버로 전환합니다.');
    const streamDeadline=Date.now()+90000;
    while(!stream&&!resolver.isDestroyed()&&Date.now()<streamDeadline){
      for(const frame of resolver.webContents.mainFrame.frames){
        frame.executeJavaScript(`(()=>{document.querySelectorAll('video').forEach(v=>{v.muted=true;v.play().catch(()=>{})});const els=[...document.querySelectorAll('button,[role=button],.play,.vjs-big-play-button,.jw-display-icon-container,.jw-icon-display,.jwplayer')];const play=els.find(e=>/play|재생|watch|jw-display|jw-icon-display/i.test((e.innerText||e.getAttribute('aria-label')||e.className||'')));if(play&&!play.dataset.lilacClicked){play.dataset.lilacClicked='1';play.click()}let jw=[];try{const api=window.jwplayer?.();const item=api?.getPlaylistItem?.();jw=[item?.file,...(item?.sources||[]).map(x=>x.file)].filter(Boolean);api?.play?.()}catch{}const resources=performance.getEntriesByType('resource').map(e=>e.name);return {urls:[...jw,...resources].filter(u=>/\.(m3u8|mp4|webm)(?:\?|$)/i.test(u)&&!/runative|magsrv|juneworewyjyna|pxltag/i.test(u)),pk:window.__pk||''}})()`,true).then(result=>{if(Array.isArray(result?.urls)){const preferred=result.urls[0];if(preferred&&!stream)stream=preferred}if(result?.pk)flixPk=result.pk}).catch(()=>{});
      }
      await new Promise(resolve=>setTimeout(resolve,350));
    }
    if(isFlixCloud&&stream&&!resolver.isDestroyed()){
      let previousSize=-1,stableChecks=0;
      while(stableChecks<6&&!resolver.isDestroyed()){
        await new Promise(resolve=>setTimeout(resolve,500));
        if(streams.size===previousSize)stableChecks++;else{previousSize=streams.size;stableChecks=0}
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
    if(stream&&!subtitle&&!isFlixCloud){const subtitleDeadline=Date.now()+2500;while(Date.now()<subtitleDeadline&&!subtitle)await new Promise(resolve=>setTimeout(resolve,200));}
    if(!stream)throw new Error('플레이어 창이 닫혀 스트림 탐색을 중단했습니다.');    if(isFlixCloud){while(!flixPk&&!resolver.isDestroyed()){flixPk=await resolver.webContents.executeJavaScript(`window.__pk||''`,true).catch(()=>'');if(!flixPk)await new Promise(resolve=>setTimeout(resolve,250))}if(!flixPk)throw new Error('플레이어 창이 닫혀 복호화 키 탐색을 중단했습니다.');const headers={...lastHeaders,Referer:targetUrl,'User-Agent':ANDROID_WEBVIEW_UA};stream=flixVideo&&flixAudio?await createFlixAvProxyUrl(flixVideo,flixAudio,flixPk,headers):await createFlixProxyUrl(stream,flixPk,headers);}
    let subtitleUrl=subtitle,subtitlePath=null,subtitleAss=null;if(subtitle){try{const saved=subtitleResult(await saveRemoteSubtitle(subtitle,{referer:targetUrl,userAgent:browserUa,headers:lastHeaders}));subtitleUrl=saved.url;subtitlePath=saved.path;subtitleAss=saved.assUrl?{url:saved.assUrl,path:saved.assPath}:null}catch{/* Community subtitle fallback remains available. */}}
    resolvedStreamHeaders.set(new URL(stream).host,{...lastHeaders,Referer:targetUrl});return {url:stream,subtitleUrl,subtitlePath,subtitleAss,subtitleTracks,headers:lastHeaders,referer:targetUrl};
  } finally {ses.webRequest.onBeforeSendHeaders(null);if(!resolver.isDestroyed())resolver.destroy();}
}

function simpleTitle(value=''){return value.toLowerCase().normalize('NFKC').replace(/\[[^\]]*]|\([^)]*\)/g,' ').replace(/\b(?:subtitle|sub)\b|(?:한글|한국어)?\s*자막/gi,' ').replace(/[^a-z0-9가-힣]+/g,' ').trim()}
function titleKey(value=''){const clean=simpleTitle(value),hangul=(clean.match(/[가-힣]+/g)||[]).join('');return hangul.length>=2?hangul:clean.replace(/\s+/g,'')}
function titleScore(target,candidate){const keyA=titleKey(target),keyB=titleKey(candidate);if(!keyA||!keyB)return 0;if(keyA===keyB)return 1;if(keyA.includes(keyB)||keyB.includes(keyA))return Math.min(keyA.length,keyB.length)/Math.max(keyA.length,keyB.length);const a=new Set(simpleTitle(target).split(' ').filter(Boolean)),b=new Set(simpleTitle(candidate).split(' ').filter(Boolean));let hits=0;a.forEach(x=>{if([...b].some(y=>y.includes(x)||x.includes(y)))hits++});return a.size?hits/a.size:0}
async function downloadBuffer(url,referer){const response=await fetch(url,{headers:{'User-Agent':LINKKF_UA,Referer:referer||url}});if(!response.ok)throw new Error(`자막 다운로드 HTTP ${response.status}`);return Buffer.from(await response.arrayBuffer())}
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
function srtToVtt(file){const text=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2');const out=file.replace(/\.srt$/i,'.vtt');fs.writeFileSync(out,`WEBVTT\n\n${text}`,'utf8');return out}
function assToVtt(file){const lines=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/);let inEvents=false,fields=[];const cues=[];const stamp=value=>{const match=String(value).trim().match(/(\d+):(\d{2}):(\d{2})[.](\d{1,3})/);if(!match)return null;return `${String(match[1]).padStart(2,'0')}:${match[2]}:${match[3]}.${match[4].padEnd(3,'0').slice(0,3)}`};for(const line of lines){if(/^\[Events]/i.test(line)){inEvents=true;continue}if(/^\[/.test(line)){inEvents=false;continue}if(!inEvents)continue;if(/^Format:/i.test(line)){fields=line.slice(line.indexOf(':')+1).split(',').map(x=>x.trim().toLowerCase());continue}if(!/^Dialogue:/i.test(line)||!fields.length)continue;const raw=line.slice(line.indexOf(':')+1),parts=raw.split(','),values=parts.slice(0,fields.length-1);values.push(parts.slice(fields.length-1).join(','));const row=Object.fromEntries(fields.map((field,index)=>[field,values[index]||'']));const start=stamp(row.start),end=stamp(row.end);if(!start||!end)continue;const text=(row.text||'').replace(/\{[^}]*}/g,'').replace(/\\[Nn]/g,'\n').replace(/\\h/g,' ').trim();if(text)cues.push(`${start} --> ${end}\n${text}`)}const out=file.replace(/\.(ass|ssa)$/i,'.vtt');fs.writeFileSync(out,`WEBVTT\n\n${cues.join('\n\n')}\n`,'utf8');return out}
// Port of Android NamuWikiTitleResolver: NamuWiki search is a SPA, so the search page is
// rendered in a hidden window and Korean document titles whose result card contains the
// query are ranked (English title first as on Android, then the Japanese native title).
// Android takes the top card as-is, which often lands on songs or unrelated pages, so each
// candidate document is opened and accepted only if it mentions the native or English title.
const namuTitleCache=new Map();
function namuCacheFile(){return path.join(app.getPath('userData'),'namuwiki-title-cache.json')}
function readNamuCache(){try{return JSON.parse(fs.readFileSync(namuCacheFile(),'utf8'))||{}}catch{return {}}}
async function renderNamuPage(url,script,isReady){
  const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{partition:'persist:lilac-namuwiki',contextIsolation:true,nodeIntegration:false,sandbox:true,images:false}});
  try{
    await win.loadURL(url).catch(()=>{});
    let result=null;
    for(let attempt=0;attempt<16&&!win.isDestroyed();attempt++){
      await new Promise(resolve=>setTimeout(resolve,500));
      result=await win.webContents.executeJavaScript(script,true).catch(()=>null);
      if(result&&isReady(result))break;
    }
    return result;
  }finally{if(!win.isDestroyed())win.destroy()}
}
async function namuSearchLinks(query){
  const result=await renderNamuPage(`https://namu.wiki/Search?q=${encodeURIComponent(query)}`,`(()=>{const text=document.body?.innerText||'';const done=/전체\s*\d+\s*건/.test(text);const links=[...document.querySelectorAll('a[href^="/w/"]')].filter(a=>a.closest('section')||a.parentElement?.tagName==='H4').map(a=>({label:a.textContent.replace(/\s+/g,' ').trim(),h4:a.parentElement?.tagName==='H4',card:(a.closest('section')||a.parentElement).innerText.replace(/\s+/g,' ')}));return {done,links}})()`,result=>result.links.length>0||result.done);
  return result?.links||[];
}
async function namuDocumentText(title){
  const result=await renderNamuPage(`https://namu.wiki/w/${encodeURIComponent(title)}`,`(()=>{const text=(document.querySelector('article')||document.body)?.innerText||'';return {text:text.slice(0,30000)}})()`,result=>result.text.length>2000);
  return result?.text||'';
}
function namuCompareKey(value=''){return String(value).normalize('NFKC').toLowerCase().replace(/…/g,'...').replace(/[\s:：'’"“”!！?？.,·・\-–—~〜()（）]/g,'')}
function namuCandidates(query,links){
  const normalize=value=>String(value).toLowerCase().replace(/…/g,'...').replace(/\s+/g,'');
  const tokens=[...new Set(query.replace(/…/g,'...').split(/\s+/).filter(token=>token.length>=2))];
  return links.map(link=>{
    // Subpages (시리즈/음반) count as their parent document; namespaces, list pages and
    // titles whose only Hangul is a disambiguation suffix such as "(노래)" are ignored.
    const label=link.label.replace(/^(파일|분류|틀|나무위키):.*/,'').split('/')[0].trim(),bare=label.replace(/\([^)]*\)/g,'').trim();
    if(!/[가-힣]/.test(bare)||/문서로\s*가기/.test(link.label)||/^(애니메이션|일본 애니메이션|음반|노래|나무위키|최근변경|최근토론|특수기능)$/.test(bare)||/\d{4}년|분기/.test(bare))return null;
    const card=normalize(link.card);let score=card.includes(normalize(query))?10000:0;
    score+=tokens.filter(token=>card.includes(normalize(token))).length*500+(link.h4?300:0)+(label.length>=3?10:0);
    return {label,score};
  }).filter(Boolean).filter((item,index,array)=>array.findIndex(x=>x.label===item.label)===index).sort((a,b)=>b.score-a.score);
}
async function namuKoreanTitle(title,anime={}){
  const original=String(title||'').trim();if(!original||/[가-힣]/.test(original))return original;
  const key=`v2:${anime.id||original}`;if(namuTitleCache.has(key))return namuTitleCache.get(key);
  const disk=readNamuCache();if(disk[key]){namuTitleCache.set(key,disk[key]);return disk[key]}
  let native='';
  if(anime.id){try{const media=await providerFetch(`${REANIME_WEB}/api/v1/anime/${encodeURIComponent(anime.id)}`,{json:true,referer:`${REANIME_WEB}/`});native=String(media?.title?.native||'')}catch{/* English only */}}
  // The Japanese title is distinctive; English titles also appear on unrelated pages, so they only count without one.
  const english=original.replace(/…/g,'...'),markers=[native||english].map(namuCompareKey).filter(value=>value.length>=4);
  let korean=null;const checked=new Set();
  for(const query of [...new Set([english,native].filter(Boolean))]){
    let candidates=[];try{candidates=namuCandidates(query,await namuSearchLinks(query)).filter(x=>x.score>=500)}catch{}
    for(const candidate of candidates.slice(0,3)){
      if(checked.has(candidate.label))continue;checked.add(candidate.label);
      // A work's own document shows the original title in its infobox at the top; actor or
      // character pages only mention it further down.
      const text=namuCompareKey((await namuDocumentText(candidate.label).catch(()=>'')).slice(0,2500));
      if(markers.some(marker=>text.includes(marker))){korean=candidate.label.replace(/\([^)]*\)/g,'').trim();break}
    }
    if(korean)break;
  }
  const result=korean||original;namuTitleCache.set(key,result);
  if(korean){disk[key]=korean;try{fs.writeFileSync(namuCacheFile(),JSON.stringify(disk),'utf8')}catch{}}
  return result;
}
async function findCommunitySubtitle(source,title,episode){
  const blog=source==='kairan'?'https://kairan03.blogspot.com':'https://csora556.blogspot.com';
  const feed=await providerFetch(`${blog}/feeds/posts/default?alt=json&max-results=500&start-index=1`,{json:true,referer:`${blog}/`});
  const posts=(feed.feed?.entry||[]).map(entry=>({title:entry.title?.$t||'',url:(entry.link||[]).find(x=>x.rel==='alternate')?.href||''}));
  const episodePattern=new RegExp(`(?:^|\\D)(?:ep(?:isode)?\\s*|제?\\s*)?0*${episode}(?:\\s*(?:화|회|편))?(?:\\D|$)`,'i');const numbered=posts.filter(post=>episodePattern.test(`${post.title} ${post.url}`));const pool=numbered.length?numbered:(episode===1?posts:[]);const match=pool.map(post=>({...post,score:titleScore(title,post.title)})).sort((a,b)=>b.score-a.score)[0];
  if(!match||match.score<.5)throw new Error(`${source==='kairan'?'Kairan':'Csora'} 자막 게시물을 찾지 못했습니다.`);
  const html=await providerFetch(match.url,{referer:`${blog}/`});const $=cheerio.load(html);const links=[];
  $('a[href]').each((_,a)=>{const href=absoluteUrl($(a).attr('href'),match.url);if(/drive\.google\.com|docs\.google\.com|\.zip(?:$|\?)|\.ass(?:$|\?)|\.ssa(?:$|\?)|\.srt(?:$|\?)|\.vtt(?:$|\?)/i.test(href))links.push(href)});
  if(!links.length)throw new Error('게시물에서 다운로드 링크를 찾지 못했습니다.');
  const dir=path.join(app.getPath('userData'),'subtitles',simpleTitle(title).replace(/\s+/g,'_')||'anime',String(episode));fs.mkdirSync(dir,{recursive:true});const candidates=[];
  for(const original of [...new Set(links)]){try{const id=driveId(original);const url=id?`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`:original;const buffer=await downloadBuffer(url,match.url);if(buffer.length<16||buffer.length>300*1024*1024)continue;if(buffer[0]===0x50&&buffer[1]===0x4b){const zip=new AdmZip(buffer);let extracted=0;for(const entry of zip.getEntries()){if(entry.isDirectory)continue;const size=Number(entry.header?.size||0);extracted+=size;if(size>100*1024*1024||extracted>300*1024*1024)throw new Error('ZIP 자막 크기 제한을 초과했습니다.');const base=path.basename(entry.entryName).replace(/[^\p{L}\p{N}._ -]/gu,'_');if(!/\.(ass|ssa|srt|vtt|ttf|otf|ttc)$/i.test(base))continue;const out=path.join(dir,base);fs.writeFileSync(out,entry.getData());if(/\.(ass|ssa|srt|vtt)$/i.test(base))candidates.push(out)}}else{const type=buffer.slice(0,200).toString('utf8');let ext=/WEBVTT/i.test(type)?'.vtt':/\[Script Info\]/i.test(type)?'.ass':'.srt';const out=path.join(dir,`${source}_${episode}_${Date.now()}${ext}`);fs.writeFileSync(out,buffer);candidates.push(out)}}catch{/* Try remaining links. */}}
  let selected=candidates.find(x=>new RegExp(`(?:^|\\D)${episode}(?:\\D|$)`).test(path.basename(x)))||candidates[0];if(!selected)throw new Error('사용 가능한 자막 파일을 추출하지 못했습니다.');return subtitleResult(selected,{source,post:match.url,all:candidates});
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
    backgroundColor: '#0d0b12',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0b12', symbolColor: '#c9c2d4', height: 42 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

app.whenReady().then(async () => {
  const broadcast=(channel,value)=>BrowserWindow.getAllWindows().forEach(win=>{if(!win.isDestroyed())win.webContents.send(channel,value)});
  downloadManager=new DownloadManager({app,resolveEpisode:resolveProviderEpisode,resolveLinkkf:async episode=>{
    let playerUrl='';try{const root=await linkkfFetch(`https://emdlinkkf.5imgdarr.top/apilink2.php?data=${encodeURIComponent(episode.token)}`,12000);const links=Array.isArray(root.data)?root.data:[];playerUrl=(links.find(x=>String(x.server).toUpperCase()==='NR-HD')||links[0]||{}).link||'';}catch{}
    if(!playerUrl)playerUrl=`${LINKKF_WEB}/up/${encodeURIComponent(episode.postId)}/watch/?slug=${encodeURIComponent(episode.slug)}`;return resolveStreamPage(playerUrl,`${LINKKF_WEB}/`);
  },broadcast});
  session.defaultSession.webRequest.onBeforeSendHeaders({urls:['*://*/*']},(details,callback)=>{let headers=details.requestHeaders||{};const host=new URL(details.url).host,remembered=resolvedStreamHeaders.get(host);if(remembered){for(const [key,value] of Object.entries(remembered)){if(['referer','origin','user-agent','cookie','authorization'].includes(key.toLowerCase())&&value)headers[key]=value;}}callback({requestHeaders:headers});});
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
    return linkkfFetch(`${LINKKF_API}/view.php?action=get&id=${encodeURIComponent(id)}`, 10000).then(root => root.status === 'success' && root.data ? { day: Number(root.data.day_views) || 0, week: Number(root.data.week_views) || 0, month: Number(root.data.month_views) || 0, total: Number(root.data.total_views) || 0 } : null).catch(() => null);
  });
  ipcMain.handle('linkkf:extras', async (_, anime = {}) => {
    const postId = String(anime.id || '');
    const stats = await linkkfFetch(`${LINKKF_API}/view.php?action=get&id=${encodeURIComponent(postId)}`, 10000).then(root => root.status === 'success' && root.data ? { day: Number(root.data.day_views) || 0, week: Number(root.data.week_views) || 0, month: Number(root.data.month_views) || 0, total: Number(root.data.total_views) || 0 } : null).catch(() => null);
    const related = (await Promise.all((anime.seriesTagIds || []).map(async tagId => {
      try {
        const tax = await linkkfFetch(`${LINKKF_API}/link/tax.php?taxonomy=anime-aniss&tag_ID=${Number(tagId)}`, 10000), term = (tax.terms || [])[0] || {};
        const root = await linkkfFetch(`${LINKKF_API}/singlefilter.php?postanisstagid=${Number(tagId)}&limit=25`, 10000);
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
        token: String(item.link || `${postId}v${server.id}_${item.slug || ''}`), postId
      }))
    })).filter(server => server.episodes.length);
  });
  ipcMain.handle('linkkf:play', async (_, episode) => {
    let playerUrl = '';
    try {
      const root = await linkkfFetch(`https://emdlinkkf.5imgdarr.top/apilink2.php?data=${encodeURIComponent(episode.token)}`, 12000);
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
    let playerUrl='';try{const root=await linkkfFetch(`https://emdlinkkf.5imgdarr.top/apilink2.php?data=${encodeURIComponent(episode.token)}`,12000);const links=Array.isArray(root.data)?root.data:[];playerUrl=(links.find(x=>String(x.server).toUpperCase()==='NR-HD')||links[0]||{}).link||'';}catch{}
    if(!playerUrl)playerUrl=`${LINKKF_WEB}/up/${encodeURIComponent(episode.postId)}/watch/?slug=${encodeURIComponent(episode.slug)}`;
    return resolveStreamPage(playerUrl,`${LINKKF_WEB}/`);
  });
  ipcMain.handle('provider:catalog', async (_, provider, query = '', offset = 0) => {
    if (provider === 'reanime') {
      const pageOffset=Math.max(0,Number(offset)||0),url=new URL('/api/v1/search',REANIME_WEB);if(query)url.searchParams.set('q',query);url.searchParams.set('limit','36');url.searchParams.set('offset',String(pageOffset));const root=await providerFetch(url.href,{json:true,referer:`${REANIME_WEB}/search?limit=36&offset=${pageOffset}`});return {data:reanimeItems(root),total:Number(root?.total)||null,offset:pageOffset,limit:36};
    }
    if (provider === 'animenosub') {
      const page=Math.max(1,Number(offset)||1),base=query?`${ANIMENOSUB_WEB}/?s=${encodeURIComponent(query)}`:(page===1?`${ANIMENOSUB_WEB}/`:`${ANIMENOSUB_WEB}/page/${page}/`),url=query&&page>1?`${ANIMENOSUB_WEB}/page/${page}/?s=${encodeURIComponent(query)}`:base;const data=animenosubList(await providerFetch(url,{referer:`${ANIMENOSUB_WEB}/`}));return {data,offset:page,nextOffset:page+1,done:data.length===0};
    }
    throw new Error('지원하지 않는 콘텐츠 소스입니다.');
  });
  ipcMain.handle('provider:detail', async (_, anime) => {
    const html=await providerFetch(anime.url,{referer:new URL(anime.url).origin+'/'});
    const detail=anime.provider==='animenosub'?animenosubDetail(html,anime):anime.provider==='reanime'?await reanimeDetail(anime,html):{...anime,synopsis:cheerio.load(html)('meta[name=description]').attr('content')||anime.synopsis};
    const episodes=anime.provider==='reanime'?await reanimeEpisodes(detail,html):providerEpisodes(html,anime.provider,detail);
    return {data:detail,episodes,unavailable:false};
  });
  ipcMain.handle('provider:play', (_, episode, title) => openProviderPlayer(episode,title).then(()=>true));
  ipcMain.handle('provider:resolve', (_, episode) => resolveProviderEpisode(episode));
  ipcMain.handle('provider:subtitle-tracks', (_, episode) => reanimeSubtitleTracks(episode));
  ipcMain.handle('cover:data', (_, url) => coverDataUrl(url));
  updater=new Updater({app,broadcast});
  const subtitleStore=new SubtitleStore({app});
  ipcMain.handle('subtitle-store:list',(_,key)=>subtitleStore.list(String(key||'')));
  ipcMain.handle('subtitle-store:save',(_,key,entry)=>subtitleStore.save(String(key||''),entry));
  ipcMain.handle('subtitle-store:remove',(_,key,id)=>subtitleStore.remove(String(key||''),String(id||'')));
  ipcMain.handle('window:theme',(event,light)=>{const win=BrowserWindow.fromWebContents(event.sender);if(win&&!win.isDestroyed())win.setTitleBarOverlay(light?{color:'#ffffff',symbolColor:'#242026'}:{color:'#0d0b12',symbolColor:'#c9c2d4'});});
  ipcMain.handle('update:state',()=>updater.state);
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
  ipcMain.handle('oped:get', async (event, request = {}) => {
    const {title='',episode,duration,currentUrl,currentHeaders={},candidates=[],anilistId=null,malId=null,audioAnalysis=true}=request;if(!/^(https?|file):/i.test(currentUrl||'')||!Number.isFinite(Number(duration)))return [];
    const cacheFile=path.join(app.getPath('userData'),'oped-fingerprint-cache.json'),key=`v5-android:${simpleTitle(title)}:${Number(episode)||1}`;let cache={};try{cache=JSON.parse(fs.readFileSync(cacheFile,'utf8'))}catch{}if(Array.isArray(cache[key])&&cache[key].length)return cache[key];
    let segments=[];try{event.sender.send('oped:status','Android 온라인 타임스탬프 확인 중');segments=await androidOnlineSkipTimes({episode,anilistId,malId,duration})}catch{/* Audio analysis remains the offline fallback, matching Android. */}
    if(!segments.length&&audioAnalysis!==false)segments=await detectOpEd({currentUrl,duration:Number(duration),currentHeaders,candidates,resolveEpisode:candidate=>candidate.localUrl?Promise.resolve({url:candidate.localUrl,headers:{}}):resolveProviderEpisode(candidate),status:message=>event.sender.send('oped:status',message)});if(segments.length){cache[key]=segments;try{fs.writeFileSync(cacheFile,JSON.stringify(cache),'utf8')}catch{}}return segments;
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
    return saveRemoteSubtitle(String(url), { referer: /^https:\/\//i.test(referer) ? referer : 'https://flixcloud.cc/', userAgent: ANDROID_WEBVIEW_UA }).then(file => subtitleResult(file));
  });
  // The sandboxed preload has no url.pathToFileURL, so file URLs are built here.
  ipcMain.handle('subtitle:find', async (_, source, title, episode, anime = null) => {
    // Kairan/Csora posts use Korean titles; Re:ANIME titles are resolved through NamuWiki first.
    const searchTitle = anime?.provider === 'reanime' ? await namuKoreanTitle(title, anime) : title;
    return { ...await findCommunitySubtitle(source, searchTitle, Number(episode)), searchTitle };
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
      filters: [{ name: 'Subtitle', extensions: ['vtt', 'srt', 'ass', 'ssa'] }]
    });
    if(result.canceled)return null;return subtitleResult(result.filePaths[0]);
  });
  // Default ASS font: the user's choice (설정 > 기본 자막 폰트) or a Korean system font,
  // since libass' bundled fallback font has no Hangul glyphs.
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
  if(app.isPackaged)setTimeout(()=>updater.check(),5000);
  app.on('activate', () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); });
});

app.on('before-quit', closeFlixProxy);
app.on('window-all-closed', () => { if (process.env.LILAC_SMOKE_REANIME==='1')return;if (process.platform !== 'darwin') app.quit(); });
