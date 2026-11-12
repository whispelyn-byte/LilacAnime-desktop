// Read-only source smoke check (Electron preserves the Korean sites' TLS behavior):
// node node_modules/electron/cli.js tests/provider-schedule.live.cjs
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const cheerio = require('cheerio'), zlib = require('node:zlib');
const electron = process.versions.electron ? require('electron') : null;
const { createWeeklySchedule } = require('../electron/weekly-schedule.cjs');

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const ctx = vm.createContext({ cheerio, zlib, Buffer, URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout,
  fetch, LINKKF_UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  LINKKF_API: 'https://linkkf1.5imgdarr.top/api', LINKKF_WEB: 'https://linkkf.app', REANIME_WEB: 'https://reanime.cz', REANIME_ID: 'https://reanime.to', reanimeLive: url => String(url || '').replace(/^https?:\/\/(?:www\.)?reanime\.(?:to|cz)(?=[/?#]|$)/i, 'https://reanime.cz'),
  ANIMENOSUB_WEB: 'https://animenosub.to', MIRURO_WEB: 'https://www.miruro.to', MIRURO_KEY: Buffer.from('miruro/catalog'),
  LINKANI_WEB: 'https://linkani.tv', OHLI24_WEB: 'https://ani.ohli24.com', net: electron?.net || { fetch }
});
function add(name, oneLine = false) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  if (!match) throw new Error(`Missing production function: ${name}`);
  const start = match.index, end = oneLine ? source.indexOf('\n', start) : source.indexOf('\n}', start) + 2;
  vm.runInContext(source.slice(start, end), ctx);
}
for (const name of ['linkkfFetch', 'linkkfImage', 'linkkfAnime', 'providerFetch', 'reanimeItems', 'animenosubList', 'miruroApi', 'miruroItem', 'linkaniFetch', 'linkaniItems', 'ohliFetch', 'ohliPage', 'ohliAnime']) add(name);
for (const name of ['absoluteUrl', 'miruroText']) add(name, true);
vm.runInContext(source.match(/^const ohliText=.*$/m)[0], ctx);
vm.runInContext(source.match(/^const ohliInfo=.*$/m)[0], ctx);
vm.runInContext("const ohliPath=(...parts)=>`${OHLI24_WEB}/${parts.map(part=>encodeURIComponent(part)).join('/')}`;", ctx);
const {createProviderSchedule}=require('../electron/provider-schedule.cjs');
const schedule=createProviderSchedule({ reanimeBase:ctx.REANIME_WEB,reanimeFetch:url=>ctx.providerFetch(url,{json:true}),reanimeItems:ctx.reanimeItems,miruroApi:ctx.miruroApi,miruroItem:ctx.miruroItem,animenosubBase:ctx.ANIMENOSUB_WEB,animenosubFetch:ctx.providerFetch,animenosubItems:ctx.animenosubList,ohliBase:ctx.OHLI24_WEB,ohliPage:ctx.ohliPage,ohliAnime:ctx.ohliAnime,linkaniBase:ctx.LINKANI_WEB,linkaniFetch:ctx.linkaniFetch,linkaniItems:ctx.linkaniItems,linkkfBase:ctx.LINKKF_API,linkkfTags:[21189,21190,21191,21192,21193,21194,21195],linkkfFetch:ctx.linkkfFetch,linkkfAnime:ctx.linkkfAnime,fallback:createWeeklySchedule(async day=>{const r=await ctx.providerFetch(`https://api.anissia.net/anime/schedule/${day}`,{json:true});if(r.code!=='ok')throw new Error('Anissia failed');return r.data;})});
(async()=>{await electron.app.whenReady();const results=[];await Promise.all(Object.keys({reanime:1,miruro:1,animenosub:1,ohli24:1,linkani:1,linkkf:1}).map(async provider=>{for(const day of (provider==='linkkf'?[6]:[1,2,3,4,5,6,0])){try{const r=await schedule(provider,day);results.push({provider,day,...r});console.log(JSON.stringify({provider,day,native:r.native,count:r.items.length,note:r.note,sample:r.items[0]&&{title:r.items[0].title,time:r.items[0].time,id:r.items[0].anime?.mal_id}}));}catch(e){console.log(provider,day,e.message);process.exitCode=1}}}));fs.writeFileSync(path.join(__dirname,'../build/provider-schedule-live.json'),JSON.stringify(results));electron.app.exit(process.exitCode||0)})().catch(e=>{console.error(e);electron.app.exit(1)});

