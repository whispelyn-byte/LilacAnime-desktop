const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { resolve, track } = require('../src/subtitle-source.js');
const ja = { language: 'ja-JP', label: 'Japanese Full', url: 'ja' }, en = { language: 'en', label: 'English Full', url: 'en' }, jimaku = { name: 'show.01.ja.ass', url: 'jimaku' };
function lookup(tracks, files = [jimaku], failures = []) {
  const calls = [];
  return { calls, run: () => resolve({ tracks, getJimaku: async () => { calls.push('list'); return files; },
    readTrack: async item => { calls.push(item.url); if (failures.includes(item.url)) throw Error('offline'); return { path: item.url }; },
    readJimaku: async item => { calls.push(item.url); if (failures.includes(item.url)) throw Error('offline'); return { path: item.url }; } }) };
}
test('site Japanese wins without waiting for Jimaku; Jimaku wins over English', async () => {
  const first = lookup([en, ja]); assert.equal((await first.run()).file.path, 'ja'); assert.deepEqual(first.calls, ['ja']);
  const second = lookup([en]); assert.equal((await second.run()).file.path, 'jimaku'); assert.deepEqual(second.calls, ['list', 'jimaku']);
});
test('missing or failed Jimaku falls through to site English, and failed site Japanese tries Jimaku', async () => {
  for (const files of [[], [jimaku]]) {
    const state = lookup([en], files, ['jimaku']); assert.equal((await state.run()).file.path, 'en');
  }
  const state = lookup([ja, en], [jimaku], ['ja']); assert.equal((await state.run()).file.path, 'jimaku');
});
test('dialogue tracks precede AI transcripts, signs-only tracks and English Jimaku files are skipped', async () => {
  assert.equal(track([{...en,label:'English Signs & Songs'}, {...en,label:'English AI'}, en], 'en'), en);
  assert.equal(track([{...ja,label:'Japanese Forced'}], 'ja'), null);
  const state = lookup([en], [{name:'show.01.en.srt',url:'wrong-language'}]);
  assert.equal((await state.run()).file.path, 'en'); assert.equal(state.calls.includes('wrong-language'), false);
});
test('another site\'s tracks come after the site\'s own and Jimaku, and are waited for only after Jimaku', async () => {
  const crossJa = { ...ja, url: 'cross-ja', crossSite: true }, crossEn = { ...en, url: 'cross-en', crossSite: true };
  const order = async ({ tracks = [], later = null, files = [jimaku], failures = [] }) => {
    const calls = [];
    const result = await resolve({ tracks, laterTracks: later, getJimaku: async () => { calls.push('list'); return files; },
      readTrack: async item => { calls.push(item.url); if (failures.includes(item.url)) throw Error('offline'); return { path: item.url }; },
      readJimaku: async item => { calls.push(item.url); if (failures.includes(item.url)) throw Error('offline'); return { path: item.url }; } });
    return { path: result?.file.path || null, calls };
  };
  assert.equal((await order({ tracks: [crossJa, en] })).path, 'jimaku');
  assert.deepEqual((await order({ later: Promise.resolve([crossJa, crossEn]), files: [] })).calls, ['list', 'cross-ja']);
  assert.deepEqual((await order({ tracks: [en], later: Promise.resolve([en, crossJa]), files: [] })).calls, ['list', 'cross-ja']);
  assert.deepEqual((await order({ tracks: [], later: Promise.resolve([crossEn, en]), files: [] })).calls, ['list', 'en']);
  assert.deepEqual((await order({ later: Promise.resolve([crossJa, crossEn]), files: [], failures: ['cross-ja'] })).calls, ['list', 'cross-ja', 'cross-en']);
  // A failed own Japanese track is not tried a second time once the later list (which holds it too) is in.
  assert.deepEqual((await order({ tracks: [ja], later: Promise.resolve([ja]), files: [], failures: ['ja'] })).calls, ['ja', 'list']);
  // The own tracks a downloaded episode loads later still go before another site's.
  assert.equal(track([crossJa, ja], 'ja'), ja);
});
test('switching episodes while Jimaku loads cannot read or apply the old source', async () => {
  let current = true, reads = 0;
  const result = await resolve({ tracks:[en], current:()=>current, getJimaku:async()=>{current=false;return [jimaku]}, readTrack:async()=>{reads++},readJimaku:async()=>{reads++} });
  assert.equal(result,null);assert.equal(reads,0);
});
const appSource=fs.readFileSync(path.resolve(__dirname,'../src/app.js'),'utf8');
const ensure=appSource.slice(appSource.indexOf('async function ensureSubtitle('),appSource.indexOf('// No Korean subtitle anywhere',appSource.indexOf('async function ensureSubtitle(')));
for(const source of ['kairan','csora','anissia'])for(const saved of [false,true])test(`${source} ${saved?'saved':'online'} Korean subtitle is used without background translation`,async()=>{
  let translated=0,applied=0;
  const context={window:{lilac:{savedSubtitles:async()=>saved?[{source}]:[]}},localStorage:{getItem:()=> 'reanime'},playbackRequestId:1,currentPlaybackContext:{episode:{provider:'reanime'}},currentSubtitle:null,
    $:()=>({classList:{add(){}},textContent:''}),subtitleStoreKey:()=> 'episode',prefersAiSubtitle:()=>false,
    applySavedSubtitle:async()=>{applied++},attachOnlineSubtitle:()=>{applied++},onlineSubtitleFor:async()=>({source,result:{}}),subtitleSearchAnime:()=>({}),
    isKoreanTrack:()=>false,autoTranslate:async()=>{translated++;return true},offerKoreanSubtitle:()=>{},renderSubtitleTracks:()=>{},
    setTimeout,clearTimeout,seriesKey:()=> 'series',autoTranslateProvider:()=>null};
  vm.createContext(context);vm.runInContext(ensure,context);
  assert.equal(await context.ensureSubtitle(null,'show',1),true);assert.equal(applied,1);assert.equal(translated,0);
});
test('downloaded Korean fansubs do not trigger Jimaku or track translation',async t=>{
  const {DownloadManager}=require('../electron/download-manager.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-subtitle-source-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'episode.mp4'),sub=path.join(dir,'ja.vtt');fs.writeFileSync(file,'video');fs.writeFileSync(sub,'WEBVTT');
  let jimakuCalls=0,translated=0;
  const job={filePath:file,episode:{provider:'reanime'}};
  const manager=Object.assign(Object.create(DownloadManager.prototype),{jobs:[job],save(){},copySubtitle(){},findSubtitle:async()=>({source:'kairan'}),findJimaku:async()=>{jimakuCalls++},saveTrack:async()=>({path:sub}),translateTrack:async()=>{translated++}});
  await manager.attachSubtitle(job,{subtitleTracks:[ja]});await manager.attachTracks(job,{subtitleTracks:[ja]});
  assert.equal(job.koreanSubtitle,true);assert.equal(jimakuCalls,0);assert.equal(translated,0);
});
// The Korean search of ensureSubtitle (koreanSearchFor), run as the player runs it.
function koreanSearch({blog,blogAfter=0,tracksAfter=null,korean=false}){
  const context={currentPlaybackContext:{subtitleTracks:[]},setTimeout,clearTimeout,Date,subtitleSearchAnime:()=>({}),
    isKoreanTrack:item=>item.language==='ko',onlineSubtitleFor:()=>new Promise(done=>setTimeout(()=>done(blog||null),blogAfter))};
  if(tracksAfter!==null)context.currentPlaybackContext.tracksPromise=new Promise(done=>setTimeout(()=>{if(korean)context.currentPlaybackContext.subtitleTracks=[{crossSite:true,language:'ko',url:'ohli24'}];done()},tracksAfter));
  vm.createContext(context);vm.runInContext(ensure,context);return context.koreanSearchFor('show',1);
}
test('another site\'s Korean track that comes within the short wait is put on before the blogs\' one',async()=>{
  const search=koreanSearch({blog:{source:'kairan'},tracksAfter:40,korean:true});
  assert.equal((await search.wait(2500))?.track?.url,'ohli24');
});
test('the blogs\' Korean subtitle goes on once the other sites have nothing',async()=>{
  const search=koreanSearch({blog:{source:'kairan'},tracksAfter:20});
  assert.equal((await search.wait(2500))?.blog?.source,'kairan');assert.equal(search.settled(),true);
});
test('a slow search ends the short wait with nothing, and the Korean file it brings later is still there',async()=>{
  const search=koreanSearch({tracksAfter:150,korean:true});
  const started=Date.now();assert.equal(await search.wait(30),null);assert.ok(Date.now()-started<120);assert.equal(search.settled(),false);
  assert.equal((await search.wait(5000))?.track?.url,'ohli24');
});
