const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../electron/main.cjs'),'utf8');
const episode={url:'https://reanime.test/watch/mouse-cursor?ep=2',number:2,anilistId:206774,dub:false};
const server=(id,name,type)=>({serverName:name,dataType:type,dataLink:`https://flixcloud.cc/e/${id}`});
function setup(watch,flix){
  const context=vm.createContext({URL,REANIME_WEB:'https://reanime.test',providerFetch:async url=>url.includes('/api/watch/')?{episode_links:watch}:{servers:flix}});
  vm.runInContext(source.slice(source.indexOf('async function reanimeServers('),source.indexOf('// Subtitle track list only')),context);
  return request=>context.reanimeServers({...episode,...request});
}
test('DUB-first API responses still select original audio before HD priority (mouse cursor episode 2)',async()=>{
  const list=[server('dub1','HD-1','dub'),server('sub1','HD-1','sub'),server('dub2','HD-2','dub'),server('sub2','HD-2','sub')];
  const result=await setup([],list)();
  assert.deepEqual(Array.from(result,x=>x.url),['https://flixcloud.cc/e/sub2','https://flixcloud.cc/e/sub1']);
});
test('explicit dubbed episodes only use dubbed servers',async()=>{
  const result=await setup([],[server('sub','HD-2','sub'),server('dub','HD-1','dub')])({dub:true});
  assert.deepEqual(Array.from(result,x=>x.url),['https://flixcloud.cc/e/dub']);
});
test('unusable or wrong-audio watch links fall back to Flix; dub-only replies stay unavailable',async()=>{
  const dub=server('dub','HD-2','dub');
  assert.equal((await setup([dub],[server('sub','HD-1','sub')])())[0].url,'https://flixcloud.cc/e/sub');
  assert.equal((await setup([dub],[dub])()).length,0);
});
test('shared SUB/DUB URLs are filtered before deduplication and legacy untyped links remain usable',async()=>{
  const result=await setup([],[server('same','HD-2','dub'),server('same','HD-2','sub'),server('legacy','HD-1',undefined)])();
  assert.deepEqual(Array.from(result,x=>x.url),['https://flixcloud.cc/e/same','https://flixcloud.cc/e/legacy']);
});
// An episode synced from the phone has no AniList id: it is read from the series route by the episode's slug.
test('an episode without its AniList id asks Flix by the one the series route gives',async()=>{
  const asked=[];
  const context=vm.createContext({URL,REANIME_WEB:'https://reanime.test',providerFetch:async url=>{asked.push(url);return url.includes('/api/watch/')?{episode_links:[]}:url.includes('/api/v1/anime/')?{anilist_id:14741}:{servers:[server('sub','HD-2','sub')]}}});
  vm.runInContext(source.slice(source.indexOf('async function reanimeServers('),source.indexOf('// Subtitle track list only')),context);
  const result=await context.reanimeServers({url:'https://reanime.to/watch/love-chunibyo-other-delusions-y66mwz?ep=1',number:1,dub:false});
  assert.deepEqual(Array.from(result,x=>x.url),['https://flixcloud.cc/e/sub']);
  assert.ok(asked.includes('https://reanime.test/api/v1/anime/love-chunibyo-other-delusions-y66mwz'));
  assert.ok(asked.includes('https://reanime.test/api/flix/14741/1'));
});
