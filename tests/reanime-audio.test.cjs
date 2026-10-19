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
