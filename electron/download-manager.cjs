const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');

function safeName(value = '') {
  return String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 120) || 'episode';
}

function seconds(value = '') {
  const match = String(value).match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

const MAX_CONCURRENT_DOWNLOADS = 2;
const HLS_PARALLEL = 6;
const HLS_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || '131.0.0.0'} Safari/537.36`;

class DownloadManager {
  constructor({ app, resolveEpisode, resolveLinkkf, findSubtitle, findJimaku, translateJimaku, jimakuTranslates, findSkips, analyzeOpEd, resolveTitles, saveTrack, translateTrack, broadcast }) {
    this.root = path.join(app.getPath('videos'), 'LilacAnime');
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
    this.active = new Map(); // job id -> {job, process}; Android runs up to 2 downloads at once.
    this.jobs = this.read().map(job => ['downloading', 'resolving'].includes(job.status) ? {...job, status:'queued'} : job.stage ? {...job, stage:''} : job);
    fs.mkdirSync(this.root, { recursive: true });
    this.save();
    setImmediate(() => { this.pump(); this.backfillSubtitles(); });
  }

  read() { try { const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); return Array.isArray(value) ? value : []; } catch { return []; } }
  save() { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); fs.writeFileSync(this.stateFile, JSON.stringify(this.jobs, null, 2)); this.broadcast('downloads:changed', this.list()); }
  list() { return this.jobs.slice().sort((a,b) => (b.updated || 0) - (a.updated || 0)); }
  key(request) { return `${request.anime?.mal_id || request.anime?.id || request.title}:${request.episode?.provider || request.resolveKind}:${request.episode?.url || request.episode?.token || request.episode?.id || request.episodeNumber}`; }

  enqueue(request) {
    const key = this.key(request), existing = this.jobs.find(job => job.key === key);
    if (existing && existing.status === 'completed' && fs.existsSync(existing.filePath)) { if (!existing.subtitlePath) { existing.subtitleChecked = false; this.backfillSubtitles(); } return existing; }
    if (existing && ['queued','resolving','downloading'].includes(existing.status)) return existing;
    const now = Date.now(), job = existing || { id:`dl_${now}_${Math.random().toString(36).slice(2,8)}`, key, created:now };
    Object.assign(job, request, { title:request.title || request.anime?.title || '애니메이션', episodeNumber:Number(request.episodeNumber || request.episode?.number || request.episode?.name || 1), image:request.image || '', status:'queued', progress:0, error:'', updated:now });
    if (!existing) this.jobs.push(job);
    this.save(); this.pump(); return job;
  }

  cancel(id) {
    const job = this.jobs.find(item => item.id === id); if (!job) return false;
    this.active.get(id)?.process?.kill?.();
    job.status = 'paused'; job.updated = Date.now(); this.save(); return true;
  }

  resume(id) { const job=this.jobs.find(item=>item.id===id); if(!job)return false; job.status='queued';job.error='';job.updated=Date.now();this.save();this.pump();return true; }

  remove(id) {
    const job = this.jobs.find(item => item.id === id); if (!job) return false;
    this.active.get(id)?.process?.kill?.();
    for (const file of [job.filePath, job.subtitlePath, job.subtitleAssPath, job.partialPath, ...(job.subtitleOriginals || [])]) { if (file) try { fs.unlinkSync(file); } catch {} }
    if (job.partialPath) try { fs.rmSync(`${job.partialPath}.hls`, { recursive: true, force: true }); } catch {} // mirrorHls copy
    if (job.filePath && job.subtitleTracks) try { fs.rmSync(trackDir(job), { recursive: true, force: true }); } catch {}
    this.jobs = this.jobs.filter(item => item.id !== id);
    // The series poster goes with its last episode.
    if (job.posterPath && !this.jobs.some(item => item.posterPath === job.posterPath)) try { fs.unlinkSync(job.posterPath); } catch {}
    this.save(); return true;
  }

  pump() {
    while (this.active.size < MAX_CONCURRENT_DOWNLOADS) {
      // A job resumed while its previous run is still winding down (or still resolving) is left to that run.
      const job = this.jobs.find(item => item.status === 'queued' && !this.active.has(item.id)); if (!job) return;
      job.status='resolving';job.updated=Date.now();this.active.set(job.id,{job,process:null});this.save();
      this.run(job);
    }
  }

  async run(job) {
    try {
      // Stream resolution shares one browser session whose request hooks are swapped per call, so only the
      // ffmpeg transfers run in parallel.
      const resolving = this.resolving.then(() => job.resolveKind === 'linkkf' ? this.resolveLinkkf(job.episode) : this.resolveEpisode(job.episode, job));
      this.resolving = resolving.catch(() => {});
      const stream = await resolving;
      // Paused while resolving; a pause and resume in that time just carries on.
      if(job.status==='paused'||!this.jobs.some(item=>item.id===job.id))return;
      if(stream?.server)job.videoServer=stream.server; // Animenosub: which server the video came from
      const animeDir=path.join(this.root,safeName(job.title)), base=`${String(job.episodeNumber).padStart(3,'0')}화`;
      fs.mkdirSync(animeDir,{recursive:true});job.filePath=path.join(animeDir,`${base}.mp4`);job.partialPath=`${job.filePath}.part`;job.status='downloading';job.updated=Date.now();this.save();
      const local=stream?.mirror?await this.mirrorHls(job,stream):null;
      if(job.status==='paused')return;
      await this.runFfmpeg(job,stream,local);
      if(job.status==='paused')return;
      try{fs.unlinkSync(job.filePath)}catch{}fs.renameSync(job.partialPath,job.filePath);if(local)try{fs.rmSync(local.dir,{recursive:true,force:true})}catch{}job.partialPath='';job.status='completed';job.progress=100;job.completed=Date.now();job.updated=Date.now();
      job.stage='subtitle';this.save();await this.attachSubtitle(job,stream);job.stage='';job.updated=Date.now();this.save();
      await this.attachSkips(job);
      await this.attachTitles(job);
      await this.attachPoster(job);
      this.queueTracks(job, stream);
    } catch (error) {
      // A job resumed while this run was stopping stays queued and starts again below.
      if(!['paused','queued'].includes(job.status)){job.status='failed';job.error=error?.message||String(error);job.updated=Date.now();this.save();}
    } finally { this.active.delete(job.id); setImmediate(()=>this.pump()); }
  }

  // local: playlists already fetched by mirrorHls, which FFmpeg only remuxes (the last few percent of the progress).
  runFfmpeg(job,stream,local=null) {
    return new Promise((resolve,reject)=>{
      let ffmpeg=require('ffmpeg-static');if(ffmpeg.includes('app.asar'))ffmpeg=ffmpeg.replace('app.asar','app.asar.unpacked');
      const args=['-y'];
      if(local){
        for(const input of local.inputs)args.push('-allowed_extensions','ALL','-i',input);
        args.push('-map','0:v?','-map',local.inputs.length>1?'1:a?':'0:a?');
      }else{
        const headers={...(stream?.headers||{})};if(stream?.referer&&!headers.Referer)headers.Referer=stream.referer;
        if(Object.keys(headers).length)args.push('-headers',Object.entries(headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n');
        args.push('-rw_timeout','180000000'); // Android MpvHlsDownloader read timeout: 180 s
        args.push('-i',stream.url,'-map','0:v?','-map','0:a?');
      }
      args.push('-c','copy','-movflags','+faststart','-f','mp4',job.partialPath);
      const [from,span]=local?[95,4]:[0,99];
      const child=spawn(ffmpeg,args,{windowsHide:true});this.active.set(job.id,{job,process:child});let duration=0,stderr='';
      child.stderr.on('data',chunk=>{const text=chunk.toString();stderr=(stderr+text).slice(-12000);const d=text.match(/Duration:\s*([^,]+)/)?.[1];if(d){duration=seconds(d);job.duration=duration}const t=[...text.matchAll(/time=\s*([^\s]+)/g)].pop()?.[1];if(t&&duration){const progress=from+Math.max(0,Math.min(span,Math.round(seconds(t)/duration*span)));if(progress!==job.progress){job.progress=progress;job.updated=Date.now();this.save();}}});
      child.once('error',reject);child.once('close',code=>{if(job.status==='paused')return resolve();if(code===0&&fs.existsSync(job.partialPath))resolve();else reject(new Error((stderr.match(/([^\r\n]+)$/)?.[1]||`FFmpeg 종료 코드 ${code}`).trim()));});
    });
  }

  // Hosts that serve each segment from another random subdomain make FFmpeg's one-at-a-time HLS reader crawl (a new
  // connection per segment, well under real time). For such streams (stream.mirror, Miruro) the chosen variant
  // (stream.program, else the highest) and its separate audio rendition are fetched here, six files at a time, into a
  // folder next to the file, with the playlists rewritten to the local copies. Files already there are kept, so a
  // paused download continues where it stopped.
  async mirrorHls(job,stream) {
    const dir=`${job.partialPath}.hls`,controller=new AbortController();fs.mkdirSync(dir,{recursive:true});
    this.active.set(job.id,{job,process:{kill:()=>controller.abort()}});
    const headers={'User-Agent':HLS_USER_AGENT,...(stream.headers||{})};if(stream.referer&&!headers.Referer)headers.Referer=stream.referer;
    const get=async(url,binary=false)=>{
      for(let attempt=0;;attempt++){
        try{
          const response=await fetch(url,{headers,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
          if(!response.ok)throw new Error(`HTTP ${response.status}`);
          return binary?Buffer.from(await response.arrayBuffer()):await response.text();
        }catch(error){if(controller.signal.aborted||attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,1500*(attempt+1)))}
      }
    };
    const master=await get(stream.url),lists=[];
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
    const source=JSON.stringify(lists.map(list=>{const url=new URL(list.url);return url.origin+url.pathname})),sourceFile=path.join(dir,'source.json');
    let kept='';try{kept=fs.readFileSync(sourceFile,'utf8')}catch{/* new folder */}
    if(kept!==source){fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(sourceFile,source)}
    const files=new Map(),tasks=[];
    for(const list of lists){
      const fmp4=/#EXT-X-MAP/.test(list.text);
      const local=(uri,ext)=>{const url=new URL(uri,list.url).href;if(!files.has(url)){const file=`${list.name}_${String(files.size).padStart(5,'0')}${ext}`;files.set(url,file);tasks.push({url,file:path.join(dir,file)})}return files.get(url)};
      const text=list.text.split(/\r?\n/).map(line=>!line.trim()?line:line.startsWith('#')?line.replace(/URI="([^"]+)"/g,(_,uri)=>`URI="${local(uri,line.startsWith('#EXT-X-MAP')?'.mp4':'.key')}"`):local(line.trim(),fmp4?'.m4s':'.ts')).join('\n');
      fs.writeFileSync(path.join(dir,`${list.name}.m3u8`),text);
    }
    let done=0,next=0;
    if(!tasks.length)throw new Error('영상 재생목록이 비어 있습니다.');
    const report=()=>{const progress=Math.min(95,Math.floor(done/tasks.length*95));if(progress!==job.progress){job.progress=progress;job.updated=Date.now();this.save()}};
    await Promise.all(Array.from({length:HLS_PARALLEL},async()=>{
      while(next<tasks.length&&!controller.signal.aborted){
        const task=tasks[next++];
        if(!(fs.existsSync(task.file)&&fs.statSync(task.file).size>0)){const data=await get(task.url,true);fs.writeFileSync(`${task.file}.tmp`,task.file.endsWith('.ts')?transportStream(data):data);fs.renameSync(`${task.file}.tmp`,task.file)}
        done++;report();
      }
    })).catch(error=>{controller.abort();if(job.status!=='paused')throw error});
    return {dir,inputs:lists.map(list=>path.join(dir,`${list.name}.m3u8`))};
  }

  // Subtitles are fetched right after the video so the episode also plays offline with them.
  async attachSubtitle(job, stream) {
    let found = null;
    try { found = await this.findSubtitle?.(job, stream); } catch { /* fall back to the stream's own subtitle */ }
    job.subtitleChecked = true;
    // The Jimaku file (and its translation) always comes too: as the subtitle when nothing Korean was found, else next
    // to the Korean one (a fansub, or RE:Anime's / Miruro's own Korean track), saved for the episode so the player
    // offers it.
    if (!found || found.stream) {
      await this.saveSubtitle(job, stream?.subtitleUrl); this.saveAssSubtitle(job, stream?.subtitleAss?.path);
      await this.attachJimaku(job, stream, !found && !job.subtitlePath);
      return;
    }
    this.copySubtitle(job, found);
    await this.attachJimaku(job, stream, false);
  }
  copySubtitle(job, found) {
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
  // (설정 > Jimaku 자막 자동 번역), which follows in the track queue so a long local translation holds no download
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
      const result = await this.translateJimaku(job, file.path);
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
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
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
        const entry = { label: track.label || `트랙 ${index + 1}`, format: track.format || 'vtt', language: track.language || '', url: track.url, path: path.join(dir, `${name}${path.extname(file.path)}`) };
        fs.copyFileSync(file.path, entry.path);
        if (file.assPath && fs.existsSync(file.assPath)) { entry.assPath = path.join(dir, `${name}${path.extname(file.assPath)}`); fs.copyFileSync(file.assPath, entry.assPath); }
        saved.push(entry);
      } catch { /* the other tracks are still kept */ }
    }
    if (!saved.length || !this.jobs.includes(job)) return;
    job.subtitleTracks = saved; job.updated = Date.now(); this.save();
    // One Korean subtitle is enough: none is made when the episode's Jimaku file is translated (설정 > Jimaku 자막 자동
    // 번역) or a Korean track came with it; otherwise the Japanese track (the original dialogue, translated once) or
    // else the English one is translated. Translating every track took one run per language, hours with the local AI.
    if (job.jimakuFound && this.jimakuTranslates?.()) return;
    const text = track => `${track.label} ${track.language}`, code = (track, lang) => new RegExp(`^${lang}(?:[-_]|$)`, 'i').test(track.language || '');
    const korean = saved.some(track => /kor|korean|한국/i.test(text(track)) || code(track, 'ko'));
    const track = korean ? null : saved.find(item => /japanese|日本/i.test(text(item)) || code(item, 'ja')) || saved.find(item => /english/i.test(text(item)) || code(item, 'en'));
    if (!track) return;
    const title = job.displayTitles?.ko || job.title;
    try {
      job.stage = 'translate'; job.translateProgress = track.label; this.save();
      const result = await this.translateTrack?.(track.path, title, job.anime).catch(() => null);
      if (!result || !this.jobs.includes(job)) return; // no key or model, translation of downloads turned off, or it failed
      track.translatedPath = track.path.replace(/\.[^.]+$/, '.ko.vtt'); fs.copyFileSync(result.path, track.translatedPath);
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
    if(!url)return;try{let data,ext='.vtt';if(url.startsWith('file:')){const source=fileURLToPath(url);ext=path.extname(source)||ext;data=fs.readFileSync(source)}else{const response=await fetch(url);if(!response.ok)return;data=Buffer.from(await response.arrayBuffer())}job.subtitlePath=job.filePath.replace(/\.mp4$/i,ext);fs.writeFileSync(job.subtitlePath,data)}catch{}
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
