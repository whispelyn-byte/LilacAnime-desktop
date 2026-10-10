const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const { downloadFile } = require('./download-transfer.cjs');

function safeName(value = '') {
  return String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 120) || 'episode';
}

function seconds(value = '') {
  const match = String(value).match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

const MAX_CONCURRENT_DOWNLOADS = 2;
// Saved and found subtitle sources whose file is Korean (a fansub, a machine translation, Linkkf's, the user's own).
const KOREAN_SOURCES = ['kairan', 'csora', 'anissia', 'gemini', 'linkkf', 'user'];
const HLS_PARALLEL = 6;
const HLS_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || '131.0.0.0'} Safari/537.36`;

class DownloadManager {
  constructor({ app, resolveEpisode, resolveLinkkf, findSubtitle, findJimaku, translateJimaku, jimakuTranslates, findSkips, analyzeOpEd, resolveTitles, saveTrack, translateTrack, broadcast }) {
    // The folder new episodes go to: Videos\LilacAnime, or the one picked in 내 목록 > 다운로드 (an external drive).
    this.defaultRoot = path.join(app.getPath('videos'), 'LilacAnime');
    this.settingsFile = path.join(app.getPath('userData'), 'download-settings.json');
    let saved = ''; try { saved = String(JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')).root || ''); } catch { /* the default */ }
    this.root = saved && fs.existsSync(saved) ? saved : this.defaultRoot;
    this.stateFile = path.join(app.getPath('userData'), 'downloads.json');
    this.resolveEpisode = resolveEpisode;
    this.resolveLinkkf = resolveLinkkf;
    this.findSubtitle = findSubtitle; this.findJimaku = findJimaku; this.translateJimaku = translateJimaku;
    this.saveTrack = saveTrack;
    this.translateTrack = translateTrack;
    this.jimakuTranslates = jimakuTranslates;
    this.trackQueue = Promise.resolve();
    this.resolveTitles = resolveTitles;
    this.findSkips = findSkips;
    this.analyzeOpEd = analyzeOpEd;
    this.broadcast = broadcast;
    this.resolving = Promise.resolve();
    this.active = new Map(); // job id -> {job, process, controller, finished}; up to two downloads.
    this.jobs = this.read().map(job => ['downloading', 'resolving'].includes(job.status) ? {...job, status:'queued'} : job.stage ? {...job, stage:''} : job);
    fs.mkdirSync(this.root, { recursive: true });
    this.relink();
    this.save();
    setImmediate(() => { this.pump(); this.backfillSubtitles(); });
  }

  read() { try { const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); return Array.isArray(value) ? value : []; } catch { return []; } }
  save() { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); fs.writeFileSync(this.stateFile, JSON.stringify(this.jobs, null, 2)); this.broadcast('downloads:changed', this.list()); }
  // Latest change first: an episode moves up when its state changes, not with every percent of progress, so two
  // series downloading at once do not trade places in the list all the time.
  // missing: a finished episode whose video is not where it was saved (the folder moved, the drive not plugged in).
  list() { return this.jobs.slice().sort((a,b) => (b.updated || 0) - (a.updated || 0)).map(job => job.status === 'completed' && !fs.existsSync(job.filePath || '') ? { ...job, missing: true } : job); }

  // Episodes whose files were moved (the series folders copied to an external drive, say) are found again under the
  // download folder by their series folder and file name; every file of the episode (subtitles, tracks, fonts, poster)
  // moves with its video. Returns how many were found again.
  relink() {
    let found = 0;
    for (const job of this.jobs) {
      if (job.status !== 'completed' || !job.filePath || fs.existsSync(job.filePath)) continue;
      const parts = job.filePath.split(/[\\/]/), candidate = path.join(this.root, ...parts.slice(-2));
      if (!fs.existsSync(candidate)) continue;
      const from = path.dirname(job.filePath), to = path.dirname(candidate), move = file => typeof file === 'string' && file.startsWith(from) ? to + file.slice(from.length) : file;
      for (const key of ['filePath', 'subtitlePath', 'subtitleAssPath', 'posterPath', 'partialPath']) if (job[key]) job[key] = move(job[key]);
      for (const key of ['subtitleFonts', 'subtitleOriginals']) if (Array.isArray(job[key])) job[key] = job[key].map(move);
      for (const track of job.subtitleTracks || []) for (const key of ['path', 'assPath', 'translatedPath']) if (track[key]) track[key] = move(track[key]);
      if (job.posterPath) job.posterUrl = pathToFileURL(job.posterPath).href;
      found++;
    }
    return found;
  }
  // A new download folder: kept for the next start, and the episodes moved into it are found again.
  setRoot(dir) {
    if (!dir || !fs.existsSync(dir)) throw new Error('폴더를 찾을 수 없습니다.');
    this.root = dir;
    fs.writeFileSync(this.settingsFile, JSON.stringify({ root: dir === this.defaultRoot ? '' : dir }));
    const found = this.relink(); this.save();
    return { root: this.root, found, missing: this.list().filter(job => job.missing).length };
  }
  // 목록 비우기: every entry not downloading now leaves the list; its files stay on disk.
  clear() {
    const done = this.jobs.filter(job => !['queued', 'resolving', 'downloading'].includes(job.status));
    this.jobs = this.jobs.filter(job => !done.includes(job)); this.save();
    return done.length;
  }
  key(request) { return `${request.anime?.mal_id || request.anime?.id || request.title}:${request.episode?.provider || request.resolveKind}:${request.episode?.url || request.episode?.token || request.episode?.id || request.episodeNumber}`; }

  enqueue(request) {
    const key = this.key(request), existing = this.jobs.find(job => job.key === key);
    if (existing && existing.status === 'completed' && fs.existsSync(existing.filePath)) { if (!existing.subtitlePath) { existing.subtitleChecked = false; this.backfillSubtitles(); } return existing; }
    if (existing && ['queued','resolving','downloading'].includes(existing.status)) return existing;
    const now = Date.now(), job = existing || { id:`dl_${now}_${Math.random().toString(36).slice(2,8)}`, key, created:now };
    Object.assign(job, request, { title:request.title || request.anime?.title || '애니메이션', episodeNumber:Number(request.episodeNumber || request.episode?.number || request.episode?.name || 1), image:request.image || '', status:'queued', progress:existing?.progress||0, error:'', updated:now });
    if (!existing) this.jobs.push(job);
    this.save(); this.pump(); return job;
  }

  cancel(id) {
    const job = this.jobs.find(item => item.id === id); if (!job || job.status==='completed') return false;
    clearTimeout(this.retryTimers?.get(id));
    this.active.get(id)?.controller?.abort();
    this.active.get(id)?.process?.kill?.();
    job.status = 'paused'; job.updated = Date.now(); this.save(); return true;
  }

  resume(id) { const job=this.jobs.find(item=>item.id===id); if(!job||!['paused','failed'].includes(job.status))return false; clearTimeout(this.retryTimers?.get(id)); job.status='queued';job.error='';job.retries=0;job.updated=Date.now();this.save();this.pump();return true; }

  async remove(id) {
    const job = this.jobs.find(item => item.id === id); if (!job) return false;
    clearTimeout(this.retryTimers?.get(id));
    const active=this.active.get(id);active?.controller?.abort();active?.process?.kill?.();
    this.jobs = this.jobs.filter(item => item.id !== id);this.save();
    await active?.finished;
    for (const file of [job.filePath, job.subtitlePath, job.subtitleAssPath, job.partialPath, ...(job.subtitleOriginals || [])]) { if (file) try { fs.unlinkSync(file); } catch {} }
    this.cleanTransfer(job);
    if (job.filePath) removeOwnedFolder(trackDir(job),path.dirname(job.filePath));
    // The series poster goes with its last episode.
    if (job.posterPath && !this.jobs.some(item => item.posterPath === job.posterPath)) try { fs.unlinkSync(job.posterPath); } catch {}
    this.save(); return true;
  }

  cleanTransfer(job) {
    if(!job.filePath)return;
    const partial=`${job.filePath}.part`;
    removeOwnedFolder(`${partial}.hls`,path.dirname(job.filePath));
    for(const file of [`${partial}.source`,`${partial}.source.json`])try{fs.unlinkSync(file)}catch{}
  }
  shutdown() {
    if(this.stopping)return;this.stopping=true;
    for(const timer of this.retryTimers?.values()||[])clearTimeout(timer);
    for(const active of this.active.values()){
      active.controller.abort();active.process?.kill?.();
      if(['downloading','resolving'].includes(active.job.status))active.job.status='queued';
    }
    this.save();
  }

  pump() {
    if(this.stopping)return;
    while (this.active.size < MAX_CONCURRENT_DOWNLOADS) {
      // A job resumed while its previous run is still winding down (or still resolving) is left to that run.
      const job = this.jobs.find(item => item.status === 'queued' && !this.active.has(item.id)); if (!job) return;
      job.status='resolving';job.updated=Date.now();const active={job,process:null,controller:new AbortController()};this.active.set(job.id,active);this.save();
      active.finished=this.run(job,active);
    }
  }

  async run(job,active) {
    const stopped=()=>active.controller.signal.aborted||this.stopping||!this.jobs.includes(job);
    try {
      // Stream resolution shares one browser session whose request hooks are swapped per call, so only the
      // transfers run in parallel.
      const resolving = this.resolving.then(() => stopped()?null:job.resolveKind === 'linkkf' ? this.resolveLinkkf(job.episode) : this.resolveEpisode(job.episode, job));
      this.resolving = resolving.catch(() => {});
      const stream = await resolving;
      if(stopped())return;
      if(stream?.server)job.videoServer=stream.server; // Animenosub: which server the video came from
      // A special (OVA, SP) is saved by its label ("OVA 1화.mp4"), not over the numbered episode it shares a number with.
      const animeDir=path.join(this.root,safeName(job.title)), base=job.episodeLabel?safeName(job.episodeLabel):`${String(job.episodeNumber).padStart(3,'0')}화`;
      fs.mkdirSync(animeDir,{recursive:true});job.filePath||=path.join(animeDir,`${base}.mp4`);job.partialPath=`${job.filePath}.part`;fs.mkdirSync(path.dirname(job.filePath),{recursive:true});job.status='downloading';job.updated=Date.now();this.save();
      const hls=stream?.mirror||stream?.hls||/\.m3u8(?:$|\?)/i.test(stream.url)||new URL(stream.url).pathname.startsWith('/__flix/');
      const local=hls?await this.mirrorHls(job,stream):await this.mirrorFile(job,stream);
      if(stopped())return;
      await this.runFfmpeg(job,stream,local);
      if(stopped())return;
      try{fs.unlinkSync(job.filePath)}catch{}fs.renameSync(job.partialPath,job.filePath);this.cleanTransfer(job);job.partialPath='';job.status='completed';job.retries=0;job.progress=100;job.completed=Date.now();job.updated=Date.now();
      job.stage='subtitle';this.save();await this.attachSubtitle(job,stream);job.stage='';job.updated=Date.now();this.save();
      if(stopped())return;
      await this.attachSkips(job);
      await this.attachTitles(job);
      await this.attachPoster(job);
      if(!stopped())this.queueTracks(job, stream);
    } catch (error) {
      // A job resumed while this run was stopping stays queued and starts again below.
      if(!stopped()&&!['paused','queued'].includes(job.status)){
        job.status='failed';job.error=error?.message||String(error);job.updated=Date.now();
        // A server that did not answer or a dropped connection: tried again by itself twice (after half a minute, then
        // two minutes), keeping what was downloaded; then it waits for 다시 시작.
        job.retries=(job.retries||0)+1;
        if(job.retries<=2){
          job.error=`${job.error} · ${job.retries===1?'30초':'2분'} 뒤 다시 시도`;
          (this.retryTimers ||= new Map()).set(job.id,setTimeout(()=>{if(job.status==='failed'&&this.jobs.includes(job)){job.status='queued';job.updated=Date.now();this.save();this.pump()}},job.retries===1?30000:120000));
        }
        this.save();
      }
    } finally { this.active.delete(job.id); setImmediate(()=>this.pump()); }
  }

  // local: playlists already fetched by mirrorHls, which FFmpeg only remuxes (the last few percent of the progress).
  runFfmpeg(job,stream,local=null) {
    return new Promise((resolve,reject)=>{
      let ffmpeg=require('ffmpeg-static');if(ffmpeg.includes('app.asar'))ffmpeg=ffmpeg.replace('app.asar','app.asar.unpacked');
      const args=['-y'];
      if(local){
        for(const input of local.inputs){args.push('-protocol_whitelist','file,crypto,data');if(input.endsWith('.m3u8'))args.push('-allowed_extensions','ALL');args.push('-i',input)}
        args.push('-map','0:v?','-map',local.inputs.length>1?'1:a?':'0:a?');
      }else{
        const headers={...(stream?.headers||{})};if(stream?.referer&&!headers.Referer)headers.Referer=stream.referer;
        if(Object.keys(headers).length)args.push('-headers',Object.entries(headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n');
        args.push('-rw_timeout','180000000'); // Android MpvHlsDownloader read timeout: 180 s
        // A playlist whose address does not end in .m3u8 (애니24's) is read as HLS only when told.
        if(stream.hls)args.push('-f','hls','-allowed_extensions','ALL');
        args.push('-i',stream.url,'-map','0:v?','-map','0:a?');
      }
      args.push('-c','copy','-movflags','+faststart','-f','mp4',job.partialPath);
      const [from,span]=local?[95,4]:[0,99];
      const child=spawn(ffmpeg,args,{windowsHide:true});this.active.get(job.id).process=child;let duration=0,stderr='';
      child.stderr.on('data',chunk=>{const text=chunk.toString();stderr=(stderr+text).slice(-12000);const d=text.match(/Duration:\s*([^,]+)/)?.[1];if(d){duration=seconds(d);job.duration=duration}const t=[...text.matchAll(/time=\s*([^\s]+)/g)].pop()?.[1];if(t&&duration){const progress=from+Math.max(0,Math.min(span,Math.round(seconds(t)/duration*span)));if(progress!==job.progress){job.progress=progress;this.save();}}});
      child.once('error',reject);child.once('close',code=>{if(job.status==='paused')return resolve();if(code===0&&fs.existsSync(job.partialPath))resolve();else reject(new Error((stderr.match(/([^\r\n]+)$/)?.[1]||`FFmpeg 종료 코드 ${code}`).trim()));});
    });
  }

  // Persist the chosen HLS variant and its separate audio six files at a time. Atomic segment files survive pause,
  // application exit, and a new stream URL; the playlists are rewritten for local FFmpeg remuxing.
  async mirrorHls(job,stream) {
    const dir=`${job.partialPath}.hls`,controller=new AbortController(),signal=AbortSignal.any([controller.signal,this.active.get(job.id).controller.signal]);fs.mkdirSync(dir,{recursive:true});
    const headers={'User-Agent':HLS_USER_AGENT,...(stream.headers||{})};if(stream.referer&&!headers.Referer)headers.Referer=stream.referer;
    const get=async(url,binary=false,range=null)=>{
      for(let attempt=0;;attempt++){
        try{
          const response=await fetch(url,{headers:{...headers,...(range?{Range:`bytes=${range.start}-${range.start+range.length-1}`}:{})},signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
          if(!response.ok)throw new Error(`HTTP ${response.status}`);
          if(!binary)return await response.text();
          const data=Buffer.from(await response.arrayBuffer());
          if(range){if(response.status!==206||!response.headers.get('content-range')?.startsWith(`bytes ${range.start}-`)||data.length!==range.length)throw new Error('영상 조각의 바이트 범위가 일치하지 않습니다.')}
          return data;
        }catch(error){if(signal.aborted||attempt>=3)throw error;await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason)};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},1500*(attempt+1));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})}
      }
    };
    const master=await get(stream.url),lists=[];
    if(!master.trimStart().startsWith('#EXTM3U'))throw new Error('HLS 재생목록이 올바르지 않습니다.');
    const variants=[...master.matchAll(/#EXT-X-STREAM-INF:([^\r\n]*)\r?\n\s*([^\r\n#][^\r\n]*)/g)].map(match=>({attrs:match[1],uri:match[2].trim(),height:Number(match[1].match(/RESOLUTION=\d+x(\d+)/)?.[1])||0,bandwidth:Number(match[1].match(/BANDWIDTH=(\d+)/)?.[1])||0}));
    if(variants.length){
      const pick=variants[Number.isInteger(stream.program)&&variants[stream.program]?stream.program:variants.reduce((best,item,index)=>(item.height-variants[best].height||item.bandwidth-variants[best].bandwidth)>0?index:best,0)];
      const videoUrl=new URL(pick.uri,stream.url).href;lists.push({name:'video',url:videoUrl,text:await get(videoUrl)});
      // A separate audio rendition (AUDIO="group"): the default one of the group, else its first.
      const group=pick.attrs.match(/AUDIO="([^"]+)"/)?.[1],renditions=group?[...master.matchAll(/#EXT-X-MEDIA:([^\r\n]*)/g)].map(match=>match[1]).filter(attrs=>/TYPE=AUDIO/.test(attrs)&&attrs.includes(`GROUP-ID="${group}"`)&&/URI="/.test(attrs)):[];
      const audio=renditions.find(attrs=>/DEFAULT=YES/.test(attrs))||renditions[0];
      if(audio){const audioUrl=new URL(audio.match(/URI="([^"]+)"/)[1],stream.url).href;lists.push({name:'audio',url:audioUrl,text:await get(audioUrl)})}
    }else lists.push({name:'video',url:stream.url,text:master});
    // A resumed download can land on another server, whose segments must not be mixed with the kept ones (addresses
    // are compared without their per-request tokens).
    const source=JSON.stringify(lists.map(list=>({name:list.name,text:list.text.split(/\r?\n/).map(line=>line.startsWith('#')?line.replace(/URI="([^"]+)"/g,(_,uri)=>`URI="${stableMediaUrl(new URL(uri,list.url).href)}"`):line.trim()?stableMediaUrl(new URL(line.trim(),list.url).href):'')}))),sourceFile=path.join(dir,'source.json');
    let kept='';try{kept=fs.readFileSync(sourceFile,'utf8')}catch{/* new folder */}
    if(kept!==source){removeOwnedFolder(dir,path.dirname(job.filePath));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(sourceFile,source)}
    const files=new Map(),tasks=[];
    for(const list of lists){
      const fmp4=/#EXT-X-MAP/.test(list.text);
      const encrypted=/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/.test(list.text);
      let pendingRange=null,lastEnd=0,lastUri='';
      const local=(uri,ext,range=null)=>{const url=new URL(uri,list.url).href,key=`${url}:${range?`${range.start}:${range.length}`:''}`;if(!files.has(key)){const file=`${list.name}_${String(files.size).padStart(5,'0')}${ext}`;files.set(key,file);tasks.push({url,range,encrypted,file:path.join(dir,file)})}return files.get(key)};
      const text=list.text.split(/\r?\n/).map(raw=>{
        const line=raw.trim();if(!line)return '';
        if(line.startsWith('#EXT-X-BYTERANGE:')){pendingRange=line.split(':')[1];return ''}
        if(line.startsWith('#')){
          const spec=line.startsWith('#EXT-X-MAP')?line.match(/BYTERANGE="(\d+)(?:@(\d+))?"/):null;
          const range=spec?{length:Number(spec[1]),start:Number(spec[2]||0)}:null;
          return line.replace(/,?BYTERANGE="[^"]+"/g,'').replace(/URI="([^"]+)"/g,(_,uri)=>`URI="${local(uri,line.startsWith('#EXT-X-MAP')?'.mp4':'.key',range)}"`);
        }
        let range=null;
        if(pendingRange){const [length,start]=pendingRange.split('@');if(start==null&&lastUri!==line)throw new Error('HLS 바이트 범위의 시작 위치가 없습니다.');range={length:Number(length),start:start==null?lastEnd:Number(start)};lastEnd=range.start+range.length;pendingRange=null}
        lastUri=line;return local(line,fmp4?'.m4s':'.ts',range);
      }).join('\n');
      fs.writeFileSync(path.join(dir,`${list.name}.m3u8`),text);
    }
    let done=tasks.filter(task=>fs.existsSync(task.file)&&fs.statSync(task.file).size>0).length,next=0;
    if(!tasks.length)throw new Error('영상 재생목록이 비어 있습니다.');
    const report=()=>{const progress=Math.min(95,Math.floor(done/tasks.length*95));if(progress!==job.progress){job.progress=progress;this.save()}};
    report();
    const results=await Promise.allSettled(Array.from({length:HLS_PARALLEL},async()=>{
      try{while(next<tasks.length&&!signal.aborted){
        const task=tasks[next++];
        if(!(fs.existsSync(task.file)&&fs.statSync(task.file).size>0)){const data=await get(task.url,true,task.range);signal.throwIfAborted();fs.writeFileSync(`${task.file}.tmp`,task.file.endsWith('.ts')&&!task.encrypted?transportStream(data):data);fs.renameSync(`${task.file}.tmp`,task.file);done++;report()}
      }}catch(error){controller.abort();throw error}
    }));
    const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
    signal.throwIfAborted();
    return {dir,inputs:lists.map(list=>path.join(dir,`${list.name}.m3u8`))};
  }

  async mirrorFile(job,stream) {
    const file=`${job.partialPath}.source`,signal=this.active.get(job.id).controller.signal;
    const headers={'User-Agent':HLS_USER_AGENT,...stream.headers};if(stream.referer&&!headers.Referer)headers.Referer=stream.referer;
    await downloadFile({url:stream.url,file,headers,signal,identity:stableMediaUrl(stream.url),progress:(received,total)=>{
      const progress=total?Math.min(95,Math.floor(received/total*95)):job.progress||0;
      if(progress!==job.progress){job.progress=progress;this.save()}
    }});
    return {inputs:[file]};
  }

  // Subtitles are fetched right after the video so the episode also plays offline with them.
  async attachSubtitle(job, stream) {
    // 애니24: the Korean subtitle is in the video itself, unless the player put it over a raw video from a file.
    if (stream?.burnedKorean || (job.episode?.provider === 'ohli24' && !stream?.subtitleUrl)) { job.subtitleChecked = true; return; }
    let found = null;
    try { found = await this.findSubtitle?.(job, stream); } catch { /* fall back to the stream's own subtitle */ }
    if(!this.jobs.includes(job)||this.stopping)return;
    job.subtitleChecked = true;
    // The Jimaku file (and its translation) comes too: as the subtitle when nothing Korean was found, else next to a
    // Kairan / Csora / Anissia one (a fansub can be another episode's), saved for the episode so the player offers it.
    // Not when the site has its own Korean subtitle (a RE:Anime / Miruro Korean track, Linkkf's), which is the
    // episode's: no Jimaku file and no translation beside it (see attachTracks too).
    job.siteKorean = Boolean(stream?.subtitleUrl) && (job.resolveKind === 'linkkf' || ['reanime', 'miruro', 'linkani', 'ohli24'].includes(job.episode?.provider));
    // Whether the episode's own subtitle is Korean (the site's, a fansub, a translation or the user's file): a track
    // translated later stays beside it then, instead of becoming the episode's subtitle (see attachTracks).
    job.koreanSubtitle = job.siteKorean || Boolean(found && !found.stream && KOREAN_SOURCES.includes(found.source));
    if (!found || found.stream) {
      await this.saveSubtitle(job, stream?.subtitleUrl); this.saveAssSubtitle(job, stream?.subtitleAss?.path);
      if (!job.siteKorean) await this.attachJimaku(job, stream, !found && !job.subtitlePath);
      return;
    }
    this.copySubtitle(job, found);
    if (!job.siteKorean) await this.attachJimaku(job, stream, false);
  }
  copySubtitle(job, found) {
    if(!this.jobs.includes(job)||this.stopping)return;
    const base = job.filePath.replace(/\.mp4$/i, '');
    try {
      if (found.path && fs.existsSync(found.path)) { job.subtitlePath = base + path.extname(found.path); fs.copyFileSync(found.path, job.subtitlePath); }
      if (found.assPath && fs.existsSync(found.assPath)) { job.subtitleAssPath = base + path.extname(found.assPath); fs.copyFileSync(found.assPath, job.subtitleAssPath); }
      // ASS styles name their fonts; they are shared by every episode of the series.
      const fonts = (found.fonts || []).map(url => { try { return fileURLToPath(url); } catch { return null; } }).filter(file => file && fs.existsSync(file));
      if (fonts.length) { const dir = path.join(path.dirname(job.filePath), 'fonts'); fs.mkdirSync(dir, { recursive: true }); job.subtitleFonts = fonts.map(file => { const out = path.join(dir, path.basename(file)); if (!fs.existsSync(out)) fs.copyFileSync(file, out); return out; }); }
      job.subtitleLabel = found.label || '';
    } catch { /* the video is still usable without a subtitle */ }
  }

  // The episode's Japanese file from Jimaku (findJimaku saves it for the episode) and its Korean translation
  // (설정 > 자막 자동 번역), which follows in the track queue so a long local translation holds no download
  // slot. primary: nothing Korean was found, so the file becomes the episode's subtitle (not over English burned into
  // the video) and then its translation does.
  async attachJimaku(job, stream, primary) {
    let file = null;
    try { file = await this.findJimaku?.(job); } catch { /* the video is still usable without a subtitle */ }
    if (!file) return;
    job.jimakuFound = true; this.save();
    const burned = (stream?.servers || []).find(server => server.label === stream?.server)?.kind === 'sub';
    if (primary && !burned) this.copySubtitle(job, file);
    this.trackQueue = this.trackQueue.then(() => this.translateJimakuFor(job, file, primary && !burned)).catch(() => {});
  }
  async translateJimakuFor(job, file, primary) {
    if (!this.jobs.includes(job) || !this.translateJimaku) return;
    job.stage = 'translate'; job.translateProgress = 'Jimaku 자막'; this.save();
    try {
      // Not beside a Korean subtitle: the episode's own file is the Japanese one, or none (English burned into the video).
      const result = await this.translateJimaku(job, file.path, primary || !job.subtitlePath);
      if (!primary || !result || !this.jobs.includes(job) || !fs.existsSync(job.filePath || '')) return;
      const out = job.filePath.replace(/\.mp4$/i, '.ko.vtt'); fs.copyFileSync(result.path, out);
      job.subtitleOriginals = [...(job.subtitleOriginals || []), job.subtitlePath, job.subtitleAssPath].filter(item => item && item !== out);
      Object.assign(job, { subtitlePath: out, subtitleAssPath: null, subtitleFonts: [], subtitleLabel: result.label });
    } catch { /* the Japanese file stays the episode's subtitle */ }
    finally { job.stage = ''; delete job.translateProgress; job.updated = Date.now(); this.save(); }
  }

  // The anime's poster, kept once in its series folder so the downloads list (and the player) show it offline.
  async attachPoster(job) {
    job.posterChecked = true;
    if (job.posterPath && fs.existsSync(job.posterPath)) return;
    if (!/^https?:\/\//i.test(job.image || '') || !job.filePath) return;
    const dir = path.dirname(job.filePath);
    let file = ['.jpg', '.png', '.webp'].map(ext => path.join(dir, `poster${ext}`)).find(item => fs.existsSync(item));
    if (!file) {
      try {
        const response = await fetch(job.image, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' } });
        const type = response.headers.get('content-type') || '';
        if (!response.ok || !/^image\//i.test(type)) return;
        file = path.join(dir, `poster${/png/i.test(type) ? '.png' : /webp/i.test(type) ? '.webp' : '.jpg'}`);
        const data=Buffer.from(await response.arrayBuffer());if(!this.jobs.includes(job)||this.stopping)return;
        fs.writeFileSync(file, data);
      } catch { return; }
    }
    job.posterPath = file; job.posterUrl = pathToFileURL(file).href; this.save();
  }

  // Re:Anime and Miruro subtitle tracks are all kept with the episode, so the track list works offline, and one of them
  // is translated into Korean (설정 > 다운로드할 때 자막 트랙 번역). This runs one episode at a time after the download
  // has finished, so it never holds a download slot.
  queueTracks(job, stream) {
    if (!stream?.subtitleTracks?.length || !this.saveTrack) return;
    this.trackQueue = this.trackQueue.then(() => this.attachTracks(job, stream)).catch(() => {});
  }
  async attachTracks(job, stream) {
    if (!this.jobs.includes(job) || !fs.existsSync(job.filePath || '')) return;
    const dir = trackDir(job), saved = [];
    fs.mkdirSync(dir, { recursive: true });
    for (const [index, track] of stream.subtitleTracks.entries()) {
      try {
        const file = await this.saveTrack(track.url, stream.referer), name = `${String(index + 1).padStart(2, '0')}_${safeName(track.label || 'track')}`;
        if(!this.jobs.includes(job)||this.stopping)return;
        const entry = { label: track.label || `트랙 ${index + 1}`, format: track.format || 'vtt', language: track.language || '', url: track.url, path: path.join(dir, `${name}${path.extname(file.path)}`) };
        fs.copyFileSync(file.path, entry.path);
        if (file.assPath && fs.existsSync(file.assPath)) { entry.assPath = path.join(dir, `${name}${path.extname(file.assPath)}`); fs.copyFileSync(file.assPath, entry.assPath); }
        saved.push(entry);
      } catch { /* the other tracks are still kept */ }
    }
    if (!saved.length || !this.jobs.includes(job)) return;
    job.subtitleTracks = saved; job.updated = Date.now(); this.save();
    // One machine translation is enough, made from the best source even beside a Kairan / Csora / Anissia subtitle (it
    // may be another episode's): none from the tracks when the episode's Jimaku file is translated (설정 > 자막 자동 번역); otherwise the
    // Japanese track (the original dialogue, translated once) or else the English dialogue one (not signs & songs alone,
    // a written one before an AI dub transcript). Translating every track took one run per language, hours with the
    // local AI.
    // None either beside the site's own Korean track (attachSubtitle): the episode has its Korean subtitle.
    if (job.siteKorean || (job.jimakuFound && this.jimakuTranslates?.())) return;
    const text = track => `${track.label} ${track.language}`, code = (track, lang) => new RegExp(`^${lang}(?:[-_]|$)`, 'i').test(track.language || '');
    const rank = track => /signs|songs|forced/i.test(track.label) ? 3 : /dubtitle|\(ai\)|\bai\b/i.test(track.label) ? 2 : /dialogue|full/i.test(track.label) ? 0 : 1;
    const track = saved.find(item => /japanese|日本/i.test(text(item)) || code(item, 'ja')) || saved.filter(item => /english/i.test(text(item)) || code(item, 'en')).sort((a, b) => rank(a) - rank(b))[0];
    if (!track) return;
    const title = job.displayTitles?.ko || job.title;
    try {
      job.stage = 'translate'; job.translateProgress = track.label; this.save();
      const result = await this.translateTrack?.(track.path, title, job.anime).catch(() => null);
      if (!result || !this.jobs.includes(job)) return; // no key or model, translation of downloads turned off, or it failed
      // Nothing Korean for the episode: the translation is its subtitle, beside the video ("<episode>.ko.vtt") as a
      // translated Jimaku file is, not only in the track folder. Beside a Korean one it is kept with the tracks.
      if (!job.koreanSubtitle && fs.existsSync(job.filePath || '')) {
        const out = job.filePath.replace(/\.mp4$/i, '.ko.vtt'); fs.copyFileSync(result.path, out); track.translatedPath = out;
        job.subtitleOriginals = [...(job.subtitleOriginals || []), job.subtitlePath, job.subtitleAssPath].filter(item => item && item !== out);
        Object.assign(job, { subtitlePath: out, subtitleAssPath: null, subtitleFonts: [], subtitleLabel: `${result.engine || 'AI'} 번역 (${track.label})` });
      } else { track.translatedPath = track.path.replace(/\.[^.]+$/, '.ko.vtt'); fs.copyFileSync(result.path, track.translatedPath); }
      track.translatedFailed = result.failed || 0; this.save();
    } finally { job.stage = ''; delete job.translateProgress; job.updated = Date.now(); this.save(); }
  }

  // Korean and English titles, stored with the job so the download is labelled correctly offline.
  async attachTitles(job) {
    if (!job.anime || job.displayTitles?.ko && job.displayTitles?.en) return;
    try {
      const titles = await this.resolveTitles?.({ ...job.anime, title: job.anime.title || job.title });
      if (titles && (titles.ko || titles.en)) { job.displayTitles = { ko: titles.ko || '', en: titles.en || '' }; this.save(); }
    } catch { /* titles stay as they were */ }
  }

  // OP/ED timestamps for offline playback. A failed lookup is not stored, so the analyzer can fill it later.
  async attachSkips(job) {
    let segments = [];
    try { segments = await this.findSkips?.(job) || []; } catch { /* stays empty */ }
    job.skipChecked = true;
    if (segments.length) { job.skipSegments = segments; job.updated = Date.now(); this.save(); return; }
    this.save();
    if (job.opedAnalysis === false || !job.duration) return;
    const identity = item => item.anime?.mal_id || item.anime?.id || item.title;
    const siblings = this.jobs.filter(item => item !== job && item.status === 'completed' && identity(item) === identity(job) && fs.existsSync(item.filePath || ''));
    if (siblings.length) this.analyzeOpEd?.(job, siblings).catch(() => {});
  }

  // Episodes saved before subtitles were bundled get one lookup each.
  async backfillSubtitles() {
    if (this.backfilling) return; this.backfilling = true;
    try {
      for (const job of this.jobs.filter(item => item.status === 'completed' && !item.subtitlePath && !item.subtitleChecked && fs.existsSync(item.filePath || ''))) {
        job.stage = 'subtitle'; this.save(); await this.attachSubtitle(job, null); job.stage = ''; job.updated = Date.now(); this.save();
      }
      for (const job of this.jobs.filter(item => item.status === 'completed' && !item.skipChecked && fs.existsSync(item.filePath || ''))) await this.attachSkips(job);
      for (const job of this.jobs.filter(item => item.status === 'completed' && item.anime && !(item.displayTitles?.ko && item.displayTitles?.en))) await this.attachTitles(job);
      for (const job of this.jobs.filter(item => item.status === 'completed' && item.image && !item.posterChecked && fs.existsSync(item.filePath || ''))) await this.attachPoster(job);
    } finally { this.backfilling = false; }
  }

  saveAssSubtitle(job, file) {
    if(!file||!fs.existsSync(file))return;try{job.subtitleAssPath=job.filePath.replace(/\.mp4$/i,path.extname(file));fs.copyFileSync(file,job.subtitleAssPath)}catch{}
  }

  async saveSubtitle(job, url) {
    if(!url)return;try{let data,ext='.vtt';if(url.startsWith('file:')){const source=fileURLToPath(url);ext=path.extname(source)||ext;data=fs.readFileSync(source)}else{const response=await fetch(url);if(!response.ok)return;data=Buffer.from(await response.arrayBuffer())}if(!this.jobs.includes(job)||this.stopping)return;job.subtitlePath=job.filePath.replace(/\.mp4$/i,ext);fs.writeFileSync(job.subtitlePath,data)}catch{}
  }

  localPlayback(id) { const job=this.jobs.find(item=>item.id===id);if(!job||job.status!=='completed'||!fs.existsSync(job.filePath))throw new Error('다운로드 파일을 찾지 못했습니다.');return {url:pathToFileURL(job.filePath).href,subtitleUrl:job.subtitlePath&&fs.existsSync(job.subtitlePath)?pathToFileURL(job.subtitlePath).href:null,subtitleAss:job.subtitleAssPath&&fs.existsSync(job.subtitleAssPath)?{url:pathToFileURL(job.subtitleAssPath).href,path:job.subtitleAssPath,fonts:(job.subtitleFonts||[]).filter(file=>fs.existsSync(file)).map(file=>pathToFileURL(file).href)}:null,subtitleLabel:job.subtitleLabel||'',subtitleTracks:offlineTracks(job),job}; }
}

// Some hosts disguise TS segments as images (a 1x1 PNG and padding in front). Players look for the TS sync bytes, but
// FFmpeg reading the local copy would take the file for a picture, so the segment is cut at its first TS packet.
function transportStream(data) {
  for (let i = 0; i + 376 < data.length && i < 65536; i++) if (data[i] === 0x47 && data[i + 188] === 0x47 && data[i + 376] === 0x47) return i ? data.subarray(i) : data;
  return data;
}

// Saved tracks with file URLs for the player; the remote URL stays as the track's identity.
function offlineTracks(job) {
  const url = file => file && fs.existsSync(file) ? pathToFileURL(file).href : null;
  return (job.subtitleTracks || []).filter(track => fs.existsSync(track.path || '')).map(track => ({ ...track, localUrl: url(track.path), assUrl: url(track.assPath), translatedUrl: url(track.translatedPath), translatedPath: url(track.translatedPath) ? track.translatedPath : null }));
}
function trackDir(job) { return job.filePath.replace(/\.mp4$/i, '_자막트랙'); }

module.exports = { DownloadManager };

function removeOwnedFolder(target,parent) {
  const resolved=path.resolve(target),root=path.resolve(parent);
  if(path.dirname(resolved)!==root||resolved===root)throw new Error('다운로드 임시 폴더 경로가 올바르지 않습니다.');
  fs.rmSync(resolved,{recursive:true,force:true});
}
function stableMediaUrl(value) {
  let url=new URL(value);
  const proxy=url.hostname==='127.0.0.1'&&url.pathname.match(/^\/__flix\/[^/]+\/(.+)$/);
  if(proxy&&proxy[1]!=='master.m3u8')url=new URL(Buffer.from(proxy[1],'base64url').toString());
  for(const key of [...url.searchParams.keys()])if(/^(?:token|expires?|exp|signature|sig|auth|policy|key-pair-id|hdnts|hmac)$/i.test(key))url.searchParams.delete(key);
  return url.href;
}
