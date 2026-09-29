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
  constructor({ app, resolveEpisode, resolveLinkkf, findSubtitle, broadcast }) {
    this.root = path.join(app.getPath('videos'), 'LilacAnime');
    this.stateFile = path.join(app.getPath('userData'), 'downloads.json');
    this.resolveEpisode = resolveEpisode;
    this.resolveLinkkf = resolveLinkkf;
    this.findSubtitle = findSubtitle;
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
      child.stderr.on('data',chunk=>{const text=chunk.toString();stderr=(stderr+text).slice(-12000);const d=text.match(/Duration:\s*([^,]+)/)?.[1];if(d)duration=seconds(d);const t=[...text.matchAll(/time=\s*([^\s]+)/g)].pop()?.[1];if(t&&duration){job.progress=Math.max(0,Math.min(99,Math.round(seconds(t)/duration*100)));job.updated=Date.now();this.save();}});
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

  // Episodes saved before subtitles were bundled get one lookup each.
  async backfillSubtitles() {
    if (this.backfilling) return; this.backfilling = true;
    try {
      for (const job of this.jobs.filter(item => item.status === 'completed' && !item.subtitlePath && !item.subtitleChecked && fs.existsSync(item.filePath || ''))) {
        job.stage = 'subtitle'; this.save(); await this.attachSubtitle(job, null); job.stage = ''; job.updated = Date.now(); this.save();
      }
    } finally { this.backfilling = false; }
  }

  saveAssSubtitle(job, file) {
    if(!file||!fs.existsSync(file))return;try{job.subtitleAssPath=job.filePath.replace(/\.mp4$/i,path.extname(file));fs.copyFileSync(file,job.subtitleAssPath)}catch{}
  }

  async saveSubtitle(job, url) {
    if(!url)return;try{let data,ext='.vtt';if(url.startsWith('file:')){const source=fileURLToPath(url);ext=path.extname(source)||ext;data=fs.readFileSync(source)}else{const response=await fetch(url);if(!response.ok)return;data=Buffer.from(await response.arrayBuffer())}job.subtitlePath=job.filePath.replace(/\.mp4$/i,ext);fs.writeFileSync(job.subtitlePath,data)}catch{}
  }

  localPlayback(id) { const job=this.jobs.find(item=>item.id===id);if(!job||job.status!=='completed'||!fs.existsSync(job.filePath))throw new Error('다운로드 파일을 찾지 못했습니다.');return {url:pathToFileURL(job.filePath).href,subtitleUrl:job.subtitlePath&&fs.existsSync(job.subtitlePath)?pathToFileURL(job.subtitlePath).href:null,subtitleAss:job.subtitleAssPath&&fs.existsSync(job.subtitleAssPath)?{url:pathToFileURL(job.subtitleAssPath).href,path:job.subtitleAssPath,fonts:(job.subtitleFonts||[]).filter(file=>fs.existsSync(file)).map(file=>pathToFileURL(file).href)}:null,subtitleLabel:job.subtitleLabel||'',job}; }
}

module.exports = { DownloadManager };
