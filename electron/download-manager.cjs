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

class DownloadManager {
  constructor({ app, resolveEpisode, resolveLinkkf, findSubtitle, findSkips, analyzeOpEd, resolveTitles, saveTrack, translateTrack, broadcast }) {
    this.root = path.join(app.getPath('videos'), 'LilacAnime');
    this.stateFile = path.join(app.getPath('userData'), 'downloads.json');
    this.resolveEpisode = resolveEpisode;
    this.resolveLinkkf = resolveLinkkf;
    this.findSubtitle = findSubtitle;
    this.saveTrack = saveTrack;
    this.translateTrack = translateTrack;
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
    for (const file of [job.filePath, job.subtitlePath, job.subtitleAssPath, job.partialPath]) { if (file) try { fs.unlinkSync(file); } catch {} }
    if (job.filePath && job.subtitleTracks) try { fs.rmSync(trackDir(job), { recursive: true, force: true }); } catch {}
    this.jobs = this.jobs.filter(item => item.id !== id); this.save(); return true;
  }

  pump() {
    while (this.active.size < MAX_CONCURRENT_DOWNLOADS) {
      const job = this.jobs.find(item => item.status === 'queued'); if (!job) return;
      job.status='resolving';job.updated=Date.now();this.active.set(job.id,{job,process:null});this.save();
      this.run(job);
    }
  }

  async run(job) {
    try {
      // Stream resolution shares one browser session whose request hooks are swapped per call, so only the
      // ffmpeg transfers run in parallel.
      const resolving = this.resolving.then(() => job.resolveKind === 'linkkf' ? this.resolveLinkkf(job.episode) : this.resolveEpisode(job.episode));
      this.resolving = resolving.catch(() => {});
      const stream = await resolving;
      if(job.status==='paused'||!this.jobs.some(item=>item.id===job.id))return;
      const animeDir=path.join(this.root,safeName(job.title)), base=`${String(job.episodeNumber).padStart(3,'0')}화`;
      fs.mkdirSync(animeDir,{recursive:true});job.filePath=path.join(animeDir,`${base}.mp4`);job.partialPath=`${job.filePath}.part`;job.status='downloading';job.updated=Date.now();this.save();
      await this.runFfmpeg(job,stream);
      if(job.status==='paused')return;
      try{fs.unlinkSync(job.filePath)}catch{}fs.renameSync(job.partialPath,job.filePath);job.partialPath='';job.status='completed';job.progress=100;job.completed=Date.now();job.updated=Date.now();
      job.stage='subtitle';this.save();await this.attachSubtitle(job,stream);job.stage='';job.updated=Date.now();this.save();
      await this.attachSkips(job);
      await this.attachTitles(job);
      this.queueTracks(job, stream);
    } catch (error) {
      if(job.status!=='paused'){job.status='failed';job.error=error?.message||String(error);job.updated=Date.now();this.save();}
    } finally { this.active.delete(job.id); setImmediate(()=>this.pump()); }
  }

  runFfmpeg(job,stream) {
    return new Promise((resolve,reject)=>{
      let ffmpeg=require('ffmpeg-static');if(ffmpeg.includes('app.asar'))ffmpeg=ffmpeg.replace('app.asar','app.asar.unpacked');
      const args=['-y'];const headers={...(stream?.headers||{})};if(stream?.referer&&!headers.Referer)headers.Referer=stream.referer;
      if(Object.keys(headers).length)args.push('-headers',Object.entries(headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n');
      args.push('-rw_timeout','180000000'); // Android MpvHlsDownloader read timeout: 180 s
      args.push('-i',stream.url,'-map','0:v?','-map','0:a?','-c','copy','-movflags','+faststart','-f','mp4',job.partialPath);
      const child=spawn(ffmpeg,args,{windowsHide:true});this.active.set(job.id,{job,process:child});let duration=0,stderr='';
      child.stderr.on('data',chunk=>{const text=chunk.toString();stderr=(stderr+text).slice(-12000);const d=text.match(/Duration:\s*([^,]+)/)?.[1];if(d){duration=seconds(d);job.duration=duration}const t=[...text.matchAll(/time=\s*([^\s]+)/g)].pop()?.[1];if(t&&duration){const progress=Math.max(0,Math.min(99,Math.round(seconds(t)/duration*100)));if(progress!==job.progress){job.progress=progress;job.updated=Date.now();this.save();}}});
      child.once('error',reject);child.once('close',code=>{if(job.status==='paused')return resolve();if(code===0&&fs.existsSync(job.partialPath))resolve();else reject(new Error((stderr.match(/([^\r\n]+)$/)?.[1]||`FFmpeg 종료 코드 ${code}`).trim()));});
    });
  }

  // Subtitles are fetched right after the video so the episode also plays offline with them.
  async attachSubtitle(job, stream) {
    let found = null;
    try { found = await this.findSubtitle?.(job, stream); } catch { /* fall back to the stream's own subtitle */ }
    job.subtitleChecked = true;
    if (!found || found.stream) { await this.saveSubtitle(job, stream?.subtitleUrl); this.saveAssSubtitle(job, stream?.subtitleAss?.path); return; }
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

  // Re:Anime subtitle tracks are all kept with the episode and, when the user set up Gemini, translated into
  // Korean, so the track list and the translations work offline. This runs one episode at a time after the
  // download has finished, so it never holds a download slot.
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
    const title = job.displayTitles?.ko || job.title;
    try {
      for (const [index, track] of saved.entries()) {
        if (!this.jobs.includes(job)) return;
        job.stage = 'translate'; job.translateProgress = `${index + 1}/${saved.length}`; this.save();
        let result = null;
        try { result = await this.translateTrack?.(track.path, title); } catch (error) {
          // A bad key or an exhausted quota fails every track the same way.
          if ([400, 401, 403, 404, 429].includes(error?.status)) break; continue;
        }
        if (!result) break; // no key, or translation of downloads is turned off
        track.translatedPath = track.path.replace(/\.[^.]+$/, '.ko.vtt'); fs.copyFileSync(result.path, track.translatedPath);
        track.translatedFailed = result.failed || 0; this.save();
      }
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

// Saved tracks with file URLs for the player; the remote URL stays as the track's identity.
function offlineTracks(job) {
  const url = file => file && fs.existsSync(file) ? pathToFileURL(file).href : null;
  return (job.subtitleTracks || []).filter(track => fs.existsSync(track.path || '')).map(track => ({ ...track, localUrl: url(track.path), assUrl: url(track.assPath), translatedUrl: url(track.translatedPath), translatedPath: url(track.translatedPath) ? track.translatedPath : null }));
}
function trackDir(job) { return job.filePath.replace(/\.mp4$/i, '_자막트랙'); }

module.exports = { DownloadManager };
